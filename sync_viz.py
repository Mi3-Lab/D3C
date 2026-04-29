#!/usr/bin/env python3
"""
Visualize sync performance for a D3C session.
Usage:
  python3 sync_viz.py                          # latest session
  python3 sync_viz.py session_20260423_215342  # specific session
"""

import json
import os
import sys
import glob
import subprocess
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import numpy as np
import pandas as pd

DATASETS_DIR = Path(__file__).parent / "datasets"
RTT_WARN_MS = 350


def find_session(name=None):
    if name:
        p = DATASETS_DIR / name
        if not p.exists():
            # try prefix match
            matches = sorted(DATASETS_DIR.glob(f"*{name}*"))
            if not matches:
                sys.exit(f"Session not found: {name}")
            p = matches[-1]
        return p

    # pick most recent session that has a sync_report
    sessions = sorted(DATASETS_DIR.glob("*/sync_report.json"))
    if not sessions:
        sys.exit("No sessions with sync_report.json found.")
    return sessions[-1].parent


def load_net_csv(device_dir):
    p = device_dir / "streams" / "net.csv"
    if not p.exists():
        return None
    df = pd.read_csv(p)
    df["t_s"] = (df["t_recv_ms"] - df["t_recv_ms"].iloc[0]) / 1000.0
    return df


def load_server_health_csv(session_dir):
    p = session_dir / "server_health.csv"
    if not p.exists():
        return None
    df = pd.read_csv(p)
    df["t_s"] = (df["t_server_ms"] - df["t_server_ms"].iloc[0]) / 1000.0
    return df


def drift_ppm(b):
    return (b - 1.0) * 1_000_000


def drift_ms_per_min(b):
    return (b - 1.0) * 1000 * 60


def format_device_name(device_id, device_info):
    name = device_info.get("device_name", "")
    short_id = device_id.split("-")[0]
    return f"{name} ({short_id})" if name else short_id


def main():
    session_arg = sys.argv[1] if len(sys.argv) > 1 else None
    session_dir = find_session(session_arg)

    sync_path = session_dir / "sync_report.json"
    with open(sync_path) as f:
        report = json.load(f)

    devices = report.get("devices", {})
    if not devices:
        sys.exit("No device data in sync_report.json")

    device_ids = list(devices.keys())
    n = len(device_ids)

    fig = plt.figure(figsize=(14, 4 * n + 3))
    fig.suptitle(
        f"Sync Performance — {session_dir.name}\n"
        f"{report.get('generated_at_iso', '')}",
        fontsize=13, fontweight="bold", y=0.98
    )

    gs = gridspec.GridSpec(n + 1, 2, figure=fig, hspace=0.55, wspace=0.35,
                           height_ratios=[3] * n + [1.5])

    # pre-load all net CSVs to find global RTT max for shared y-axis
    net_dfs = {}
    global_rtt_max = 0
    for device_id in device_ids:
        df = load_net_csv(session_dir / "devices" / device_id)
        net_dfs[device_id] = df
        if df is not None and not df.empty:
            global_rtt_max = max(global_rtt_max, df["rtt_ms"].max())
    rtt_ylim = global_rtt_max * 1.1 if global_rtt_max > 0 else 1000

    # server health — loaded once, overlaid on every RTT chart
    health_df = load_server_health_csv(session_dir)

    summary_rows = []

    for row, device_id in enumerate(device_ids):
        info = devices[device_id]
        sync = info.get("sync", {})
        mapping = sync.get("mapping") or {}
        quality = sync.get("quality") or {}

        a_ms = mapping.get("a_ms")
        b = mapping.get("b")
        rtt_mean = quality.get("rtt_mean")
        rtt_p95 = quality.get("rtt_p95")
        residual = quality.get("residual_ms")
        ping_sent = sync.get("ping_sent", 0)
        ping_acked = sync.get("ping_acked", 0)
        loss_pct = sync.get("ping_loss_pct", 0)
        conn_status = info.get("connection_status", "?")
        label = format_device_name(device_id, info)

        # --- RTT over time plot ---
        ax_rtt = fig.add_subplot(gs[row, 0])
        df = net_dfs[device_id]

        if df is not None and not df.empty:
            ax_rtt.plot(df["t_s"], df["rtt_ms"], color="#2196F3", linewidth=1, alpha=0.8, label="RTT")
            ax_rtt.axhline(RTT_WARN_MS, color="#f44336", linestyle="--", linewidth=1, label=f"Warning ({RTT_WARN_MS}ms)")
            if rtt_mean is not None:
                ax_rtt.axhline(rtt_mean, color="#4CAF50", linestyle=":", linewidth=1.5, label=f"Mean ({rtt_mean:.0f}ms)")

            # overlay server event loop lag if available
            if health_df is not None and not health_df.empty and "event_loop_lag_ms" in health_df.columns:
                ax2 = ax_rtt.twinx()
                ax2.plot(health_df["t_s"], health_df["event_loop_lag_ms"],
                         color="#FF6F00", linewidth=1, alpha=0.6, linestyle="-", label="Server lag")
                ax2.set_ylabel("Event loop lag (ms)", fontsize=8, color="#FF6F00")
                ax2.tick_params(axis="y", labelcolor="#FF6F00", labelsize=7)
                ax2.set_ylim(bottom=0)
                ax2.legend(fontsize=7, loc="upper left")

            ax_rtt.set_xlabel("Time (seconds into session)", fontsize=9)
            ax_rtt.set_ylabel("RTT (ms)", fontsize=9)
            ax_rtt.legend(fontsize=8, loc="upper right")
            ax_rtt.set_ylim(0, rtt_ylim)
        else:
            ax_rtt.text(0.5, 0.5, "No net.csv data", ha="center", va="center", transform=ax_rtt.transAxes)

        ax_rtt.set_title(f"RTT over Time — {label}", fontsize=10, fontweight="bold")
        ax_rtt.grid(True, alpha=0.3)

        # --- Drift / sync quality panel ---
        ax_info = fig.add_subplot(gs[row, 1])
        ax_info.axis("off")

        if b is not None:
            ppm = drift_ppm(b)
            ms_per_min = drift_ms_per_min(b)
            drift_dir = "fast" if ppm > 0 else "slow"
            drift_str = f"{abs(ppm):.2f} ppm ({drift_dir})\n= {abs(ms_per_min):.2f} ms/min"
        else:
            drift_str = "not enough data"

        conn_color = {"excellent": "#4CAF50", "good": "#8BC34A",
                      "poor": "#FF9800", "degraded": "#f44336",
                      "disconnected": "#9E9E9E"}.get(conn_status, "#9E9E9E")

        lines = [
            ("Device", label),
            ("Connection", conn_status.upper()),
            ("Pings sent / acked", f"{ping_sent} / {ping_acked}  (loss {loss_pct:.1f}%)"),
            ("RTT mean", f"{rtt_mean:.1f} ms" if rtt_mean is not None else "—"),
            ("RTT p95", f"{rtt_p95:.1f} ms" if rtt_p95 is not None else "—"),
            ("Residual error", f"{residual:.1f} ms" if residual is not None else "—"),
            ("Clock drift (b)", drift_str),
        ]

        y = 0.95
        for key, val in lines:
            color = conn_color if key == "Connection" else "black"
            weight = "bold" if key == "Connection" else "normal"
            ax_info.text(0.02, y, f"{key}:", fontsize=9, va="top", color="#555555")
            ax_info.text(0.42, y, val, fontsize=9, va="top", color=color, fontweight=weight)
            y -= 0.13

        ax_info.set_title("Sync Summary", fontsize=10, fontweight="bold")
        ax_info.set_xlim(0, 1)
        ax_info.set_ylim(0, 1)

        summary_rows.append({
            "Device": label,
            "RTT mean": f"{rtt_mean:.1f}" if rtt_mean else "—",
            "RTT p95": f"{rtt_p95:.1f}" if rtt_p95 else "—",
            "Residual": f"{residual:.1f}" if residual else "—",
            "Drift (ppm)": f"{drift_ppm(b):+.2f}" if b else "—",
            "Status": conn_status,
        })

    # --- Bottom: summary table across all devices ---
    ax_table = fig.add_subplot(gs[n, :])
    ax_table.axis("off")

    if summary_rows:
        cols = list(summary_rows[0].keys())
        cell_data = [[r[c] for c in cols] for r in summary_rows]
        tbl = ax_table.table(
            cellText=cell_data,
            colLabels=cols,
            loc="center",
            cellLoc="center"
        )
        tbl.auto_set_font_size(False)
        tbl.set_fontsize(9)
        tbl.scale(1, 1.6)
        for (r, c), cell in tbl.get_celld().items():
            if r == 0:
                cell.set_facecolor("#1565C0")
                cell.set_text_props(color="white", fontweight="bold")
            elif r % 2 == 0:
                cell.set_facecolor("#E3F2FD")
        ax_table.set_title("All Devices Summary", fontsize=10, fontweight="bold", pad=12)

    out_path = session_dir / "sync_viz.png"
    plt.savefig(out_path, dpi=150, bbox_inches="tight", facecolor="white")
    print(f"Saved: {out_path}")

    # open the image
    try:
        subprocess.Popen(["xdg-open", str(out_path)])
    except Exception:
        try:
            subprocess.Popen(["open", str(out_path)])
        except Exception:
            pass


if __name__ == "__main__":
    main()
