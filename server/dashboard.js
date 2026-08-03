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
  body { padding:0 24px 72px; }
  .wrap { max-width:1800px; margin:0 auto; display:grid; gap:24px; }

  /* stat row */
  .stats { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); }
  .stat { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .stat .n { font-size:26px; font-weight:600; letter-spacing:-.02em; font-variant-numeric:tabular-nums; line-height:1.15; }
  .stat .l { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.07em; margin-top:2px; }
  .stat .sub { font-size:12px; color:var(--ink-2); margin-top:6px; }

  section { background:var(--surface); border:1px solid var(--line); border-radius:12px;
            padding:20px; min-width:0; margin:0; }
  /* Three equal columns that hold their size — content scrolls inside the box
     instead of stretching it, so the row never reflows as work comes in. */
  .grid { display:grid; gap:20px; grid-template-columns:repeat(3,minmax(0,1fr)); align-items:stretch; }
  .grid section { margin-bottom:0; height:var(--pane-h,420px); display:flex; flex-direction:column; }
  .grid section > h2 { flex:none; }
  @media (max-width:1080px) { .grid { grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); } }
  @media (max-width:560px)  { .grid { grid-template-columns:1fr; } }
  .grid.insights { grid-template-columns:minmax(0,1.15fr) minmax(0,.9fr) minmax(0,.85fr); }
  @media (max-width:800px) { .grid.insights { grid-template-columns:1fr; } }

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

  /* Environment entries are long operational facts, not inline labels. Give
     keys a stable column and values their own wrapping block so paths, commits,
     and evidence never run into the key or stretch the dashboard. */
  .env-list { display:grid; margin:0; }
  .env-row { display:grid; grid-template-columns:minmax(140px,220px) minmax(0,1fr);
             gap:18px; align-items:start; padding:10px 0; border-bottom:1px solid var(--line); }
  .env-row:first-child { padding-top:2px; }
  .env-row:last-child { padding-bottom:0; border-bottom:0; }
  .env-key { min-width:0; color:var(--muted); font:600 12px/1.45 var(--mono);
             overflow-wrap:anywhere; }
  .env-value { min-width:0; color:var(--ink-2); font-size:13px; line-height:1.5;
               white-space:pre-wrap; overflow-wrap:anywhere; }
  @media (max-width:640px) {
    .env-row { grid-template-columns:1fr; gap:3px; padding:11px 0; }
    .env-key { color:var(--ink); }
  }

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
  .message-actions { display:inline-flex; gap:5px; margin-left:8px; }
  .message-action { appearance:none; border:1px solid var(--line); border-radius:6px; background:var(--plane);
                    color:var(--muted); padding:2px 6px; font:11px var(--mono); cursor:pointer; }
  .message-action:hover { color:var(--ink); border-color:var(--muted); }
  .message-action.delete:hover { color:var(--critical); border-color:var(--critical); }
  .message-deleted { color:var(--muted); font-style:italic; }
  .hb { font-variant-numeric:tabular-nums; }
  .digest { border-left:2px solid var(--series-1); padding:2px 0 2px 12px; margin-bottom:12px; }
  .digest b { font-family:var(--mono); font-size:12px; color:var(--series-1); }
  .digest ul { margin:4px 0 0; padding-left:18px; }
  .digest li { font-size:12.5px; color:var(--ink-2); margin-bottom:2px; }

  /* Tasks and findings are work queues, so unresolved work is primary and
     historical records sit in a deliberately quieter, collapsed archive. */
  .queue-group + .queue-group, .queue-group + details, details + .queue-group { margin-top:18px; }
  .group-title { display:flex; align-items:center; gap:8px; margin:0 0 6px; color:var(--ink-2);
                 font-size:11px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; }
  .count { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:20px;
           padding:0 6px; border-radius:999px; color:var(--muted); background:var(--plane);
           border:1px solid var(--line); font:11px/1 var(--mono); }
  .work-item { padding:12px 0; border-bottom:1px solid var(--line); }
  .work-item:last-child { border-bottom:0; }
  .work-head { display:flex; align-items:flex-start; gap:9px; }
  .work-id { flex:none; padding-top:2px; }
  .work-title { min-width:0; font-weight:600; line-height:1.4; overflow-wrap:anywhere; }
  .work-meta { display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin-top:7px; }
  details.archive { border-top:1px solid var(--rule); padding-top:12px; }
  details.archive > summary { display:flex; align-items:center; gap:8px; cursor:pointer; color:var(--muted);
                              font-size:11px; font-weight:700; letter-spacing:.07em;
                              list-style:none; text-transform:uppercase; user-select:none; }
  details.archive > summary::-webkit-details-marker { display:none; }
  details.archive > summary::before { content:'›'; font-size:17px; line-height:1; transform:rotate(0); transition:transform .12s ease; }
  details.archive[open] > summary::before { transform:rotate(90deg); }
  details.archive .work-item { opacity:.74; }
  .finding-item { padding:13px 0; }
  .finding-item .path { margin-top:7px; color:var(--ink-2); overflow-wrap:anywhere; }

  /* Confirmed findings are deliverables, not ordinary queue noise. Keep the
     filing queue full-width so evidence and report metadata have room. */
  .submissions-head { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; margin-bottom:16px; }
  .submissions-head h2 { margin-bottom:4px; }
  .submissions-head p { margin:0; }
  .submission-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
  .submission-column { min-width:0; }
  .submission-card { border:1px solid var(--line); border-radius:10px; background:var(--plane); padding:13px 14px; }
  .submission-card + .submission-card { margin-top:10px; }
  .submission-copy { margin-top:9px; color:var(--ink-2); white-space:pre-wrap; overflow-wrap:anywhere; }
  .submission-detail { margin-top:10px; border-top:1px solid var(--line); padding-top:9px; }
  .submission-detail summary { cursor:pointer; color:var(--muted); font-size:12px; }
  @media (max-width:840px) {
    .submission-grid { grid-template-columns:1fr; }
    .submissions-head { align-items:flex-start; flex-direction:column; }
  }

  /* Coverage is a full-width ledger. Each review remains a single row so the
     reviewer, verdict and note cannot become visually detached. */
  .coverage-head { display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-bottom:16px; }
  .coverage-head h2 { margin-bottom:4px; }
  .coverage-head p { margin:0; }
  .coverage-filter { flex:0 1 360px; }
  .coverage-filter span { display:block; margin-bottom:5px; color:var(--muted); font-size:11px;
                          font-weight:700; letter-spacing:.07em; text-transform:uppercase; }
  .coverage-filter input { width:100%; min-height:38px; border:1px solid var(--rule); border-radius:8px;
                           padding:7px 10px; background:var(--plane); color:var(--ink); font:13px var(--sans); }
  .coverage-filter input:focus { outline:2px solid color-mix(in srgb,var(--series-1) 45%,transparent); outline-offset:1px; }
  .coverage-list { display:grid; gap:12px; max-height:760px; overflow:auto; padding-right:5px;
                   overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:var(--rule) transparent; }
  .file-card { border:1px solid var(--line); border-radius:10px; background:var(--plane); overflow:hidden; }
  .file-head { display:flex; align-items:flex-start; gap:10px; flex-wrap:wrap; padding:11px 13px;
               border-bottom:1px solid var(--line); background:var(--surface); }
  .file-path { flex:1 1 480px; min-width:0; font-family:var(--mono); font-size:13px; font-weight:650;
               overflow-wrap:anywhere; word-break:normal; }
  .file-links { display:flex; flex-wrap:wrap; gap:5px; }
  .review-row { display:grid; grid-template-columns:minmax(150px,200px) minmax(110px,145px) minmax(260px,1fr);
                gap:14px; align-items:start; padding:11px 13px; }
  .review-row + .review-row { border-top:1px solid var(--line); }
  .review-note { min-width:0; color:var(--ink-2); overflow-wrap:anywhere; }
  .review-note.empty-note { color:var(--muted); font-style:italic; }
  .review-lines { display:block; margin-top:3px; color:var(--muted); font:11px var(--mono); }
  .coverage-none { display:none; }
  @media (max-width:720px) {
    .coverage-head { align-items:stretch; flex-direction:column; }
    .coverage-filter { flex-basis:auto; width:100%; }
    .review-row { grid-template-columns:1fr; gap:7px; }
    .coverage-list { max-height:none; }
  }

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
<div class="head">
  <h1>claude-bros <span class="room">· ${roomName}</span></h1>
  ${nav('board', query)}
  <div class="when" id="when">connecting…</div>
</div>
<!-- tick() writes into these; without them el(...) is null and nothing renders -->
<div id="offline"></div>
<div id="clash"></div>

<div class="wrap">
  <div class="stats" id="stats"></div>

  <section><h2>Shared environment</h2><div class="env-list" id="env"></div></section>

  <div class="grid">
    <section><h2>Goals</h2><div class="pane" id="goals"></div></section>
    <section><h2>Agents — live heartbeat</h2><div class="pane" id="agents"></div></section>
    <section><h2>Tasks</h2><div class="pane" id="tasks"></div></section>
  </div>

  <div class="grid insights">
    <section><h2>Findings</h2><div class="pane" id="findings"></div></section>
    <section><h2>Polls — team decisions</h2><div class="pane" id="polls"></div></section>
    <section><h2>Digest — what got decided</h2><div class="pane" id="digest"></div></section>
  </div>

  <section class="submissions-section">
    <div class="submissions-head">
      <div><h2>Submissions</h2><p class="muted">Confirmed findings ready to file, separated from reports already submitted.</p></div>
      <div class="muted" id="submission-summary"></div>
    </div>
    <div class="submission-grid">
      <div class="submission-column"><div class="group-title">Ready to submit <span class="count" id="ready-count">0</span></div><div id="submissions-ready"></div></div>
      <div class="submission-column"><div class="group-title">Submitted <span class="count" id="reported-count">0</span></div><div id="submissions-reported"></div></div>
    </div>
  </section>

  <section class="coverage-section">
    <div class="coverage-head">
      <div><h2>File coverage — the shared brain</h2><p class="muted">Every review, verdict, and note stays paired with its file.</p></div>
      <label class="coverage-filter"><span>Filter coverage</span><input id="coverage-filter" type="search" placeholder="Path, reviewer, verdict, note…" autocomplete="off"></label>
    </div>
    <div class="coverage-list" id="files"></div>
    <div class="empty coverage-none" id="coverage-none">No reviews match this filter.</div>
  </section>

  <section><h2>Traffic — threaded</h2><div class="pane" id="messages"></div></section>
</div>

<script>
const token = new URLSearchParams(location.search).get('token');
const q = token ? '?token=' + encodeURIComponent(token) : '';
const el = (id) => document.getElementById(id);
let canModerate = false;
let messageById = new Map();
fetch('/api/auth' + q).then((res) => res.ok ? res.json() : null).then((auth) => {
  canModerate = Boolean(auth && auth.human);
}).catch(() => {});
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

const empty = (message) => '<div class="empty">' + esc(message) + '</div>';

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

const applyCoverageFilter = () => {
  const input = el('coverage-filter');
  const needle = String(input && input.value || '').trim().toLowerCase();
  const rows = [...document.querySelectorAll('[data-coverage-row]')];
  let visible = 0;
  rows.forEach((row) => {
    const match = !needle || String(row.dataset.search || '').includes(needle);
    row.hidden = !match;
    if (match) visible += 1;
  });
  el('coverage-none').style.display = needle && rows.length && !visible ? 'block' : 'none';
};
el('coverage-filter').addEventListener('input', applyCoverageFilter);
let taskArchiveOpen = false;
let rejectedArchiveOpen = false;
let agentArchiveOpen = false;

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
  const activeAgents = agents.filter((a) => a.membershipStatus !== 'kicked');
  const removedAgents = agents.filter((a) => a.membershipStatus === 'kicked');
  const names = activeAgents.map((a) => a.name).sort();
  palette = {};
  names.forEach((n, i) => { palette[n] = 'var(--series-' + ((i % 6) + 1) + ')'; });

  const clashes = activeAgents.filter((a) => (a.hosts || []).length > 1);
  el('clash').innerHTML = clashes.length
    ? clashes.map((a) => '<div class="alert"><b>Name clash:</b> "' + esc(a.name)
        + '" is connecting from ' + a.hosts.length + ' machines (' + esc(a.hosts.join(', '))
        + '). They share one identity and cannot see each other. One machine must re-run '
        + '<code>join</code> with a different <code>--as</code> name.</div>').join('')
    : '';

  const counts = { active: 0, quiet: 0, offline: 0 };
  activeAgents.forEach((a) => { counts[liveness(a)] += 1; });
  const tasks = s.tasks || [];
  const goals = s.goals || [];
  const files = Object.values(s.files || {});
  const findings = s.findings || [];
  const polls = s.polls || [];

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
  const actionableFindings = findings.filter((f) => !['confirmed', 'reported', 'rejected'].includes(f.status));
  const readySubmissions = findings.filter((f) => f.status === 'confirmed');
  const reportedSubmissions = findings.filter((f) => f.status === 'reported');
  const worst = ['critical','high','medium','low','info'].find((sev) => actionableFindings.some((f) => f.severity === sev));

  el('stats').innerHTML = [
    '<div class="stat"><div class="n">' + counts.active + '<span class="muted" style="font-size:15px">/' + activeAgents.length + '</span></div>'
      + '<div class="l">agents up</div><div class="sub">' + esc(names.join(', ') || '—')
      + ' · ' + counts.quiet + ' quiet / ' + counts.offline + ' offline'
      + (removedAgents.length ? ' · ' + removedAgents.length + ' removed' : '') + '</div></div>',
    '<div class="stat"><div class="n">' + goalPct + '%</div><div class="l">goal progress</div>'
      + '<div class="meter"><i style="width:' + goalPct + '%"></i></div>'
      + '<div class="sub">' + linkedDone + '/' + linked + ' linked tasks · '
      + withProgress.filter((g) => g.status === 'active').length + ' active goal(s)</div></div>',
    '<div class="stat"><div class="n">' + reviewed.length + '</div><div class="l">files covered</div>'
      + '<div class="sub">' + peer.length + ' peer-reviewed'
      + (disputed.length ? ' · <b style="color:var(--critical)">' + disputed.length + ' disputed</b>' : '') + '</div></div>',
    '<div class="stat"><div class="n">' + actionableFindings.length + '</div><div class="l">findings to verify</div>'
      + '<div class="sub">' + (worst ? pill(worst, 'worst: ' + worst) : 'none yet')
      + (findings.filter((f) => f.status === 'rejected').length ? ' · ' + findings.filter((f) => f.status === 'rejected').length + ' rejected' : '') + '</div></div>',
    '<div class="stat"><div class="n">' + readySubmissions.length + '</div><div class="l">ready to submit</div>'
      + '<div class="sub">' + reportedSubmissions.length + ' already submitted</div></div>',
    '<div class="stat"><div class="n">' + tasks.filter((t) => t.status !== 'done').length + '</div><div class="l">tasks left</div>'
      + '<div class="sub">' + tasks.filter((t) => t.status === 'claimed').length + ' in progress</div></div>',
  ].join('');

  const env = Object.entries(s.env || {});
  el('env').innerHTML = env.length
    ? env.map(([k, v]) => '<div class="env-row"><div class="env-key">' + esc(k)
        + '</div><div class="env-value">' + esc(v.value) + '</div></div>').join('')
    : '<div class="empty">Not recorded. Agents should pin repo, commit and build with '
      + '<code>env_set</code> — otherwise they may be auditing different code.</div>';

  fill(el('goals'), withProgress, (g) =>
    '<div style="display:flex;gap:10px;align-items:baseline"><code class="muted" style="white-space:nowrap">' + esc(g.id) + '</code>'
    + '<b>' + esc(g.title) + '</b>'
    + '<span class="muted" style="margin-left:auto;font-variant-numeric:tabular-nums">' + g.done + '/' + g.total + '</span></div>'
    + '<div class="meter"><i style="width:' + g.pct + '%;background:' + (g.status === 'done' ? 'var(--good)' : 'var(--series-1)') + '"></i></div>'
    + (g.detail ? '<div class="muted">' + esc(g.detail) + '</div>' : '')
    + (g.status !== 'active' ? ' ' + pill(g.status === 'done' ? 'clean' : 'skipped', g.status) : ''));

  // Agents pane: current members first; kicked identities are retained only as
  // collapsed contribution history and do not inflate the live roster count.
  const agentRow = (a, removed = false) => {
    const st = liveness(a);
    const t = ms(a.lastSeen);
    const current = tasks.filter((task) => task.owner === a.name && ['claimed', 'blocked'].includes(task.status));
    const taken = tasks.filter((task) => (task.participants || []).includes(a.name)
      || task.owner === a.name || task.lastOwner === a.name
      || (task.history || []).some((entry) => entry.who === a.name && entry.what === 'claimed'));
    const completed = taken.filter((task) => task.status === 'done');
    return who(a.name, removed ? 'offline' : st)
      + (removed ? ' ' + pill('skipped', 'removed') : '')
      + '<div class="ink2" style="font-size:13px;margin-top:3px"><b>Current:</b> '
      + (current.length ? current.map((task) => '<code>' + esc(task.id) + '</code> ' + esc(task.title)).join('; ') : 'available — no claimed task') + '</div>'
      + '<div class="muted" style="margin-top:3px">Activity: ' + esc(a.status || 'idle') + '</div>'
      + (a.client ? '<div class="muted">Client: ' + esc(a.client.title || a.client.name)
        + (a.client.version ? ' ' + esc(a.client.version) : '') + '</div>' : '')
      + (taken.length ? '<div class="muted">Took ' + esc(taken.map((task) => task.id).join(', '))
        + (completed.length ? ' · built/completed ' + esc(completed.map((task) => task.id).join(', ')) : '') + '</div>' : '')
      + '<div class="muted">' + pill(st, st === 'active' ? 'up' : st)
      + ' <span class="hb">last activity ' + hb(a) + '</span>'
      + (st === 'offline' && t ? ' · ' + onDay(t) + at(t) : '') + '</div>';
  };
  el('agents').innerHTML = '<div class="queue-group"><div class="group-title">Current members <span class="count">'
    + activeAgents.length + '</span></div>'
    + (activeAgents.length ? activeAgents.map((a) => '<div class="row">' + agentRow(a) + '</div>').join('') : empty('No current members.')) + '</div>'
    + '<details class="archive"' + (agentArchiveOpen ? ' open' : '') + '><summary>Removed identities <span class="count">'
    + removedAgents.length + '</span></summary>'
    + (removedAgents.length ? removedAgents.map((a) => '<div class="row">' + agentRow(a, true) + '</div>').join('') : empty('No removed identities.')) + '</details>';
  el('agents').querySelector('details.archive').addEventListener('toggle', (event) => {
    agentArchiveOpen = event.currentTarget.open;
  });

  const taskOrder = { claimed:0, blocked:1, open:2 };
  const activeTasks = tasks.filter((t) => t.status !== 'done').sort((a, b) =>
    (taskOrder[a.status] ?? 9) - (taskOrder[b.status] ?? 9)
      || String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric:true }));
  const completedTasks = tasks.filter((t) => t.status === 'done').sort((a, b) =>
    String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
      || String(b.id || '').localeCompare(String(a.id || ''), undefined, { numeric:true }));
  const taskRow = (t) => '<div class="work-item">'
    + '<div class="work-head"><code class="muted work-id">' + esc(t.id) + '</code>'
    + '<div class="work-title">' + esc(t.title) + '</div></div>'
    + '<div class="work-meta">'
    + pill(t.status === 'done' ? 'clean' : t.status === 'blocked' ? 'suspicious' : t.status === 'claimed' ? 'active' : 'reviewed', t.status)
    + (t.owner ? who(t.owner) : t.status === 'done' ? '' : '<span class="muted">unclaimed</span>')
    + (t.goal ? '<code class="muted">goal ' + esc(t.goal) + '</code>' : '')
    + (t.dependsOn ? '<code class="muted">depends on ' + esc(t.dependsOn) + '</code>' : '')
    + '</div></div>';
  el('tasks').innerHTML = '<div class="queue-group"><div class="group-title">Active queue <span class="count">'
    + activeTasks.length + '</span></div>'
    + (activeTasks.length ? activeTasks.map(taskRow).join('') : empty('No active tasks.')) + '</div>'
    + '<details class="archive"' + (taskArchiveOpen ? ' open' : '') + '><summary>Completed <span class="count">' + completedTasks.length + '</span></summary>'
    + (completedTasks.length ? completedTasks.map(taskRow).join('') : empty('No completed tasks.')) + '</details>';
  el('tasks').querySelector('details.archive').addEventListener('toggle', (event) => {
    taskArchiveOpen = event.currentTarget.open;
  });

  const SEV = { critical:0, high:1, medium:2, low:3, info:4 };
  const bySeverity = (list) => [...list].sort((a, b) =>
    (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9) || (b.ts || '').localeCompare(a.ts || ''));
  const standingFindings = bySeverity(actionableFindings);
  const rejectedFindings = bySeverity(findings.filter((f) => f.status === 'rejected'));
  const findingRow = (f) => '<div class="work-item finding-item">'
    + '<div class="work-head"><code class="muted work-id">' + esc(f.id) + '</code>'
    + '<div class="work-title">' + esc(f.title) + '</div></div>'
    + '<div class="work-meta">' + pill(f.severity, f.severity)
    + pill(f.status === 'confirmed' ? 'clean' : f.status === 'rejected' ? 'skipped' : 'partial', f.status)
    + (f.by ? '<span class="muted">reported by ' + esc(f.by) + '</span>' : '') + '</div>'
    + (f.target ? '<div class="path">' + esc(f.target) + '</div>' : '')
    + '</div>';
  el('findings').innerHTML = '<div class="queue-group"><div class="group-title">Standing &amp; actionable <span class="count">'
    + standingFindings.length + '</span></div>'
    + (standingFindings.length ? standingFindings.map(findingRow).join('') : empty('No standing findings.')) + '</div>'
    + '<details class="archive"' + (rejectedArchiveOpen ? ' open' : '') + '><summary>Rejected <span class="count">' + rejectedFindings.length + '</span></summary>'
    + (rejectedFindings.length ? rejectedFindings.map(findingRow).join('') : empty('No rejected findings.')) + '</details>';
  el('findings').querySelector('details.archive').addEventListener('toggle', (event) => {
    rejectedArchiveOpen = event.currentTarget.open;
  });

  const submissionCard = (f) => '<article class="submission-card">'
    + '<div class="work-head"><code class="muted work-id">' + esc(f.id) + '</code>'
    + '<div class="work-title">' + esc(f.title) + '</div></div>'
    + '<div class="work-meta">' + pill(f.severity, f.severity)
    + pill(f.status === 'reported' ? 'reviewed' : 'clean', f.status === 'reported' ? 'submitted' : 'ready')
    + (f.by ? '<span class="muted">found by ' + esc(f.by) + '</span>' : '')
    + (f.confirmedBy ? '<span class="muted">confirmed by ' + esc(f.confirmedBy) + '</span>' : '') + '</div>'
    + (f.target ? '<div class="path" style="margin-top:8px">' + esc(f.target) + '</div>' : '')
    + (f.submission?.url ? '<div class="submission-copy"><b>Report:</b> ' + esc(f.submission.url) + '</div>' : '')
    + (f.submission?.note ? '<div class="submission-copy"><b>Submission note:</b> ' + esc(f.submission.note) + '</div>' : '')
    + '<details class="submission-detail"><summary>Evidence and reproduction</summary>'
    + (f.evidence ? '<div class="submission-copy"><b>Evidence</b>\\n' + esc(f.evidence) + '</div>' : '')
    + (f.repro ? '<div class="submission-copy"><b>Reproduction</b>\\n' + esc(f.repro) + '</div>' : '')
    + (!f.evidence && !f.repro ? empty('No evidence text recorded.') : '') + '</details></article>';
  const readySorted = bySeverity(readySubmissions);
  const reportedSorted = bySeverity(reportedSubmissions);
  el('ready-count').textContent = readySorted.length;
  el('reported-count').textContent = reportedSorted.length;
  el('submission-summary').textContent = readySorted.length + ' ready · ' + reportedSorted.length + ' submitted';
  el('submissions-ready').innerHTML = readySorted.length ? readySorted.map(submissionCard).join('') : empty('No confirmed findings waiting to be filed.');
  el('submissions-reported').innerHTML = reportedSorted.length ? reportedSorted.map(submissionCard).join('') : empty('No findings marked reported yet.');

  const pollRow = (p) => {
    const votes = Object.values(p.votes || {}).map((vote) => vote.choice);
    const yes = votes.filter((choice) => choice === 'yes').length;
    const no = votes.filter((choice) => choice === 'no').length;
    const abstain = votes.filter((choice) => choice === 'abstain').length;
    return '<div class="work-item"><div class="work-head"><code class="muted work-id">' + esc(p.id) + '</code>'
      + '<div class="work-title">' + esc(p.question) + '</div></div><div class="work-meta">'
      + pill(p.status === 'passed' ? 'clean' : p.status === 'rejected' ? 'skipped' : 'partial', p.status)
      + (p.systemManaged ? pill('reviewed', 'automatic inactivity review') : '')
      + '<span class="muted">' + yes + ' yes · ' + no + ' no · ' + abstain + ' abstain · '
      + votes.length + '/' + (p.eligible || []).length + ' cast</span></div>'
      + (p.reason ? '<div class="ink2" style="margin-top:7px">' + esc(p.reason) + '</div>' : '')
      + (p.action ? '<div class="muted" style="margin-top:5px">Action: <code>' + esc(JSON.stringify(p.action)) + '</code></div>' : '')
      + (p.execution ? '<div class="muted" style="margin-top:5px">Result: <code>' + esc(JSON.stringify(p.execution)) + '</code></div>' : '')
      + '</div>';
  };
  const openPolls = polls.filter((p) => p.status === 'open');
  const decidedPolls = polls.filter((p) => p.status !== 'open').slice().reverse();
  el('polls').innerHTML = '<div class="queue-group"><div class="group-title">Needs votes <span class="count">'
    + openPolls.length + '</span></div>' + (openPolls.length ? openPolls.map(pollRow).join('') : empty('No open polls.')) + '</div>'
    + '<details class="archive"><summary>Decided <span class="count">' + decidedPolls.length + '</span></summary>'
    + (decidedPolls.length ? decidedPolls.map(pollRow).join('') : empty('No decisions yet.')) + '</details>';

  // ---- the coverage table: who has actually read what, and did they agree
  const reviewTime = (f) => {
    const reviews = f.reviews || [];
    return f.lastTouched || (reviews.length && reviews[reviews.length - 1].ts) || '';
  };
  const sorted = [...reviewed].sort((a, b) => {
    const aDisputed = new Set(a.reviews.map((r) => r.verdict)).size > 1;
    const bDisputed = new Set(b.reviews.map((r) => r.verdict)).size > 1;
    return Number(bDisputed) - Number(aDisputed) || reviewTime(b).localeCompare(reviewTime(a));
  });
  el('files').innerHTML = sorted.length
    ? sorted.map((f) => {
          const dispute = new Set(f.reviews.map((r) => r.verdict)).size > 1;
          const search = [f.path, ...(f.findings || []), ...f.reviews.flatMap((r) => [r.agent, r.verdict, r.note, r.lines])].join(' ').toLowerCase();
          return '<article class="file-card" data-coverage-row data-search="' + esc(search) + '">'
            + '<div class="file-head"><div class="file-path">' + esc(f.path) + '</div>'
            + '<div class="file-links">' + (dispute ? pill('vulnerable', 'disputed') : f.reviews.length > 1 ? pill('clean', 'peer reviewed') : pill('reviewed', 'single review'))
            + (f.findings || []).map((id) => '<code class="pill reviewed">' + esc(id) + '</code>').join('') + '</div></div>'
            + f.reviews.map((r) => '<div class="review-row">'
                + '<div>' + who(r.agent) + (r.ts ? '<span class="review-lines">' + esc(onDay(r.ts) + at(r.ts)) + '</span>' : '') + '</div>'
                + '<div>' + pill(r.verdict, r.verdict) + (r.lines ? '<span class="review-lines">lines ' + esc(r.lines) + '</span>' : '') + '</div>'
                + '<div class="review-note' + (r.note ? '' : ' empty-note') + '">' + esc(r.note || 'No review note recorded.') + '</div>'
              + '</div>').join('')
            + '</article>';
        }).join('')
    : '<div class="empty">No files recorded yet — agents log them with the <code>file_review</code> tool.</div>';
  applyCoverageFilter();

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
    + (m.editedAt ? ' <span class="muted">edited ' + esc(ago(m.editedAt)) + '</span>' : '')
    + (canModerate && !m.deletedAt ? '<span class="message-actions">'
      + '<button class="message-action" data-message-action="edit" data-message-id="' + esc(m.id) + '">edit</button>'
      + '<button class="message-action delete" data-message-action="delete" data-message-id="' + esc(m.id) + '">delete</button></span>' : '')
    + '<div class="ink2' + (m.deletedAt ? ' message-deleted' : '') + '" style="margin-top:2px">'
      + (m.deletedAt ? 'Message deleted by human ' + esc(ago(m.deletedAt)) + '.' : esc(m.text)) + '</div>';

  // Threads: a reply nests under its ultimate in-view ancestor; threads sort by
  // their latest message so an active discussion stays near the top.
  const lastMsgs = (s.messages || []).slice(-40);
  messageById = new Map((s.messages || []).map((m) => [m.id, m]));
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
el('messages').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-message-action]');
  if (!button || !canModerate) return;
  const id = button.dataset.messageId;
  const action = button.dataset.messageAction;
  const message = messageById.get(id);
  if (!message) return;
  let options;
  if (action === 'edit') {
    const replacement = prompt('Replace ' + id + ' completely:', message.text || '');
    if (replacement === null || !replacement.trim() || replacement === message.text) return;
    options = { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:replacement}) };
  } else {
    if (!confirm('Delete ' + id + '? Its body will be erased and only an audit tombstone will remain.')) return;
    options = { method:'DELETE' };
  }
  button.disabled = true;
  try {
    const res = await fetch('/api/messages/' + encodeURIComponent(id) + q, options);
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'HTTP ' + res.status);
    await tick();
  } catch (error) {
    alert('Could not ' + action + ' ' + id + ': ' + error.message);
    button.disabled = false;
  }
});
tick();
setInterval(tick, 3000);
</script>
</body>
</html>`;
