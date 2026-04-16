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
GRID = (21, 34, 49)
BORDER = (39, 58, 79)
TEXTLESS_BAR_BG = (28, 42, 58)
START_MARK = (240, 244, 248)
END_MARK = (150, 163, 184)


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


def draw_progress_bar(frame, width, height, progress):
    bar_margin_x = 28
    bar_height = 10
    bar_bottom = height - 16
    bar_top = bar_bottom - bar_height
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


def draw_grid(frame, width, height, map_rect):
    left, top, right, bottom = map_rect
    fill_rect(frame, width, height, left, top, right, bottom, BG)
    fill_rect(frame, width, height, left, top, right, top + 2, BORDER)
    fill_rect(frame, width, height, left, bottom - 2, right, bottom, BORDER)
    fill_rect(frame, width, height, left, top, left + 2, bottom, BORDER)
    fill_rect(frame, width, height, right - 2, top, right, bottom, BORDER)
    cols = 6
    rows = 4
    for i in range(1, cols):
        x = left + int(round((right - left) * i / cols))
        fill_rect(frame, width, height, x, top + 2, x + 1, bottom - 2, GRID)
    for i in range(1, rows):
        y = top + int(round((bottom - top) * i / rows))
        fill_rect(frame, width, height, left + 2, y, right - 2, y + 1, GRID)


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

    left = 28
    right = width - 28
    top = 24
    bottom = height - 40
    map_width = max(1, right - left)
    map_height = max(1, bottom - top)
    scale = min(map_width / span_x, map_height / span_y)
    if span_x < 1e-5 and span_y < 1e-5:
        scale = min(map_width, map_height) / 4.0
    extra_x = (map_width - span_x * scale) / 2.0
    extra_y = (map_height - span_y * scale) / 2.0

    def project(lat, lon):
        px = left + extra_x + ((lon * lon_scale) - min_x) * scale
        py = bottom - extra_y - (lat - min_y) * scale
        return int(round(px)), int(round(py))

    return project, (left, top, right, bottom)


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
            })
        if not points:
            continue
        points.sort(key=lambda item: item["t_ms"])
        raw_tracks.append({
            "device_id": device.get("device_id") or f"device-{index + 1}",
            "color": PALETTE[index % len(PALETTE)],
            "points": points,
        })

    if not raw_tracks:
        return [], None, None, None

    project, map_rect = build_projection(raw_tracks, width, height)
    for track in raw_tracks:
        for point in track["points"]:
            point["x"], point["y"] = project(point["lat"], point["lon"])

    starts = [track["points"][0]["t_ms"] for track in raw_tracks]
    ends = [track["points"][-1]["t_ms"] for track in raw_tracks]
    start_ms = min(starts)
    end_ms = max(ends)
    if end_ms <= start_ms:
        end_ms = start_ms + 1000.0
    return raw_tracks, map_rect, start_ms, end_ms


def draw_static_background(width, height, tracks, map_rect):
    frame = bytearray(bytes(BG) * (width * height))
    draw_grid(frame, width, height, map_rect)
    for track in tracks:
        route_color = dim(track["color"], 0.42)
        points = track["points"]
        for idx in range(1, len(points)):
            prev = points[idx - 1]
            curr = points[idx]
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
        return point["x"], point["y"], point.get("heading_deg"), idx, idx

    curr = points[idx]
    nxt = points[idx + 1]
    if nxt["t_ms"] <= curr["t_ms"]:
        return curr["x"], curr["y"], curr.get("heading_deg"), idx, idx + 1

    ratio = max(0.0, min(1.0, (t_ms - curr["t_ms"]) / (nxt["t_ms"] - curr["t_ms"])))
    x = int(round(curr["x"] + (nxt["x"] - curr["x"]) * ratio))
    y = int(round(curr["y"] + (nxt["y"] - curr["y"]) * ratio))
    heading = curr.get("heading_deg")
    if heading is None and (nxt["x"] != curr["x"] or nxt["y"] != curr["y"]):
        heading = math.degrees(math.atan2(nxt["x"] - curr["x"], curr["y"] - nxt["y"]))
    return x, y, heading, idx, idx + 1


def draw_marker(frame, width, height, x, y, color, heading_deg):
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


def render_video(payload, output_path: Path, ffmpeg_bin: str, width: int, height: int, fps: float, crf: int):
    tracks, map_rect, start_ms, end_ms = prepare_tracks(payload, width, height)
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

    base_frame = draw_static_background(width, height, tracks, map_rect)
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
                    draw_line(active_frame, width, height, prev["x"], prev["y"], curr["x"], curr["y"], track["color"], thickness=3)
                    state["idx"] += 1

            frame = bytearray(active_frame)
            for track_index, track in enumerate(tracks):
                x, y, heading, seg_idx, next_idx = interpolate_position(track, states[track_index]["idx"], t_ms)
                points = track["points"]
                if next_idx < len(points):
                    curr = points[seg_idx]
                    draw_line(frame, width, height, curr["x"], curr["y"], x, y, track["color"], thickness=3)
                draw_marker(frame, width, height, x, y, track["color"], heading)

            progress = min(1.0, max(0.0, (t_ms - start_ms) / duration_ms))
            draw_progress_bar(frame, width, height, progress)
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
