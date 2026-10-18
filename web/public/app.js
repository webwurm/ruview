import { mockLatest } from './mock.js';

const POLL_MS = 500;
const HEALTH_MS = 5000;
const NODES_MS = 2000;
const TRAIL_LEN = 24;
// Eigene Verfolgung: RuView-IDs wechseln ständig, die Positionen springen.
const MATCH_RADIUS_M = 2.5;   // so weit darf eine Erkennung vom letzten Punkt entfernt sein
const CONFIRM_HITS = 3;       // erst nach so vielen Treffern als Person zählen
const MAX_MISSES = 4;         // nach so vielen Aussetzern (je 0,5 s) verwerfen
const MERGE_RADIUS_M = 1.0;   // näher beieinander ist für uns dieselbe Person
const SENSOR_KEY = 'ruview-demo-sensor';
const SPARK_SECONDS = 60;
const COUNT_WINDOW_MS = 10000; // Personenzahl über so viele ms mitteln

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
let origin = [0, 0];      // wo RuViews Nullpunkt im Grundriss liegt (ruview_origin)
let placing = false;      // Sensor wird gerade per Klick gesetzt
let nextTrackNo = 1;
const tracks = [];        // { no, pos: [x,y], hits, misses, points, SVG-Elemente }
const motionHistory = []; // [timestamp, motion_band_power]
const countHistory = [];  // [timestamp, estimated_persons]

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

// RuView-Weltkoordinaten (x, z in Metern) -> Grundriss-Koordinaten.
function toPlan([x, , z]) {
  return [origin[0] + x, origin[1] + z];
}

// Wo stehen die Sensoren? Im Browser gesetzt (Klick) vor floorplan.json.
// RuView kennt die Standorte nicht: ohne Angabe meldet es alle Sensoren an derselben Stelle.
function savedPlacements() {
  try {
    const saved = JSON.parse(localStorage.getItem(SENSOR_KEY));
    if (Array.isArray(saved)) return saved;
  } catch { /* kein gespeicherter Wert */ }
  return [];
}

function sensorPlacement() {
  const byId = new Map((plan.sensors ?? []).map((s) => [s.node_id, s]));
  for (const s of savedPlacements()) byId.set(s.node_id, s);
  return [...byId.values()].sort((a, b) => a.node_id - b.node_id);
}

function svgPoint(evt) {
  const svg = $('plan');
  const pt = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10];
}

const knownNodes = new Set();

// Auswahlliste mit allen Sensoren, die RuView meldet oder die schon gesetzt sind.
function updateNodeSelect(nodes = []) {
  const before = knownNodes.size;
  for (const n of nodes) knownNodes.add(n.node_id);
  for (const s of sensorPlacement()) knownNodes.add(s.node_id);
  if (knownNodes.size === before && before > 0) return;
  const select = $('place-node');
  const current = Number(select.value);
  select.replaceChildren(...[...knownNodes].sort((a, b) => a - b).map((id) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `Sensor ${id}`;
    return o;
  }));
  if (knownNodes.has(current)) select.value = current;
}

function setupSensorPlacement() {
  const btn = $('place-sensor');
  const select = $('place-node');
  btn.addEventListener('click', () => {
    placing = !placing;
    btn.classList.toggle('active', placing);
    $('place-hint').hidden = !placing;
  });
  $('plan').addEventListener('click', (evt) => {
    if (!placing) return;
    placing = false;
    btn.classList.remove('active');
    $('place-hint').hidden = true;
    const nodeId = Number(select.value);
    const local = savedPlacements().filter((s) => s.node_id !== nodeId);
    local.push({ node_id: nodeId, position: svgPoint(evt) });
    try { localStorage.setItem(SENSOR_KEY, JSON.stringify(local)); } catch { /* nur für diese Sitzung */ }
    if (!savedPlacements().length) plan.sensors = [...(plan.sensors ?? []).filter((s) => s.node_id !== nodeId), local.at(-1)];
    // Gleich den nächsten noch nicht gesetzten Sensor vorwählen.
    const placed = new Set(sensorPlacement().map((s) => s.node_id));
    const next = [...knownNodes].sort((a, b) => a - b).find((id) => !placed.has(id));
    if (next != null) select.value = next;
    const snippet = $('sensor-snippet');
    snippet.hidden = false;
    snippet.querySelector('code:last-of-type').textContent = `"sensors": ${JSON.stringify(sensorPlacement())}`;
  });
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
  const placed = new Map(sensorPlacement().map((s) => [s.node_id, s.position]));
  const online = new Set(nodes.map((n) => n.node_id));
  let unplaced = 0;
  for (const id of [...new Set([...online, ...placed.keys()])].sort((a, b) => a - b)) {
    let x, y, label = `Sensor ${id}`;
    if (placed.has(id)) {
      [x, y] = placed.get(id);
    } else {
      // RuView meldet ungesetzte Sensoren alle am selben Punkt; untereinander zeigen.
      const n = nodes.find((m) => m.node_id === id);
      [x, y] = toPlan(n.position ?? [0, 0, 0]);
      y += unplaced++ * 0.45;
      label += ' (Lage unbekannt)';
    }
    if (!online.has(id)) label += ' (offline)';
    const grp = el('g', { class: online.has(id) ? '' : 'offline' }, g);
    el('rect', { class: 'node', x: x - 0.12, y: y - 0.12, width: 0.24, height: 0.24, rx: 0.05 }, grp);
    el('text', { class: 'node-label', x: x + 0.2, y: y + 0.08 }, grp).textContent = label;
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Ordnet die Erkennungen eines Frames den bestehenden Spuren zu (nächster Nachbar)
// und glättet die Position, statt jedem Sprung von RuView zu folgen.
function updateTracks(detections) {
  const alpha = Number($('smoothing').value);
  const free = [...detections];
  for (const t of tracks) {
    let best = -1;
    for (let i = 0; i < free.length; i++) {
      const d = dist(t.pos, free[i]);
      if (d < MATCH_RADIUS_M && (best < 0 || d < dist(t.pos, free[best]))) best = i;
    }
    if (best >= 0) {
      const [d] = free.splice(best, 1);
      t.pos = [t.pos[0] + alpha * (d[0] - t.pos[0]), t.pos[1] + alpha * (d[1] - t.pos[1])];
      t.hits++;
      t.misses = 0;
    } else {
      t.misses++;
    }
  }
  for (const d of free) tracks.push({ pos: d, hits: 1, misses: 0, points: [] });
  // RuView findet für eine Person oft mehrere Spitzen dicht nebeneinander.
  // Davon bleibt die Spur mit den meisten Treffern.
  tracks.sort((a, b) => b.hits - a.hits);
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    const merged = tracks.some((o, j) => j < i && dist(o.pos, t.pos) < MERGE_RADIUS_M);
    if (merged || t.misses > MAX_MISSES) {
      t.halo?.remove(); t.dot?.remove(); t.label?.remove(); t.trail?.remove();
      tracks.splice(i, 1);
    }
  }
}

function drawPersons(persons) {
  const g = $('persons');
  const trails = $('trails');
  // Position [0,0,0] heißt bei RuView: keine Spitze in der Signalkarte gefunden.
  const detections = persons
    .filter((p) => p.position && !p.position.every((v) => v === 0))
    .map((p) => toPlan(p.position));
  updateTracks(detections);

  const confirmed = [];
  for (const t of tracks) {
    if (t.hits < CONFIRM_HITS) continue;
    if (!t.dot) {
      t.no = nextTrackNo++;
      t.halo = el('circle', { class: 'person-halo', r: 0.42 }, g);
      t.dot = el('circle', { class: 'person', r: 0.16 }, g);
      t.label = el('text', { class: 'person-label', 'text-anchor': 'middle' }, g);
      t.trail = el('polyline', { class: 'trail' }, trails);
    }
    const pt = t.pos;
    t.points.push(pt);
    if (t.points.length > TRAIL_LEN) t.points.shift();
    for (const c of [t.halo, t.dot]) { c.setAttribute('cx', pt[0]); c.setAttribute('cy', pt[1]); }
    // Bei Aussetzern verblassen, statt sofort zu verschwinden.
    const fade = String(1 - t.misses / (MAX_MISSES + 1));
    for (const c of [t.halo, t.dot, t.label]) c.style.opacity = fade;
    t.label.setAttribute('x', pt[0]);
    t.label.setAttribute('y', pt[1] - 0.5);
    t.label.textContent = `Person ${t.no}`;
    t.trail.setAttribute('points', $('show-trails').checked ? t.points.map((q) => q.join(',')).join(' ') : '');
    if (t.misses === 0) confirmed.push(pt);
  }
  return confirmed;
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

  updateNodeSelect(data.nodes);
  drawField(data.signal_field);
  drawNodes(data.nodes);
  const points = drawPersons(persons);
  updateRooms(points);

  // RuView nimmt den höchsten Wert aller Sensoren; ein einzelner Ausreißer zählt sonst sofort.
  countHistory.push([now, data.estimated_persons ?? 0]);
  while (now - countHistory[0][0] > COUNT_WINDOW_MS) countHistory.shift();
  const counts = countHistory.map(([, c]) => c);
  const avg = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  $('est-persons').textContent = avg;
  $('est-range').textContent = lo === hi ? 'geschätzte Anzahl' : `geschätzt, schwankt ${lo} bis ${hi}`;
  $('tracked-persons').textContent = points.length;
  $('count-warn').hidden = avg === points.length;

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

// Was jeder Sensor selbst zählt. RuView meldet als Gesamtzahl den höchsten dieser Werte.
function renderNodes(nodes = []) {
  $('per-node').replaceChildren(...nodes.map((n) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `Sensor ${n.node_id}${n.status === 'stale' ? ' (keine Daten)' : ''}`;
    const value = document.createElement('strong');
    value.textContent = `zählt ${n.person_count ?? '–'}`;
    li.append(label, value);
    return li;
  }));
}

async function pollNodes() {
  try {
    const res = await fetch('/api/v1/nodes');
    if (res.ok) renderNodes((await res.json()).nodes);
  } catch { /* nächster Versuch */ }
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
  origin = plan.ruview_origin ?? [plan.width / 2, plan.height / 2];
  buildPlan();
  setupSensorPlacement();
  if (useMock) {
    setSource('mock');
    const t0 = performance.now();
    setInterval(() => render(mockLatest((performance.now() - t0) / 1000)), POLL_MS);
    renderNodes([1, 2, 3].map((id) => ({ node_id: id, status: 'active', person_count: id === 2 ? 4 : 1 })));
    return;
  }
  pollHealth();
  setInterval(pollHealth, HEALTH_MS);
  pollLatest();
  setInterval(pollLatest, POLL_MS);
  pollNodes();
  setInterval(pollNodes, NODES_MS);
}

start();
