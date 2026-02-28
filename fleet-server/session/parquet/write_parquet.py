#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def _import_pyarrow():
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
        return pa, pq, None
    except Exception as e:
        return None, None, str(e)


def read_csv_lines(csv_path: Path):
    if not csv_path.exists():
        return []
    lines = csv_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    if len(lines) <= 1:
        return []
    rows = []
    for line in lines[1:]:
        if line.strip():
            rows.append(line)
    return rows


def parse_simple_csv_rows(rows):
    return [line.split(",") for line in rows]


def parse_events_csv_rows(rows):
    import csv
    return list(csv.reader(rows))


def to_int(v, default=0):
    try:
        return int(float(v))
    except Exception:
        return default


def to_float(v, default=0.0):
    try:
        return float(v)
    except Exception:
        return default


def write_table(pa, pq, columns: dict, out_path: Path, codec="zstd"):
    table = pa.table(columns)
    for candidate in [codec, "snappy", None]:
        try:
            kwargs = {}
            if candidate:
                kwargs["compression"] = candidate
            pq.write_table(table, out_path.as_posix(), **kwargs)
            return candidate or "none"
        except Exception:
            continue
    raise RuntimeError(f"failed to write parquet: {out_path}")


def convert_streams(session_dir: Path, device_id: str, streams_dir: Path):
    converted = []
    session_id = session_dir.name

    imu_rows = parse_simple_csv_rows(read_csv_lines(streams_dir / "imu.csv"))
    if imu_rows:
        cols = {
            "session_id": [], "device_id": [], "t_device_ns": [], "t_wall_utc_ns": [],
            "accel_x": [], "accel_y": [], "accel_z": [],
            "gyro_x": [], "gyro_y": [], "gyro_z": [],
            "mag_x": [], "mag_y": [], "mag_z": [],
            "sample_rate_hz": [], "sensor_frame": []
        }
        for r in imu_rows:
            if len(r) < 8:
                continue
            cols["session_id"].append(session_id)
            cols["device_id"].append(device_id)
            cols["t_device_ns"].append(to_int(r[1], 0) * 1_000_000)
            cols["t_wall_utc_ns"].append(to_int(r[0], 0) * 1_000_000)
            cols["accel_x"].append(to_float(r[2], 0.0))
            cols["accel_y"].append(to_float(r[3], 0.0))
            cols["accel_z"].append(to_float(r[4], 0.0))
            cols["gyro_x"].append(to_float(r[5], 0.0))
            cols["gyro_y"].append(to_float(r[6], 0.0))
            cols["gyro_z"].append(to_float(r[7], 0.0))
            cols["mag_x"].append(None)
            cols["mag_y"].append(None)
            cols["mag_z"].append(None)
            cols["sample_rate_hz"].append(None)
            cols["sensor_frame"].append(None)
        out = streams_dir / "imu.parquet"
        codec = write_table(pa, pq, cols, out)
        converted.append(f"{out.name}:{codec}")

    gps_rows = parse_simple_csv_rows(read_csv_lines(streams_dir / "gps.csv"))
    if gps_rows:
        cols = {
            "session_id": [], "device_id": [], "t_device_ns": [], "t_wall_utc_ns": [],
            "lat": [], "lon": [], "accuracy_m": [], "speed_mps": [], "heading_deg": [], "altitude_m": []
        }
        for r in gps_rows:
            if len(r) < 8:
                continue
            cols["session_id"].append(session_id)
            cols["device_id"].append(device_id)
            cols["t_device_ns"].append(to_int(r[1], 0) * 1_000_000)
            cols["t_wall_utc_ns"].append(to_int(r[0], 0) * 1_000_000)
            cols["lat"].append(to_float(r[2], 0.0))
            cols["lon"].append(to_float(r[3], 0.0))
            cols["accuracy_m"].append(to_float(r[4], -1.0))
            cols["speed_mps"].append(to_float(r[5], -1.0))
            cols["heading_deg"].append(to_float(r[6], -1.0))
            cols["altitude_m"].append(to_float(r[7], -1.0))
        out = streams_dir / "gps.parquet"
        codec = write_table(pa, pq, cols, out)
        converted.append(f"{out.name}:{codec}")

    event_rows = parse_events_csv_rows(read_csv_lines(streams_dir / "events.csv"))
    if event_rows:
        cols = {
            "session_id": [], "device_id": [], "t_device_ns": [], "t_wall_utc_ns": [],
            "label": [], "meta_json": []
        }
        for r in event_rows:
            if len(r) < 4:
                continue
            cols["session_id"].append(session_id)
            cols["device_id"].append(device_id)
            cols["t_device_ns"].append(to_int(r[1], 0) * 1_000_000)
            cols["t_wall_utc_ns"].append(to_int(r[0], 0) * 1_000_000)
            cols["label"].append(r[2])
            cols["meta_json"].append(r[3])
        out = streams_dir / "events.parquet"
        codec = write_table(pa, pq, cols, out)
        converted.append(f"{out.name}:{codec}")

    net_rows = parse_simple_csv_rows(read_csv_lines(streams_dir / "net.csv"))
    if net_rows:
        cols = {
            "session_id": [], "device_id": [], "t_wall_utc_ns": [],
            "fps": [], "dropped_frames": [], "rtt_ms": []
        }
        for r in net_rows:
            if len(r) < 4:
                continue
            cols["session_id"].append(session_id)
            cols["device_id"].append(device_id)
            cols["t_wall_utc_ns"].append(to_int(r[0], 0) * 1_000_000)
            cols["fps"].append(to_float(r[1], 0.0))
            cols["dropped_frames"].append(to_float(r[2], 0.0))
            cols["rtt_ms"].append(to_float(r[3], -1.0))
        out = streams_dir / "net.parquet"
        codec = write_table(pa, pq, cols, out)
        converted.append(f"{out.name}:{codec}")

    audio_rows = parse_simple_csv_rows(read_csv_lines(streams_dir / "audio.csv"))
    if audio_rows:
        cols = {
            "session_id": [], "device_id": [], "t_device_ns": [], "t_wall_utc_ns": [],
            "amplitude": [], "noise_level": []
        }
        for r in audio_rows:
            if len(r) < 4:
                continue
            cols["session_id"].append(session_id)
            cols["device_id"].append(device_id)
            cols["t_device_ns"].append(to_int(r[1], 0) * 1_000_000)
            cols["t_wall_utc_ns"].append(to_int(r[0], 0) * 1_000_000)
            cols["amplitude"].append(to_float(r[2], 0.0))
            cols["noise_level"].append(to_float(r[3], 0.0))
        out = streams_dir / "audio.parquet"
        codec = write_table(pa, pq, cols, out)
        converted.append(f"{out.name}:{codec}")

    device_rows = parse_simple_csv_rows(read_csv_lines(streams_dir / "device.csv"))
    if device_rows:
        cols = {
            "session_id": [], "device_id": [], "t_device_ns": [], "t_wall_utc_ns": [],
            "battery_level": [], "charging": [], "orientation": []
        }
        for r in device_rows:
            if len(r) < 5:
                continue
            cols["session_id"].append(session_id)
            cols["device_id"].append(device_id)
            cols["t_device_ns"].append(to_int(r[1], 0) * 1_000_000)
            cols["t_wall_utc_ns"].append(to_int(r[0], 0) * 1_000_000)
            cols["battery_level"].append(to_float(r[2], -1.0))
            cols["charging"].append(str(r[3]).lower() == "true")
            cols["orientation"].append(r[4])
        out = streams_dir / "device.parquet"
        codec = write_table(pa, pq, cols, out)
        converted.append(f"{out.name}:{codec}")

    fusion_rows = parse_simple_csv_rows(read_csv_lines(streams_dir / "fusion.csv"))
    if fusion_rows:
        cols = {
            "session_id": [], "device_id": [], "t_wall_utc_ns": [],
            "connection_quality": [], "sensing_confidence": []
        }
        for r in fusion_rows:
            if len(r) < 3:
                continue
            cols["session_id"].append(session_id)
            cols["device_id"].append(device_id)
            cols["t_wall_utc_ns"].append(to_int(r[0], 0) * 1_000_000)
            cols["connection_quality"].append(to_float(r[1], 0.0))
            cols["sensing_confidence"].append(to_float(r[2], 0.0))
        out = streams_dir / "fusion.parquet"
        codec = write_table(pa, pq, cols, out)
        converted.append(f"{out.name}:{codec}")

    return converted


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-dir", required=True)
    args = parser.parse_args()

    session_dir = Path(args.session_dir)
    pa_, pq_, import_err = _import_pyarrow()
    global pa, pq
    pa = pa_
    pq = pq_

    if pa is None:
        print(json.dumps({"ok": False, "error": f"pyarrow import failed: {import_err}"}))
        return 2

    devices_root = session_dir / "devices"
    if not devices_root.exists():
        print(json.dumps({"ok": True, "converted": {}, "note": "no devices dir"}))
        return 0

    converted = {}
    for device_dir in devices_root.iterdir():
        if not device_dir.is_dir():
            continue
        streams = device_dir / "streams"
        if not streams.exists():
            continue
        files = convert_streams(session_dir, device_dir.name, streams)
        if files:
            converted[device_dir.name] = files

    print(json.dumps({"ok": True, "converted": converted}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
