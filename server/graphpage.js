import { THEME_CSS, NAV_CSS, nav } from './theme.js';

/**
 * An Obsidian-style view of the shared brain: force-directed, canvas, no
 * dependencies.
 *
 * Encoding decisions, and why:
 *  - SHAPE carries node type. Only three hues clear the colourblind
 *    all-pairs separation gate for scattered marks, and there are five types,
 *    so colour cannot do this job honestly.
 *  - COLOUR carries status, using the reserved status palette. "Where are the
 *    problems" is the question you bring to this view anyway.
 *  - SIZE carries degree — how connected a thing is — so hubs are findable.
 *  - Inferred edges (file paths parsed out of a finding's prose) are dashed, so
 *    a guess never looks like a recorded fact.
 */
export const graphHtml = (roomName, query = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-bros — graph</title>
<style>
${THEME_CSS}
${NAV_CSS}
  body { padding:0 24px 24px; overflow:hidden; }
  .stage { position:relative; border:1px solid var(--line); border-radius:12px;
           background:var(--surface); overflow:hidden; }
  canvas { display:block; width:100%; cursor:grab; }
  canvas.drag { cursor:grabbing; }

  .legend { position:absolute; left:14px; bottom:14px; display:flex; gap:16px; flex-wrap:wrap;
            background:color-mix(in srgb, var(--surface) 88%, transparent); backdrop-filter:blur(6px);
            border:1px solid var(--line); border-radius:10px; padding:9px 12px; font-size:11px; }
  .legend div { display:flex; align-items:center; gap:5px; color:var(--ink-2); }
  .legend svg { flex:none; }

  .panel { position:absolute; right:14px; top:14px; width:290px; max-height:calc(100% - 28px);
           overflow-y:auto; background:color-mix(in srgb, var(--surface) 94%, transparent);
           backdrop-filter:blur(8px); border:1px solid var(--line); border-radius:10px;
           padding:14px; font-size:12.5px; display:none; }
  .panel.on { display:block; }
  .panel h3 { margin:0 0 2px; font-size:13px; }
  .panel .kind { font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
  .panel .detail { color:var(--ink-2); margin:8px 0; word-break:break-word; }
  .panel ul { margin:6px 0 0; padding-left:16px; }
  .panel li { margin-bottom:3px; color:var(--ink-2); }
  .panel .close { position:absolute; right:10px; top:8px; cursor:pointer; color:var(--muted);
                  font-size:16px; line-height:1; background:none; border:0; }

  .controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 12px; }
  .controls input[type=search] { flex:1; min-width:180px; background:var(--plane); color:var(--ink);
    border:1px solid var(--line); border-radius:8px; padding:6px 10px; font:inherit; font-size:12.5px; }
  .chip { font-size:11px; font-family:var(--mono); padding:3px 9px; border-radius:999px;
          border:1px solid var(--line); color:var(--muted); cursor:pointer; user-select:none; background:none; }
  .chip.on { color:var(--ink); background:var(--plane); border-color:var(--rule); }
  .hint { color:var(--muted); font-size:11px; }
</style>
</head>
<body>
<div class="head">
  <h1>claude-bros <span class="room">· ${roomName}</span></h1>
  ${nav('graph', query)}
  <div class="when" id="when">loading…</div>
</div>

<div class="controls">
  <input type="search" id="find" placeholder="Search files, findings, tasks, agents…" autocomplete="off">
  <button class="chip on" data-type="agent">agents</button>
  <button class="chip on" data-type="goal">goals</button>
  <button class="chip on" data-type="task">tasks</button>
  <button class="chip on" data-type="finding">findings</button>
  <button class="chip on" data-type="file">files</button>
  <span class="hint">drag to pan · scroll to zoom · click a node to focus</span>
</div>

<div class="stage">
  <canvas id="c"></canvas>
  <div class="legend" id="legend"></div>
  <div class="panel" id="panel"><button class="close" id="close">×</button><div id="panelBody"></div></div>
</div>

<script>
const token = new URLSearchParams(location.search).get('token');
const q = token ? '?token=' + encodeURIComponent(token) : '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const el = (id) => document.getElementById(id);

// Status palette — reserved colours, always paired with shape and a label.
const STATUS = { good:'#0ca30c', warn:'#fab219', bad:'#d03b3b', open:'#8b8b93', idle:'#4a4a52' };
const TYPES = ['agent','goal','task','finding','file'];
const hidden = new Set();

let nodes = [], edges = [], byId = new Map();
let selected = null, hover = null;
let view = { x:0, y:0, k:1 };
const canvas = el('c'), ctx = canvas.getContext('2d');
let W = 0, H = 0, dpr = Math.min(devicePixelRatio || 1, 2);

function resize() {
  const stage = canvas.parentElement;
  W = stage.clientWidth;
  H = Math.max(420, innerHeight - stage.getBoundingClientRect().top - 40);
  canvas.style.height = H + 'px';
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', () => { resize(); draw(); });

/** Each type gets its own silhouette, readable with no colour at all. */
function shape(c, type, x, y, r) {
  c.beginPath();
  if (type === 'agent') c.arc(x, y, r, 0, Math.PI * 2);
  else if (type === 'goal') { c.moveTo(x, y - r); c.lineTo(x + r, y + r * 0.8); c.lineTo(x - r, y + r * 0.8); c.closePath(); }
  else if (type === 'finding') { c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); }
  else if (type === 'task') { const s = r * 0.85; c.roundRect(x - s, y - s, s * 2, s * 2, 3); }
  else { // file — hexagon
    for (let i = 0; i < 6; i += 1) {
      const a = Math.PI / 3 * i - Math.PI / 6;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath();
  }
}

const radius = (n) => 4 + Math.min(Math.sqrt(n.degree) * 2.4, 13);
const visible = (n) => !hidden.has(n.type);

function neighboursOf(id) {
  const set = new Set([id]);
  for (const e of edges) {
    if (e.from === id) set.add(e.to);
    else if (e.to === id) set.add(e.from);
  }
  return set;
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  const focus = selected ? neighboursOf(selected) : null;

  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || !visible(a) || !visible(b)) continue;
    const lit = !focus || (focus.has(e.from) && focus.has(e.to));
    ctx.globalAlpha = lit ? (focus ? 0.85 : 0.34) : 0.06;
    ctx.strokeStyle = lit && focus ? STATUS.open : 'currentColor';
    ctx.lineWidth = (lit && focus ? 1.6 : 1) / view.k;
    ctx.setLineDash(e.inferred ? [4 / view.k, 4 / view.k] : []);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const n of nodes) {
    if (!visible(n)) continue;
    const lit = !focus || focus.has(n.id);
    ctx.globalAlpha = lit ? 1 : 0.12;
    const r = radius(n);
    shape(ctx, n.type, n.x, n.y, r);
    ctx.fillStyle = STATUS[n.status] || STATUS.open;
    ctx.fill();
    if (n.id === selected || n.id === hover) {
      ctx.lineWidth = 2 / view.k; ctx.strokeStyle = 'currentColor'; ctx.stroke();
    }
    // Label hubs, the selection, and whatever is under the cursor. Labelling
    // everything at 163 nodes is unreadable soup.
    if (lit && (n.degree >= 6 || n.id === selected || n.id === hover || focus)) {
      ctx.globalAlpha = lit ? 0.9 : 0.1;
      ctx.font = (11 / view.k) + 'px ui-monospace, monospace';
      ctx.fillStyle = 'currentColor';
      ctx.textAlign = 'center';
      ctx.fillText(n.label.slice(0, 28), n.x, n.y - r - 4 / view.k);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Plain spring/repulsion layout. 163 nodes is small enough for O(n²). */
function simulate(steps = 260) {
  const live = nodes.filter(visible);
  for (const n of live) { n.vx = 0; n.vy = 0; }
  for (let step = 0; step < steps; step += 1) {
    const t = 1 - step / steps;
    for (let i = 0; i < live.length; i += 1) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j += 1) {
        const b = live[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 90000) continue;                 // ignore distant pairs
        const f = 2600 / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f;
        b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b || !visible(a) || !visible(b)) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d - 70) * 0.012;
      const ux = dx / d * f, uy = dy / d * f;
      a.vx += ux; a.vy += uy; b.vx -= ux; b.vy -= uy;
    }
    for (const n of live) {
      n.vx -= n.x * 0.0016; n.vy -= n.y * 0.0016;   // gentle pull to centre
      n.x += n.vx * t; n.y += n.vy * t;
      n.vx *= 0.82; n.vy *= 0.82;
    }
  }
}

function fit() {
  const live = nodes.filter(visible);
  if (!live.length) return;
  const xs = live.map((n) => n.x), ys = live.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = Math.min(W / (maxX - minX + 120), H / (maxY - minY + 120), 2.2);
  view.k = k;
  view.x = W / 2 - ((minX + maxX) / 2) * k;
  view.y = H / 2 - ((minY + maxY) / 2) * k;
}

function at(px, py) {
  const x = (px - view.x) / view.k, y = (py - view.y) / view.k;
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < radius(n) + 6 && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

function showPanel(n) {
  const ring = [...neighboursOf(n.id)].filter((id) => id !== n.id).map((id) => byId.get(id)).filter(Boolean);
  const how = (other) => (edges.find((e) =>
    (e.from === n.id && e.to === other.id) || (e.to === n.id && e.from === other.id)) || {}).kind || '';
  el('panelBody').innerHTML =
    '<div class="kind">' + esc(n.type) + '</div>'
    + '<h3>' + esc(n.label) + '</h3>'
    + (n.detail && n.detail !== n.label ? '<div class="detail">' + esc(n.detail) + '</div>' : '')
    + '<div class="kind">' + ring.length + ' connection' + (ring.length === 1 ? '' : 's') + '</div>'
    + '<ul>' + ring.slice(0, 40).map((o) =>
        '<li><b>' + esc(o.type) + '</b> ' + esc(o.label) + ' <span class="kind">' + esc(how(o)) + '</span></li>').join('')
    + '</ul>';
  el('panel').classList.add('on');
}

el('close').onclick = () => { selected = null; el('panel').classList.remove('on'); draw(); };

let dragging = null, panning = null, pressAt = null, moved = 0;
canvas.addEventListener('pointerdown', (ev) => {
  pressAt = { x: ev.offsetX, y: ev.offsetY };
  moved = 0;
  const n = at(ev.offsetX, ev.offsetY);
  if (n) { dragging = n; canvas.setPointerCapture(ev.pointerId); }
  else { panning = { x: ev.offsetX - view.x, y: ev.offsetY - view.y }; canvas.classList.add('drag'); }
});
canvas.addEventListener('pointermove', (ev) => {
  if (pressAt) moved = Math.max(moved, Math.hypot(ev.offsetX - pressAt.x, ev.offsetY - pressAt.y));
  if (dragging) {
    dragging.x = (ev.offsetX - view.x) / view.k;
    dragging.y = (ev.offsetY - view.y) / view.k;
    draw(); return;
  }
  if (panning) { view.x = ev.offsetX - panning.x; view.y = ev.offsetY - panning.y; draw(); return; }
  const n = at(ev.offsetX, ev.offsetY);
  if (n?.id !== hover) { hover = n?.id || null; canvas.style.cursor = n ? 'pointer' : 'grab'; draw(); }
});
addEventListener('pointerup', () => {
  const wasClick = moved < 4;
  if (dragging && wasClick) { selected = dragging.id; showPanel(dragging); }
  else if (!dragging && wasClick) { selected = null; el('panel').classList.remove('on'); }
  dragging = null; panning = null; pressAt = null;
  canvas.classList.remove('drag');
  draw();
});
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
  const mx = ev.offsetX, my = ev.offsetY;
  view.x = mx - (mx - view.x) * factor;
  view.y = my - (my - view.y) * factor;
  view.k = Math.min(Math.max(view.k * factor, 0.15), 6);
  draw();
}, { passive: false });

el('find').addEventListener('input', (ev) => {
  const needle = ev.target.value.trim().toLowerCase();
  if (!needle) { selected = null; el('panel').classList.remove('on'); draw(); return; }
  const hit = nodes.find((n) => visible(n) && (n.label.toLowerCase().includes(needle) || (n.detail || '').toLowerCase().includes(needle)));
  if (hit) {
    selected = hit.id; showPanel(hit);
    view.k = 1.4;
    view.x = W / 2 - hit.x * view.k; view.y = H / 2 - hit.y * view.k;
  }
  draw();
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.onclick = () => {
    const t = chip.dataset.type;
    hidden.has(t) ? hidden.delete(t) : hidden.add(t);
    chip.classList.toggle('on', !hidden.has(t));
    simulate(120); fit(); draw();
  };
}

el('legend').innerHTML =
  TYPES.map((t) => {
    const svg = { agent:'<circle cx="7" cy="7" r="5"/>', goal:'<polygon points="7,2 12,11 2,11"/>',
      task:'<rect x="2.5" y="2.5" width="9" height="9" rx="2"/>', finding:'<polygon points="7,2 12,7 7,12 2,7"/>',
      file:'<polygon points="7,2 11.3,4.5 11.3,9.5 7,12 2.7,9.5 2.7,4.5"/>' }[t];
    return '<div><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">' + svg + '</svg>' + t + '</div>';
  }).join('')
  + Object.entries({ good:'ok', warn:'needs attention', bad:'problem', open:'in progress' })
      .map(([k, label]) => '<div><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="' + STATUS[k] + '"/></svg>' + label + '</div>').join('')
  + '<div><svg width="26" height="14"><line x1="1" y1="7" x2="25" y2="7" stroke="currentColor" stroke-dasharray="4 4"/></svg>inferred</div>';

async function load() {
  const res = await fetch('/api/graph' + q);
  if (!res.ok) { el('when').textContent = 'relay unreachable'; return; }
  const g = await res.json();
  const previous = new Map(nodes.map((n) => [n.id, n]));
  nodes = g.nodes.map((n) => {
    const old = previous.get(n.id);
    return { ...n, x: old?.x ?? (Math.random() - 0.5) * 500, y: old?.y ?? (Math.random() - 0.5) * 500 };
  });
  edges = g.edges;
  byId = new Map(nodes.map((n) => [n.id, n]));
  el('when').textContent = nodes.length + ' nodes · ' + edges.length + ' links';
  resize(); simulate(); fit(); draw();
}
load();
setInterval(load, 15000);
</script>
</body>
</html>`;
