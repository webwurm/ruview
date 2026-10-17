import { mockLatest } from './mock.js';

const POLL_MS = 500;
const HEALTH_MS = 5000;
const TRAIL_LEN = 24;
const SPARK_SECONDS = 60;

// RuView rechnet Signalkarten-Zellen so in Meter um (field_localize.rs).
const FIELD_X_SCALE = 0.6;
const FIELD_Z_SCALE = 0.5;

const MOTION_LABELS = {
  absent: 'Niemand da',
  present_still: 'Anwesend, ruhig',
  present_moving: 'Anwesend, in Bewegung',
  active: 'Viel Bewegung',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const useMock = new URLSearchParams(location.search).has('mock');
const $ = (id) => document.getElementById(id);

let plan;
const tracks = new Map(); // person id -> { points: [[x,y]], SVG-Elemente }
const motionHistory = []; // [timestamp, motion_band_power]

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

// RuView-Weltkoordinaten (x, z in Metern) -> Grundriss-Koordinaten.
function toPlan([x, , z]) {
  return [plan.ruview_origin[0] + x, plan.ruview_origin[1] + z];
}

function pointInPolygon([px, py], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function roomOf(point) {
  return plan.rooms.find((r) => pointInPolygon(point, r.polygon))?.name ?? 'Außerhalb';
}

function centroid(polygon) {
  const n = polygon.length;
  return polygon.reduce(([sx, sy], [x, y]) => [sx + x / n, sy + y / n], [0, 0]);
}

function buildPlan() {
  const svg = $('plan');
  // 1 m Rand, damit Personen knapp außerhalb (Balkon, Garten) sichtbar bleiben.
  svg.setAttribute('viewBox', `-1 -1 ${plan.width + 2} ${plan.height + 2}`);
  $('plan-name').textContent = plan.name;

  const rooms = el('g', { id: 'room-shapes' }, svg);
  for (const room of plan.rooms) {
    room.shape = el('polygon', { class: 'room', points: room.polygon.map((p) => p.join(',')).join(' ') }, rooms);
    const [cx, cy] = centroid(room.polygon);
    el('text', { class: 'room-label', x: cx, y: cy, 'text-anchor': 'middle' }, svg).textContent = room.name;
    room.countLabel = el('text', { class: 'room-count', x: cx, y: cy + 0.38, 'text-anchor': 'middle' }, svg);
  }
  const clip = el('clipPath', { id: 'plan-clip' }, el('defs', {}, svg));
  el('rect', { x: -1, y: -1, width: plan.width + 2, height: plan.height + 2 }, clip);
  el('g', { id: 'field', 'clip-path': 'url(#plan-clip)' }, svg);
  el('g', { id: 'trails' }, svg);
  el('g', { id: 'nodes' }, svg);
  el('g', { id: 'persons' }, svg);
}

function drawField(field) {
  const g = $('field');
  g.replaceChildren();
  if (!$('show-field').checked || !field?.values?.length) return;
  const [nx, , nz] = field.grid_size;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const v = field.values[iz * nx + ix];
      if (v < 0.15) continue;
      const [x, y] = toPlan([(ix - nx / 2) * FIELD_X_SCALE, 0, (iz - nz / 2) * FIELD_Z_SCALE]);
      el('rect', {
        x, y, width: FIELD_X_SCALE, height: FIELD_Z_SCALE,
        fill: `hsl(${220 - v * 220} 90% 55%)`, opacity: (v * 0.45).toFixed(2),
      }, g);
    }
  }
}

function drawNodes(nodes = []) {
  const g = $('nodes');
  g.replaceChildren();
  for (const n of nodes) {
    const [x, y] = toPlan(n.position ?? [0, 0, 0]);
    el('rect', { class: 'node', x: x - 0.12, y: y - 0.12, width: 0.24, height: 0.24, rx: 0.05 }, g);
    el('text', { class: 'node-label', x: x + 0.2, y: y + 0.08 }, g).textContent = `Sensor ${n.node_id}`;
  }
}

function drawPersons(persons) {
  const g = $('persons');
  const trails = $('trails');
  const seen = new Set();

  for (const p of persons) {
    // Position [0,0,0] heißt bei RuView: keine Spitze in der Signalkarte gefunden.
    if (!p.position || p.position.every((v) => v === 0)) continue;
    const pt = toPlan(p.position);
    seen.add(p.id);
    let t = tracks.get(p.id);
    if (!t) {
      t = { points: [] };
      t.halo = el('circle', { class: 'person-halo', r: 0.42 }, g);
      t.dot = el('circle', { class: 'person', r: 0.16 }, g);
      t.label = el('text', { class: 'person-label', 'text-anchor': 'middle' }, g);
      t.trail = el('polyline', { class: 'trail' }, trails);
      tracks.set(p.id, t);
    }
    t.points.push(pt);
    if (t.points.length > TRAIL_LEN) t.points.shift();
    for (const c of [t.halo, t.dot]) { c.setAttribute('cx', pt[0]); c.setAttribute('cy', pt[1]); }
    t.label.setAttribute('x', pt[0]);
    t.label.setAttribute('y', pt[1] - 0.5);
    t.label.textContent = `#${p.id}`;
    t.trail.setAttribute('points', $('show-trails').checked ? t.points.map((q) => q.join(',')).join(' ') : '');
  }

  for (const [id, t] of tracks) {
    // RuView vergibt bei jedem Neuerkennen neue IDs; Verschwundene sofort entfernen.
    if (!seen.has(id)) {
      t.halo.remove(); t.dot.remove(); t.label.remove(); t.trail.remove();
      tracks.delete(id);
    }
  }
  return persons.filter((p) => seen.has(p.id)).map((p) => toPlan(p.position));
}

function updateRooms(points) {
  const counts = new Map(plan.rooms.map((r) => [r.name, 0]));
  for (const pt of points) {
    const name = roomOf(pt);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const room of plan.rooms) {
    const c = counts.get(room.name);
    room.shape.classList.toggle('active', c > 0);
    room.countLabel.textContent = c > 0 ? `${c} ${c === 1 ? 'Person' : 'Personen'}` : '';
  }
  $('rooms').replaceChildren(...[...counts].map(([name, c]) => {
    const li = document.createElement('li');
    li.className = c ? '' : 'empty';
    li.innerHTML = `<span></span><strong>${c}</strong>`;
    li.firstChild.textContent = name;
    return li;
  }));
}

function drawSpark(now) {
  const canvas = $('spark');
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = 60 * devicePixelRatio);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  while (motionHistory.length && now - motionHistory[0][0] > SPARK_SECONDS * 1000) motionHistory.shift();
  if (motionHistory.length < 2) return;
  const max = Math.max(1, ...motionHistory.map(([, v]) => v));
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.beginPath();
  motionHistory.forEach(([ts, v], i) => {
    const x = w - ((now - ts) / (SPARK_SECONDS * 1000)) * w;
    const y = h - (v / max) * (h - 4) - 2;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

function fmt(v, digits = 1) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '–';
}

function render(data) {
  const now = Date.now();
  const cls = data.classification ?? {};
  const persons = data.persons ?? [];

  $('presence').textContent = cls.presence ? 'Ja' : 'Nein';
  $('motion').textContent = MOTION_LABELS[cls.motion_level] ?? cls.motion_level ?? '–';
  $('confidence-bar').style.width = `${Math.round((cls.confidence ?? 0) * 100)}%`;
  $('confidence').textContent = `Konfidenz ${Math.round((cls.confidence ?? 0) * 100)} %`;
  $('age').textContent = data.age_ms != null ? `vor ${Math.round(data.age_ms)} ms` : '';

  drawField(data.signal_field);
  drawNodes(data.nodes);
  const points = drawPersons(persons);
  updateRooms(points);

  $('est-persons').textContent = data.estimated_persons ?? '–';
  $('tracked-persons').textContent = points.length;
  $('count-warn').hidden = data.estimated_persons == null || data.estimated_persons === points.length;

  const f = data.features ?? {};
  motionHistory.push([now, f.motion_band_power ?? 0]);
  drawSpark(now);
  $('raw').innerHTML = [
    ['RSSI', `${fmt(f.mean_rssi, 0)} dBm`],
    ['Bewegungsenergie', fmt(f.motion_band_power)],
    ['Atemband-Energie', fmt(f.breathing_band_power)],
    ['Varianz', fmt(f.variance)],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function setSource(source) {
  const chip = $('source-chip');
  const s = String(source ?? '');
  chip.className = 'chip';
  if (s === 'simulated' || s === 'mock') {
    chip.classList.add('sim');
    chip.textContent = s === 'mock' ? 'Testdaten im Browser' : 'Simulierte Daten';
  } else if (!s || s.includes('offline')) {
    chip.classList.add('off');
    chip.textContent = s ? 'Sensor offline' : 'Keine Verbindung';
  } else {
    chip.classList.add('live');
    chip.textContent = `Live: ${s}`;
  }
}

async function pollHealth() {
  try {
    const res = await fetch('/health');
    setSource(res.ok ? (await res.json()).source : null);
  } catch {
    setSource(null);
  }
}

async function pollLatest() {
  try {
    const res = await fetch('/api/v1/sensing/latest');
    if (res.ok) render(await res.json());
    else if (res.status === 401) setSource('Token falsch');
  } catch {
    setSource(null);
  }
}

// Der eigene Grundriss liegt nur auf dem Server (config/, per Volume eingebunden);
// fehlt er, zeigt die Demo die Beispielwohnung aus dem Repo.
async function loadPlan() {
  for (const url of ['config/floorplan.json', 'floorplan.json']) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch { /* nächste Quelle versuchen */ }
  }
  throw new Error('Kein Grundriss gefunden');
}

async function start() {
  plan = await loadPlan();
  buildPlan();
  if (useMock) {
    setSource('mock');
    const t0 = performance.now();
    setInterval(() => render(mockLatest((performance.now() - t0) / 1000)), POLL_MS);
    return;
  }
  pollHealth();
  setInterval(pollHealth, HEALTH_MS);
  pollLatest();
  setInterval(pollLatest, POLL_MS);
}

start();
