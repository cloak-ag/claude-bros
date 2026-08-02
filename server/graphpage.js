import { THEME_CSS, NAV_CSS, nav } from './theme.js';

/**
 * The shared brain in three dimensions — force-directed in x/y/z, perspective
 * projected, depth-sorted, and alive.
 *
 * Encoding, unchanged from the flat version and for the same reason:
 *  - SHAPE carries node type. Only three hues clear the colourblind all-pairs
 *    separation gate for scattered marks and there are five types, so colour
 *    cannot carry type honestly.
 *  - COLOUR carries status, from the reserved status palette.
 *  - SIZE carries degree, then perspective scales it by distance.
 *
 * Depth is sold with four cues at once, because perspective alone reads flat on
 * a dark field: nodes shrink with distance, fade into the background haze, lose
 * contrast, and are painted back-to-front so nearer things genuinely occlude.
 * Pulsing is not decoration — amplitude tracks severity, so the things that
 * need attention are the things that move.
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
  /* The void the graph floats in. Declared as a variable so the fog colour the
     canvas blends toward is read from the same place — they cannot disagree. */
  :root { --void:#f4f4f1; --void-edge:#e6e6e1; }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) { --void:#0d0d14; --void-edge:#06060a; }
  }
  :root[data-theme="dark"] { --void:#0d0d14; --void-edge:#06060a; }
  .stage { position:relative; border:1px solid var(--line); border-radius:12px; overflow:hidden;
           background:radial-gradient(125% 95% at 50% 42%,
             color-mix(in srgb, var(--void) 88%, white 12%) 0%, var(--void) 55%, var(--void-edge) 100%); }
  canvas { display:block; width:100%; cursor:grab; touch-action:none; }
  canvas.drag { cursor:grabbing; }

  .legend { position:absolute; left:14px; bottom:14px; display:flex; gap:15px; flex-wrap:wrap;
            background:color-mix(in srgb, var(--surface) 82%, transparent); backdrop-filter:blur(8px);
            border:1px solid var(--line); border-radius:10px; padding:9px 12px; font-size:11px; }
  .legend div { display:flex; align-items:center; gap:5px; color:var(--ink-2); }

  .panel { position:absolute; right:14px; top:14px; width:290px; max-height:calc(100% - 28px);
           overflow-y:auto; background:color-mix(in srgb, var(--surface) 92%, transparent);
           backdrop-filter:blur(10px); border:1px solid var(--line); border-radius:10px;
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
  .controls input[type=search] { flex:1; min-width:170px; background:var(--plane); color:var(--ink);
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
  <button class="chip on" id="spin">auto-orbit</button>
  <span class="hint">drag to orbit · scroll to zoom · click a node to focus</span>
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

const STATUS = { good:'#0ca30c', warn:'#fab219', bad:'#d03b3b', open:'#8b8b93', idle:'#4a4a52' };
// How hard each status breathes. Problems pulse; settled things sit still.
const PULSE  = { bad:1, warn:0.62, open:0.3, good:0.12, idle:0 };
const TYPES = ['agent','goal','task','finding','file'];
const hidden = new Set();

let nodes = [], edges = [], byId = new Map();
let selected = null, hover = null, spinning = true;
// Camera: yaw/pitch orbit around the origin at cam.dist, focal length cam.f.
const cam = { yaw:0.5, pitch:-0.25, dist:900, f:820, panX:0, panY:0 };
const canvas = el('c'), ctx = canvas.getContext('2d');
let W = 0, H = 0, dpr = Math.min(devicePixelRatio || 1, 2);
let haze = '#0a0a0e';

/** Take the fog colour straight from the CSS variable the stage is painted with. */
function readHaze() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--void').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) haze = v;
}

function resize() {
  const stage = canvas.parentElement;
  W = stage.clientWidth;
  H = Math.max(440, innerHeight - stage.getBoundingClientRect().top - 40);
  canvas.style.height = H + 'px';
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', () => { resize(); });

const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
const mix = (hex, other, t) => {
  const a = [1,3,5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const b = [1,3,5].map((i) => parseInt(other.slice(i, i + 2), 16));
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';
};

/** Rotate by yaw then pitch, translate away from the camera, perspective divide. */
function project(n) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const x1 = n.x * cy - n.z * sy;
  const z1 = n.x * sy + n.z * cy;
  const y1 = n.y * cp - z1 * sp;
  const z2 = n.y * sp + z1 * cp + cam.dist;
  if (z2 < 40) return null;                       // behind or through the lens
  const s = cam.f / z2;
  return { sx: W / 2 + x1 * s + cam.panX, sy: H / 2 + y1 * s + cam.panY, s, z: z2 };
}

function shape(c, type, x, y, r) {
  c.beginPath();
  if (type === 'agent') c.arc(x, y, r, 0, Math.PI * 2);
  else if (type === 'goal') { c.moveTo(x, y - r); c.lineTo(x + r, y + r * 0.8); c.lineTo(x - r, y + r * 0.8); c.closePath(); }
  else if (type === 'finding') { c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); }
  else if (type === 'task') { const s = r * 0.82; c.roundRect(x - s, y - s, s * 2, s * 2, Math.max(1, r * 0.25)); }
  else {
    for (let i = 0; i < 6; i += 1) {
      const a = Math.PI / 3 * i - Math.PI / 6;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath();
  }
}

const baseR = (n) => 3.4 + Math.min(Math.sqrt(n.degree) * 2.1, 11);
const visible = (n) => !hidden.has(n.type);

function neighboursOf(id) {
  const set = new Set([id]);
  for (const e of edges) {
    if (e.from === id) set.add(e.to);
    else if (e.to === id) set.add(e.from);
  }
  return set;
}

let t0 = performance.now(), lastRender = 0, rafQueued = false;

/**
 * requestAnimationFrame is the right clock, but a browser stops firing it for
 * any tab it is not compositing — a second monitor, a background window — and
 * the graph would sit frozen. A slow watchdog keeps it alive at a few frames a
 * second in that case, and stands down as soon as rAF resumes.
 */
function schedule() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame((now) => { rafQueued = false; frame(now); schedule(); });
}
setInterval(() => {
  if (performance.now() - lastRender > 400) frame(performance.now());
}, 450);

function frame(now) {
  lastRender = now;
  const t = (now - t0) / 1000;
  if (spinning && !dragging && !panning) cam.yaw += 0.0016;

  ctx.clearRect(0, 0, W, H);
  const focus = selected ? neighboursOf(selected) : null;

  // Project once per frame; everything downstream reads these.
  for (const n of nodes) n.p = visible(n) ? project(n) : null;

  // Depth range, for fog and contrast falloff.
  let near = Infinity, far = -Infinity;
  for (const n of nodes) if (n.p) { near = Math.min(near, n.p.z); far = Math.max(far, n.p.z); }
  const span = Math.max(far - near, 1);
  const fogOf = (z) => Math.min(Math.max((z - near) / span, 0), 1);

  // Edges first, back to front, faded by their far end.
  const drawable = edges
    .map((e) => ({ e, a: byId.get(e.from), b: byId.get(e.to) }))
    .filter(({ a, b }) => a?.p && b?.p)
    .sort((p, r) => Math.max(r.a.p.z, r.b.p.z) - Math.max(p.a.p.z, p.b.p.z));

  for (const { e, a, b } of drawable) {
    const lit = !focus || (focus.has(e.from) && focus.has(e.to));
    const fog = fogOf((a.p.z + b.p.z) / 2);
    ctx.globalAlpha = lit ? (focus ? 0.9 : 0.30) * (1 - fog * 0.72) : 0.04;
    ctx.strokeStyle = lit && focus ? '#8b8b93' : mix('#8b8b93', haze, fog * 0.6);
    ctx.lineWidth = Math.max(0.4, (lit && focus ? 1.5 : 0.9) * ((a.p.s + b.p.s) / 2));
    ctx.setLineDash(e.inferred ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(a.p.sx, a.p.sy); ctx.lineTo(b.p.sx, b.p.sy); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Nodes back to front so near ones occlude far ones.
  const order = nodes.filter((n) => n.p).sort((a, b) => b.p.z - a.p.z);
  for (const n of order) {
    const lit = !focus || focus.has(n.id);
    const fog = fogOf(n.p.z);
    // Breathing: amplitude by status, phase by id so the field never marches in step.
    const amp = PULSE[n.status] ?? 0.2;
    const beat = 0.5 + 0.5 * Math.sin(t * (1.5 + amp) + n.phase);
    const r = Math.max(1, baseR(n) * n.p.s * (1 + beat * amp * 0.34));
    const colour = mix(STATUS[n.status] || STATUS.open, haze, fog * 0.78);

    // Halo — only where it earns its cost: things that need attention, and hubs.
    if (lit && amp > 0.5) {
      const glow = r * (3.1 + beat * 1.5);
      const g = ctx.createRadialGradient(n.p.sx, n.p.sy, r * 0.4, n.p.sx, n.p.sy, glow);
      g.addColorStop(0, mix(STATUS[n.status], haze, 0.25));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = (0.16 + beat * 0.22) * (1 - fog * 0.7);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(n.p.sx, n.p.sy, glow, 0, Math.PI * 2); ctx.fill();
    }

    ctx.globalAlpha = lit ? 1 - fog * 0.5 : 0.08;
    shape(ctx, n.type, n.p.sx, n.p.sy, r);
    ctx.fillStyle = colour;
    ctx.fill();
    if (n.id === selected || n.id === hover) {
      ctx.lineWidth = 1.6; ctx.strokeStyle = 'currentColor'; ctx.stroke();
    }

    // Only label what is near, connected and worth reading.
    if (lit && (n.id === selected || n.id === hover || (focus && n.p.s > 0.55) || (!focus && n.degree >= 8 && fog < 0.55))) {
      ctx.globalAlpha = (1 - fog * 0.8) * (lit ? 0.95 : 0.1);
      ctx.font = Math.max(9, 11 * n.p.s) + 'px ui-monospace, monospace';
      ctx.fillStyle = 'currentColor';
      ctx.textAlign = 'center';
      ctx.fillText(n.label.slice(0, 26), n.p.sx, n.p.sy - r - 4);
    }
  }
  ctx.globalAlpha = 1;
}

/** Force layout in three dimensions. 163 nodes keeps O(n²) comfortable. */
function simulate(steps = 300) {
  const live = nodes.filter(visible);
  for (const n of live) { n.vx = 0; n.vy = 0; n.vz = 0; }
  for (let step = 0; step < steps; step += 1) {
    const cool = 1 - step / steps;
    for (let i = 0; i < live.length; i += 1) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j += 1) {
        const b = live[j];
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        let d2 = dx * dx + dy * dy + dz * dz || 0.01;
        if (d2 > 250000) continue;
        const d = Math.sqrt(d2), f = 5200 / d2;
        dx /= d; dy /= d; dz /= d;
        a.vx -= dx * f; a.vy -= dy * f; a.vz -= dz * f;
        b.vx += dx * f; b.vy += dy * f; b.vz += dz * f;
      }
    }
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b || !visible(a) || !visible(b)) continue;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.hypot(dx, dy, dz) || 0.01;
      const f = (d - 90) * 0.011;
      const ux = dx / d * f, uy = dy / d * f, uz = dz / d * f;
      a.vx += ux; a.vy += uy; a.vz += uz;
      b.vx -= ux; b.vy -= uy; b.vz -= uz;
    }
    for (const n of live) {
      n.vx -= n.x * 0.0013; n.vy -= n.y * 0.0013; n.vz -= n.z * 0.0013;
      n.x += n.vx * cool; n.y += n.vy * cool; n.z += n.vz * cool;
      n.vx *= 0.84; n.vy *= 0.84; n.vz *= 0.84;
    }
  }
}

function fit() {
  const live = nodes.filter(visible);
  if (!live.length) return;
  let max = 1;
  for (const n of live) max = Math.max(max, Math.hypot(n.x, n.y, n.z));
  cam.dist = max * 1.55 + 150;
  cam.panX = 0; cam.panY = 0;
}

function at(px, py) {
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    if (!n.p || !visible(n)) continue;
    const d = Math.hypot(n.p.sx - px, n.p.sy - py);
    const r = baseR(n) * n.p.s + 7;
    if (d < r && d < bestD) { best = n; bestD = d; }
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
el('close').onclick = () => { selected = null; el('panel').classList.remove('on'); };

let dragging = null, panning = null, pressAt = null, moved = 0, orbiting = null;
canvas.addEventListener('pointerdown', (ev) => {
  pressAt = { x: ev.offsetX, y: ev.offsetY }; moved = 0;
  const n = at(ev.offsetX, ev.offsetY);
  canvas.setPointerCapture(ev.pointerId);
  if (n) dragging = n;
  else if (ev.shiftKey || ev.button === 1) panning = { x: ev.offsetX - cam.panX, y: ev.offsetY - cam.panY };
  else orbiting = { x: ev.offsetX, y: ev.offsetY, yaw: cam.yaw, pitch: cam.pitch };
  canvas.classList.add('drag');
});
canvas.addEventListener('pointermove', (ev) => {
  if (pressAt) moved = Math.max(moved, Math.hypot(ev.offsetX - pressAt.x, ev.offsetY - pressAt.y));
  if (dragging) {
    // Drag in the screen plane, then unproject back into world space.
    const s = dragging.p ? dragging.p.s : 1;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const dx = (ev.offsetX - pressAt.x) / s, dy = (ev.offsetY - pressAt.y) / s;
    dragging.x += dx * cy; dragging.z += dx * sy; dragging.y += dy;
    pressAt = { x: ev.offsetX, y: ev.offsetY };
    return;
  }
  if (orbiting) {
    cam.yaw = orbiting.yaw + (ev.offsetX - orbiting.x) * 0.006;
    cam.pitch = Math.max(-1.4, Math.min(1.4, orbiting.pitch + (ev.offsetY - orbiting.y) * 0.006));
    return;
  }
  if (panning) { cam.panX = ev.offsetX - panning.x; cam.panY = ev.offsetY - panning.y; return; }
  const n = at(ev.offsetX, ev.offsetY);
  if (n?.id !== hover) { hover = n?.id || null; canvas.style.cursor = n ? 'pointer' : 'grab'; }
});
addEventListener('pointerup', () => {
  const wasClick = moved < 4;
  if (dragging && wasClick) { selected = dragging.id; showPanel(dragging); }
  else if (!dragging && wasClick && !panning) { selected = null; el('panel').classList.remove('on'); }
  dragging = null; orbiting = null; panning = null; pressAt = null;
  canvas.classList.remove('drag');
});
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  cam.dist = Math.min(Math.max(cam.dist * (ev.deltaY < 0 ? 0.9 : 1.11), 120), 6000);
}, { passive: false });

el('spin').onclick = () => { spinning = !spinning; el('spin').classList.toggle('on', spinning); };

el('find').addEventListener('input', (ev) => {
  const needle = ev.target.value.trim().toLowerCase();
  if (!needle) { selected = null; el('panel').classList.remove('on'); return; }
  const hit = nodes.find((n) => visible(n) && (n.label.toLowerCase().includes(needle) || (n.detail || '').toLowerCase().includes(needle)));
  if (hit) { selected = hit.id; showPanel(hit); }
});

for (const chip of document.querySelectorAll('.chip[data-type]')) {
  chip.onclick = () => {
    const t = chip.dataset.type;
    hidden.has(t) ? hidden.delete(t) : hidden.add(t);
    chip.classList.toggle('on', !hidden.has(t));
    simulate(140); fit();
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
  + '<div><svg width="26" height="14"><line x1="1" y1="7" x2="25" y2="7" stroke="currentColor" stroke-dasharray="4 4"/></svg>inferred</div>'
  + '<div class="hint">pulse = needs attention</div>';

async function load() {
  const res = await fetch('/api/graph' + q);
  if (!res.ok) { el('when').textContent = 'relay unreachable'; return; }
  const g = await res.json();
  const previous = new Map(nodes.map((n) => [n.id, n]));
  nodes = g.nodes.map((n) => {
    const old = previous.get(n.id);
    return {
      ...n,
      x: old?.x ?? (Math.random() - 0.5) * 600,
      y: old?.y ?? (Math.random() - 0.5) * 600,
      z: old?.z ?? (Math.random() - 0.5) * 600,
      phase: hash(n.id) % 628 / 100,
    };
  });
  edges = g.edges;
  byId = new Map(nodes.map((n) => [n.id, n]));
  el('when').textContent = nodes.length + ' nodes · ' + edges.length + ' links';
  readHaze(); resize();
  if (!previous.size) { simulate(); fit(); } else simulate(90);
}
load().then(schedule);
setInterval(load, 15000);
</script>
</body>
</html>`;
