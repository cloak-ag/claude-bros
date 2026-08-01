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
  .row { padding:9px 0; border-bottom:1px solid var(--line); word-break:break-word; }
  .row:last-child { border-bottom:0; }
  .empty { color:var(--muted); font-style:italic; font-size:13px; }
  .muted { color:var(--muted); font-size:12px; }
  .ink2 { color:var(--ink-2); }

  /* agent identity: colour ALWAYS beside the name, never alone */
  .who { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-weight:600; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; box-shadow:0 0 0 2px var(--surface); }
  .off { opacity:.42; }
  /* liveness ring around the identity dot: fresh / slow / silent */
  .live { display:inline-flex; align-items:center; gap:5px; }
  .beat { width:7px; height:7px; border-radius:50%; flex:none; }
  .beat.fresh { background:var(--good); }
  .beat.slow  { background:var(--warning); }
  .beat.cold  { background:var(--critical); }
  .beat.gone  { background:var(--muted); }
  .digest { border-left:2px solid var(--series-1); padding:2px 0 2px 12px; margin-bottom:12px; }
  .digest b { font-family:var(--mono); font-size:12px; color:var(--series-1); }
  .digest ul { margin:4px 0 0; padding-left:18px; }
  .digest li { font-size:12.5px; color:var(--ink-2); margin-bottom:2px; }
  .reply { font-size:11px; font-family:var(--mono); color:var(--muted);
           border-left:2px solid var(--line); padding-left:7px; margin-bottom:3px; }

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

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.07em;
       color:var(--muted); font-weight:600; padding:0 10px 8px 0; border-bottom:1px solid var(--rule); }
  td { padding:9px 10px 9px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .scroll { overflow-x:auto; }
  #files { max-height:460px; overflow-y:auto; }
  #files table { min-width:720px; }
  #files thead th { position:sticky; top:0; background:var(--surface); z-index:1; }
  .path { font-family:var(--mono); font-size:12.5px; word-break:break-all; }

  .alert { border:1px solid var(--critical); background:color-mix(in srgb, var(--critical) 10%, transparent);
           border-radius:12px; padding:12px 15px; margin-bottom:18px; line-height:1.6; }
  .alert.warn { border-color:var(--warning); background:color-mix(in srgb, var(--warning) 12%, transparent); }
  .alert code { background:var(--ring); padding:1px 5px; border-radius:4px; }
  body.offline .stats, body.offline .board { opacity:.4; filter:grayscale(.8); pointer-events:none; }
  .envgrid { display:grid; gap:8px 22px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); }
  .envgrid div { display:flex; gap:10px; align-items:baseline; min-width:0; }
  .envgrid b { font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted);
               font-weight:600; flex:none; min-width:62px; }
  .envgrid span { font-family:var(--mono); font-size:12.5px; word-break:break-all; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--muted); margin-top:10px; }
</style>
</head>
<body>
<div class="head">
  <h1>claude-bros <span class="room">· ${roomName}</span></h1>
  ${nav('board', query)}
  <div class="when" id="when">connecting…</div>
</div>
<div id="offline"></div>
<div id="clash"></div>
<div class="stats" id="stats"></div>
<div class="board" id="board">
  <section><h2>Shared environment</h2><div id="env"></div></section>
  <section><h2>Goals</h2><div id="goals"></div></section>
  <div class="grid">
    <section><h2>Agents</h2><div class="pane" id="agents"></div></section>
    <section><h2>Task board</h2><div class="pane" id="tasks"></div></section>
    <section><h2>Findings</h2><div class="pane" id="findings"></div></section>
  </div>
  <section style="margin-top:18px"><h2>File coverage — the shared brain</h2><div class="scroll pane" id="files"></div>
    <div class="legend">
      <span>✓ clean</span><span>◐ partial</span><span>▲ suspicious</span>
      <span>✕ vulnerable</span><span>– skipped</span><span>‖ reviewers disagree</span>
    </div>
  </section>
  <section><h2>Digest <span style="text-transform:none;letter-spacing:0">· what actually got decided</span></h2>
    <div id="digest"></div></section>
  <section><h2>Traffic <span style="text-transform:none;letter-spacing:0">· times UTC−3</span></h2>
    <div class="pane" id="messages"></div></section>
</div>
<script>
const token = new URLSearchParams(location.search).get('token');
const q = token ? '?token=' + encodeURIComponent(token) : '';
const el = (id) => document.getElementById(id);
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

const ICON = { clean:'✓', partial:'◐', suspicious:'▲', vulnerable:'✕', skipped:'–', reviewed:'·' };
const pill = (kind, label) => '<span class="pill ' + esc(kind) + '">' + (ICON[kind] || '') + ' ' + esc(label || kind) + '</span>';

// Identity colour is assigned by stable name order, never by rank or activity.
let palette = {};
const colourFor = (name) => palette[name] || 'var(--muted)';
const who = (name, online) => '<span class="who' + (online === false ? ' off' : '') + '">'
  + '<span class="dot" style="background:' + colourFor(name) + '"></span>' + esc(name) + '</span>';

let lastGood = null;
function goStale(why) {
  document.body.classList.add('offline');
  el('when').textContent = 'stale';
  el('offline').innerHTML = '<div class="alert warn"><b>' + esc(why) + '</b><br>'
    + 'Everything below is frozen from '
    + (lastGood ? 'the last update at ' + at(lastGood) + ' UTC\u22123' : 'an earlier page load')
    + ' and is probably out of date. On the relay machine, run:<br>'
    + '<code>node bin/claude-bros.js serve --token &lt;your token&gt;</code></div>';
}

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
  el('when').textContent = 'updated ' + at(lastGood) + ' UTC\u22123';

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

  const online = agents.filter((a) => Date.now() - (a.lastSeen || 0) < 90000);
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
    '<div class="stat"><div class="n">' + online.length + '<span class="muted" style="font-size:15px">/' + agents.length + '</span></div>'
      + '<div class="l">agents online</div><div class="sub">' + (agents.length ? esc(names.join(', ')) : '—') + '</div></div>',
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

  // Name, what they are doing right now, and when they last spoke. Role and
  // scope are standing facts, not activity — they live on the board tool.
  const beatOf = (a) => {
    if (!a.lastSeen) return ['gone', 'never checked in'];
    const mins = (Date.now() - a.lastSeen) / 60000;
    if (mins < 5) return ['fresh', 'active'];
    if (mins < 15) return ['slow', 'quiet ' + Math.round(mins) + 'm'];
    return ['cold', 'silent ' + Math.round(mins) + 'm'];
  };
  fill(el('agents'), agents, (a) => {
    const up = Date.now() - (a.lastSeen || 0) < 90000;
    const [beat, beatLabel] = beatOf(a);
    const statusMins = a.statusAt ? Math.round((Date.now() - a.statusAt) / 60000) : null;
    return who(a.name, up)
      + ' <span class="live"><span class="beat ' + beat + '"></span>'
      + '<span class="muted">' + esc(beatLabel) + '</span></span>'
      + '<div class="ink2" style="font-size:13px;margin-top:3px">' + esc(a.status || 'idle')
      + (statusMins !== null && statusMins >= 5
          ? ' <span class="muted">(said ' + statusMins + 'm ago)</span>' : '') + '</div>'
      + '<div class="muted">' + (up
          ? 'online · seen ' + ago(a.lastSeen)
          : 'last seen ' + ago(a.lastSeen) + (a.lastSeen ? ' · ' + onDay(a.lastSeen) + at(a.lastSeen) : '')) + '</div>';
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

  const digests = [...(s.digests || [])].reverse();
  el('digest').innerHTML = digests.length
    ? digests.slice(0, 4).map((d) => '<div class="digest"><b>' + esc(d.id) + '</b> '
        + '<span class="muted">' + esc(at(d.ts)) + ' · ' + esc(ago(d.ts)) + '</span>'
        + '<ul>' + d.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></div>').join('')
    : '<div class="empty">No digest yet — one is written every 20 messages or 15 minutes of activity.</div>';

  fill(el('messages'), (s.messages || []).slice(-40).reverse(), (m) =>
    '<span class="mono">' + esc(onDay(m.ts) + at(m.ts)) + '</span>'
    + '<span class="muted"> ' + esc(ago(m.ts)) + '</span>  ' + who(m.from)
    + '<span class="muted"> → ' + esc(m.to) + '</span>' + (m.urgent ? ' ' + pill('vulnerable', 'urgent') : '')
    + (m.replyTo ? '<div class="reply">re: ' + esc(m.replyTo) + '</div>' : '')
    + '<div class="ink2" style="margin-top:2px">' + esc(m.text) + '</div>');
}
tick();
setInterval(tick, 3000);
</script>
</body>
</html>`;
