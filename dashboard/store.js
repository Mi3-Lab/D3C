export function createStore(initialState) {
  let state = initialState;
  const subs = [];

  function getState() {
    return state;
  }

  function setState(patch) {
    state = { ...state, ...patch };
    for (const sub of subs) {
      const next = sub.selector(state);
      if (!deepEqual(next, sub.last)) {
        sub.last = clone(next);
        sub.callback(next, state);
      }
    }
  }

  function subscribe(selector, callback) {
    const rec = { selector, callback, last: clone(selector(state)) };
    subs.push(rec);
    return () => {
      const i = subs.indexOf(rec);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  return { getState, setState, subscribe };
}

export function createEventBus() {
  const map = new Map();
  return {
    on(evt, cb) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(cb);
      return () => map.get(evt)?.delete(cb);
    },
    emit(evt, payload) {
      const cbs = map.get(evt);
      if (!cbs) return;
      for (const cb of cbs) cb(payload);
    }
  };
}

export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

export function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatElapsed(sec) {
  const s = Math.max(0, Number(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function formatTs(t) {
  return t ? new Date(Number(t)).toLocaleTimeString() : "-";
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseImuCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const p = line.split(",");
    const t = Number(p[0]);
    const ax = Number(p[2]);
    const ay = Number(p[3]);
    const az = Number(p[4]);
    rows.push({ t_recv_ms: t, mag: Math.sqrt(ax * ax + ay * ay + az * az) });
  }
  return rows;
}

export function parseCameraTsCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const p = line.split(",");
    if (p.length >= 4) rows.push({ filename: p[1], t_recv_ms: Number(p[3]) });
  }
  return rows;
}

export function parseEventsCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const first = line.indexOf(",");
    const second = line.indexOf(",", first + 1);
    const third = line.indexOf(",", second + 1);
    if (first < 0 || second < 0 || third < 0) continue;
    rows.push({
      t_recv_ms: Number(line.slice(0, first)),
      label: line.slice(second + 1, third).replace(/^"|"$/g, ""),
      source: "replay"
    });
  }
  return rows;
}
