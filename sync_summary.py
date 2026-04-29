#!/usr/bin/env python3
"""
Summary of sync performance across all sessions with >= 2 devices and >= 5 min duration.
Usage: python3 sync_summary.py
"""

import json
import subprocess
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import numpy as np
import pandas as pd

DATASETS_DIR = Path(__file__).parent / "datasets"
MIN_DEVICES = 2
MIN_DURATION_MS = 5 * 60 * 1000  # 5 minutes


def session_duration_ms(sync_report):
    """Max segment duration across all devices."""
    best = 0
    for dev in sync_report.get("devices", {}).values():
        for seg in dev.get("sync", {}).get("segments", []):
            best = max(best, seg.get("duration_ms", 0))
    return best


def drift_ppm(b):
    return (b - 1.0) * 1_000_000


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

        session_label = session_dir.name.replace("session_", "")

        for dev_id, info in report["devices"].items():
            sync = info.get("sync", {})
            mapping = sync.get("mapping") or {}
            quality = sync.get("quality") or {}
            b = mapping.get("b")
            rows.append({
                "session": session_label,
                "session_dir": session_dir,
                "device_id": dev_id,
                "device_name": info.get("device_name", dev_id[:8]),
                "duration_min": dur / 60000,
                "device_count": device_count,
                "rtt_mean": quality.get("rtt_mean"),
                "rtt_p95": quality.get("rtt_p95"),
                "residual_ms": quality.get("residual_ms"),
                "drift_ppm": drift_ppm(b) if b is not None else None,
                "ping_loss_pct": sync.get("ping_loss_pct", 0),
                "conn_status": info.get("connection_status", "?"),
            })

    return pd.DataFrame(rows)


def load_rtt_timeseries(session_dir, device_id):
    p = session_dir / "devices" / device_id / "streams" / "net.csv"
    if not p.exists():
        return None
    df = pd.read_csv(p)
    df["t_s"] = (df["t_recv_ms"] - df["t_recv_ms"].iloc[0]) / 1000.0
    return df


def main():
    df = load_sessions()

    if df.empty:
        print("No sessions found matching criteria (>=2 devices, >=5 min).")
        return

    sessions = df["session"].unique()
    print(f"Found {len(sessions)} qualifying sessions across {len(df)} device-session pairs.")

    device_names = df["device_name"].unique()
    colors = plt.cm.tab10(np.linspace(0, 1, max(len(device_names), 2)))
    color_map = {name: colors[i] for i, name in enumerate(device_names)}

    fig = plt.figure(figsize=(18, 22))
    fig.suptitle(
        f"Sync Performance Summary — {len(sessions)} Sessions  ({MIN_DEVICES}+ devices, 5+ min)\n"
        f"Total device-session pairs: {len(df)}",
        fontsize=14, fontweight="bold", y=0.99
    )

    gs = gridspec.GridSpec(4, 2, figure=fig, hspace=0.55, wspace=0.35,
                           height_ratios=[2, 2, 2, 1.8])

    session_labels = [s for s in sessions]
    x = np.arange(len(session_labels))
    width = 0.35

    # ── Plot 1: RTT mean per session per device ──────────────────────────────
    ax1 = fig.add_subplot(gs[0, :])
    for i, name in enumerate(device_names):
        sub = df[df["device_name"] == name]
        vals = [sub[sub["session"] == s]["rtt_mean"].values[0]
                if len(sub[sub["session"] == s]) > 0 and sub[sub["session"] == s]["rtt_mean"].notna().any()
                else np.nan for s in session_labels]
        offset = (i - len(device_names) / 2 + 0.5) * width
        ax1.bar(x + offset, vals, width, label=name, color=color_map[name], alpha=0.85)

    ax1.axhline(350, color="#f44336", linestyle="--", linewidth=1, label="350ms warning")
    ax1.set_xticks(x)
    ax1.set_xticklabels(session_labels, rotation=45, ha="right", fontsize=7)
    ax1.set_ylabel("RTT Mean (ms)")
    ax1.set_title("RTT Mean per Session", fontweight="bold")
    ax1.legend(fontsize=8)
    ax1.grid(axis="y", alpha=0.3)

    # ── Plot 2: RTT p95 per session ──────────────────────────────────────────
    ax2 = fig.add_subplot(gs[1, 0])
    for i, name in enumerate(device_names):
        sub = df[df["device_name"] == name]
        vals = [sub[sub["session"] == s]["rtt_p95"].values[0]
                if len(sub[sub["session"] == s]) > 0 and sub[sub["session"] == s]["rtt_p95"].notna().any()
                else np.nan for s in session_labels]
        offset = (i - len(device_names) / 2 + 0.5) * width
        ax2.bar(x + offset, vals, width, label=name, color=color_map[name], alpha=0.85)

    ax2.axhline(350, color="#f44336", linestyle="--", linewidth=1)
    ax2.set_xticks(x)
    ax2.set_xticklabels(session_labels, rotation=45, ha="right", fontsize=7)
    ax2.set_ylabel("RTT p95 (ms)")
    ax2.set_title("RTT p95 (Worst 5%) per Session", fontweight="bold")
    ax2.grid(axis="y", alpha=0.3)

    # ── Plot 3: Residual error ───────────────────────────────────────────────
    ax3 = fig.add_subplot(gs[1, 1])
    for i, name in enumerate(device_names):
        sub = df[df["device_name"] == name]
        vals = [sub[sub["session"] == s]["residual_ms"].values[0]
                if len(sub[sub["session"] == s]) > 0 and sub[sub["session"] == s]["residual_ms"].notna().any()
                else np.nan for s in session_labels]
        offset = (i - len(device_names) / 2 + 0.5) * width
        ax3.bar(x + offset, vals, width, label=name, color=color_map[name], alpha=0.85)

    ax3.set_xticks(x)
    ax3.set_xticklabels(session_labels, rotation=45, ha="right", fontsize=7)
    ax3.set_ylabel("Residual Error (ms)")
    ax3.set_title("Sync Residual Error per Session\n(how much error remains after correction)", fontweight="bold")
    ax3.grid(axis="y", alpha=0.3)

    # ── Plot 4: Clock drift ──────────────────────────────────────────────────
    ax4 = fig.add_subplot(gs[2, 0])
    for i, name in enumerate(device_names):
        sub = df[df["device_name"] == name]
        vals = [sub[sub["session"] == s]["drift_ppm"].values[0]
                if len(sub[sub["session"] == s]) > 0 and sub[sub["session"] == s]["drift_ppm"].notna().any()
                else np.nan for s in session_labels]
        offset = (i - len(device_names) / 2 + 0.5) * width
        ax4.bar(x + offset, vals, width, label=name, color=color_map[name], alpha=0.85)

    ax4.axhline(0, color="black", linewidth=0.8)
    ax4.set_xticks(x)
    ax4.set_xticklabels(session_labels, rotation=45, ha="right", fontsize=7)
    ax4.set_ylabel("Drift (ppm)")
    ax4.set_title("Clock Drift per Session\n(+ = phone fast, − = phone slow)", fontweight="bold")
    ax4.grid(axis="y", alpha=0.3)

    # ── Plot 5: Session duration ─────────────────────────────────────────────
    ax5 = fig.add_subplot(gs[2, 1])
    dur_vals = [df[df["session"] == s]["duration_min"].max() for s in session_labels]
    ax5.bar(x, dur_vals, color="#1565C0", alpha=0.8)
    ax5.axhline(5, color="#f44336", linestyle="--", linewidth=1, label="5 min minimum")
    ax5.set_xticks(x)
    ax5.set_xticklabels(session_labels, rotation=45, ha="right", fontsize=7)
    ax5.set_ylabel("Duration (minutes)")
    ax5.set_title("Session Duration", fontweight="bold")
    ax5.legend(fontsize=8)
    ax5.grid(axis="y", alpha=0.3)

    # ── Table: overall stats ─────────────────────────────────────────────────
    ax_tbl = fig.add_subplot(gs[3, :])
    ax_tbl.axis("off")

    summary = (
        df.groupby("device_name")
        .agg(
            sessions=("session", "count"),
            rtt_mean_avg=("rtt_mean", "mean"),
            rtt_p95_avg=("rtt_p95", "mean"),
            residual_avg=("residual_ms", "mean"),
            drift_avg=("drift_ppm", "mean"),
            loss_avg=("ping_loss_pct", "mean"),
        )
        .reset_index()
    )

    col_labels = ["Device", "Sessions", "Avg RTT mean", "Avg RTT p95",
                  "Avg Residual", "Avg Drift (ppm)", "Avg Ping Loss %"]
    cell_data = [
        [
            row["device_name"],
            int(row["sessions"]),
            f"{row['rtt_mean_avg']:.1f} ms",
            f"{row['rtt_p95_avg']:.1f} ms",
            f"{row['residual_avg']:.1f} ms",
            f"{row['drift_avg']:+.2f}",
            f"{row['loss_avg']:.2f}%",
        ]
        for _, row in summary.iterrows()
    ]

    tbl = ax_tbl.table(cellText=cell_data, colLabels=col_labels,
                       loc="center", cellLoc="center")
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(9)
    tbl.scale(1, 1.8)
    for (r, c), cell in tbl.get_celld().items():
        if r == 0:
            cell.set_facecolor("#1565C0")
            cell.set_text_props(color="white", fontweight="bold")
        elif r % 2 == 0:
            cell.set_facecolor("#E3F2FD")

    ax_tbl.set_title("Average Metrics Across All Qualifying Sessions", fontweight="bold", pad=12)

    out_path = DATASETS_DIR.parent / "sync_summary.png"
    plt.savefig(out_path, dpi=150, bbox_inches="tight", facecolor="white")
    print(f"Saved: {out_path}")

    try:
        subprocess.Popen(["xdg-open", str(out_path)])
    except Exception:
        try:
            subprocess.Popen(["open", str(out_path)])
        except Exception:
            pass


if __name__ == "__main__":
    main()
