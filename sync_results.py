#!/usr/bin/env python3
"""
D3C sync performance results.
Prints a text summary and saves a clean chart for papers/reports.
Usage: python3 sync_results.py
"""

import json
import subprocess
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

DATASETS_DIR = Path(__file__).parent / "datasets"
MIN_DEVICES = 2
MIN_DURATION_MS = 5 * 60 * 1000


def session_duration_ms(report):
    best = 0
    for dev in report.get("devices", {}).values():
        for seg in dev.get("sync", {}).get("segments", []):
            best = max(best, seg.get("duration_ms", 0))
    return best


def load_sessions():
    rows = []
    for sync_path in sorted(DATASETS_DIR.glob("*/sync_report.json")):
        session_dir = sync_path.parent
        with open(sync_path) as f:
            report = json.load(f)

        device_count = len(report.get("devices", {}))
        if device_count < MIN_DEVICES:
            continue
        dur = session_duration_ms(report)
        if dur < MIN_DURATION_MS:
            continue

        for dev_id, info in report["devices"].items():
            sync = info.get("sync", {})
            mapping = sync.get("mapping") or {}
            quality = sync.get("quality") or {}
            b = mapping.get("b")
            rows.append({
                "session": session_dir.name.replace("session_", ""),
                "device": info.get("device_name", dev_id[:8]),
                "duration_min": dur / 60000,
                "device_count": device_count,
                "rtt_mean": quality.get("rtt_mean"),
                "rtt_p95": quality.get("rtt_p95"),
                "residual_ms": quality.get("residual_ms"),
                "drift_ppm": (b - 1.0) * 1e6 if b is not None else None,
                "ping_loss_pct": sync.get("ping_loss_pct", 0),
                "conn_status": info.get("connection_status", "?"),
            })
    return pd.DataFrame(rows)


def print_text_summary(df):
    COL = {
        "Session":       18,
        "Device":        14,
        "Dur(min)":       9,
        "RTT mean":      10,
        "RTT p95":        9,
        "Residual":      10,
        "Drift(ppm)":    11,
        "Loss%":          7,
        "Status":        11,
    }

    def fmt(v, decimals=1, suffix=""):
        return f"{v:.{decimals}f}{suffix}" if v is not None and not (isinstance(v, float) and np.isnan(v)) else "—"

    sep = "  "
    header = sep.join(k.ljust(v) for k, v in COL.items())
    divider = "-" * len(header)

    print()
    print("  D3C SYNC PERFORMANCE — qualifying sessions (≥2 devices, ≥5 min)")
    print(divider)
    print(header)
    print(divider)

    for _, r in df.iterrows():
        row = sep.join([
            r["session"][:18].ljust(18),
            str(r["device"])[:14].ljust(14),
            fmt(r["duration_min"]).ljust(9),
            fmt(r["rtt_mean"], suffix=" ms").ljust(10),
            fmt(r["rtt_p95"], suffix=" ms").ljust(9),
            fmt(r["residual_ms"], suffix=" ms").ljust(10),
            fmt(r["drift_ppm"], decimals=2).ljust(11),
            fmt(r["ping_loss_pct"], decimals=2, suffix="%").ljust(7),
            str(r["conn_status"]).ljust(11),
        ])
        print(row)

    print(divider)

    # aggregate stats
    print()
    print("  AGGREGATE (across all qualifying device-session pairs)")
    print(divider)
    metrics = {
        "RTT mean (ms)":    df["rtt_mean"].dropna(),
        "RTT p95  (ms)":    df["rtt_p95"].dropna(),
        "Residual  (ms)":   df["residual_ms"].dropna(),
        "Drift     (ppm)":  df["drift_ppm"].dropna(),
        "Ping loss (%)":    df["ping_loss_pct"].dropna(),
    }
    print(f"  {'Metric':<20} {'Mean':>8}  {'Median':>8}  {'Min':>8}  {'Max':>8}")
    print(f"  {'-'*20} {'-'*8}  {'-'*8}  {'-'*8}  {'-'*8}")
    for label, s in metrics.items():
        if s.empty:
            continue
        print(f"  {label:<20} {s.mean():>8.2f}  {s.median():>8.2f}  {s.min():>8.2f}  {s.max():>8.2f}")
    print(divider)
    print()


def make_chart(df):
    # Use only rows with valid residual and rtt
    valid = df.dropna(subset=["rtt_mean", "residual_ms"])

    # Cap extreme RTT outliers for readability, annotate clipped bars
    RTT_CAP = 500
    clipped = valid[valid["rtt_mean"] > RTT_CAP][["session", "device", "rtt_mean"]].copy()
    valid = valid.copy()
    valid["rtt_mean_plot"] = valid["rtt_mean"].clip(upper=RTT_CAP)

    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    fig.suptitle("D3C Time Synchronization Performance", fontsize=13, fontweight="bold", y=1.02)

    devices = sorted(valid["device"].unique())
    colors = plt.cm.tab10(np.linspace(0, 0.6, len(devices)))
    cmap = dict(zip(devices, colors))

    sessions = valid["session"].unique()
    x = np.arange(len(sessions))
    n = len(devices)
    width = 0.7 / max(n, 1)

    # shared y-axis max across RTT and residual (both ms)
    ms_max = max(
        valid["rtt_mean_plot"].max(),
        valid["residual_ms"].max()
    ) * 1.15

    # ── Panel 1: RTT mean ──────────────────────────────────────────────────
    ax = axes[0]
    for i, dev in enumerate(devices):
        sub = valid[valid["device"] == dev]
        vals = [sub[sub["session"] == s]["rtt_mean_plot"].values[0]
                if len(sub[sub["session"] == s]) > 0 else np.nan
                for s in sessions]
        offset = (i - n / 2 + 0.5) * width
        bars = ax.bar(x + offset, vals, width, label=dev, color=cmap[dev], alpha=0.85, edgecolor="white")

        # annotate clipped bars with actual value
        for j, (bar, s) in enumerate(zip(bars, sessions)):
            row = clipped[(clipped["session"] == s) & (clipped["device"] == dev)]
            if not row.empty:
                ax.text(bar.get_x() + bar.get_width() / 2, RTT_CAP + 8,
                        f"{int(row['rtt_mean'].values[0])}↑",
                        ha="center", va="bottom", fontsize=6, color="#d32f2f")

    ax.axhline(350, color="#d32f2f", linestyle="--", linewidth=1, label="350 ms threshold")
    ax.set_xticks(x)
    ax.set_xticklabels(sessions, rotation=35, ha="right", fontsize=8)
    ax.set_ylabel("ms")
    ax.set_title("RTT Mean", fontweight="bold")
    ax.legend(fontsize=7)
    ax.grid(axis="y", alpha=0.25)
    ax.set_ylim(0, ms_max)

    # ── Panel 2: Residual error ────────────────────────────────────────────
    ax = axes[1]
    for i, dev in enumerate(devices):
        sub = valid[valid["device"] == dev]
        vals = [sub[sub["session"] == s]["residual_ms"].values[0]
                if len(sub[sub["session"] == s]) > 0 else np.nan
                for s in sessions]
        offset = (i - n / 2 + 0.5) * width
        ax.bar(x + offset, vals, width, label=dev, color=cmap[dev], alpha=0.85, edgecolor="white")

    ax.set_xticks(x)
    ax.set_xticklabels(sessions, rotation=35, ha="right", fontsize=8)
    ax.set_ylabel("ms")
    ax.set_title("Sync Residual Error\n(timestamp error after correction)", fontweight="bold")
    ax.grid(axis="y", alpha=0.25)
    ax.set_ylim(0, ms_max)

    # ── Panel 3: Clock drift ───────────────────────────────────────────────
    ax = axes[2]
    valid_drift = df.dropna(subset=["drift_ppm"])
    # clip extreme outliers for readability
    clip = 500
    valid_drift = valid_drift[valid_drift["drift_ppm"].abs() < clip]
    drift_sessions = valid_drift["session"].unique()
    xd = np.arange(len(drift_sessions))

    for i, dev in enumerate(devices):
        sub = valid_drift[valid_drift["device"] == dev]
        vals = [sub[sub["session"] == s]["drift_ppm"].values[0]
                if len(sub[sub["session"] == s]) > 0 else np.nan
                for s in drift_sessions]
        offset = (i - n / 2 + 0.5) * width
        ax.bar(xd + offset, vals, width, label=dev, color=cmap[dev], alpha=0.85, edgecolor="white")

    ax.axhline(0, color="black", linewidth=0.8)
    ax.set_xticks(xd)
    ax.set_xticklabels(drift_sessions, rotation=35, ha="right", fontsize=8)
    ax.set_ylabel("ppm")
    ax.set_title("Clock Drift\n(+ = phone fast,  − = phone slow)", fontweight="bold")
    ax.grid(axis="y", alpha=0.25)

    plt.tight_layout()
    out = DATASETS_DIR.parent / "sync_results.png"
    plt.savefig(out, dpi=180, bbox_inches="tight", facecolor="white")
    print(f"Chart saved: {out}")
    try:
        subprocess.Popen(["xdg-open", str(out)])
    except Exception:
        try:
            subprocess.Popen(["open", str(out)])
        except Exception:
            pass


def main():
    df = load_sessions()
    if df.empty:
        print("No qualifying sessions found (need ≥2 devices and ≥5 min).")
        return

    print_text_summary(df)
    make_chart(df)


if __name__ == "__main__":
    main()
