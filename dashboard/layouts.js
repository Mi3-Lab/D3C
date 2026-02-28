import { clamp, clone } from "./store.js";

export const LAYOUTS_KEY = "d3c_widget_layouts_v2";
export const ACTIVE_LAYOUT_KEY = "d3c_active_layout_v2";

export function defaultLayouts(makeWidget) {
  return {
    Recording: {
      name: "Recording",
      widgets: [
        makeWidget("stream_controls", { w: 4, h: 6, pinned: true, settings: { device_id: "global" } }),
        makeWidget("imu_plot", { w: 5, h: 4, pinned: true, settings: { device_id: "global", time_window_sec: 15 } }),
        makeWidget("device_list", { w: 3, h: 4, pinned: true }),
        makeWidget("camera_preview", { w: 6, h: 2, pinned: true, settings: { device_id: "global" } }),
        makeWidget("events_timeline", { w: 3, h: 2, pinned: false })
      ]
    },
    Monitoring: {
      name: "Monitoring",
      widgets: [
        makeWidget("stream_controls", { w: 4, h: 6, pinned: true }),
        makeWidget("imu_plot", { w: 6, h: 4, pinned: true }),
        makeWidget("device_list", { w: 3, h: 4, pinned: true }),
        makeWidget("camera_preview", { w: 6, h: 2, pinned: true }),
        makeWidget("events_timeline", { w: 3, h: 2, pinned: false }),
        makeWidget("replay", { w: 9, h: 3, pinned: false })
      ]
    },
    Debug: {
      name: "Debug",
      widgets: [
        makeWidget("stream_controls", { w: 4, h: 4, pinned: true }),
        makeWidget("device_list", { w: 4, h: 4, pinned: true }),
        makeWidget("json_state", { w: 8, h: 4, pinned: false }),
        makeWidget("replay", { w: 12, h: 3, pinned: false })
      ]
    }
  };
}

export function loadLayouts(defaultsFactory) {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUTS_KEY) || "null");
    if (raw && typeof raw === "object" && Object.keys(raw).length) return raw;
  } catch {}
  return defaultsFactory();
}

export function persistLayouts(layouts, activeName) {
  localStorage.setItem(LAYOUTS_KEY, JSON.stringify(layouts));
  localStorage.setItem(ACTIVE_LAYOUT_KEY, activeName);
}

export function normalizeLayout(layout, widgetRegistry) {
  const out = clone(layout);
  out.widgets = Array.isArray(out.widgets) ? out.widgets : [];
  out.widgets = out.widgets.map((w) => {
    const def = widgetRegistry[w.type];
    if (!def) return null;
    return {
      id: String(w.id || `w_${Math.random().toString(36).slice(2, 8)}`),
      type: w.type,
      w: clamp(Number(w.w || def.defaults.w), 2, 12),
      h: clamp(Number(w.h || def.defaults.h), 1, 6),
      pinned: !!w.pinned,
      settings: { ...clone(def.defaults.settings || {}), ...(w.settings || {}) }
    };
  }).filter(Boolean);
  return out;
}

export function reorderWidgets(layout, sourceId, targetId) {
  const arr = layout.widgets;
  const i = arr.findIndex((w) => w.id === sourceId);
  const j = arr.findIndex((w) => w.id === targetId);
  if (i < 0 || j < 0) return;
  const [moved] = arr.splice(i, 1);
  arr.splice(j, 0, moved);
}


