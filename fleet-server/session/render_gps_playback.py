#!/usr/bin/env python3
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path


PALETTE = [
    (90, 190, 255),
    (255, 136, 77),
    (105, 220, 158),
    (255, 210, 92),
    (201, 124, 255),
    (255, 97, 146),
]

BG = (8, 14, 22)
MAP_BG_TOP = (8, 14, 22)
MAP_BG_BOTTOM = (13, 24, 36)
GRID = (21, 34, 49)
GRID_MAJOR = (34, 56, 80)
BORDER = (39, 58, 79)
TEXTLESS_BAR_BG = (28, 42, 58)
START_MARK = (240, 244, 248)
END_MARK = (150, 163, 184)
LEGEND_BG = (10, 18, 28)
LEGEND_BORDER = (66, 86, 110)
LEGEND_TEXT = (238, 242, 247)
HUD_BG = (10, 19, 29)
HUD_BORDER = (58, 79, 104)
HUD_MUTED = (144, 161, 181)
TRACK_GLOW = (225, 241, 255)

FONT_5X7 = {
    " ": ("00000", "00000", "00000", "00000", "00000", "00000", "00000"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "01100", "01100"),
    "/": ("00001", "00010", "00100", "01000", "10000", "00000", "00000"),
    ":": ("00000", "01100", "01100", "00000", "01100", "01100", "00000"),
    "?": ("01110", "10001", "00001", "00010", "00100", "00000", "00100"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "10000", "11110", "00001", "00001", "11110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "11100"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "D": ("11100", "10010", "10001", "10001", "10001", "10010", "11100"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01110", "10001", "10000", "10111", "10001", "10001", "01110"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "J": ("00001", "00001", "00001", "00001", "10001", "10001", "01110"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "10101", "01010"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
}


def parse_args():
    parser = argparse.ArgumentParser(description="Render GPS playback JSON to MP4.")
    parser.add_argument("--input-json", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg-bin", default="ffmpeg")
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=540)
    parser.add_argument("--fps", type=float, default=4.0)
    parser.add_argument("--crf", type=int, default=23)
    return parser.parse_args()


def to_float(value, default=None):
    try:
        out = float(value)
    except Exception:
        return default
    return out if math.isfinite(out) else default


def dim(color, factor):
    return tuple(max(0, min(255, int(channel * factor))) for channel in color)


def mix_color(a, b, factor):
    t = max(0.0, min(1.0, float(factor)))
    return tuple(
        max(0, min(255, int(round(a[idx] + (b[idx] - a[idx]) * t))))
        for idx in range(3)
    )


def clamp_int(value, lo, hi):
    return max(lo, min(hi, int(value)))


def set_pixel(frame, width, height, x, y, color):
    if x < 0 or y < 0 or x >= width or y >= height:
        return
    idx = (y * width + x) * 3
    frame[idx] = color[0]
    frame[idx + 1] = color[1]
    frame[idx + 2] = color[2]


def fill_rect(frame, width, height, x0, y0, x1, y1, color):
    left = clamp_int(min(x0, x1), 0, width)
    right = clamp_int(max(x0, x1), 0, width)
    top = clamp_int(min(y0, y1), 0, height)
    bottom = clamp_int(max(y0, y1), 0, height)
    if left >= right or top >= bottom:
        return
    row = bytes(color) * (right - left)
    for y in range(top, bottom):
        idx = (y * width + left) * 3
        frame[idx: idx + len(row)] = row


def fill_vertical_gradient(frame, width, height, x0, y0, x1, y1, top_color, bottom_color):
    left = clamp_int(min(x0, x1), 0, width)
    right = clamp_int(max(x0, x1), 0, width)
    top = clamp_int(min(y0, y1), 0, height)
    bottom = clamp_int(max(y0, y1), 0, height)
    if left >= right or top >= bottom:
        return
    span = max(1, bottom - top - 1)
    for y in range(top, bottom):
        color = mix_color(top_color, bottom_color, (y - top) / span)
        idx = (y * width + left) * 3
        frame[idx: idx + (right - left) * 3] = bytes(color) * (right - left)


def draw_circle(frame, width, height, cx, cy, radius, color):
    if radius <= 0:
        return
    left = clamp_int(cx - radius, 0, width - 1)
    right = clamp_int(cx + radius, 0, width - 1)
    top = clamp_int(cy - radius, 0, height - 1)
    bottom = clamp_int(cy + radius, 0, height - 1)
    r2 = radius * radius
    for y in range(top, bottom + 1):
        dy = y - cy
        for x in range(left, right + 1):
            dx = x - cx
            if dx * dx + dy * dy <= r2:
                set_pixel(frame, width, height, x, y, color)


def draw_ring(frame, width, height, cx, cy, outer_radius, inner_radius, color):
    if outer_radius <= 0 or inner_radius >= outer_radius:
        return
    left = clamp_int(cx - outer_radius, 0, width - 1)
    right = clamp_int(cx + outer_radius, 0, width - 1)
    top = clamp_int(cy - outer_radius, 0, height - 1)
    bottom = clamp_int(cy + outer_radius, 0, height - 1)
    outer2 = outer_radius * outer_radius
    inner2 = inner_radius * inner_radius
    for y in range(top, bottom + 1):
        dy = y - cy
        for x in range(left, right + 1):
            dx = x - cx
            dist2 = dx * dx + dy * dy
            if inner2 < dist2 <= outer2:
                set_pixel(frame, width, height, x, y, color)


def draw_line(frame, width, height, x0, y0, x1, y1, color, thickness=1):
    dx = x1 - x0
    dy = y1 - y0
    steps = max(abs(dx), abs(dy), 1)
    radius = max(0, int(thickness // 2))
    for step in range(steps + 1):
        t = step / steps
        x = int(round(x0 + dx * t))
        y = int(round(y0 + dy * t))
        if radius <= 0:
            set_pixel(frame, width, height, x, y, color)
        else:
            draw_circle(frame, width, height, x, y, radius, color)


def draw_progress_bar(frame, width, height, progress, label=None):
    bar_margin_x = 28
    bar_height = 10
    bar_bottom = height - 16
    bar_top = bar_bottom - bar_height
    if label:
        draw_text(frame, width, height, bar_margin_x, bar_top - 18, label, LEGEND_TEXT, scale=2)
    fill_rect(frame, width, height, bar_margin_x, bar_top, width - bar_margin_x, bar_bottom, TEXTLESS_BAR_BG)
    fill_rect(frame, width, height, bar_margin_x, bar_top, width - bar_margin_x, bar_top + 1, BORDER)
    fill_rect(frame, width, height, bar_margin_x, bar_bottom - 1, width - bar_margin_x, bar_bottom, BORDER)
    fill_rect(frame, width, height, bar_margin_x, bar_top, bar_margin_x + 1, bar_bottom, BORDER)
    fill_rect(frame, width, height, width - bar_margin_x - 1, bar_top, width - bar_margin_x, bar_bottom, BORDER)
    inner_left = bar_margin_x + 2
    inner_top = bar_top + 2
    inner_right = width - bar_margin_x - 2
    inner_bottom = bar_bottom - 2
    if inner_right <= inner_left:
        return
    filled = inner_left + int(round((inner_right - inner_left) * max(0.0, min(1.0, progress))))
    if filled > inner_left:
        fill_rect(frame, width, height, inner_left, inner_top, filled, inner_bottom, (102, 206, 148))


def normalize_label(text):
    cleaned = str(text or "").upper()
    cleaned = "".join(ch if ch in FONT_5X7 else "?" for ch in cleaned)
    return cleaned


def truncate_label(text, max_chars=24):
    if len(text) <= max_chars:
        return text
    if max_chars <= 3:
        return text[:max_chars]
    return text[:max_chars - 3] + "..."


def glyph_width(text, scale=1):
    if not text:
        return 0
    return len(text) * (5 * scale) + max(0, len(text) - 1) * scale


def draw_text(frame, width, height, x, y, text, color, scale=1):
    cursor_x = x
    for char in text:
        glyph = FONT_5X7.get(char, FONT_5X7["?"])
        for row_index, row in enumerate(glyph):
            for col_index, bit in enumerate(row):
                if bit != "1":
                    continue
                fill_rect(
                    frame,
                    width,
                    height,
                    cursor_x + col_index * scale,
                    y + row_index * scale,
                    cursor_x + (col_index + 1) * scale,
                    y + (row_index + 1) * scale,
                    color,
                )
        cursor_x += 6 * scale


def draw_legend(frame, width, height, tracks):
    if not tracks:
        return
    scale = 2
    swatch = 14
    row_height = 7 * scale + 8
    padding = 10
    labels = [track["label"] for track in tracks]
    text_width = max(glyph_width(label, scale) for label in labels)
    panel_width = min(width - 24, padding * 2 + swatch + 8 + text_width)
    panel_height = padding * 2 + len(tracks) * row_height - 4
    x = 20
    y = 18
    fill_rect(frame, width, height, x, y, x + panel_width, y + panel_height, LEGEND_BG)
    fill_rect(frame, width, height, x, y, x + panel_width, y + 2, LEGEND_BORDER)
    fill_rect(frame, width, height, x, y + panel_height - 2, x + panel_width, y + panel_height, LEGEND_BORDER)
    fill_rect(frame, width, height, x, y, x + 2, y + panel_height, LEGEND_BORDER)
    fill_rect(frame, width, height, x + panel_width - 2, y, x + panel_width, y + panel_height, LEGEND_BORDER)
    for index, track in enumerate(tracks):
        row_y = y + padding + index * row_height
        fill_rect(frame, width, height, x + padding, row_y + 2, x + padding + swatch, row_y + 2 + swatch, track["color"])
        draw_ring(frame, width, height, x + padding + swatch // 2, row_y + 2 + swatch // 2, 8, 5, START_MARK)
        draw_text(frame, width, height, x + padding + swatch + 8, row_y, track["label"], LEGEND_TEXT, scale=scale)


def format_distance_label(distance_m):
    if distance_m >= 1000:
        if distance_m >= 10000:
            return normalize_label(f"{distance_m / 1000:.0f}KM")
        return normalize_label(f"{distance_m / 1000:.1f}KM")
    return normalize_label(f"{int(round(distance_m))}M")


def format_speed_label(speed_mps):
    if speed_mps is None or not math.isfinite(speed_mps) or speed_mps < 0:
        return normalize_label("--MPH")
    mph = speed_mps * 2.2369362921
    return normalize_label(f"{int(round(mph))}MPH")


def format_accuracy_label(accuracy_m):
    if accuracy_m is None or not math.isfinite(accuracy_m) or accuracy_m < 0:
        return normalize_label("ACC --")
    return normalize_label(f"ACC {int(round(accuracy_m))}M")


def format_elapsed_label(elapsed_ms, total_ms):
    def _format(ms):
        total_seconds = max(0, int(round(ms / 1000.0)))
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60
        if hours > 0:
            return f"{hours}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    return normalize_label(f"{_format(elapsed_ms)} / {_format(total_ms)}")


def project_point(projection, lat, lon):
    px = projection["left"] + projection["extra_x"] + ((lon * projection["lon_scale"]) - projection["min_x"]) * projection["scale"]
    py = projection["bottom"] - projection["extra_y"] - (lat - projection["min_y"]) * projection["scale"]
    return int(round(px)), int(round(py))


def draw_scale_bar(frame, width, height, projection):
    target_px = max(80, int(round((projection["right"] - projection["left"]) * 0.18)))
    target_m = target_px * projection["meters_per_px"]
    bar_m = 20.0
    while bar_m < target_m:
        for factor in (1.0, 2.0, 5.0):
            candidate = bar_m * factor
            if candidate >= target_m:
                bar_m = candidate
                break
        else:
            bar_m *= 10.0
            continue
        break
    bar_px = max(32, int(round(bar_m / projection["meters_per_px"])))
    x = projection["left"] + 18
    y = projection["bottom"] - 24
    segment = max(10, bar_px // 2)
    fill_rect(frame, width, height, x, y, x + segment, y + 8, LEGEND_TEXT)
    fill_rect(frame, width, height, x + segment, y, x + bar_px, y + 8, HUD_MUTED)
    fill_rect(frame, width, height, x, y, x + bar_px, y + 2, BORDER)
    fill_rect(frame, width, height, x, y + 6, x + bar_px, y + 8, BORDER)
    draw_text(frame, width, height, x, y - 16, format_distance_label(bar_m), LEGEND_TEXT, scale=2)


def draw_grid(frame, width, height, projection):
    left = projection["left"]
    top = projection["top"]
    right = projection["right"]
    bottom = projection["bottom"]
    fill_vertical_gradient(frame, width, height, left, top, right, bottom, MAP_BG_TOP, MAP_BG_BOTTOM)
    fill_rect(frame, width, height, left, top, right, top + 2, BORDER)
    fill_rect(frame, width, height, left, bottom - 2, right, bottom, BORDER)
    fill_rect(frame, width, height, left, top, left + 2, bottom, BORDER)
    fill_rect(frame, width, height, right - 2, top, right, bottom, BORDER)
    draw_scale_bar(frame, width, height, projection)


def build_projection(tracks, width, height):
    all_points = [point for track in tracks for point in track["points"]]
    mean_lat = sum(point["lat"] for point in all_points) / max(1, len(all_points))
    lon_scale = max(0.2, math.cos(math.radians(mean_lat)))
    xs = [point["lon"] * lon_scale for point in all_points]
    ys = [point["lat"] for point in all_points]
    min_x = min(xs)
    max_x = max(xs)
    min_y = min(ys)
    max_y = max(ys)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)

    left = max(44, int(round(width * 0.06)))
    right = width - max(28, int(round(width * 0.035)))
    top = max(24, int(round(height * 0.05)))
    bottom = height - max(54, int(round(height * 0.11)))
    map_width = max(1, right - left)
    map_height = max(1, bottom - top)
    scale = min(map_width / span_x, map_height / span_y)
    if span_x < 1e-5 and span_y < 1e-5:
        scale = min(map_width, map_height) / 4.0
    extra_x = (map_width - span_x * scale) / 2.0
    extra_y = (map_height - span_y * scale) / 2.0

    return {
        "left": left,
        "right": right,
        "top": top,
        "bottom": bottom,
        "map_width": map_width,
        "map_height": map_height,
        "scale": scale,
        "extra_x": extra_x,
        "extra_y": extra_y,
        "lon_scale": lon_scale,
        "min_x": min_x,
        "min_y": min_y,
        "min_lat": min(ys),
        "max_lat": max(ys),
        "min_lon": min(point["lon"] for point in all_points),
        "max_lon": max(point["lon"] for point in all_points),
        "meters_per_px": 111320.0 / max(1e-6, scale),
    }


def prepare_tracks(payload, width, height):
    raw_tracks = []
    for index, device in enumerate(payload.get("devices", [])):
        points = []
        for point in device.get("points", []):
            t_ms = to_float(point.get("t_playback_ms"))
            lat = to_float(point.get("lat"))
            lon = to_float(point.get("lon"))
            if t_ms is None or lat is None or lon is None:
                continue
            points.append({
                "t_ms": t_ms,
                "lat": lat,
                "lon": lon,
                "heading_deg": to_float(point.get("heading_deg")),
                "speed_mps": None if to_float(point.get("speed_mps")) is None or to_float(point.get("speed_mps")) < 0 else to_float(point.get("speed_mps")),
                "accuracy_m": None if to_float(point.get("accuracy_m")) is None or to_float(point.get("accuracy_m")) < 0 else to_float(point.get("accuracy_m")),
            })
        if not points:
            continue
        points.sort(key=lambda item: item["t_ms"])
        device_id = str(device.get("device_id") or f"device-{index + 1}")
        device_name = str(device.get("device_name") or "").strip()
        base_label = f"{device_name} / {device_id[-4:]}" if device_name and device_name != device_id else device_id
        tag = normalize_label(device_id[-4:])
        raw_tracks.append({
            "device_id": device_id,
            "label": truncate_label(normalize_label(base_label)),
            "tag": tag,
            "color": PALETTE[index % len(PALETTE)],
            "points": points,
        })

    if not raw_tracks:
        return [], None, None, None

    projection = build_projection(raw_tracks, width, height)
    for track in raw_tracks:
        for point in track["points"]:
            point["x"], point["y"] = project_point(projection, point["lat"], point["lon"])

    starts = [track["points"][0]["t_ms"] for track in raw_tracks]
    ends = [track["points"][-1]["t_ms"] for track in raw_tracks]
    start_ms = min(starts)
    end_ms = max(ends)
    if end_ms <= start_ms:
        end_ms = start_ms + 1000.0
    return raw_tracks, projection, start_ms, end_ms


def draw_static_background(width, height, tracks, projection):
    frame = bytearray(bytes(BG) * (width * height))
    draw_grid(frame, width, height, projection)
    for track in tracks:
        halo_color = dim(track["color"], 0.18)
        route_color = dim(track["color"], 0.46)
        points = track["points"]
        for idx in range(1, len(points)):
            prev = points[idx - 1]
            curr = points[idx]
            draw_line(frame, width, height, prev["x"], prev["y"], curr["x"], curr["y"], halo_color, thickness=6)
            draw_line(frame, width, height, prev["x"], prev["y"], curr["x"], curr["y"], route_color, thickness=2)
        start = points[0]
        end = points[-1]
        draw_ring(frame, width, height, start["x"], start["y"], 6, 3, START_MARK)
        draw_ring(frame, width, height, end["x"], end["y"], 7, 4, END_MARK)
    return frame


def interpolate_position(track, idx, t_ms):
    points = track["points"]
    if idx >= len(points) - 1:
        point = points[-1]
        return point["x"], point["y"], point.get("heading_deg"), point.get("speed_mps"), point.get("accuracy_m"), idx, idx

    curr = points[idx]
    nxt = points[idx + 1]
    if nxt["t_ms"] <= curr["t_ms"]:
        return curr["x"], curr["y"], curr.get("heading_deg"), curr.get("speed_mps"), curr.get("accuracy_m"), idx, idx + 1

    ratio = max(0.0, min(1.0, (t_ms - curr["t_ms"]) / (nxt["t_ms"] - curr["t_ms"])))
    x = int(round(curr["x"] + (nxt["x"] - curr["x"]) * ratio))
    y = int(round(curr["y"] + (nxt["y"] - curr["y"]) * ratio))
    heading = curr.get("heading_deg")
    if heading is None and (nxt["x"] != curr["x"] or nxt["y"] != curr["y"]):
        heading = math.degrees(math.atan2(nxt["x"] - curr["x"], curr["y"] - nxt["y"]))
    speed = curr.get("speed_mps")
    next_speed = nxt.get("speed_mps")
    if speed is None:
        speed = next_speed
    elif next_speed is not None:
        speed = speed + (next_speed - speed) * ratio
    accuracy = curr.get("accuracy_m")
    next_accuracy = nxt.get("accuracy_m")
    if accuracy is None:
        accuracy = next_accuracy
    elif next_accuracy is not None:
        accuracy = accuracy + (next_accuracy - accuracy) * ratio
    return x, y, heading, speed, accuracy, idx, idx + 1


def draw_marker(frame, width, height, x, y, color, heading_deg, accuracy_px=None, tag=None):
    if accuracy_px is not None and accuracy_px >= 4:
        draw_ring(frame, width, height, x, y, int(round(accuracy_px)), max(0, int(round(accuracy_px - 2))), dim(color, 0.55))
    draw_circle(frame, width, height, x, y, 10, dim(color, 0.35))
    draw_circle(frame, width, height, x, y, 7, START_MARK)
    draw_circle(frame, width, height, x, y, 4, color)
    if heading_deg is None or not math.isfinite(heading_deg):
        return
    heading_rad = math.radians(heading_deg)
    tip_x = int(round(x + math.sin(heading_rad) * 12))
    tip_y = int(round(y - math.cos(heading_rad) * 12))
    left_x = int(round(x + math.sin(heading_rad - 2.5) * 7))
    left_y = int(round(y - math.cos(heading_rad - 2.5) * 7))
    right_x = int(round(x + math.sin(heading_rad + 2.5) * 7))
    right_y = int(round(y - math.cos(heading_rad + 2.5) * 7))
    draw_line(frame, width, height, x, y, tip_x, tip_y, START_MARK, thickness=2)
    draw_line(frame, width, height, tip_x, tip_y, left_x, left_y, START_MARK, thickness=1)
    draw_line(frame, width, height, tip_x, tip_y, right_x, right_y, START_MARK, thickness=1)


def draw_recent_trail(frame, width, height, track, idx, live_x, live_y):
    points = track["points"]
    start_idx = max(0, idx - 6)
    prev_x = live_x
    prev_y = live_y
    for seg_idx in range(idx, start_idx, -1):
        curr = points[seg_idx]
        prev = points[seg_idx - 1]
        factor = (seg_idx - start_idx) / max(1, idx - start_idx + 1)
        color = mix_color(dim(track["color"], 0.30), TRACK_GLOW, factor * 0.5)
        if seg_idx == idx:
            draw_line(frame, width, height, curr["x"], curr["y"], prev_x, prev_y, color, thickness=5)
        draw_line(frame, width, height, prev["x"], prev["y"], curr["x"], curr["y"], color, thickness=max(2, int(round(2 + factor * 2))))


def draw_status_panel(frame, width, height, tracks, live_states):
    if not live_states:
        return
    scale = 1
    padding = 8
    row_height = 7 * scale + 10
    labels = []
    for state in live_states:
        speed = format_speed_label(state.get("speed_mps"))
        accuracy = format_accuracy_label(state.get("accuracy_m"))
        labels.append(f"{state['track']['tag']} {speed} {accuracy}")
    panel_width = min(width - 24, max(glyph_width(normalize_label(text), scale) for text in labels) + padding * 2 + 18)
    panel_height = padding * 2 + len(live_states) * row_height - 2
    x = width - panel_width - 18
    y = height - panel_height - 40
    fill_rect(frame, width, height, x, y, x + panel_width, y + panel_height, HUD_BG)
    fill_rect(frame, width, height, x, y, x + panel_width, y + 2, HUD_BORDER)
    fill_rect(frame, width, height, x, y + panel_height - 2, x + panel_width, y + panel_height, HUD_BORDER)
    fill_rect(frame, width, height, x, y, x + 2, y + panel_height, HUD_BORDER)
    fill_rect(frame, width, height, x + panel_width - 2, y, x + panel_width, y + panel_height, HUD_BORDER)
    for index, state in enumerate(live_states):
        row_y = y + padding + index * row_height
        track = state["track"]
        fill_rect(frame, width, height, x + padding, row_y + 2, x + padding + 10, row_y + 12, track["color"])
        draw_text(frame, width, height, x + padding + 16, row_y + 1, normalize_label(labels[index]), LEGEND_TEXT, scale=scale)


def render_video(payload, output_path: Path, ffmpeg_bin: str, width: int, height: int, fps: float, crf: int):
    tracks, projection, start_ms, end_ms = prepare_tracks(payload, width, height)
    if not tracks:
        return {
            "ok": True,
            "skipped": True,
            "reason": "no_gps_tracks",
            "path": output_path.as_posix(),
        }

    duration_ms = max(1000.0, end_ms - start_ms)
    frame_count = max(2, int(math.ceil((duration_ms / 1000.0) * fps)) + 1)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    base_frame = draw_static_background(width, height, tracks, projection)
    active_frame = bytearray(base_frame)
    states = [{"idx": 0} for _ in tracks]

    cmd = [
        ffmpeg_bin,
        "-y",
        "-f", "rawvideo",
        "-pixel_format", "rgb24",
        "-video_size", f"{width}x{height}",
        "-framerate", str(fps),
        "-i", "-",
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output_path.as_posix(),
    ]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for frame_index in range(frame_count):
            t_ms = start_ms + (frame_index * 1000.0 / fps)
            for track_index, track in enumerate(tracks):
                points = track["points"]
                state = states[track_index]
                while state["idx"] + 1 < len(points) and points[state["idx"] + 1]["t_ms"] <= t_ms:
                    prev = points[state["idx"]]
                    curr = points[state["idx"] + 1]
                    draw_line(active_frame, width, height, prev["x"], prev["y"], curr["x"], curr["y"], dim(track["color"], 0.35), thickness=6)
                    draw_line(active_frame, width, height, prev["x"], prev["y"], curr["x"], curr["y"], track["color"], thickness=3)
                    state["idx"] += 1

            frame = bytearray(active_frame)
            live_states = []
            for track_index, track in enumerate(tracks):
                x, y, heading, speed_mps, accuracy_m, seg_idx, next_idx = interpolate_position(track, states[track_index]["idx"], t_ms)
                points = track["points"]
                if next_idx < len(points):
                    curr = points[seg_idx]
                    draw_line(frame, width, height, curr["x"], curr["y"], x, y, mix_color(track["color"], TRACK_GLOW, 0.35), thickness=4)
                draw_recent_trail(frame, width, height, track, seg_idx, x, y)
                accuracy_px = None if accuracy_m is None else max(4.0, min(22.0, accuracy_m / projection["meters_per_px"]))
                draw_marker(frame, width, height, x, y, track["color"], heading, accuracy_px=accuracy_px, tag=track["tag"])
                live_states.append({
                    "track": track,
                    "speed_mps": speed_mps,
                    "accuracy_m": accuracy_m,
                })

            draw_legend(frame, width, height, tracks)
            draw_status_panel(frame, width, height, tracks, live_states)
            progress = min(1.0, max(0.0, (t_ms - start_ms) / duration_ms))
            draw_progress_bar(frame, width, height, progress, label=format_elapsed_label(t_ms - start_ms, duration_ms))
            proc.stdin.write(frame)
    except BrokenPipeError:
        pass
    finally:
        if proc.stdin:
            try:
                proc.stdin.close()
            except Exception:
                pass

    stderr = b""
    try:
        stderr = proc.stderr.read() if proc.stderr else b""
    except Exception:
        stderr = b""
    code = proc.wait()
    if code != 0:
        return {
            "ok": False,
            "path": output_path.as_posix(),
            "error": f"ffmpeg exit {code}",
            "stderr": stderr.decode("utf-8", errors="ignore")[-1200:],
        }
    return {
        "ok": True,
        "skipped": False,
        "path": output_path.as_posix(),
        "width": width,
        "height": height,
        "fps": fps,
        "frame_count": frame_count,
        "duration_ms": duration_ms,
        "device_count": len(tracks),
    }


def main():
    args = parse_args()
    input_path = Path(args.input_json)
    output_path = Path(args.output)
    if not input_path.exists():
        print(json.dumps({
            "ok": False,
            "path": output_path.as_posix(),
            "error": "input json not found",
        }))
        return 1

    try:
        payload = json.loads(input_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception as err:
        print(json.dumps({
            "ok": False,
            "path": output_path.as_posix(),
            "error": f"invalid json: {err}",
        }))
        return 1

    result = render_video(
        payload=payload,
        output_path=output_path,
        ffmpeg_bin=args.ffmpeg_bin,
        width=max(320, int(args.width)),
        height=max(180, int(args.height)),
        fps=max(1.0, float(args.fps)),
        crf=max(0, int(args.crf)),
    )
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
