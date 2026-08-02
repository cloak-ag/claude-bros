import { THEME_CSS, NAV_CSS, nav } from './theme.js';

/** A human-readable window onto the room. Open it in a browser while the agents work. */
export const dashboardHtml = (roomName, query = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-bros — ${roomName}</title>
<style>
${THEME_CSS}
${NAV_CSS}
  body { padding:0 24px 60px; }

  /* stat row */
  .stats { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); margin-bottom:22px; }
  .stat { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .stat .n { font-size:26px; font-weight:600; letter-spacing:-.02em; font-variant-numeric:tabular-nums; line-height:1.15; }
  .stat .l { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.07em; margin-top:2px; }
  .stat .sub { font-size:12px; color:var(--ink-2); margin-top:6px; }

  section { background:var(--surface); border:1px solid var(--line); border-radius:12px;
            padding:16px 18px; min-width:0; margin-bottom:18px; }
  /* Three equal columns that hold their size — content scrolls inside the box
     instead of stretching it, so the row never reflows as work comes in. */
  .grid { display:grid; gap:18px; grid-template-columns:repeat(3,minmax(0,1fr)); align-items:stretch; }
  .grid section { margin-bottom:0; height:var(--pane-h,420px); display:flex; flex-direction:column; }
  .grid section > h2 { flex:none; }
  @media (max-width:1080px) { .grid { grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); } }
  @media (max-width:560px)  { .grid { grid-template-columns:1fr; } }

  .pane { overflow-y:auto; overscroll-behavior:contain; flex:1 1 auto; min-height:0; padding-right:4px; }
  .pane::-webkit-scrollbar { width:9px; }
  .pane::-webkit-scrollbar-track { background:transparent; }
  .pane::-webkit-scrollbar-thumb { background:var(--rule); border-radius:99px;
    border:2px solid var(--surface); }
  .pane::-webkit-scrollbar-thumb:hover { background:var(--muted); }
  .pane { scrollbar-width:thin; scrollbar-color:var(--rule) transparent; }
  #messages { max-height:360px; }
  #files { max-height:460px; overflow-y:auto; }
  #files table { min-width:720px; }
  #files thead th { position:sticky; top:0; background:var(--surface); z-index:1; }
  .row { padding:9px 0; border-bottom:1px solid var(--line); word-break:break-word; }
  .row:last-child { border-bottom:0; }
  .empty { color:var(--muted); font-style:italic; font-size:13px; }
  .muted { color:var(--muted); font-size:12px; }
  .ink2 { color:var(--ink-2); }

  /* agent identity: colour ALWAYS beside the name, never alone */
  .who { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-weight:600; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; box-shadow:0 0 0 2px var(--surface); }
  .off { opacity:.42; }
  /* liveness ring: a quiet agent's identity dot gets a yellow ring; offline dims the row */
  .who.st-quiet .dot { box-shadow:0 0 0 2px var(--surface), 0 0 0 3px var(--warning); }
  /* legacy beat classes from main (kept for compatibility) */
  .beat { width:7px; height:7px; border-radius:50%; flex:none; }
  .beat.fresh { background:var(--good); }
  .beat.slow  { background:var(--warning); }
  .beat.cold  { background:var(--critical); }
  .beat.gone  { background:var(--muted); }

  /* progress meter: thin, rounded data-end, anchored left */
  .meter { height:7px; background:var(--track); border-radius:4px; overflow:hidden; margin:8px 0 4px; }
  .meter > i { display:block; height:100%; border-radius:4px; background:var(--series-1); }

  /* status pills always carry an icon AND a word */
  .pill { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-family:var(--mono);
          padding:1px 7px; border-radius:999px; border:1px solid var(--ring); white-space:nowrap; }
  .pill.clean,.pill.good      { color:var(--good); border-color:var(--good); }
  .pill.partial,.pill.medium  { color:var(--warning); border-color:var(--warning); }
  .pill.suspicious,.pill.high { color:var(--serious); border-color:var(--serious); }
  .pill.vulnerable,.pill.critical { color:var(--critical); border-color:var(--critical); }
  .pill.skipped,.pill.info,.pill.low,.pill.reviewed { color:var(--muted); }
  .pill.active { color:var(--good); border-color:var(--good); }
  .pill.quiet { color:var(--warning); border-color:var(--warning); }
  .pill.offline { color:var(--critical); border-color:var(--critical); }

  /* message threads: replies nest under their parent behind a guide line */
  .thread { border-left:2px solid var(--rule); padding-left:10px; margin:2px 0 10px; }
  .thread .row { border-bottom:0; padding:4px 0; }
  .thread + .thread { margin-top:4px; }
  .replyto { font-family:var(--mono); font-size:11px; color:var(--muted); }
  .hb { font-variant-numeric:tabular-nums; }
  .digest { border-left:2px solid var(--series-1); padding:2px 0 2px 12px; margin-bottom:12px; }
  .digest b { font-family:var(--mono); font-size:12px; color:var(--series-1); }
  .digest ul { margin:4px 0 0; padding-left:18px; }
  .digest li { font-size:12.5px; color:var(--ink-2); margin-bottom:2px; }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.07em;
       color:var(--muted); padding:9px 10px 9px 0; border-bottom:2px solid var(--rule); }
  td { padding:9px 10px 9px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .scroll { overflow-x:auto; }
  .path { font-family:var(--mono); font-size:12.5px; word-break:break-all; }
  code.mono { font-family:var(--mono); font-size:12.5px; }

  .alert { border:1px solid var(--critical); background:color-mix(in srgb, var(--critical) 10%, transparent);
           border-radius:12px; padding:12px 14px; margin-bottom:12px; }
  .alert.warn { border-color:var(--warning); background:color-mix(in srgb, var(--warning) 10%, transparent); }
  .alert b { font-size:13px; }
</style>
</head>
<body>
${nav('dashboard', roomName)}

<div class="wrap">
  <div class="stats" id="stats"></div>

  <section style="margin-top:18px"><h2>Shared environment</h2><div class="envgrid" id="env"></div></section>

  <div class="grid">
    <section><h2>Goals</h2><div class="pane" id="goals"></div></section>
    <section><h2>Agents — live heartbeat</h2><div class="pane" id="agents"></div></section>
    <section><h2>Tasks</h2><div class="pane" id="tasks"></div></section>
  </div>

  <div class="grid">
    <section><h2>File coverage — the shared brain</h2><div class="pane scroll" id="files"></div></section>
    <section><h2>Findings</h2><div class="pane" id="findings"></div></section>
    <section><h2>Digest — what got decided</h2><div class="pane" id="digest"></div></section>
  </div>

  <section style="margin-top:18px"><h2>Traffic — threaded</h2><div class="pane" id="messages"></div></section>
</div>

<script>
const token = new URLSearchParams(location.search).get('token');
const q = token ? '?token=' + encodeURIComponent(token) : '';
const el = (id) => document.getElementById(id);
// Agent-supplied text flows through this into innerHTML — it must actually
// escape, or any message/status/title on the board becomes stored XSS that
// runs in the dashboard's origin and can read the relay token.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fill = (node, items, render) => {
  node.innerHTML = items.length
    ? items.map((i) => '<div class="row">' + render(i) + '</div>').join('')
    : '<div class="empty">nothing yet</div>';
};
// Times are pinned to UTC−3 rather than browser-local, so two people watching
// this board from different machines always quote each other the same clock.
const OFFSET_MS = 3 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const ms = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts)) || 0;
const at = (ts) => {
  const t = ms(ts);
  if (!t) return '';
  const d = new Date(t - OFFSET_MS);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
};
const onDay = (ts) => {
  const t = ms(ts);
  if (!t) return '';
  const d = new Date(t - OFFSET_MS);
  const today = new Date(Date.now() - OFFSET_MS);
  if (d.toISOString().slice(0, 10) === today.toISOString().slice(0, 10)) return '';
  return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + ' ';
};
const ago = (ts) => {
  const t = ms(ts);
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
};

const ACTIVE_MS = 5 * 60 * 1000;
const QUIET_MS = 15 * 60 * 1000;
// Human-facing liveness: green < 5 min, yellow < 15 min, red past that or never.
// Deliberately separate from the board tool's binary "online" (a 90 s window).
const liveness = (a) => {
  const t = ms(a.lastSeen);
  if (!t) return 'offline';
  const age = Date.now() - t;
  return age < ACTIVE_MS ? 'active' : age < QUIET_MS ? 'quiet' : 'offline';
};
// Last-activity heartbeat at second granularity: "now", "12s ago", "3m 04s ago".
const hb = (a) => {
  const t = ms(a.lastSeen);
  if (!t) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60), r = s % 60;
  return (r ? m + 'm ' + String(r).padStart(2, '0') + 's' : m + 'm') + ' ago';
};

const ICON = { clean:'✓', partial:'◐', suspicious:'▲', vulnerable:'✕', skipped:'–', reviewed:'·' };
const pill = (kind, label) => '<span class="pill ' + esc(kind) + '">' + (ICON[kind] || '') + ' ' + esc(label || kind) + '</span>';

// Identity colour is assigned by stable name order, never by rank or activity.
let palette = {};
const colourFor = (name) => palette[name] || 'var(--muted)';
const who = (name, st) => {
  const cls = ['who'];
  if (st === 'offline') cls.push('off');
  if (st) cls.push('st-' + st);
  return '<span class="' + cls.join(' ') + '">'
    + '<span class="dot" style="background:' + colourFor(name) + '"></span>' + esc(name) + '</span>';
};

async function tick() {
  let s;
  try {
    const res = await fetch('/api/state' + q);
    if (res.status === 401) return goStale('Token rejected — check the ?token= in this URL.');
    if (!res.ok) return goStale('Relay returned HTTP ' + res.status + '.');
    s = await res.json();
  } catch {
    return goStale('Relay unreachable — it is not running, or the network dropped.');
  }
  document.body.classList.remove('offline');
  el('offline').innerHTML = '';
  lastGood = new Date();
  el('when').textContent = 'updated ' + at(lastGood) + ' UTC−3';

  const agents = Object.values(s.agents || {});
  const names = agents.map((a) => a.name).sort();
  palette = {};
  names.forEach((n, i) => { palette[n] = 'var(--series-' + ((i % 6) + 1) + ')'; });

  const clashes = agents.filter((a) => (a.hosts || []).length > 1);
  el('clash').innerHTML = clashes.length
    ? clashes.map((a) => '<div class="alert"><b>Name clash:</b> "' + esc(a.name)
        + '" is connecting from ' + a.hosts.length + ' machines (' + esc(a.hosts.join(', '))
        + '). They share one identity and cannot see each other. One machine must re-run '
        + '<code>join</code> with a different <code>--as</code> name.</div>').join('')
    : '';

  const counts = { active: 0, quiet: 0, offline: 0 };
  agents.forEach((a) => { counts[liveness(a)] += 1; });
  const tasks = s.tasks || [];
  const goals = s.goals || [];
  const files = Object.values(s.files || {});
  const findings = s.findings || [];

  // ---- goals, with progress derived from the tasks pointed at them
  const withProgress = goals.map((g) => {
    const own = tasks.filter((t) => t.goal === g.id);
    const done = own.filter((t) => t.status === 'done').length;
    return Object.assign({}, g, { total: own.length, done, pct: own.length ? Math.round(done / own.length * 100) : 0 });
  });
  // Aggregate over tasks, not the mean of per-goal percentages — otherwise a
  // one-task goal counts as much as a twenty-task one.
  const linked = withProgress.reduce((a, g) => a + g.total, 0);
  const linkedDone = withProgress.reduce((a, g) => a + g.done, 0);
  const goalPct = linked ? Math.round(linkedDone / linked * 100) : 0;

  // ---- coverage
  const reviewed = files.filter((f) => (f.reviews || []).length);
  const peer = reviewed.filter((f) => f.reviews.length > 1);
  const disputed = reviewed.filter((f) => new Set(f.reviews.map((r) => r.verdict)).size > 1);
  const openFindings = findings.filter((f) => f.status !== 'rejected');
  const worst = ['critical','high','medium','low','info'].find((sev) => openFindings.some((f) => f.severity === sev));

  el('stats').innerHTML = [
    '<div class="stat"><div class="n">' + counts.active + '<span class="muted" style="font-size:15px">/' + agents.length + '</span></div>'
      + '<div class="l">agents up</div><div class="sub">' + esc(names.join(', ') || '—')
      + ' · ' + counts.quiet + ' quiet / ' + counts.offline + ' offline</div></div>',
    '<div class="stat"><div class="n">' + goalPct + '%</div><div class="l">goal progress</div>'
      + '<div class="meter"><i style="width:' + goalPct + '%"></i></div>'
      + '<div class="sub">' + linkedDone + '/' + linked + ' linked tasks · '
      + withProgress.filter((g) => g.status === 'active').length + ' active goal(s)</div></div>',
    '<div class="stat"><div class="n">' + reviewed.length + '</div><div class="l">files covered</div>'
      + '<div class="sub">' + peer.length + ' peer-reviewed'
      + (disputed.length ? ' · <b style="color:var(--critical)">' + disputed.length + ' disputed</b>' : '') + '</div></div>',
    '<div class="stat"><div class="n">' + findings.length + '</div><div class="l">findings</div>'
      + '<div class="sub">' + (worst ? pill(worst, 'worst: ' + worst) : 'none yet') + '</div></div>',
    '<div class="stat"><div class="n">' + tasks.filter((t) => t.status !== 'done').length + '</div><div class="l">tasks left</div>'
      + '<div class="sub">' + tasks.filter((t) => t.status === 'claimed').length + ' in progress</div></div>',
  ].join('');

  const env = Object.entries(s.env || {});
  el('env').innerHTML = env.length
    ? '<div class="envgrid">' + env.map(([k, v]) =>
        '<div><b>' + esc(k) + '</b><span>' + esc(v.value) + '</span></div>').join('') + '</div>'
    : '<div class="empty">Not recorded. Agents should pin repo, commit and build with '
      + '<code>env_set</code> — otherwise they may be auditing different code.</div>';

  fill(el('goals'), withProgress, (g) =>
    '<div style="display:flex;gap:10px;align-items:baseline"><code class="muted" style="white-space:nowrap">' + esc(g.id) + '</code>'
    + '<b>' + esc(g.title) + '</b>'
    + '<span class="muted" style="margin-left:auto;font-variant-numeric:tabular-nums">' + g.done + '/' + g.total + '</span></div>'
    + '<div class="meter"><i style="width:' + g.pct + '%;background:' + (g.status === 'done' ? 'var(--good)' : 'var(--series-1)') + '"></i></div>'
    + (g.detail ? '<div class="muted">' + esc(g.detail) + '</div>' : '')
    + (g.status !== 'active' ? ' ' + pill(g.status === 'done' ? 'clean' : 'skipped', g.status) : ''));

  // Agents pane: liveness pill + seconds-granular heartbeat
  fill(el('agents'), agents, (a) => {
    const st = liveness(a);
    const t = ms(a.lastSeen);
    return who(a.name, st)
      + '<div class="ink2" style="font-size:13px;margin-top:3px">' + esc(a.status || 'idle') + '</div>'
      + '<div class="muted">' + pill(st, st === 'active' ? 'up' : st)
      + ' <span class="hb">last activity ' + hb(a) + '</span>'
      + (st === 'offline' && t ? ' · ' + onDay(t) + at(t) : '') + '</div>';
  });

  const order = { claimed:0, blocked:1, open:2, done:3 };
  fill(el('tasks'), [...tasks].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)), (t) =>
    '<code class="muted">' + esc(t.id) + '</code> '
    + (t.status === 'done' ? '<s class="muted">' + esc(t.title) + '</s>' : esc(t.title))
    + (t.goal ? ' <code class="muted">→' + esc(t.goal) + '</code>' : '')
    + '<div style="margin-top:3px">' + pill(t.status === 'done' ? 'clean' : t.status === 'blocked' ? 'suspicious' : 'reviewed', t.status)
    + (t.owner ? ' ' + who(t.owner)
        : t.status === 'done' ? '' : ' <span class="muted">unclaimed</span>') + '</div>');

  const SEV = { critical:0, high:1, medium:2, low:3, info:4 };
  const bySeverity = [...findings].sort((a, b) =>
    (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9) || (b.ts || '').localeCompare(a.ts || ''));
  fill(el('findings'), bySeverity, (f) =>
    pill(f.severity, f.severity) + ' ' + pill(f.status === 'confirmed' ? 'clean' : f.status === 'rejected' ? 'skipped' : 'partial', f.status)
    + '<div style="margin-top:4px"><b>' + esc(f.title) + '</b></div>'
    + (f.target ? '<div class="path muted">' + esc(f.target) + '</div>' : '')
    + '<div class="muted">by ' + esc(f.by) + '</div>');

  // ---- the coverage table: who has actually read what, and did they agree
  const sorted = [...reviewed].sort((a, b) => (b.lastTouched || '').localeCompare(a.lastTouched || ''));
  el('files').innerHTML = sorted.length
    ? '<table><thead><tr><th>File</th><th>Reviewed by</th><th>Verdict</th><th>Latest note</th></tr></thead><tbody>'
      + sorted.map((f) => {
          const dispute = new Set(f.reviews.map((r) => r.verdict)).size > 1;
          const last = f.reviews[f.reviews.length - 1];
          return '<tr>'
            + '<td class="path">' + (dispute ? '<b style="color:var(--critical)">‖ </b>' : '') + esc(f.path)
              + (f.findings && f.findings.length ? ' <code class="muted">' + esc(f.findings.join(',')) + '</code>' : '') + '</td>'
            + '<td>' + f.reviews.map((r) => who(r.agent)).join(' ') + '</td>'
            + '<td>' + f.reviews.map((r) => pill(r.verdict, r.verdict)).join(' ') + '</td>'
            + '<td class="muted">' + esc((last && last.note) || '') + '</td>'
            + '</tr>';
        }).join('')
      + '</tbody></table>'
    : '<div class="empty">No files recorded yet — agents log them with the <code>file_review</code> tool.</div>';

  // ---- Digest pane (from main)
  const digests = [...(s.digests || [])].reverse();
  el('digest').innerHTML = digests.length
    ? digests.slice(0, 4).map((d) => '<div class="digest"><b>' + esc(d.id) + '</b> '
        + '<span class="muted">' + esc(at(d.ts)) + ' · ' + esc(ago(d.ts)) + '</span>'
        + '<ul>' + d.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></div>').join('')
    : '<div class="empty">No digest yet — one is written every 20 messages or 15 minutes of activity.</div>';

  // ---- Messages pane with thread grouping (our improvement)
  const msgRow = (m) => '<code class="muted" style="font-size:11px">' + esc(m.id) + '</code> '
    + '<span class="mono">' + esc(onDay(m.ts) + at(m.ts)) + '</span>'
    + '<span class="muted"> ' + esc(ago(m.ts)) + '</span>  ' + who(m.from)
    + '<span class="muted"> → ' + esc(m.to) + '</span>' + (m.urgent ? ' ' + pill('vulnerable', 'urgent') : '')
    + (m.replyTo ? ' <span class="replyto">↳ re ' + esc(m.replyTo) + '</span>' : '')
    + '<div class="ink2" style="margin-top:2px">' + esc(m.text) + '</div>';

  // Threads: a reply nests under its ultimate in-view ancestor; threads sort by
  // their latest message so an active discussion stays near the top.
  const lastMsgs = (s.messages || []).slice(-40);
  const byId = new Map(lastMsgs.map((m) => [m.id, m]));
  const rootOf = (m, seen) => {
    seen = seen || new Set();
    if (!m.replyTo || seen.has(m.id)) return m;
    const parent = byId.get(m.replyTo);
    if (!parent) return m;
    seen.add(m.id);
    return rootOf(parent, seen);
  };
  const threads = new Map();
  for (const m of lastMsgs) {
    const root = rootOf(m);
    if (!threads.has(root.id)) threads.set(root.id, { root, replies: [] });
    if (m !== root) threads.get(root.id).replies.push(m);
  }
  const latestOf = (th) => (th.replies.length ? th.replies[th.replies.length - 1] : th.root).ts || '';
  const threadList = [...threads.values()].sort((a, b) => {
    const la = latestOf(a), lb = latestOf(b);
    return lb > la ? 1 : lb < la ? -1 : 0;
  });
  el('messages').innerHTML = threadList.length
    ? threadList.map((th) =>
        '<div class="thread"><div class="row">' + msgRow(th.root) + '</div>'
        + th.replies.map((r) => '<div class="row">' + msgRow(r) + '</div>').join('')
        + '</div>').join('')
    : '<div class="empty">nothing yet</div>';
}
let lastGood = null;
function goStale(why) {
  document.body.classList.add('offline');
  el('when').textContent = 'stale';
  el('offline').innerHTML = '<div class="alert warn"><b>' + esc(why) + '</b><br>'
    + 'Everything below is frozen from '
    + (lastGood ? 'the last update at ' + at(lastGood) + ' UTC−3' : 'an earlier page load')
    + ' and is probably out of date. On the relay machine, run:<br>'
    + '<code>node bin/claude-bros.js serve --token <your token></code></div>';
}
tick();
setInterval(tick, 3000);
</script>
</body>
</html>`;