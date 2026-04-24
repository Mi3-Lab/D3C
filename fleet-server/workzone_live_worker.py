#!/usr/bin/env python3
"""Advanced low-latency WorkZone inference worker for D3C live alerts."""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import logging
import math
import shutil
import subprocess
import sys
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
from ultralytics import YOLO

try:
    import yaml
except Exception:  # pragma: no cover - optional runtime dependency
    yaml = None

try:
    import pynvml  # type: ignore
except Exception:  # pragma: no cover - optional runtime dependency
    pynvml = None


MIB = 1024 * 1024
_NVML_INITIALIZED = False
MAX_APPROACH_DURATION_FRAMES = 150
SCENE_WARMUP_SAMPLES = 4
MAX_PER_CUE_BATCH = 4

DEFAULT_FUSION_WEIGHTS = {
    "bias": -0.35,
    "channelization": 0.9,
    "workers": 0.8,
    "vehicles": 0.5,
    "ttc_signs": 0.7,
    "message_board": 0.6,
}
DEFAULT_ORANGE_PARAMS = {
    "h_low": 5,
    "h_high": 25,
    "s_th": 80,
    "v_th": 50,
    "center": 0.08,
    "k": 30.0,
}
DEFAULT_SCENE_PRESETS = {
    "highway": {
        "bias": 0.0,
        "channelization": 1.5,
        "workers": 0.4,
        "vehicles": 0.5,
        "ttc_signs": 1.3,
        "message_board": 0.8,
        "approach_th": 0.25,
        "enter_th": 0.50,
        "exit_th": 0.30,
        "min_out_frames": 60,
    },
    "urban": {
        "bias": -0.15,
        "channelization": 0.4,
        "workers": 1.2,
        "vehicles": 0.6,
        "ttc_signs": 0.9,
        "message_board": 1.0,
        "approach_th": 0.30,
        "enter_th": 0.60,
        "exit_th": 0.40,
    },
    "suburban": {
        "bias": -0.35,
        "channelization": 0.9,
        "workers": 0.8,
        "vehicles": 0.5,
        "ttc_signs": 0.7,
        "message_board": 0.6,
        "approach_th": 0.25,
        "enter_th": 0.50,
        "exit_th": 0.30,
    },
    "mixed": {
        "bias": -0.05,
        "channelization": 0.8,
        "workers": 0.8,
        "vehicles": 0.5,
        "ttc_signs": 0.8,
        "message_board": 0.6,
        "approach_th": 0.25,
        "enter_th": 0.50,
        "exit_th": 0.30,
    },
}
DEFAULT_CLIP_POS_TEXT = (
    "driving through a road construction work zone with orange barrels, traffic cones, "
    "concrete barriers, lane closure signs, and construction workers"
)
DEFAULT_CLIP_NEG_TEXT = (
    "driving on a clear normal road or highway with regular traffic, no construction, "
    "no orange cones, no work zone barriers"
)
OCR_BOOST_WEIGHTS = {
    "WORKZONE": 0.30,
    "LANE": 0.30,
    "CAUTION": 0.30,
    "DIRECTION": 0.20,
    "SPEED": 0.20,
}

logging.basicConfig(level=logging.INFO, stream=sys.stderr, force=True)

CUE_PROMPTS = {
    "channelization": {
        "pos": [
            "traffic cone on road",
            "orange construction barrel on asphalt",
            "striped barricade on road",
            "road barrier",
            "vertical panel marker",
        ],
        "neg": [
            "tree trunk",
            "street light pole",
            "mailbox",
            "pedestrian",
            "car wheel",
            "fire hydrant",
            "electricity pole",
            "bush",
        ],
        "inactive": [
            "traffic cones stacked on a truck bed",
            "cones stored in a pile",
            "construction barrels on a trailer",
            "equipment in storage yard",
        ],
    },
    "workers": {
        "pos": [
            "construction worker in high-visibility safety vest",
            "person wearing hard hat and safety gear",
            "road worker flagging traffic",
        ],
        "neg": [
            "pedestrian in casual clothes",
            "business person in suit",
            "runner",
            "cyclist",
            "mannequin",
            "statue",
        ],
    },
    "vehicles": {
        "pos": [
            "yellow construction excavator",
            "dump truck on road",
            "pickup truck with flashing amber lights",
            "road roller",
            "utility work truck",
        ],
        "neg": [
            "sedan car",
            "family suv",
            "sports car",
            "motorcycle",
            "city bus",
            "taxi",
        ],
    },
    "ttc_signs": {
        "pos": [
            "orange diamond construction sign facing camera",
            "road work ahead sign",
            "speed limit sign facing camera",
            "white rectangular regulatory sign",
        ],
        "neg": [
            "commercial billboard advertisement",
            "shop sign",
            "street name sign",
            "parking sign",
            "restaurant sign",
        ],
        "inactive": [
            "back of a road sign",
            "grey metal sign back",
            "sign facing away",
            "oblique sign edge",
        ],
    },
    "message_board": {
        "pos": [
            "electronic arrow board trailer with lights on",
            "variable message sign displaying text",
            "digital traffic sign",
        ],
        "neg": [
            "parked cargo trailer",
            "billboard",
            "back of a truck",
            "container",
        ],
        "inactive": [
            "message board turned off",
            "black screen message board",
            "folded arrow board",
        ],
    },
}


def normalize_label(label: object) -> str:
    return str(label or "").strip()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def logistic(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-float(value)))


def safe_div(numerator: float, denominator: float) -> float:
    return float(numerator) / float(denominator) if denominator else 0.0


def ema(previous: float | None, current: float, alpha: float) -> float:
    if previous is None:
        return float(current)
    return (float(alpha) * float(current)) + ((1.0 - float(alpha)) * float(previous))


def adaptive_alpha(evidence: float, alpha_min: float, alpha_max: float) -> float:
    evidence = clamp01(evidence)
    return float(alpha_min + ((alpha_max - alpha_min) * evidence))


def resolve_path(raw_path: str | None, *, base_dir: Path) -> Path | None:
    if raw_path is None:
        return None
    text = str(raw_path).strip()
    if not text:
        return None
    path = Path(text)
    return path if path.is_absolute() else (base_dir / path)


def parse_cuda_device_index(device: str) -> int | None:
    normalized = str(device or "").strip().lower()
    if normalized.isdigit():
        return int(normalized)
    if normalized.startswith("cuda:"):
        suffix = normalized.split(":", 1)[1].strip()
        if suffix.isdigit():
            return int(suffix)
    if normalized == "cuda":
        return 0
    return None


def normalize_device(device: str | None, *, fallback: str = "cpu") -> str:
    normalized = str(device or "").strip().lower()
    if not normalized:
        normalized = fallback
    if normalized in {"cpu", "mps"}:
        return normalized
    gpu_index = parse_cuda_device_index(normalized)
    if gpu_index is not None:
        if torch.cuda.is_available():
            return f"cuda:{gpu_index}"
        return "cpu"
    if normalized.startswith("cuda") and torch.cuda.is_available():
        return normalized
    return normalized or fallback


def parse_auto_bool(raw: object) -> bool | None:
    if raw is None:
        return None
    normalized = str(raw).strip().lower()
    if normalized in {"", "auto", "default"}:
        return None
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def choose_bool(override: object, configured: object, default: bool) -> bool:
    parsed_override = parse_auto_bool(override)
    if parsed_override is not None:
        return parsed_override
    parsed_configured = parse_auto_bool(configured)
    if parsed_configured is not None:
        return parsed_configured
    if isinstance(configured, bool):
        return configured
    return bool(default)


def choose_float(*candidates: object, default: float) -> float:
    for value in candidates:
        if value is None:
            continue
        try:
            numeric = float(value)
        except Exception:
            continue
        if math.isfinite(numeric):
            return float(numeric)
    return float(default)


def choose_int(*candidates: object, default: int) -> int:
    for value in candidates:
        if value is None:
            continue
        try:
            numeric = int(round(float(value)))
        except Exception:
            continue
        return int(numeric)
    return int(default)


def load_yaml_file(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists() or yaml is None:
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        print(f"[workzone-live] could not load config {path}: {exc}", file=sys.stderr, flush=True)
        return {}
    return data if isinstance(data, dict) else {}


def deep_merge_dicts(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


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


def is_ttc_sign(name: str) -> bool:
    return str(name or "").startswith("Temporary Traffic Control Sign")


def get_cue_category(name: str) -> str | None:
    if name in CHANNELIZATION:
        return "channelization"
    if name in WORKERS:
        return "workers"
    if name in VEHICLES:
        return "vehicles"
    if is_ttc_sign(name):
        return "ttc_signs"
    if name in MESSAGE_BOARD:
        return "message_board"
    return None


def group_counts_from_names(class_names: list[str]) -> dict[str, int]:
    grouped = Counter()
    for name in class_names:
        category = get_cue_category(name)
        if category:
            grouped[category] += 1
    return dict(grouped)


def yolo_frame_score(counts: dict[str, int], weights: dict[str, float]) -> tuple[float, dict[str, int]]:
    count_channelization = int(counts.get("channelization", 0))
    count_workers = int(counts.get("workers", 0))
    count_vehicles = int(counts.get("vehicles", 0))
    count_ttc = int(counts.get("ttc_signs", 0))
    count_msg = int(counts.get("message_board", 0))
    total_objs = count_channelization + count_workers + count_vehicles + count_ttc + count_msg

    score = float(weights.get("bias", -0.35))
    score += float(weights.get("channelization", 0.9)) * safe_div(count_channelization, 5.0)
    score += float(weights.get("workers", 0.8)) * safe_div(count_workers, 3.0)
    score += float(weights.get("vehicles", 0.5)) * safe_div(count_vehicles, 2.0)
    score += float(weights.get("ttc_signs", 0.7)) * safe_div(count_ttc, 4.0)
    score += float(weights.get("message_board", 0.6)) * safe_div(count_msg, 1.0)

    return clamp01(score), {
        "count_channelization": count_channelization,
        "count_workers": count_workers,
        "count_vehicles": count_vehicles,
        "count_ttc": count_ttc,
        "count_msg": count_msg,
        "total_objs": total_objs,
    }


def orange_ratio_hsv(frame_bgr: np.ndarray, orange_params: dict[str, float]) -> float:
    if frame_bgr is None or frame_bgr.size == 0:
        return 0.0
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    h_low = int(round(float(orange_params.get("h_low", 5))))
    h_high = int(round(float(orange_params.get("h_high", 25))))
    s_th = int(round(float(orange_params.get("s_th", 80))))
    v_th = int(round(float(orange_params.get("v_th", 50))))
    mask = (h >= h_low) & (h <= h_high) & (s >= s_th) & (v >= v_th)
    return clamp01(float(mask.sum()) / float(mask.size))


def context_boost_from_orange(ratio: float, orange_params: dict[str, float]) -> float:
    center = float(orange_params.get("center", 0.08))
    slope = float(orange_params.get("k", 30.0))
    return clamp01(logistic(slope * (float(ratio) - center)))


def enhance_night_frame(frame: np.ndarray) -> tuple[np.ndarray, bool]:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    brightness = float(np.mean(v))
    if brightness >= 60.0:
        return frame, False

    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    v = clahe.apply(v)

    gamma = 0.7
    inv_gamma = 1.0 / gamma
    table = np.array([((i / 255.0) ** inv_gamma) * 255 for i in np.arange(0, 256)], dtype="uint8")
    v = cv2.LUT(v, table)

    hsv_enhanced = cv2.merge([h, s, v])
    frame_enhanced = cv2.cvtColor(hsv_enhanced, cv2.COLOR_HSV2BGR)
    return frame_enhanced, True


def update_state(
    previous: str,
    score: float,
    state_duration: int,
    out_frames: int,
    thresholds: dict[str, float | int],
) -> tuple[str, int, int]:
    enter_th = float(thresholds["enter_th"])
    exit_th = float(thresholds["exit_th"])
    approach_th = float(thresholds["approach_th"])
    min_out_frames = int(thresholds["min_out_frames"])

    if previous == "OUT":
        if score >= approach_th:
            return "APPROACHING", 0, 0
        return "OUT", 0, out_frames + 1

    if previous == "APPROACHING":
        if state_duration > MAX_APPROACH_DURATION_FRAMES:
            return "OUT", 0, 0
        if score >= enter_th:
            return "INSIDE", 0, 0
        if score <= (approach_th - 0.05):
            if out_frames >= (min_out_frames * 2):
                return "OUT", 0, 0
            return "APPROACHING", state_duration + 1, out_frames + 1
        return "APPROACHING", state_duration + 1, 0

    if previous == "INSIDE":
        if score < exit_th:
            return "EXITING", 0, 0
        return "INSIDE", state_duration + 1, 0

    if previous == "EXITING":
        if score >= enter_th:
            return "INSIDE", state_duration, 0
        if out_frames >= min_out_frames:
            return "OUT", 0, 0
        return "EXITING", state_duration, out_frames + 1

    return previous, state_duration, out_frames


CHANNELIZATION: set[str]
WORKERS: set[str]
VEHICLES: set[str]
MESSAGE_BOARD: set[str]


@dataclass
class EffectiveConfig:
    workzone_project_dir: Path
    config_path: Path | None
    general_config_path: Path | None
    weights: Path
    device: str
    imgsz: int
    conf: float
    iou: float
    score_threshold: float
    ema_alpha: float
    enter_th: float
    exit_th: float
    approach_th: float
    min_inside_frames: int
    min_out_frames: int
    use_clip: bool
    enable_per_cue: bool
    enable_context_boost: bool
    scene_context_enable: bool
    enable_ocr: bool
    ocr_full_frame: bool
    clip_weight: float
    clip_trigger_th: float
    per_cue_th: float
    context_trigger_below: float
    orange_weight: float
    ocr_every_n: int
    ocr_threshold: float
    scene_interval: int
    clip_interval: int
    per_cue_interval: int
    weights_yolo: dict[str, float]
    clip_pos_text: str
    clip_neg_text: str
    orange_params: dict[str, float]
    scene_presets: dict[str, dict[str, float]]


@dataclass
class DeviceFusionState:
    last_frame_index: int = 0
    yolo_ema: float | None = None
    fused_ema: float | None = None
    last_clip_score: float = 0.0
    machine_state: str = "OUT"
    state_duration_frames: int = 0
    out_frames: int = 0
    current_scene: str = "manual"
    scene_confidence: float = 0.0
    scene_buffer: deque[tuple[str, float]] = field(default_factory=lambda: deque(maxlen=12))
    ocr_aggregator: Any = None
    last_ocr: dict[str, Any] = field(default_factory=dict)


class PerCueVerifier:
    def __init__(self, clip_bundle: dict[str, Any], device: str):
        self.clip_bundle = clip_bundle
        self.device = device
        self.embeddings: dict[str, tuple[torch.Tensor, torch.Tensor, torch.Tensor | None]] = {}
        self.use_fp16 = device.startswith("cuda")
        self._precompute_embeddings()

    def _precompute_embeddings(self) -> None:
        tokenizer = self.clip_bundle["tokenizer"]
        model = self.clip_bundle["model"]
        for category, prompts in CUE_PROMPTS.items():
            pos_tokens = tokenizer(prompts["pos"]).to(self.device)
            neg_tokens = tokenizer(prompts["neg"]).to(self.device)
            with torch.no_grad():
                pos_emb = model.encode_text(pos_tokens)
                pos_emb = pos_emb / (pos_emb.norm(dim=-1, keepdim=True) + 1e-8)
                pos_mean = pos_emb.mean(dim=0)
                pos_mean = pos_mean / (pos_mean.norm() + 1e-8)

                neg_emb = model.encode_text(neg_tokens)
                neg_emb = neg_emb / (neg_emb.norm(dim=-1, keepdim=True) + 1e-8)
                neg_mean = neg_emb.mean(dim=0)
                neg_mean = neg_mean / (neg_mean.norm() + 1e-8)

                inactive_mean = None
                inactive_prompts = prompts.get("inactive")
                if inactive_prompts:
                    inactive_tokens = tokenizer(inactive_prompts).to(self.device)
                    inactive_emb = model.encode_text(inactive_tokens)
                    inactive_emb = inactive_emb / (inactive_emb.norm(dim=-1, keepdim=True) + 1e-8)
                    inactive_mean = inactive_emb.mean(dim=0)
                    inactive_mean = inactive_mean / (inactive_mean.norm() + 1e-8)

            self.embeddings[category] = (pos_mean, neg_mean, inactive_mean)

    def verify_batch(self, crops_bgr: list[np.ndarray], categories: list[str]) -> list[float]:
        if not crops_bgr:
            return []

        preprocess = self.clip_bundle["preprocess"]
        image_cls = self.clip_bundle["PIL_Image"]
        model = self.clip_bundle["model"]
        inputs: list[torch.Tensor] = []
        valid_indices: list[int] = []
        for idx, (crop, category) in enumerate(zip(crops_bgr, categories)):
            if category not in self.embeddings or crop.size == 0:
                continue
            resized = cv2.resize(crop, (224, 224), interpolation=cv2.INTER_LINEAR)
            rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
            inputs.append(preprocess(image_cls.fromarray(rgb)))
            valid_indices.append(idx)

        if not inputs:
            return [0.0] * len(crops_bgr)

        image_batch = torch.stack(inputs).to(self.device)
        autocast_kwargs = {"device_type": "cuda", "enabled": self.use_fp16}
        with torch.no_grad():
            if self.use_fp16:
                with torch.autocast(**autocast_kwargs):
                    image_embeddings = model.encode_image(image_batch)
            else:
                image_embeddings = model.encode_image(image_batch)
            image_embeddings = image_embeddings / (image_embeddings.norm(dim=-1, keepdim=True) + 1e-8)

        scores = [0.0] * len(crops_bgr)
        for batch_index, original_index in enumerate(valid_indices):
            category = categories[original_index]
            pos_emb, neg_emb, inactive_emb = self.embeddings[category]
            emb = image_embeddings[batch_index]
            sim_pos = float(torch.dot(emb, pos_emb))
            sim_neg = float(torch.dot(emb, neg_emb))
            reject_score = sim_neg
            if inactive_emb is not None:
                sim_inactive = float(torch.dot(emb, inactive_emb))
                if sim_inactive > sim_pos:
                    scores[original_index] = -1.0
                    continue
                reject_score = max(reject_score, sim_inactive)
            scores[original_index] = sim_pos - reject_score
        return scores


def build_effective_config(args: argparse.Namespace) -> EffectiveConfig:
    workzone_project_dir = args.workzone_project_dir.resolve()
    general_config_path = workzone_project_dir / "configs" / "config.yaml"
    default_config_path = workzone_project_dir / "configs" / "jetson_config.yaml"
    explicit_config_path = resolve_path(str(args.config_path) if args.config_path else "", base_dir=workzone_project_dir)

    selected_config_path = explicit_config_path
    if selected_config_path is None:
        if default_config_path.exists():
            selected_config_path = default_config_path
        elif general_config_path.exists():
            selected_config_path = general_config_path

    general_config = load_yaml_file(general_config_path if general_config_path.exists() else None)
    selected_config = load_yaml_file(selected_config_path)
    merged_config = deep_merge_dicts(general_config, selected_config) if selected_config_path != general_config_path else general_config

    model_config = merged_config.get("model") if isinstance(merged_config.get("model"), dict) else {}
    yolo_config = merged_config.get("yolo") if isinstance(merged_config.get("yolo"), dict) else {}
    hardware_config = merged_config.get("hardware") if isinstance(merged_config.get("hardware"), dict) else {}
    device_config = merged_config.get("device") if isinstance(merged_config.get("device"), dict) else {}
    fusion_config = merged_config.get("fusion") if isinstance(merged_config.get("fusion"), dict) else {}
    scene_config = merged_config.get("scene_context") if isinstance(merged_config.get("scene_context"), dict) else {}

    configured_device = args.device
    if not configured_device:
        if hardware_config.get("device") is not None:
            configured_device = str(hardware_config.get("device"))
        elif device_config.get("type"):
            device_type = str(device_config.get("type"))
            if device_type.strip().lower() == "cuda":
                device_id = choose_int(device_config.get("id"), default=0)
                configured_device = f"cuda:{device_id}"
            else:
                configured_device = device_type
    configured_device = normalize_device(configured_device or "cpu")

    weights_text = (args.weights or "").strip()
    if not weights_text:
        weights_text = str(model_config.get("path") or yolo_config.get("model_path") or "weights/yolo12s_hardneg_1280.pt")
    weights_path = resolve_path(weights_text, base_dir=workzone_project_dir) or (workzone_project_dir / "weights" / "yolo12s_hardneg_1280.pt")

    weights_yolo = dict(DEFAULT_FUSION_WEIGHTS)
    configured_weights = fusion_config.get("weights_yolo")
    if isinstance(configured_weights, dict):
        for key, value in configured_weights.items():
            try:
                weights_yolo[str(key)] = float(value)
            except Exception:
                continue

    orange_params = dict(DEFAULT_ORANGE_PARAMS)
    configured_orange_params = fusion_config.get("orange_params")
    if isinstance(configured_orange_params, dict):
        for key, value in configured_orange_params.items():
            try:
                orange_params[str(key)] = float(value)
            except Exception:
                continue

    scene_presets = deep_merge_dicts(DEFAULT_SCENE_PRESETS, scene_config.get("presets") if isinstance(scene_config.get("presets"), dict) else {})

    return EffectiveConfig(
        workzone_project_dir=workzone_project_dir,
        config_path=selected_config_path.resolve() if selected_config_path and selected_config_path.exists() else None,
        general_config_path=general_config_path.resolve() if general_config_path.exists() else None,
        weights=weights_path.resolve(),
        device=configured_device,
        imgsz=max(64, choose_int(args.imgsz, model_config.get("imgsz"), yolo_config.get("imgsz"), default=1280)),
        conf=clamp01(choose_float(args.conf, model_config.get("conf"), yolo_config.get("confidence_threshold"), default=0.18)),
        iou=clamp01(choose_float(args.iou, model_config.get("iou"), yolo_config.get("iou_threshold"), default=0.45)),
        score_threshold=clamp01(choose_float(args.score_threshold, default=0.40)),
        ema_alpha=clamp01(choose_float(args.ema_alpha, fusion_config.get("ema_alpha"), default=0.10)),
        enter_th=clamp01(choose_float(args.enter_th, fusion_config.get("enter_th"), default=0.50)),
        exit_th=clamp01(choose_float(args.exit_th, fusion_config.get("exit_th"), default=0.30)),
        approach_th=clamp01(choose_float(args.approach_th, fusion_config.get("approach_th"), default=0.25)),
        min_inside_frames=max(1, choose_int(args.min_inside_frames, fusion_config.get("min_inside_frames"), default=6)),
        min_out_frames=max(1, choose_int(args.min_out_frames, fusion_config.get("min_out_frames"), default=20)),
        use_clip=choose_bool(args.use_clip, fusion_config.get("use_clip"), True),
        enable_per_cue=choose_bool(args.enable_per_cue, fusion_config.get("use_per_cue"), False),
        enable_context_boost=choose_bool(args.enable_context_boost, fusion_config.get("enable_context_boost"), True),
        scene_context_enable=choose_bool(args.scene_context_enable, scene_config.get("enabled"), True),
        enable_ocr=choose_bool(args.enable_ocr, None, True),
        ocr_full_frame=choose_bool(args.ocr_full_frame, None, True),
        clip_weight=clamp01(choose_float(args.clip_weight, fusion_config.get("clip_weight"), default=0.35)),
        clip_trigger_th=clamp01(choose_float(args.clip_trigger_th, fusion_config.get("clip_trigger_th"), default=0.20)),
        per_cue_th=clamp01(choose_float(args.per_cue_th, fusion_config.get("per_cue_th"), default=0.05)),
        context_trigger_below=clamp01(choose_float(args.context_trigger_below, fusion_config.get("context_trigger_below"), default=0.50)),
        orange_weight=clamp01(choose_float(args.orange_weight, fusion_config.get("orange_weight"), default=0.25)),
        ocr_every_n=max(1, choose_int(args.ocr_every_n, default=2)),
        ocr_threshold=clamp01(choose_float(args.ocr_threshold, default=0.25)),
        scene_interval=max(1, choose_int(args.scene_interval, default=15)),
        clip_interval=max(1, choose_int(args.clip_interval, default=3)),
        per_cue_interval=max(1, choose_int(args.per_cue_interval, default=3)),
        weights_yolo=weights_yolo,
        clip_pos_text=str(fusion_config.get("clip_pos_text") or DEFAULT_CLIP_POS_TEXT).strip() or DEFAULT_CLIP_POS_TEXT,
        clip_neg_text=str(fusion_config.get("clip_neg_text") or DEFAULT_CLIP_NEG_TEXT).strip() or DEFAULT_CLIP_NEG_TEXT,
        orange_params=orange_params,
        scene_presets=scene_presets,
    )


class LiveDetector:
    def __init__(self, config: EffectiveConfig) -> None:
        self.config = config
        self.workzone_project_dir = config.workzone_project_dir
        self.weights = config.weights
        self.device = config.device
        self.imgsz = config.imgsz
        self.conf = config.conf
        self.iou = config.iou
        self.score_threshold = config.score_threshold
        self._prepare_import_paths()
        self.class_counts, self.compute_workzone_score = self._load_helpers()
        self.model = self._load_model()
        self.accelerator = self._resolve_accelerator()
        self.last_telemetry = dict(self.accelerator)
        self.last_telemetry_at = 0.0
        self.device_states: dict[str, DeviceFusionState] = {}
        self.feature_errors: dict[str, str] = {}

        self.scene_predictor = None
        self.clip_bundle = None
        self.pos_emb = None
        self.neg_emb = None
        self.per_cue_verifier = None
        self.ocr_bundle = None

        self._load_optional_features()
        self.feature_flags = {
            "semantic_fusion": True,
            "scene_context": self.scene_predictor is not None,
            "clip": self.clip_bundle is not None and self.pos_emb is not None and self.neg_emb is not None,
            "per_cue": self.per_cue_verifier is not None,
            "context_boost": bool(self.config.enable_context_boost),
            "ocr": self.ocr_bundle is not None,
            "ocr_full_frame": bool(self.ocr_bundle is not None and self.config.ocr_full_frame and self.ocr_bundle.get("extract_full_frame") is not None),
        }
        self.advanced_mode = True

    def _prepare_import_paths(self) -> None:
        for candidate in (self.workzone_project_dir, self.workzone_project_dir / "src"):
            candidate_text = str(candidate.resolve())
            if candidate_text not in sys.path:
                sys.path.insert(0, candidate_text)

    def _load_helpers(self):
        from d3c_support.annotate import CHANNELIZATION as channelization
        from d3c_support.annotate import MESSAGE_BOARD as message_board
        from d3c_support.annotate import VEHICLES as vehicles
        from d3c_support.annotate import WORKERS as workers
        from d3c_support.annotate import class_counts, compute_workzone_score

        global CHANNELIZATION, WORKERS, VEHICLES, MESSAGE_BOARD
        CHANNELIZATION = set(channelization)
        WORKERS = set(workers)
        VEHICLES = set(vehicles)
        MESSAGE_BOARD = set(message_board)
        return class_counts, compute_workzone_score

    def _load_model(self) -> YOLO:
        gpu_index = parse_cuda_device_index(self.device)
        if gpu_index is not None and torch.cuda.is_available():
            with contextlib.suppress(Exception):
                torch.cuda.set_device(gpu_index)

        with contextlib.redirect_stdout(sys.stderr):
            model = YOLO(str(self.weights))
            if self.device != "cpu":
                try:
                    model.to(self.device)
                except Exception as exc:
                    print(f"[workzone-live] could not move model to {self.device}: {exc}", file=sys.stderr, flush=True)
        return model

    def _resolve_accelerator(self) -> dict[str, Any]:
        requested_index = parse_cuda_device_index(self.device)
        if (
            requested_index is not None
            and torch.cuda.is_available()
            and 0 <= requested_index < torch.cuda.device_count()
        ):
            accelerator: dict[str, Any] = {
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
            "resolved_device": self.device or "cpu",
        }

    def _record_feature_error(self, name: str, exc: Exception | str) -> None:
        self.feature_errors[name] = str(exc)
        print(f"[workzone-live] {name} unavailable: {exc}", file=sys.stderr, flush=True)

    def _load_scene_predictor(self) -> None:
        if not self.config.scene_context_enable:
            return
        scene_weights = resolve_path("weights/scene_context_classifier.pt", base_dir=self.workzone_project_dir)
        if scene_weights is None or not scene_weights.exists():
            self._record_feature_error("scene_context", "weights/scene_context_classifier.pt not found")
            return
        try:
            from workzone.detection.scene_context import SceneContextPredictor

            scene_device: str | int = self.device
            scene_index = parse_cuda_device_index(self.device)
            if scene_index is not None and self.device.startswith("cuda"):
                scene_device = scene_index
            with contextlib.redirect_stdout(sys.stderr):
                self.scene_predictor = SceneContextPredictor(str(scene_weights), scene_device)
        except Exception as exc:
            self._record_feature_error("scene_context", exc)
            self.scene_predictor = None

    def _load_clip_bundle(self) -> None:
        if not (self.config.use_clip or self.config.enable_per_cue):
            return
        try:
            import open_clip
            from PIL import Image

            cache_dir = Path.home() / ".cache" / "open_clip"
            cache_dir.mkdir(parents=True, exist_ok=True)
            model, _, preprocess = open_clip.create_model_and_transforms(
                "ViT-B-32",
                pretrained="openai",
                cache_dir=str(cache_dir),
            )
            model = model.to(self.device)
            model.eval()
            self.clip_bundle = {
                "open_clip": open_clip,
                "PIL_Image": Image,
                "model": model,
                "preprocess": preprocess,
                "tokenizer": open_clip.get_tokenizer("ViT-B-32"),
            }

            tokenizer = self.clip_bundle["tokenizer"]
            tokens = tokenizer([self.config.clip_pos_text, self.config.clip_neg_text]).to(self.device)
            with torch.no_grad():
                text_embeddings = model.encode_text(tokens)
                text_embeddings = text_embeddings / (text_embeddings.norm(dim=-1, keepdim=True) + 1e-8)
            self.pos_emb = text_embeddings[0]
            self.neg_emb = text_embeddings[1]

            if self.config.enable_per_cue:
                self.per_cue_verifier = PerCueVerifier(self.clip_bundle, self.device)
        except Exception as exc:
            self._record_feature_error("clip", exc)
            self.clip_bundle = None
            self.pos_emb = None
            self.neg_emb = None
            self.per_cue_verifier = None

    def _load_ocr_bundle(self) -> None:
        if not self.config.enable_ocr:
            return
        try:
            from workzone.ocr.text_classifier import TextClassifier
            from workzone.ocr.text_detector import SignTextDetector

            extract_full_frame = None
            aggregator_cls = None
            corrector = None
            with contextlib.suppress(Exception):
                from workzone.ocr.full_frame_ocr import extract_best_text_fullframe as loaded_extract_best_text_fullframe

                extract_full_frame = loaded_extract_best_text_fullframe
            with contextlib.suppress(Exception):
                from workzone.ocr.advanced_ocr import TemporalOCRAggregator, WorkzoneSpellCorrector

                aggregator_cls = TemporalOCRAggregator
                corrector = WorkzoneSpellCorrector()

            with contextlib.redirect_stdout(sys.stderr):
                detector = SignTextDetector(
                    use_gpu=self.device.startswith("cuda") and torch.cuda.is_available(),
                    prefer_easyocr=True,
                )
                classifier = TextClassifier()
            self.ocr_bundle = {
                "detector": detector,
                "classifier": classifier,
                "corrector": corrector,
                "aggregator_cls": aggregator_cls,
                "extract_full_frame": extract_full_frame,
            }
        except Exception as exc:
            self._record_feature_error("ocr", exc)
            self.ocr_bundle = None

    def _load_optional_features(self) -> None:
        self._load_scene_predictor()
        self._load_clip_bundle()
        self._load_ocr_bundle()

    def _query_gpu_telemetry_nvml(self, gpu_index: int) -> dict[str, Any]:
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

    def _query_gpu_telemetry_nvidia_smi(self, gpu_index: int) -> dict[str, Any]:
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
            telemetry: dict[str, Any] = {}
            with contextlib.suppress(Exception):
                telemetry["gpu_utilization_pct"] = int(round(float(parts[1])))
            with contextlib.suppress(Exception):
                telemetry["gpu_memory_used_mb"] = int(round(float(parts[2])))
            with contextlib.suppress(Exception):
                telemetry["gpu_memory_total_mb"] = int(round(float(parts[3])))
            return telemetry
        return {}

    def _query_gpu_telemetry_torch(self, gpu_index: int) -> dict[str, Any]:
        if not torch.cuda.is_available():
            return {}
        telemetry: dict[str, Any] = {}
        with contextlib.suppress(Exception):
            free_bytes, total_bytes = torch.cuda.mem_get_info(int(gpu_index))
            total_mb = safe_round_mib(total_bytes)
            free_mb = safe_round_mib(free_bytes)
            if total_mb is not None:
                telemetry["gpu_memory_total_mb"] = total_mb
            if free_mb is not None and total_mb is not None:
                telemetry["gpu_memory_used_mb"] = max(0, total_mb - free_mb)
        return telemetry

    def collect_runtime_telemetry(self, *, force: bool = False) -> dict[str, Any]:
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

    def _new_device_state(self) -> DeviceFusionState:
        aggregator = None
        if self.ocr_bundle and self.ocr_bundle.get("aggregator_cls") is not None:
            with contextlib.suppress(Exception):
                aggregator = self.ocr_bundle["aggregator_cls"](window_size=30)
        return DeviceFusionState(ocr_aggregator=aggregator)

    def _resolve_scene_weights(
        self,
        device_state: DeviceFusionState,
        frame_bgr: np.ndarray,
        frame_index: int,
        is_night: bool,
    ) -> tuple[dict[str, float], dict[str, float | int], str, float]:
        active_weights = dict(self.config.weights_yolo)
        thresholds: dict[str, float | int] = {
            "enter_th": self.config.enter_th,
            "exit_th": self.config.exit_th,
            "approach_th": self.config.approach_th,
            "min_inside_frames": self.config.min_inside_frames,
            "min_out_frames": self.config.min_out_frames,
        }
        scene_label = "manual"
        scene_confidence = 0.0

        if self.scene_predictor is not None and (frame_index % self.config.scene_interval == 0):
            try:
                raw_scene, scene_confidence = self.scene_predictor.predict(frame_bgr)
                raw_scene = str(raw_scene or "suburban").strip().lower() or "suburban"
                device_state.scene_buffer.append((raw_scene, float(scene_confidence)))
                if len(device_state.scene_buffer) >= SCENE_WARMUP_SAMPLES:
                    weighted_scores: dict[str, float] = {}
                    for scene_name, confidence in device_state.scene_buffer:
                        weighted_scores[scene_name] = weighted_scores.get(scene_name, 0.0) + float(confidence)
                    scene_label = max(weighted_scores, key=weighted_scores.get)
                else:
                    scene_label = "suburban"
                device_state.current_scene = scene_label
                device_state.scene_confidence = float(scene_confidence)
            except Exception as exc:
                self._record_feature_error("scene_context_predict", exc)
                self.scene_predictor = None
                device_state.current_scene = "manual"

        if self.scene_predictor is not None:
            scene_label = device_state.current_scene or "suburban"
            scene_confidence = float(device_state.scene_confidence or 0.0)
            preset = self.config.scene_presets.get(
                scene_label,
                self.config.scene_presets.get("suburban", DEFAULT_SCENE_PRESETS["suburban"]),
            )
            active_weights = dict(active_weights)
            for key, value in preset.items():
                if key in {"enter_th", "exit_th", "approach_th", "min_inside_frames", "min_out_frames"}:
                    thresholds[key] = value
                else:
                    active_weights[key] = float(value)
        else:
            device_state.current_scene = "manual"
            device_state.scene_confidence = 0.0

        if is_night:
            active_weights["bias"] = active_weights.get("bias", 0.0) + 0.15
            active_weights["ttc_signs"] = 1.2
            active_weights["channelization"] = active_weights.get("channelization", 0.9) * 0.9

        return active_weights, thresholds, device_state.current_scene, float(device_state.scene_confidence or 0.0)

    def _extract_crop_ocr(
        self,
        frame_bgr: np.ndarray,
        detections: list[dict[str, Any]],
        device_state: DeviceFusionState,
        frame_index: int,
    ) -> tuple[str, float, str, list[dict[str, Any]]]:
        if not self.ocr_bundle:
            return "", 0.0, "NONE", []
        detector = self.ocr_bundle["detector"]
        classifier = self.ocr_bundle["classifier"]
        corrector = self.ocr_bundle.get("corrector")
        results: list[dict[str, Any]] = []
        for detection in detections:
            category = detection.get("semantic_category")
            if category not in {"ttc_signs", "message_board"}:
                continue
            x1, y1, x2, y2 = detection.get("bbox", (0, 0, 0, 0))
            pad = 20
            crop = frame_bgr[
                max(0, y1 - pad): min(frame_bgr.shape[0], y2 + pad),
                max(0, x1 - pad): min(frame_bgr.shape[1], x2 + pad),
            ]
            if crop.size == 0:
                continue
            text, confidence = detector.extract_text(crop)
            if not text or float(confidence) < self.config.ocr_threshold:
                continue
            corrected_text = text
            correction_factor = 1.0
            if corrector is not None:
                with contextlib.suppress(Exception):
                    corrected_text, correction_factor = corrector.correct_text(text)
            text_category, class_conf = classifier.classify(corrected_text)
            final_confidence = float(confidence) * float(class_conf) * float(correction_factor)
            results.append(
                {
                    "text": corrected_text,
                    "confidence": final_confidence,
                    "category": text_category,
                    "raw_text": text,
                }
            )
        if not results:
            return "", 0.0, "NONE", []
        results.sort(key=lambda item: float(item["confidence"]), reverse=True)
        best = results[0]
        device_state.last_ocr = {
            "text": best["text"],
            "confidence": float(best["confidence"]),
            "category": best["category"],
            "frame_index": frame_index,
        }
        return str(best["text"]), float(best["confidence"]), str(best["category"]), results

    def _extract_ocr(
        self,
        frame_bgr: np.ndarray,
        detections: list[dict[str, Any]],
        device_state: DeviceFusionState,
        frame_index: int,
    ) -> tuple[str, float, str, list[dict[str, Any]], bool]:
        if not self.ocr_bundle:
            return "", 0.0, "NONE", [], False
        if frame_index % self.config.ocr_every_n != 0:
            last = device_state.last_ocr
            return (
                str(last.get("text") or ""),
                float(last.get("confidence") or 0.0),
                str(last.get("category") or "NONE"),
                [],
                False,
            )

        if self.config.ocr_full_frame and self.ocr_bundle.get("extract_full_frame") is not None:
            try:
                best_text, confidence, category, all_results = self.ocr_bundle["extract_full_frame"](
                    frame_bgr,
                    self.ocr_bundle["detector"],
                    self.ocr_bundle["classifier"],
                    corrector=self.ocr_bundle.get("corrector"),
                    aggregator=device_state.ocr_aggregator,
                    frame_idx=frame_index,
                    threshold=self.config.ocr_threshold,
                )
                device_state.last_ocr = {
                    "text": best_text,
                    "confidence": float(confidence),
                    "category": category,
                    "frame_index": frame_index,
                }
                return str(best_text), float(confidence), str(category), list(all_results or []), True
            except Exception as exc:
                self._record_feature_error("ocr_full_frame", exc)

        return (*self._extract_crop_ocr(frame_bgr, detections, device_state, frame_index), True)

    def _build_top_detections(
        self,
        detections: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        top = sorted(detections, key=lambda item: float(item.get("confidence", 0.0)), reverse=True)[:5]
        out: list[dict[str, Any]] = []
        for item in top:
            entry = {
                "label": normalize_label(item.get("label")),
                "confidence": round(float(item.get("confidence", 0.0)), 4),
            }
            if item.get("verified") is not None:
                entry["verified"] = bool(item.get("verified"))
            if item.get("semantic_category"):
                entry["semantic_category"] = str(item["semantic_category"])
            if item.get("cue_score") is not None:
                entry["cue_score"] = round(float(item.get("cue_score", 0.0)), 4)
            out.append(entry)
        return out

    def _apply_per_cue(
        self,
        frame_bgr: np.ndarray,
        detections: list[dict[str, Any]],
        frame_index: int,
    ) -> dict[str, int]:
        raw_group_counts = Counter()
        for detection in detections:
            if detection.get("semantic_category"):
                raw_group_counts[str(detection["semantic_category"])] += 1

        if (
            self.per_cue_verifier is None
            or not detections
            or frame_index % self.config.per_cue_interval != 0
        ):
            for detection in detections:
                detection["verified"] = True
            return dict(raw_group_counts)

        candidates = [item for item in detections if item.get("semantic_category")]
        if not candidates:
            return dict(raw_group_counts)

        candidates.sort(key=lambda item: float(item.get("confidence", 0.0)), reverse=True)
        to_verify = candidates[:MAX_PER_CUE_BATCH]
        remaining = candidates[MAX_PER_CUE_BATCH:]

        crops: list[np.ndarray] = []
        categories: list[str] = []
        for candidate in to_verify:
            x1, y1, x2, y2 = candidate["bbox"]
            pad = 10
            crop = frame_bgr[max(0, y1 - pad): min(frame_bgr.shape[0], y2 + pad), max(0, x1 - pad): min(frame_bgr.shape[1], x2 + pad)]
            crops.append(crop)
            categories.append(str(candidate["semantic_category"]))

        semantic_counts = Counter()
        try:
            scores = self.per_cue_verifier.verify_batch(crops, categories)
        except Exception as exc:
            self._record_feature_error("per_cue", exc)
            self.per_cue_verifier = None
            for detection in detections:
                detection["verified"] = True
            return dict(raw_group_counts)

        for candidate, score in zip(to_verify, scores):
            candidate["cue_score"] = float(score)
            accepted = float(score) > self.config.per_cue_th
            candidate["verified"] = accepted
            if accepted and candidate.get("semantic_category"):
                semantic_counts[str(candidate["semantic_category"])] += 1

        for candidate in remaining:
            candidate["verified"] = True
            if candidate.get("semantic_category"):
                semantic_counts[str(candidate["semantic_category"])] += 1

        return dict(semantic_counts)

    def analyze_frame(self, frame_bgr: np.ndarray, *, device_id: str, frame_index: int) -> dict[str, Any]:
        started = time.perf_counter()
        device_state = self.device_states.setdefault(device_id, self._new_device_state())
        if frame_index <= 0:
            frame_index = device_state.last_frame_index + 1
        device_state.last_frame_index = frame_index

        frame_ai, is_night = enhance_night_frame(frame_bgr)
        with contextlib.redirect_stdout(sys.stderr):
            results = self.model.predict(
                frame_ai,
                conf=self.conf,
                iou=self.iou,
                imgsz=self.imgsz,
                verbose=False,
                device=self.device,
                half=self.device != "cpu",
            )
        result = results[0]

        detections: list[dict[str, Any]] = []
        class_names: list[str] = []
        max_confidence = 0.0
        if result.boxes is not None and len(result.boxes) > 0:
            boxes = result.boxes.xyxy.int().cpu().tolist()
            class_ids = result.boxes.cls.int().cpu().tolist()
            confidences = [float(value) for value in result.boxes.conf.cpu().tolist()]
            for index, (box, class_id, confidence) in enumerate(zip(boxes, class_ids, confidences)):
                label = normalize_label(self.model.names[int(class_id)])
                class_names.append(label)
                max_confidence = max(max_confidence, confidence)
                semantic_category = get_cue_category(label)
                detections.append(
                    {
                        "index": index,
                        "label": label,
                        "confidence": float(confidence),
                        "bbox": tuple(int(v) for v in box),
                        "semantic_category": semantic_category,
                        "cue_score": None,
                        "verified": None,
                    }
                )

        raw_class_counts = self.class_counts(class_names)
        raw_group_counts = group_counts_from_names(class_names)
        semantic_counts = self._apply_per_cue(frame_ai, detections, frame_index)
        if not semantic_counts:
            semantic_counts = raw_group_counts

        active_weights, thresholds, scene_label, scene_confidence = self._resolve_scene_weights(
            device_state,
            frame_bgr,
            frame_index,
            is_night,
        )
        raw_yolo_score, yolo_features = yolo_frame_score(semantic_counts, active_weights)
        evidence = clamp01(
            (0.5 * clamp01(float(yolo_features.get("total_objs", 0)) / 8.0))
            + (0.5 * clamp01(raw_yolo_score))
        )
        alpha = adaptive_alpha(evidence, self.config.ema_alpha * 0.4, self.config.ema_alpha * 1.2)
        device_state.yolo_ema = ema(device_state.yolo_ema, raw_yolo_score, alpha)

        fused = raw_yolo_score
        clip_score = device_state.last_clip_score
        clip_applied = False
        if (
            self.clip_bundle is not None
            and self.pos_emb is not None
            and self.neg_emb is not None
            and device_state.yolo_ema is not None
            and device_state.yolo_ema >= self.config.clip_trigger_th
        ):
            if frame_index % self.config.clip_interval == 0 or clip_score <= 0.0:
                try:
                    rgb = cv2.cvtColor(frame_ai, cv2.COLOR_BGR2RGB)
                    image_tensor = self.clip_bundle["preprocess"](self.clip_bundle["PIL_Image"].fromarray(rgb)).unsqueeze(0).to(self.device)
                    with torch.no_grad():
                        image_embedding = self.clip_bundle["model"].encode_image(image_tensor)
                        image_embedding = image_embedding / (image_embedding.norm(dim=-1, keepdim=True) + 1e-8)
                        sim_pos = float(torch.matmul(image_embedding, self.pos_emb.unsqueeze(1)).squeeze())
                        sim_neg = float(torch.matmul(image_embedding, self.neg_emb.unsqueeze(1)).squeeze())
                    clip_score = logistic((sim_pos - sim_neg) * 3.0)
                    device_state.last_clip_score = clip_score
                except Exception as exc:
                    self._record_feature_error("clip_score", exc)
            fused = ((1.0 - self.config.clip_weight) * fused) + (self.config.clip_weight * clip_score)
            clip_applied = True

        ocr_text, ocr_confidence, ocr_category, ocr_detections, ocr_ran = self._extract_ocr(
            frame_bgr,
            detections,
            device_state,
            frame_index,
        )
        ocr_boost_applied = 0.0
        if ocr_ran and ocr_text.strip() and ocr_confidence >= self.config.ocr_threshold:
            ocr_weight = OCR_BOOST_WEIGHTS.get(ocr_category, 0.0)
            if ocr_weight > 0:
                ocr_boost_applied = min(float(ocr_confidence) * ocr_weight, ocr_weight)
                fused = min(1.0, fused + ocr_boost_applied)

        orange_ratio = 0.0
        orange_context_score = 0.0
        context_boost_applied = False
        if self.config.enable_context_boost and device_state.yolo_ema is not None and device_state.yolo_ema < self.config.context_trigger_below:
            orange_ratio = orange_ratio_hsv(frame_bgr, self.config.orange_params)
            orange_context_score = context_boost_from_orange(orange_ratio, self.config.orange_params)
            fused = ((1.0 - self.config.orange_weight) * fused) + (self.config.orange_weight * orange_context_score)
            context_boost_applied = True

        fused = clamp01(fused)
        device_state.fused_ema = ema(device_state.fused_ema, fused, alpha)
        device_state.machine_state, device_state.state_duration_frames, device_state.out_frames = update_state(
            device_state.machine_state,
            float(device_state.fused_ema or 0.0),
            device_state.state_duration_frames,
            device_state.out_frames,
            thresholds,
        )

        fused_score = float(device_state.fused_ema or 0.0)
        detection_count = len(class_names)
        semantic_evidence_count = int(sum(int(v) for v in semantic_counts.values()))
        evidence_count = max(
            semantic_evidence_count,
            1 if ocr_boost_applied > 0 else 0,
            1 if (clip_applied and fused_score >= self.score_threshold) else 0,
            1 if (device_state.machine_state != "OUT" and fused_score >= self.score_threshold) else 0,
        )
        found = fused_score >= self.score_threshold and device_state.machine_state != "OUT"
        total_ms = (time.perf_counter() - started) * 1000.0

        return {
            "found": found,
            "score": round(fused_score, 4),
            "score_threshold": self.score_threshold,
            "max_confidence": round(max_confidence, 4),
            "detection_count": detection_count,
            "evidence_count": evidence_count,
            "class_counts": raw_class_counts,
            "semantic_class_counts": semantic_counts,
            "top_detections": self._build_top_detections(detections),
            "legacy_score": round(float(self.compute_workzone_score(class_names)), 4),
            "raw_yolo_score": round(raw_yolo_score, 4),
            "yolo_ema": round(float(device_state.yolo_ema or 0.0), 4),
            "clip_score": round(float(clip_score), 4),
            "clip_applied": clip_applied,
            "clip_triggered": bool(clip_applied),
            "ocr_text": ocr_text,
            "ocr_confidence": round(float(ocr_confidence), 4),
            "ocr_category": ocr_category,
            "ocr_boost": round(float(ocr_boost_applied), 4),
            "ocr_ran": bool(ocr_ran),
            "ocr_detections": ocr_detections[:5],
            "orange_ratio": round(float(orange_ratio), 4),
            "context_score": round(float(orange_context_score), 4),
            "context_boost_applied": context_boost_applied,
            "scene": scene_label,
            "scene_confidence": round(float(scene_confidence), 4),
            "state": device_state.machine_state,
            "state_duration_frames": int(device_state.state_duration_frames),
            "out_frames": int(device_state.out_frames),
            "is_night": bool(is_night),
            "advanced_mode": True,
            "feature_flags": self.feature_flags,
            "feature_errors": self.feature_errors,
            "active_weights": active_weights,
            "thresholds": thresholds,
            "config_path": str(self.config.config_path) if self.config.config_path else "",
            "inference_ms": round(total_ms, 2),
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Advanced low-latency WorkZone inference worker")
    parser.add_argument("--workzone-project-dir", type=Path, required=True)
    parser.add_argument("--config-path", type=Path, default=None)
    parser.add_argument("--weights", default="")
    parser.add_argument("--device", default="")
    parser.add_argument("--imgsz", type=int, default=None)
    parser.add_argument("--conf", type=float, default=None)
    parser.add_argument("--iou", type=float, default=None)
    parser.add_argument("--score-threshold", type=float, default=None)
    parser.add_argument("--ema-alpha", type=float, default=None)
    parser.add_argument("--enter-th", type=float, default=None)
    parser.add_argument("--exit-th", type=float, default=None)
    parser.add_argument("--approach-th", type=float, default=None)
    parser.add_argument("--min-inside-frames", type=int, default=None)
    parser.add_argument("--min-out-frames", type=int, default=None)
    parser.add_argument("--use-clip", default="auto")
    parser.add_argument("--enable-per-cue", default="auto")
    parser.add_argument("--enable-context-boost", default="auto")
    parser.add_argument("--scene-context-enable", default="auto")
    parser.add_argument("--enable-ocr", default="auto")
    parser.add_argument("--ocr-full-frame", default="auto")
    parser.add_argument("--clip-weight", type=float, default=None)
    parser.add_argument("--clip-trigger-th", type=float, default=None)
    parser.add_argument("--per-cue-th", type=float, default=None)
    parser.add_argument("--context-trigger-below", type=float, default=None)
    parser.add_argument("--orange-weight", type=float, default=None)
    parser.add_argument("--ocr-every-n", type=int, default=None)
    parser.add_argument("--ocr-threshold", type=float, default=None)
    parser.add_argument("--scene-interval", type=int, default=None)
    parser.add_argument("--clip-interval", type=int, default=None)
    parser.add_argument("--per-cue-interval", type=int, default=None)
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
    config = build_effective_config(args)
    detector = LiveDetector(config)

    emit(
        {
            "type": "ready",
            "device": detector.device,
            "imgsz": detector.imgsz,
            "weights": str(detector.weights),
            "config_path": str(config.config_path) if config.config_path else "",
            "advanced_mode": detector.advanced_mode,
            "feature_flags": detector.feature_flags,
            "feature_errors": detector.feature_errors,
            "score_threshold": detector.score_threshold,
            "updated_at": utc_now_iso(),
            **detector.collect_runtime_telemetry(force=True),
        }
    )

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
            emit(
                {
                    "type": "pong",
                    "updated_at": utc_now_iso(),
                    "advanced_mode": detector.advanced_mode,
                    "feature_flags": detector.feature_flags,
                    **detector.collect_runtime_telemetry(force=True),
                }
            )
            continue
        if msg_type != "frame":
            emit({"type": "error", "stage": "message_type", "error": f"unsupported type: {msg_type}"})
            continue

        device_id = str(message.get("device_id") or "")
        frame_index = int(message.get("frame_index") or message.get("seq") or 0)
        frame = decode_frame(str(message.get("jpeg_base64") or ""))
        if frame is None:
            emit(
                {
                    "type": "result",
                    "device_id": device_id,
                    "seq": int(message.get("seq") or 0),
                    "frame_index": frame_index,
                    "session_dir": str(message.get("session_dir") or ""),
                    "t_recv_ms": int(message.get("t_recv_ms") or 0),
                    "t_device_ms": int(message.get("t_device_ms") or 0),
                    "queued_at_ms": int(message.get("queued_at_ms") or 0),
                    "dispatch_started_at_ms": int(message.get("dispatch_started_at_ms") or 0),
                    "found": False,
                    "score": 0.0,
                    "score_threshold": detector.score_threshold,
                    "max_confidence": 0.0,
                    "detection_count": 0,
                    "evidence_count": 0,
                    "class_counts": {},
                    "semantic_class_counts": {},
                    "top_detections": [],
                    "state": "OUT",
                    "advanced_mode": detector.advanced_mode,
                    "feature_flags": detector.feature_flags,
                    "inference_ms": 0.0,
                    "status": "decode_failed",
                    "updated_at": utc_now_iso(),
                    **detector.collect_runtime_telemetry(),
                }
            )
            continue

        try:
            result = detector.analyze_frame(frame, device_id=device_id, frame_index=frame_index)
        except Exception as exc:
            emit(
                {
                    "type": "result",
                    "device_id": device_id,
                    "seq": int(message.get("seq") or 0),
                    "frame_index": frame_index,
                    "session_dir": str(message.get("session_dir") or ""),
                    "t_recv_ms": int(message.get("t_recv_ms") or 0),
                    "t_device_ms": int(message.get("t_device_ms") or 0),
                    "queued_at_ms": int(message.get("queued_at_ms") or 0),
                    "dispatch_started_at_ms": int(message.get("dispatch_started_at_ms") or 0),
                    "found": False,
                    "score": 0.0,
                    "score_threshold": detector.score_threshold,
                    "max_confidence": 0.0,
                    "detection_count": 0,
                    "evidence_count": 0,
                    "class_counts": {},
                    "semantic_class_counts": {},
                    "top_detections": [],
                    "state": "OUT",
                    "advanced_mode": detector.advanced_mode,
                    "feature_flags": detector.feature_flags,
                    "feature_errors": detector.feature_errors,
                    "inference_ms": 0.0,
                    "status": "predict_failed",
                    "error": str(exc),
                    "updated_at": utc_now_iso(),
                    **detector.collect_runtime_telemetry(force=True),
                }
            )
            continue

        emit(
            {
                "type": "result",
                "device_id": device_id,
                "seq": int(message.get("seq") or 0),
                "frame_index": frame_index,
                "session_dir": str(message.get("session_dir") or ""),
                "t_recv_ms": int(message.get("t_recv_ms") or 0),
                "t_device_ms": int(message.get("t_device_ms") or 0),
                "queued_at_ms": int(message.get("queued_at_ms") or 0),
                "dispatch_started_at_ms": int(message.get("dispatch_started_at_ms") or 0),
                "status": "ok",
                "updated_at": utc_now_iso(),
                **result,
                **detector.collect_runtime_telemetry(),
            }
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
