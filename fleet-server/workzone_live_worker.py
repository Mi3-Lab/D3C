#!/usr/bin/env python3
"""Low-latency WorkZone inference worker for D3C live alerts."""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import torch
from ultralytics import YOLO

try:
    import pynvml  # type: ignore
except Exception:  # pragma: no cover - optional runtime dependency
    pynvml = None


MIB = 1024 * 1024
_NVML_INITIALIZED = False


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


def parse_cuda_device_index(device: str) -> int | None:
    normalized = device.strip().lower()
    if normalized.isdigit():
        return int(normalized)
    if normalized.startswith("cuda:"):
        suffix = normalized.split(":", 1)[1].strip()
        if suffix.isdigit():
            return int(suffix)
    if normalized == "cuda":
        with contextlib.suppress(Exception):
            return int(torch.cuda.current_device())
        return 0
    return None


def init_nvml() -> bool:
    global _NVML_INITIALIZED
    if _NVML_INITIALIZED:
        return True
    if pynvml is None:
        return False
    try:
        pynvml.nvmlInit()
        _NVML_INITIALIZED = True
        return True
    except Exception:
        return False


def safe_round_mib(value: object) -> int | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    if numeric < 0:
        return None
    return int(round(numeric / MIB))


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
        self.accelerator = self._resolve_accelerator()
        self.last_telemetry = dict(self.accelerator)
        self.last_telemetry_at = 0.0

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

    def _resolve_accelerator(self) -> dict:
        requested_device = str(self.device).strip()
        requested_index = parse_cuda_device_index(requested_device)
        if (
            requested_index is not None
            and torch.cuda.is_available()
            and 0 <= requested_index < torch.cuda.device_count()
        ):
            accelerator = {
                "accelerator_kind": "gpu",
                "accelerator_index": int(requested_index),
                "accelerator_name": str(torch.cuda.get_device_name(requested_index)).strip(),
                "resolved_device": f"cuda:{requested_index}",
            }
            with contextlib.suppress(Exception):
                free_bytes, total_bytes = torch.cuda.mem_get_info(requested_index)
                total_mb = safe_round_mib(total_bytes)
                free_mb = safe_round_mib(free_bytes)
                if total_mb is not None:
                    accelerator["gpu_memory_total_mb"] = total_mb
                if free_mb is not None and total_mb is not None:
                    accelerator["gpu_memory_used_mb"] = max(0, total_mb - free_mb)
            return accelerator

        return {
            "accelerator_kind": "cpu",
            "accelerator_index": None,
            "accelerator_name": "CPU",
            "resolved_device": requested_device or "cpu",
        }

    def _query_gpu_telemetry_nvml(self, gpu_index: int) -> dict:
        if not init_nvml():
            return {}
        try:
            handle = pynvml.nvmlDeviceGetHandleByIndex(int(gpu_index))
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
            return {
                "gpu_utilization_pct": int(util.gpu),
                "gpu_memory_used_mb": safe_round_mib(memory.used),
                "gpu_memory_total_mb": safe_round_mib(memory.total),
            }
        except Exception:
            return {}

    def _query_gpu_telemetry_nvidia_smi(self, gpu_index: int) -> dict:
        binary = shutil.which("nvidia-smi")
        if not binary:
            return {}
        try:
            completed = subprocess.run(
                [
                    binary,
                    "--query-gpu=index,utilization.gpu,memory.used,memory.total",
                    "--format=csv,noheader,nounits",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=1.0,
                text=True,
            )
        except Exception:
            return {}
        if completed.returncode != 0:
            return {}
        for raw_line in completed.stdout.splitlines():
            parts = [part.strip() for part in raw_line.split(",")]
            if len(parts) < 4:
                continue
            try:
                line_index = int(parts[0])
            except Exception:
                continue
            if line_index != int(gpu_index):
                continue
            telemetry = {}
            with contextlib.suppress(Exception):
                telemetry["gpu_utilization_pct"] = int(round(float(parts[1])))
            with contextlib.suppress(Exception):
                telemetry["gpu_memory_used_mb"] = int(round(float(parts[2])))
            with contextlib.suppress(Exception):
                telemetry["gpu_memory_total_mb"] = int(round(float(parts[3])))
            return telemetry
        return {}

    def _query_gpu_telemetry_torch(self, gpu_index: int) -> dict:
        if not torch.cuda.is_available():
            return {}
        telemetry = {}
        with contextlib.suppress(Exception):
            free_bytes, total_bytes = torch.cuda.mem_get_info(int(gpu_index))
            total_mb = safe_round_mib(total_bytes)
            free_mb = safe_round_mib(free_bytes)
            if total_mb is not None:
                telemetry["gpu_memory_total_mb"] = total_mb
            if free_mb is not None and total_mb is not None:
                telemetry["gpu_memory_used_mb"] = max(0, total_mb - free_mb)
        return telemetry

    def collect_runtime_telemetry(self, *, force: bool = False) -> dict:
        accelerator = dict(self.accelerator)
        if accelerator.get("accelerator_kind") != "gpu":
            return accelerator

        now = time.monotonic()
        if not force and self.last_telemetry and (now - self.last_telemetry_at) < 1.5:
            return dict(self.last_telemetry)

        gpu_index = accelerator.get("accelerator_index")
        telemetry = dict(accelerator)
        if gpu_index is not None:
            extra = self._query_gpu_telemetry_nvml(int(gpu_index))
            if not extra:
                extra = self._query_gpu_telemetry_nvidia_smi(int(gpu_index))
            if not extra:
                extra = self._query_gpu_telemetry_torch(int(gpu_index))
            telemetry.update({key: value for key, value in extra.items() if value is not None})

        used_mb = telemetry.get("gpu_memory_used_mb")
        total_mb = telemetry.get("gpu_memory_total_mb")
        if isinstance(used_mb, int) and isinstance(total_mb, int) and total_mb > 0:
            telemetry["gpu_memory_pct"] = round((used_mb / total_mb) * 100.0, 1)

        self.last_telemetry = dict(telemetry)
        self.last_telemetry_at = now
        return telemetry

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
        **detector.collect_runtime_telemetry(force=True),
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
            emit({
                "type": "pong",
                "updated_at": utc_now_iso(),
                **detector.collect_runtime_telemetry(force=True),
            })
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
                "t_recv_ms": int(message.get("t_recv_ms") or 0),
                "t_device_ms": int(message.get("t_device_ms") or 0),
                "queued_at_ms": int(message.get("queued_at_ms") or 0),
                "dispatch_started_at_ms": int(message.get("dispatch_started_at_ms") or 0),
                "found": False,
                "score": 0.0,
                "max_confidence": 0.0,
                "detection_count": 0,
                "class_counts": {},
                "top_detections": [],
                "inference_ms": 0.0,
                "status": "decode_failed",
                "updated_at": utc_now_iso(),
                **detector.collect_runtime_telemetry(),
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
                "t_recv_ms": int(message.get("t_recv_ms") or 0),
                "t_device_ms": int(message.get("t_device_ms") or 0),
                "queued_at_ms": int(message.get("queued_at_ms") or 0),
                "dispatch_started_at_ms": int(message.get("dispatch_started_at_ms") or 0),
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
                **detector.collect_runtime_telemetry(force=True),
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
            "queued_at_ms": int(message.get("queued_at_ms") or 0),
            "dispatch_started_at_ms": int(message.get("dispatch_started_at_ms") or 0),
            "score_threshold": detector.score_threshold,
            "status": "ok",
            "updated_at": utc_now_iso(),
            **result,
            **detector.collect_runtime_telemetry(),
        })

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
