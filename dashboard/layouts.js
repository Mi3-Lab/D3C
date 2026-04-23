import { clamp, clone } from "./store.js";

export const LAYOUTS_KEY = "d3c_widget_layouts_v5";
export const ACTIVE_LAYOUT_KEY = "d3c_active_layout_v5";
const COMPACT_STREAM_CONTROLS_WIDTH = 4;

export function defaultLayouts(makeWidget) {
  return {
    Overview: {
      name: "Overview",
      widgets: [
        makeWidget("workzone_live", { w: 12, h: 2, pinned: true, settings: { device_id: "global" } }),
        makeWidget("stream_controls", { w: COMPACT_STREAM_CONTROLS_WIDTH, h: 6, pinned: true, settings: { device_id: "global" } }),
        makeWidget("camera_preview", { w: 12 - COMPACT_STREAM_CONTROLS_WIDTH, h: 6, pinned: true, settings: { device_id: "global" } }),
        makeWidget("device_list", { w: 12, h: 4, pinned: true })
      ]
    },
    Cameras: {
      name: "Cameras",
      widgets: [
        makeWidget("workzone_live", { w: 12, h: 2, pinned: true, settings: { device_id: "global" } }),
        makeWidget("camera_preview", { w: 12, h: 6, pinned: true, settings: { device_id: "global" } }),
        makeWidget("device_list", { w: 12, h: 4, pinned: true })
      ]
    },
    Review: {
      name: "Review",
      widgets: [
        makeWidget("stream_controls", { w: 4, h: 5, pinned: true, settings: { device_id: "global" } }),
        makeWidget("replay", { w: 8, h: 5, pinned: true }),
        makeWidget("device_list", { w: 12, h: 4, pinned: false })
      ]
    }
  };
}

function migrateBuiltInLiveLayouts(layouts, defaultsFactory) {
  if (!layouts || typeof layouts !== "object") return false;
  const defaults = defaultsFactory();
  let changed = false;

  function syncBuiltInLayout(layoutName) {
    const layout = layouts[layoutName];
    const defaultLayout = defaults[layoutName];
    if (!layout || typeof layout !== "object" || !Array.isArray(layout.widgets) || !defaultLayout?.widgets?.length) return;

    const byType = new Map();
    const usedIds = new Set();
    for (const widget of layout.widgets) {
      if (!widget || typeof widget !== "object") continue;
      const type = String(widget.type || "");
      if (!type || byType.has(type)) continue;
      byType.set(type, widget);
    }

    const nextWidgets = [];
    for (const defaultWidget of defaultLayout.widgets) {
      const current = byType.get(defaultWidget.type);
      const nextWidget = current ? current : clone(defaultWidget);
      if (current?.id) usedIds.add(current.id);
      if (
        !current
        || Number(current.w) !== Number(defaultWidget.w)
        || Number(current.h) !== Number(defaultWidget.h)
        || !!current.pinned !== !!defaultWidget.pinned
      ) {
        changed = true;
      }
      nextWidget.type = defaultWidget.type;
      nextWidget.w = defaultWidget.w;
      nextWidget.h = defaultWidget.h;
      nextWidget.pinned = !!defaultWidget.pinned;
      nextWidget.settings = { ...clone(defaultWidget.settings || {}), ...(current?.settings || {}) };
      nextWidgets.push(nextWidget);
    }

    const extras = layout.widgets.filter((widget) => widget && typeof widget === "object" && !usedIds.has(widget.id) && !defaultLayout.widgets.some((base) => base.type === widget.type));
    const sameOrder = layout.widgets.length === nextWidgets.length + extras.length
      && layout.widgets.every((widget, index) => widget === [...nextWidgets, ...extras][index]);
    if (!sameOrder) changed = true;
    layout.widgets = [...nextWidgets, ...extras];
  }

  syncBuiltInLayout("Overview");
  syncBuiltInLayout("Cameras");
  return changed;
}

export function loadLayouts(defaultsFactory) {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUTS_KEY) || "null");
    if (raw && typeof raw === "object" && Object.keys(raw).length) {
      if (migrateBuiltInLiveLayouts(raw, defaultsFactory)) {
        localStorage.setItem(LAYOUTS_KEY, JSON.stringify(raw));
      }
      return raw;
    }
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
