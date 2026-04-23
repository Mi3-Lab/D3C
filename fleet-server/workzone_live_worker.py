#!/usr/bin/env python3
"""Low-latency WorkZone inference worker for D3C live alerts."""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO


def normalize_label(label: object) -> str:
    return str(label or "").strip()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def resolve_path(raw_path: str, *, base_dir: Path) -> Path:
    path = Path(raw_path)
    return path if path.is_absolute() else (base_dir / path)


def should_move_model_to_device(device: str) -> bool:
    normalized = device.strip().lower()
    if normalized.isdigit():
        return False
    return normalized not in {"0", "1", "2", "3"}


class LiveDetector:
    def __init__(
        self,
        *,
        workzone_project_dir: Path,
        weights: str,
        device: str,
        imgsz: int,
        conf: float,
        iou: float,
        score_threshold: float,
    ) -> None:
        self.workzone_project_dir = workzone_project_dir
        self.weights = resolve_path(weights, base_dir=workzone_project_dir)
        self.device = device
        self.imgsz = imgsz
        self.conf = conf
        self.iou = iou
        self.score_threshold = score_threshold
        self.model = self._load_model()
        self.class_counts, self.compute_workzone_score = self._load_helpers()

    def _load_model(self) -> YOLO:
        with contextlib.redirect_stdout(sys.stderr):
            model = YOLO(str(self.weights))
            if should_move_model_to_device(self.device):
                try:
                    model.to(self.device)
                except Exception as exc:
                    print(f"[workzone-live] could not move model to {self.device}: {exc}", file=sys.stderr, flush=True)
        return model

    def _load_helpers(self):
        project_str = str(self.workzone_project_dir)
        if project_str not in sys.path:
            sys.path.insert(0, project_str)
        from d3c_support.annotate import class_counts, compute_workzone_score

        return class_counts, compute_workzone_score

    def analyze_frame(self, frame_bgr: np.ndarray) -> dict:
        infer_started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            results = self.model.predict(
                frame_bgr,
                conf=self.conf,
                iou=self.iou,
                imgsz=self.imgsz,
                verbose=False,
                device=self.device,
                half=self.device.strip().lower() != "cpu",
            )
        infer_ms = (time.perf_counter() - infer_started) * 1000.0
        result = results[0]

        if result.boxes is not None and len(result.boxes) > 0:
            class_ids = result.boxes.cls.int().cpu().tolist()
            confidences = [float(value) for value in result.boxes.conf.cpu().tolist()]
            class_names = [self.model.names[int(class_id)] for class_id in class_ids]
            max_confidence = max(confidences)
            top_detections = [
                {
                    "label": normalize_label(label),
                    "confidence": round(float(confidence), 4),
                }
                for label, confidence in sorted(
                    zip(class_names, confidences),
                    key=lambda item: float(item[1]),
                    reverse=True,
                )[:5]
            ]
        else:
            class_names = []
            max_confidence = 0.0
            top_detections = []

        counts = self.class_counts(class_names)
        score = float(self.compute_workzone_score(class_names))
        return {
            "found": score >= self.score_threshold,
            "score": score,
            "max_confidence": max_confidence,
            "detection_count": len(class_names),
            "class_counts": counts,
            "top_detections": top_detections,
            "inference_ms": round(infer_ms, 2),
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Low-latency WorkZone inference worker")
    parser.add_argument("--workzone-project-dir", type=Path, required=True)
    parser.add_argument("--weights", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--conf", type=float, default=0.18)
    parser.add_argument("--iou", type=float, default=0.45)
    parser.add_argument("--score-threshold", type=float, default=0.40)
    return parser


def decode_frame(jpeg_b64: str) -> np.ndarray | None:
    try:
        payload = base64.b64decode(jpeg_b64)
    except Exception:
        return None
    array = np.frombuffer(payload, dtype=np.uint8)
    if not len(array):
        return None
    return cv2.imdecode(array, cv2.IMREAD_COLOR)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cv2.setNumThreads(1)

    detector = LiveDetector(
        workzone_project_dir=args.workzone_project_dir.resolve(),
        weights=args.weights,
        device=str(args.device),
        imgsz=max(64, int(args.imgsz)),
        conf=float(args.conf),
        iou=float(args.iou),
        score_threshold=float(args.score_threshold),
    )

    emit({
        "type": "ready",
        "device": detector.device,
        "imgsz": detector.imgsz,
        "weights": str(detector.weights),
        "updated_at": utc_now_iso(),
    })

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"type": "error", "stage": "decode_message", "error": str(exc)})
            continue

        msg_type = str(message.get("type") or "").strip().lower()
        if msg_type == "ping":
            emit({"type": "pong", "updated_at": utc_now_iso()})
            continue
        if msg_type != "frame":
            emit({"type": "error", "stage": "message_type", "error": f"unsupported type: {msg_type}"})
            continue

        frame = decode_frame(str(message.get("jpeg_base64") or ""))
        if frame is None:
            emit({
                "type": "result",
                "device_id": str(message.get("device_id") or ""),
                "seq": int(message.get("seq") or 0),
                "frame_index": int(message.get("frame_index") or 0),
                "session_dir": str(message.get("session_dir") or ""),
                "found": False,
                "score": 0.0,
                "max_confidence": 0.0,
                "detection_count": 0,
                "class_counts": {},
                "top_detections": [],
                "inference_ms": 0.0,
                "status": "decode_failed",
                "updated_at": utc_now_iso(),
            })
            continue

        try:
            result = detector.analyze_frame(frame)
        except Exception as exc:
            emit({
                "type": "result",
                "device_id": str(message.get("device_id") or ""),
                "seq": int(message.get("seq") or 0),
                "frame_index": int(message.get("frame_index") or 0),
                "session_dir": str(message.get("session_dir") or ""),
                "found": False,
                "score": 0.0,
                "max_confidence": 0.0,
                "detection_count": 0,
                "class_counts": {},
                "top_detections": [],
                "inference_ms": 0.0,
                "status": "predict_failed",
                "error": str(exc),
                "updated_at": utc_now_iso(),
            })
            continue

        emit({
            "type": "result",
            "device_id": str(message.get("device_id") or ""),
            "seq": int(message.get("seq") or 0),
            "frame_index": int(message.get("frame_index") or 0),
            "session_dir": str(message.get("session_dir") or ""),
            "t_recv_ms": int(message.get("t_recv_ms") or 0),
            "t_device_ms": int(message.get("t_device_ms") or 0),
            "score_threshold": detector.score_threshold,
            "status": "ok",
            "updated_at": utc_now_iso(),
            **result,
        })

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
