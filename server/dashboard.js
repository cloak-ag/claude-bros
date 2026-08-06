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
  .grid.pair { grid-template-columns:repeat(2,minmax(0,1fr)); }
  @media (max-width:800px) { .grid.pair { grid-template-columns:1fr; } }

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
  /* Agents write their one-line status, but not everyone stays one line —
     clamp it instead of letting a stray essay stretch the compact panel. */
  .status-line { color:var(--ink-2); font-size:13px; overflow:hidden; text-overflow:ellipsis;
                 white-space:nowrap; max-width:100%; }

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

  /* Findings are a work queue, so unresolved work is primary and
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

  /* Submission candidates stay bounded; the complete bounty report lives in
     an accessible modal instead of turning the board into a wall of text. */
  .submissions-head { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; margin-bottom:16px; }
  .submissions-head h2 { margin-bottom:4px; }
  .submissions-head p { margin:0; }
  .submission-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
  .submission-column { min-width:0; }
  .submission-list { max-height:360px; overflow-y:auto; padding-right:4px; overscroll-behavior:contain;
                     scrollbar-width:thin; scrollbar-color:var(--rule) transparent; }
  .submission-card { display:block; width:100%; appearance:none; border:1px solid var(--line); border-radius:10px;
                     background:var(--plane); color:var(--ink); padding:13px 14px; text-align:left; cursor:pointer; }
  .submission-card + .submission-card { margin-top:10px; }
  .submission-card:hover { border-color:var(--muted); }
  .submission-card:focus-visible { outline:2px solid var(--series-1); outline-offset:2px; }
  .submission-card .work-title { flex:1; }
  .submission-summary-copy { display:-webkit-box; margin-top:8px; color:var(--ink-2); font-size:12.5px;
                             overflow:hidden; overflow-wrap:anywhere; -webkit-box-orient:vertical; -webkit-line-clamp:3; }
  .blocker-count { color:var(--warning); font-size:12px; }
  /* A submitted card whose linked advisory came back rejected/withdrawn must
     never read like a live "submitted" item — mute it and strike the title. */
  .submission-card.dead { border-color:var(--critical); }
  .submission-card.dead .work-title { color:var(--muted); text-decoration:line-through; }
  .submission-card.dead:hover { border-color:var(--critical); }
  /* The warning that would have saved a burn: a fence (prior public
     disclosure or an already-accepted competitor report) predates filing. */
  .fence-warning { display:block; margin-top:9px; padding:7px 9px; border:1px solid var(--critical);
                   border-radius:8px; background:color-mix(in srgb, var(--critical) 12%, transparent);
                   color:var(--critical); font-size:12px; font-weight:600; line-height:1.4; overflow-wrap:anywhere; }
  @media (max-width:1050px) {
    .submission-grid { grid-template-columns:1fr; }
    .submissions-head { align-items:flex-start; flex-direction:column; }
    .submission-list { max-height:300px; }
  }

  .modal-backdrop[hidden] { display:none; }
  .modal-backdrop { position:fixed; inset:0; z-index:20; display:grid; place-items:center; padding:24px;
                    background:rgba(0,0,0,.68); }
  .submission-modal { width:min(960px,100%); max-height:min(900px,calc(100vh - 48px)); overflow:auto;
                      border:1px solid var(--rule); border-radius:14px; background:var(--surface);
                      color:var(--ink); box-shadow:0 24px 80px rgba(0,0,0,.45); }
  .modal-head { position:sticky; top:0; z-index:1; display:flex; align-items:flex-start; gap:18px;
                padding:18px 20px; border-bottom:1px solid var(--line); background:var(--surface); }
  .modal-head-copy { flex:1; min-width:0; }
  .modal-kicker { color:var(--muted); font:11px var(--mono); text-transform:uppercase; letter-spacing:.08em; }
  .modal-title { margin:3px 0 8px; font-size:21px; line-height:1.3; overflow-wrap:anywhere; }
  .modal-close { flex:none; appearance:none; width:36px; height:36px; border:1px solid var(--line);
                 border-radius:8px; background:var(--plane); color:var(--ink); cursor:pointer; font-size:20px; }
  .modal-close:focus-visible { outline:2px solid var(--series-1); outline-offset:2px; }
  .modal-body { padding:20px; }
  .submission-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
  .submission-field { min-width:0; border:1px solid var(--line); border-radius:9px; padding:12px 13px; }
  .submission-field.wide { grid-column:1 / -1; }
  .field-label { display:block; margin-bottom:5px; color:var(--muted); font-size:10px; font-weight:700;
                 letter-spacing:.08em; text-transform:uppercase; }
  .field-value { color:var(--ink-2); white-space:pre-wrap; overflow-wrap:anywhere; }
  .field-value.missing { color:var(--warning); font-style:italic; }
  .field-source { margin-left:6px; color:var(--muted); font-size:10px; text-transform:none; letter-spacing:0; }
  .poc { max-height:340px; overflow:auto; margin:0; padding:12px; border-radius:7px; background:var(--plane);
         color:var(--ink-2); font:12px/1.55 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere; }
  .checklist { display:grid; gap:7px; margin:0; padding:0; list-style:none; }
  .checklist li { display:flex; align-items:flex-start; gap:8px; color:var(--ink-2); }
  .check-ok { color:var(--good); }
  .check-missing { color:var(--warning); }
  .blockers { margin:7px 0 0; padding-left:20px; color:var(--ink-2); }
  @media (max-width:680px) {
    .modal-backdrop { padding:0; place-items:stretch; }
    .submission-modal { width:100%; max-height:100vh; border-radius:0; }
    .submission-fields { grid-template-columns:1fr; }
    .submission-field.wide { grid-column:auto; }
  }

  /* Advisories: Anza's real disposition of a filed report — the ground
     truth the Submissions panel now mirrors instead of a flat "submitted". */
  .advisories-head { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; margin-bottom:16px; flex-wrap:wrap; }
  .advisories-head h2 { margin-bottom:4px; }
  .advisories-head p { margin:0; }
  .burn-ledger { font-variant-numeric:tabular-nums; font-size:12.5px; color:var(--ink-2); text-align:right; white-space:nowrap; }
  .burn-ledger b { color:var(--ink); font-size:15px; font-weight:650; }
  .advisory-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
  .advisory-card { border:1px solid var(--line); border-radius:10px; background:var(--plane); padding:13px 14px; min-width:0; }
  .advisory-card.dead { border-color:var(--critical); }
  .advisory-card.dead .work-title { color:var(--muted); text-decoration:line-through; }
  .advisory-sev { margin-top:8px; font-size:12px; color:var(--ink-2); display:flex; gap:8px; flex-wrap:wrap; }
  .advisory-reason { margin-top:9px; padding:8px 10px; border-left:2px solid var(--rule); color:var(--ink-2);
                      font-size:12.5px; font-style:italic; overflow-wrap:anywhere; }
  .advisory-meta { display:flex; flex-wrap:wrap; gap:5px 12px; margin-top:9px; font-size:11.5px; color:var(--muted); }
  .advisory-meta a { color:var(--series-1); }
  @media (max-width:640px) {
    .advisories-head { flex-direction:column; align-items:flex-start; }
    .burn-ledger { text-align:left; }
  }

  /* fence-quote is still used by the false-negative cross-check below, which
     is the one place a fence's incriminating quote still surfaces live —
     fence_add/fences and the §8-fences panel that grouped them are retired. */
  .fence-quote { margin-top:6px; padding:8px 10px; border-left:2px solid var(--rule); color:var(--ink-2);
                 font-size:12.5px; font-style:italic; overflow-wrap:anywhere; }

  /* False-negative cross-check: files a reviewer called clean, contradicted by
     a merged, credited report in the same path. */
  .contradiction-item { padding:11px 0; border-bottom:1px solid var(--line); }
  .contradiction-item:last-child { border-bottom:0; }
  .contradiction-item .path { color:var(--ink); font-weight:600; }

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

  /* Traffic is the highest-volume surface: give it a real reading viewport. */
  .traffic-section { height:min(720px, 72vh); display:flex; flex-direction:column; }
  .traffic-section > h2 { flex:none; }
  #messages { max-height:none; }
  #messages .row { line-height:1.5; }
  #messages .md { margin-top:7px; color:var(--ink-2); }
  #messages .md p { margin:0 0 8px; }
  #messages .md p:last-child { margin-bottom:0; }
  #messages .md h1, #messages .md h2, #messages .md h3 { color:var(--ink); margin:8px 0 5px; line-height:1.25; }
  #messages .md h1 { font-size:18px; } #messages .md h2 { font-size:16px; } #messages .md h3 { font-size:14px; }
  #messages .md ul, #messages .md ol { margin:4px 0 8px 20px; padding:0; }
  #messages .md li { margin:2px 0; }
  #messages .md blockquote { margin:6px 0; padding:3px 10px; border-left:3px solid var(--rule); color:var(--muted); }
  #messages .md pre { overflow:auto; margin:6px 0; padding:9px 10px; background:var(--track); border-radius:7px; }
  #messages .md code { font-family:var(--mono); font-size:.92em; color:var(--ink); background:var(--track); border-radius:4px; padding:1px 4px; }
  #messages .md pre code { padding:0; background:transparent; }
  #messages .md a { color:var(--series-1); text-decoration:underline; }
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

  <div class="grid pair">
    <section><h2>Agents — live heartbeat</h2><div class="pane" id="agents"></div></section>
    <section><h2>Findings</h2><div class="pane" id="findings"></div></section>
  </div>

  <section class="submissions-section">
    <div class="submissions-head">
      <div><h2>Submissions</h2><p class="muted">Confirmed candidates are ready only when every required Anza report field is recorded. Blocked candidates are ordered closest to filing first.</p></div>
      <div class="muted" id="submission-summary"></div>
    </div>
    <div class="submission-grid">
      <div class="submission-column"><div class="group-title">Ready to submit <span class="count" id="ready-count">0</span></div><div class="submission-list" data-preserve-scroll id="submissions-ready"></div></div>
      <div class="submission-column"><div class="group-title">Needs report work <span class="count" id="needs-work-count">0</span></div><div class="submission-list" data-preserve-scroll id="submissions-needs-work"></div></div>
      <div class="submission-column"><div class="group-title">Submitted <span class="count" id="reported-count">0</span></div><div class="submission-list" data-preserve-scroll id="submissions-reported"></div></div>
    </div>
  </section>

  <section class="advisories-section">
    <div class="advisories-head">
      <div><h2>Advisories — Anza's verdict</h2><p class="muted">What actually happened to a filed report once it left the building — the ground truth the Submissions panel now mirrors.</p></div>
      <div class="burn-ledger" id="burn-ledger"></div>
    </div>
    <div class="advisory-grid" id="advisories"></div>
  </section>

  <section class="contradictions-section">
    <h2>⚠ Cleared files with accepted bugs</h2>
    <p class="muted">A file a reviewer marked "clean" that Anza then credited someone else's accepted report against.</p>
    <div class="pane" id="contradictions" style="max-height:360px;margin-top:10px"></div>
  </section>

  <section class="coverage-section">
    <div class="coverage-head">
      <div><h2>File coverage — the shared brain</h2><p class="muted">Every review, verdict, and note stays paired with its file.</p></div>
      <label class="coverage-filter"><span>Filter coverage</span><input id="coverage-filter" type="search" placeholder="Path, reviewer, verdict, note…" autocomplete="off"></label>
    </div>
    <div class="coverage-list" id="files"></div>
    <div class="empty coverage-none" id="coverage-none">No reviews match this filter.</div>
  </section>

  <section class="traffic-section"><h2>Traffic — threaded</h2><div class="pane" id="messages"></div></section>
</div>

<div class="modal-backdrop" id="submission-modal" hidden>
  <div class="submission-modal" role="dialog" aria-modal="true" aria-labelledby="submission-modal-title" tabindex="-1">
    <div class="modal-head">
      <div class="modal-head-copy"><div class="modal-kicker" id="submission-modal-kicker"></div><h2 class="modal-title" id="submission-modal-title">Submission</h2><div id="submission-modal-status"></div></div>
      <button class="modal-close" id="submission-modal-close" type="button" aria-label="Close submission details">×</button>
    </div>
    <div class="modal-body" id="submission-modal-body"></div>
  </div>
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
// Safe, small Markdown subset for agent traffic. Text is escaped before only
// generated tags are introduced; links are restricted to http(s) destinations.
const mdInline = (s) => {
  let x = esc(s);
  x = x.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  const tick = String.fromCharCode(96);
  x = x.replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), '<code>$1</code>');
  x = x.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  x = x.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>').replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  return x;
};
const markdown = (value) => {
  const lines = String(value ?? '').replace(/\\r/g, '').split('\\n');
  const out = []; let code = false; let codeLines = []; let list = null;
  const fence = String.fromCharCode(96).repeat(3);
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const line of lines) {
    if (line.trimStart().startsWith(fence)) {
      if (code) out.push('<pre><code>' + codeLines.map(esc).join(String.fromCharCode(10)) + '</code></pre>');
      else closeList();
      code = !code; codeLines = []; continue;
    }
    if (code) { codeLines.push(line); continue; }
    if (!line.trim()) { closeList(); continue; }
    const heading = line.match(/^\\s*(#{1,3})\\s+(.+)$/);
    if (heading) { closeList(); const tag = 'h' + heading[1].length; out.push('<' + tag + '>' + mdInline(heading[2]) + '</' + tag + '>'); continue; }
    const item = line.match(/^\\s*([-*]|\\d+\\.)\\s+(.+)$/);
    if (item) { const wanted = /^\\d/.test(item[1]) ? 'ol' : 'ul'; if (list !== wanted) { closeList(); list = wanted; out.push('<' + list + '>'); } out.push('<li>' + mdInline(item[2]) + '</li>'); continue; }
    if (/^\\s*>\\s?/.test(line)) { closeList(); out.push('<blockquote>' + mdInline(line.replace(/^\\s*>\\s?/, '')) + '</blockquote>'); continue; }
    closeList(); out.push('<p>' + mdInline(line) + '</p>');
  }
  if (code) out.push('<pre><code>' + codeLines.map(esc).join(String.fromCharCode(10)) + '</code></pre>');
  closeList(); return out.join('');
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
let rejectedArchiveOpen = false;
let agentArchiveOpen = false;
let submissionById = new Map();
let modalReturnFocus = null;
let openSubmissionId = null;

const present = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const pick = (...values) => values.find(present);
const envValue = (env, ...keys) => {
  const wanted = keys.map((key) => key.toLowerCase());
  const entry = Object.entries(env || {}).find(([key]) => wanted.includes(key.toLowerCase()));
  return entry ? pick(entry[1]?.value, entry[1]) : '';
};
const cleanSubmissionTitle = (finding) => String(pick(finding.submission?.title, finding.cleanTitle, finding.title) || '')
  .replace(/^\s*(?:\[[^\]]+\]|F\d+\s*[:—-])\s*/i, '').replace(/\s+/g, ' ').trim();

const buildSubmission = (finding, env) => {
  const submission = finding.submission || {};
  const product = [submission.ecosystem, submission.packageName].filter(present).join(' / ');
  const version = [submission.affectedVersions ? 'Affected: ' + submission.affectedVersions : '',
    submission.patchedVersions ? 'Patched: ' + submission.patchedVersions : ''].filter(present).join(' / ');
  const values = {
    title:pick(submission.title, cleanSubmissionTitle(finding)), summary:submission.summary, details:submission.details, poc:submission.poc,
    impact:submission.impact, product, version, severity:pick(submission.severity, finding.severity),
    cvss:submission.cvss, cwe:submission.cwe, citedCommit:submission.commit,
    currentCommit:envValue(env, 'commit', 'current_commit'), duplicateCheck:submission.duplicateCheck,
    owner:submission.owner, category:submission.category, masterCheckedAt:submission.masterCheckedAt,
    knownIssuesCheckedAt:submission.knownIssuesCheckedAt,
  };
  const requirements = [
    ['Clean report title', present(submission.title)],
    ['Summary', present(submission.summary)],
    ['Details / vulnerability mechanism', present(submission.details)],
    ['Complete inline PoC and reproduction', present(submission.poc)],
    ['Impact', present(submission.impact)],
    ['Exact master commit reproduced', present(submission.commit)],
    ['RULES.md impact category', present(submission.category)],
    ['Human submission owner', present(submission.owner)],
    ['Current-master check timestamp', present(submission.masterCheckedAt)],
    ['Known/public-issue check timestamp', present(submission.knownIssuesCheckedAt)],
    ['Finding independently reproduced', submission.reproductionVerified === true],
    ['Confirmed live on current master', submission.liveOnMaster === true],
    ['PoC is self-contained and inline', submission.inlinePoc === true],
    ['PoC demonstrates claimed impact', submission.impactDemonstrated === true],
    ['Known/public issues checked', submission.knownIssuesChecked === true],
    ['One finding per advisory', submission.oneFinding === true],
    ['Private/confidential handling confirmed', submission.confidential === true],
    ['Human owner GitHub 2FA verified', submission.twoFactorVerified === true],
    ['Submission window verified', submission.windowVerified === true],
  ].map(([label, ok]) => ({ label, ok:Boolean(ok) }));
  const source = finding.readiness || {};
  const blockers = Array.isArray(source.blockers) ? source.blockers.map(String) : requirements.filter((item) => !item.ok).map((item) => item.label);
  const readiness = source.state === 'reported' || finding.status === 'reported' ? 'submitted'
    : source.ready === true || source.state === 'ready' ? 'ready' : 'needs_work';
  return {
    id:finding.id, finding, values, requirements, blockers, readiness,
    requiredComplete:Number.isFinite(source.requiredComplete) ? source.requiredComplete : requirements.filter((item) => item.ok).length,
    requiredTotal:Number.isFinite(source.requiredTotal) ? source.requiredTotal : requirements.length,
  };
};

// -------------------------------------------------------------- advisories
// Anza's real disposition of a filed report. finding.status === 'reported'
// only means WE filed it — it says nothing about what came back. These
// helpers turn (advisory, fence) data into the badges/warnings that replace
// the flat "submitted" label and the missing prior-art check that cost F15
// its 0.5 SOL burn.
const solFmt = (n) => {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
};
const truncMid = (s, head = 8, tail = 6) => {
  const str = String(s || '');
  return str.length > head + tail + 1 ? str.slice(0, head) + '…' + str.slice(-tail) : str;
};
// "5h25m" / "1d3h" — the delta that would have told F15's filer to stop.
// Rounded to the nearest minute (not floored) so e.g. 5h24m56s reads 5h25m.
const humanDelta = (msDiff) => {
  const totalMinutes = Math.max(0, Math.round(Math.abs(msDiff) / 60000));
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (d || h) parts.push(h + 'h');
  parts.push(m + 'm');
  return parts.join('');
};
// Maps an advisory's real outcome onto the existing pill vocabulary — no new
// pill kinds needed, just the honest one: rejected/withdrawn read as dead
// (critical, struck through), accepted/paid read as good, everything else
// (draft/pending) reads as an open, amber, in-review item.
const ADVISORY_BADGE = {
  rejected: { kind: 'vulnerable', dead: true },
  withdrawn: { kind: 'skipped', dead: true },
  accepted: { kind: 'clean', dead: false },
  paid: { kind: 'clean', dead: false },
  pending: { kind: 'partial', dead: false },
};
const advisoryBadge = (advisory) => {
  const outcome = advisory.outcome || 'pending';
  const info = ADVISORY_BADGE[outcome] || ADVISORY_BADGE.pending;
  const stateLabel = String(advisory.state || 'draft').toUpperCase();
  const outcomeLabel = outcome === 'pending'
    ? (advisory.state === 'draft' ? 'awaiting triage' : 'pending')
    : outcome + (advisory.closedBy ? ' by ' + advisory.closedBy : '');
  return { kind: info.kind, dead: info.dead, label: stateLabel + ' · ' + outcomeLabel };
};
// A finding's effective filing timestamp: the advisory's real submission time
// if we have one, else our own reportedAt, else null (not filed yet — any
// applicable fence is automatically a live risk, not a historical one).
const findingFilingTs = (finding, advisory) => {
  const t = pick(advisory && advisory.submittedAt, finding && finding.reportedAt);
  return t ? ms(t) : null;
};
// The earliest fence that both applies to this finding and predates (or has
// no) filing — i.e. the prior-art/duplicate/by-design collision that would
// have excluded the finding under RULES §8 before a burn was spent on it.
const collisionFor = (finding, advisory, fences) => {
  if (!finding) return null;
  let best = null;
  for (const fence of fences || []) {
    if (!Array.isArray(fence.appliesTo) || !fence.appliesTo.includes(finding.id)) continue;
    const pubRaw = fence.publishedAt || fence.mergedAt;
    if (!pubRaw) continue;
    const pub = ms(pubRaw);
    if (!pub) continue;
    const filingTs = findingFilingTs(finding, advisory);
    if (filingTs !== null && pub >= filingTs) continue; // fence landed after we filed — no risk
    if (!best || pub < best.pub) best = { fence, pub, filingTs };
  }
  return best;
};
const FENCE_RISK_LABEL = {
  accepted_report: 'PRIOR-ACCEPTED RISK', duplicate: 'DUPLICATE RISK', by_design: 'BY-DESIGN RISK',
};
const collisionBanner = (collision) => {
  if (!collision) return '';
  const { fence, filingTs, pub } = collision;
  const ref = fence.ref || fence.title || fence.id;
  const label = FENCE_RISK_LABEL[fence.kind] || '§8 RISK';
  const when = filingTs === null
    ? 'published ' + humanDelta(Date.now() - pub) + ' ago — not yet filed'
    : 'published ' + humanDelta(filingTs - pub) + ' before filing';
  return '<span class="fence-warning">⚠ ' + esc(label) + ' — ' + esc(ref) + ' ' + esc(when) + '</span>';
};
// Files a reviewer marked "clean" that a merged, credited competitor report
// (an accepted_report fence) later proved vulnerable in the same path —
// the exact false negative that hit block_id_repair_service.rs.
const pathsMatch = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('/' + b) || b.endsWith('/' + a);
};

const hasDashboardSelection = () => {
  const selection = window.getSelection && window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const node = selection.anchorNode || selection.focusNode;
  return Boolean(node && document.body.contains(node));
};
const captureRenderState = () => {
  const active = document.activeElement;
  const keyed = active && active.closest && active.closest('[data-focus-key]');
  const detail = active && active.closest && active.closest('details[data-detail-id]');
  return {
    openDetails:new Set([...document.querySelectorAll('details[data-detail-id][open]')].map((node) => node.dataset.detailId)),
    scrolls:new Map([...document.querySelectorAll('[data-preserve-scroll][id]')].map((node) => [node.id, node.scrollTop])),
    focusId:active && active !== document.body ? active.id : '',
    focusKey:keyed ? keyed.dataset.focusKey : '',
    focusDetail:detail && active.tagName === 'SUMMARY' ? detail.dataset.detailId : '',
    modalId:openSubmissionId,
    modalScroll:document.querySelector('.submission-modal')?.scrollTop || 0,
  };
};
const restoreRenderState = (state) => {
  document.querySelectorAll('details[data-detail-id]').forEach((node) => {
    node.open = state.openDetails.has(node.dataset.detailId);
  });
  state.scrolls.forEach((top, id) => { const node = el(id); if (node) node.scrollTop = top; });
  let focus = state.focusId && el(state.focusId);
  if (!focus && state.focusKey) focus = [...document.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === state.focusKey);
  if (!focus && state.focusDetail) {
    const details = [...document.querySelectorAll('details[data-detail-id]')].find((node) => node.dataset.detailId === state.focusDetail);
    focus = details && details.querySelector('summary');
  }
  if (focus && focus.focus) focus.focus({ preventScroll:true });
  if (state.modalId && submissionById.has(state.modalId)) {
    openSubmission(state.modalId, null, true);
    document.querySelector('.submission-modal').scrollTop = state.modalScroll;
  }
};

const modalField = (label, value, options = {}) => '<div class="submission-field' + (options.wide ? ' wide' : '') + '">'
  + '<span class="field-label">' + esc(label) + (options.source ? '<span class="field-source">' + esc(options.source) + '</span>' : '') + '</span>'
  + (options.poc && present(value) ? '<pre class="poc">' + esc(value) + '</pre>'
    : '<div class="field-value' + (present(value) ? '' : ' missing') + '">' + esc(present(value) ? value : 'Not recorded') + '</div>')
  + '</div>';
const openSubmission = (id, trigger, preserveFocus = false) => {
  const model = submissionById.get(id);
  if (!model) return;
  openSubmissionId = id;
  if (!preserveFocus) modalReturnFocus = trigger || document.activeElement;
  let statusKind = model.readiness === 'ready' ? 'clean' : model.readiness === 'submitted' ? 'reviewed' : 'partial';
  let statusLabel = model.readiness === 'ready' ? 'ready to submit' : model.readiness === 'submitted' ? 'submitted' : 'needs report work';
  if (model.readiness === 'submitted' && model.advisory) {
    const badge = advisoryBadge(model.advisory);
    statusKind = badge.kind; statusLabel = badge.label;
  }
  el('submission-modal-kicker').textContent = model.id + ' · Anza bounty report';
  el('submission-modal-title').textContent = model.values.title || model.id;
  el('submission-modal-status').innerHTML = pill(statusKind, statusLabel)
    + (model.blockers.length ? ' <span class="blocker-count">' + model.blockers.length + ' blocker(s)</span>' : '');
  const f = model.finding;
  const checklist = '<ul class="checklist">' + model.requirements.map((item) => '<li><span class="'
    + (item.ok ? 'check-ok' : 'check-missing') + '">' + (item.ok ? '✓' : '○') + '</span>' + esc(item.label) + '</li>').join('') + '</ul>';
  const blockers = model.blockers.length ? '<ul class="blockers">' + model.blockers.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>'
    : '<div class="field-value">No recorded blockers.</div>';
  el('submission-modal-body').innerHTML = '<div class="submission-fields">'
    + modalField('Clean title', model.values.title)
    + modalField('Readiness status', statusLabel + (f.status === 'confirmed' ? ' · peer confirmed' : ''))
    + modalField('Summary', model.values.summary, { wide:true })
    + modalField('Details / mechanism', model.values.details, { wide:true })
    + modalField('PoC / reproduction', model.values.poc, { wide:true, poc:true })
    + modalField('Impact', model.values.impact, { wide:true })
    + modalField('Affected product', model.values.product)
    + modalField('Affected versions', model.values.version)
    + modalField('Severity', model.values.severity)
    + modalField('CVSS', model.values.cvss)
    + modalField('CWE / weakness', model.values.cwe)
    + modalField('Target / component', f.target)
    + modalField('Reproduced master commit', model.values.citedCommit)
    + modalField('Current commit', model.values.currentCommit, { source:present(model.values.currentCommit) ? 'shared environment' : '' })
    + modalField('RULES.md category', model.values.category)
    + modalField('Current-master checked at', model.values.masterCheckedAt)
    + modalField('Known issues checked at', model.values.knownIssuesCheckedAt)
    + modalField('Duplicate check', model.values.duplicateCheck, { wide:true })
    + modalField('Submission owner', model.values.owner)
    + modalField('Confirmed by', f.confirmedBy)
    + modalField('Finding evidence (not a substitute for report fields)', f.evidence, { wide:true })
    + modalField('Finding reproduction (not a substitute for inline PoC)', f.repro, { wide:true, poc:true })
    + modalField('Report reference', f.submission?.url)
    + modalField('Submission note', f.submission?.note)
    + (model.advisory ? modalField('Anza verdict', String(model.advisory.state || 'draft').toUpperCase() + ' · '
        + (model.advisory.outcome || 'pending') + (model.advisory.closedBy ? ' by ' + model.advisory.closedBy : '')) : '')
    + (model.advisory && model.advisory.outcomeReason ? modalField('Anza outcome reason (verbatim)', model.advisory.outcomeReason, { wide:true }) : '')
    + (model.advisory ? modalField('Anza severity vs ours', pick(model.advisory.anzaSeverity, '—') + ' vs '
        + pick(model.advisory.ourSeverity, model.values.severity, '—')) : '')
    + (model.advisory ? modalField('Burn', (present(model.advisory.burnSol) ? solFmt(model.advisory.burnSol) + ' SOL' : '—')
        + (model.advisory.burnTx ? ' · tx ' + truncMid(model.advisory.burnTx) : '')) : '')
    + (model.advisory && model.advisory.url ? '<div class="submission-field wide"><span class="field-label">GHSA advisory</span>'
        + '<div class="field-value"><a href="' + esc(model.advisory.url) + '" target="_blank" rel="noreferrer noopener">' + esc(model.advisory.ghsaId) + '</a></div></div>' : '')
    + (model.fenceHit ? '<div class="submission-field wide"><span class="field-label">§8 / prior-art risk</span>' + collisionBanner(model.fenceHit) + '</div>' : '')
    + '<div class="submission-field wide"><span class="field-label">Readiness checklist</span>' + checklist + '</div>'
    + '<div class="submission-field wide"><span class="field-label">Blockers</span>' + blockers + '</div>'
    + '</div>';
  el('submission-modal').hidden = false;
  document.body.style.overflow = 'hidden';
  if (!preserveFocus) el('submission-modal-close').focus();
};
const closeSubmission = () => {
  if (el('submission-modal').hidden) return;
  el('submission-modal').hidden = true;
  document.body.style.overflow = '';
  openSubmissionId = null;
  if (modalReturnFocus && modalReturnFocus.isConnected) modalReturnFocus.focus({ preventScroll:true });
  modalReturnFocus = null;
};
el('submission-modal-close').addEventListener('click', closeSubmission);
el('submission-modal').addEventListener('click', (event) => { if (event.target === el('submission-modal')) closeSubmission(); });
el('submission-modal').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeSubmission(); return; }
  if (event.key === 'Tab') { event.preventDefault(); el('submission-modal-close').focus(); }
});
document.querySelector('.submissions-section').addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-submission-id]');
  if (trigger) openSubmission(trigger.dataset.submissionId, trigger);
});

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
  // Polling may continue while somebody reads/copies evidence, but replacing
  // innerHTML would destroy their selection. Render the next fresh state only
  // after the selection collapses.
  if (hasDashboardSelection()) return;
  const renderState = captureRenderState();
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
  const files = Object.values(s.files || {});
  const findings = s.findings || [];
  // Advisories/fences are the ground truth a plain finding.status never
  // learns: what Anza actually did with a filed report, and what prior-art
  // already forecloses a class of finding.
  const advisories = s.advisories || [];
  const fences = s.fences || [];
  const advisoryByFindingId = new Map(advisories.filter((a) => a.findingId).map((a) => [a.findingId, a]));
  const submissionCandidates = Array.isArray(s.submissions) ? s.submissions
    : findings.filter((f) => ['confirmed', 'reported'].includes(f.status));
  const submissionModels = submissionCandidates.map((f) => buildSubmission(f, s.env || {}));
  // Attach the real outcome + collision check to every model up front so the
  // card renderer, the modal, and the readiness summary all read one source.
  submissionModels.forEach((model) => {
    model.advisory = advisoryByFindingId.get(model.id) || null;
    model.fenceHit = collisionFor(model.finding, model.advisory, fences);
  });
  submissionById = new Map(submissionModels.map((model) => [String(model.id), model]));
  const readySubmissions = submissionModels.filter((model) => model.readiness === 'ready');
  const needsWorkSubmissions = submissionModels.filter((model) => model.readiness === 'needs_work');
  const reportedSubmissions = submissionModels.filter((model) => model.readiness === 'submitted');

  // ---- coverage
  const reviewed = files.filter((f) => (f.reviews || []).length);
  const peer = reviewed.filter((f) => f.reviews.length > 1);
  const disputed = reviewed.filter((f) => new Set(f.reviews.map((r) => r.verdict)).size > 1);
  const actionableFindings = findings.filter((f) => !['confirmed', 'reported', 'rejected'].includes(f.status));
  const worst = ['critical','high','medium','low','info'].find((sev) => actionableFindings.some((f) => f.severity === sev));

  el('stats').innerHTML = [
    '<div class="stat"><div class="n">' + counts.active + '<span class="muted" style="font-size:15px">/' + activeAgents.length + '</span></div>'
      + '<div class="l">agents up</div><div class="sub">' + esc(names.join(', ') || '—')
      + ' · ' + counts.quiet + ' quiet / ' + counts.offline + ' offline'
      + (removedAgents.length ? ' · ' + removedAgents.length + ' removed' : '') + '</div></div>',
    '<div class="stat"><div class="n">' + reviewed.length + '</div><div class="l">files covered</div>'
      + '<div class="sub">' + peer.length + ' peer-reviewed'
      + (disputed.length ? ' · <b style="color:var(--critical)">' + disputed.length + ' disputed</b>' : '') + '</div></div>',
    '<div class="stat"><div class="n">' + actionableFindings.length + '</div><div class="l">findings to verify</div>'
      + '<div class="sub">' + (worst ? pill(worst, 'worst: ' + worst) : 'none yet')
      + (findings.filter((f) => f.status === 'rejected').length ? ' · ' + findings.filter((f) => f.status === 'rejected').length + ' rejected' : '') + '</div></div>',
    '<div class="stat"><div class="n">' + readySubmissions.length + '</div><div class="l">ready to submit</div>'
      + '<div class="sub">' + needsWorkSubmissions.length + ' need report work · ' + reportedSubmissions.length + ' submitted</div></div>',
  ].join('');

  // Agents pane: presence and a one-line status only — task ownership used to
  // be folded in here, but tasks are retired (see the archive tool), and a
  // compact roster is the point. Long free-text status lines are clamped to
  // one line instead of letting a multi-paragraph essay stretch the panel.
  const agentRow = (a, removed = false) => {
    const st = liveness(a);
    const t = ms(a.lastSeen);
    return who(a.name, removed ? 'offline' : st)
      + (removed ? ' ' + pill('skipped', 'removed') : '')
      + '<div class="status-line" style="margin-top:3px">' + esc(a.status || 'idle') + '</div>'
      + (a.client ? '<div class="muted">Client: ' + esc(a.client.title || a.client.name)
        + (a.client.version ? ' ' + esc(a.client.version) : '') + '</div>' : '')
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

  const SEV = { critical:0, high:1, medium:2, low:3, info:4 };
  const bySeverity = (list) => [...list].sort((a, b) =>
    (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9) || (b.ts || '').localeCompare(a.ts || ''));
  const standingFindings = bySeverity(actionableFindings);
  const rejectedFindings = bySeverity(findings.filter((f) => f.status === 'rejected'));
  const findingRow = (f) => {
    const collision = collisionFor(f, advisoryByFindingId.get(f.id) || null, fences);
    return '<div class="work-item finding-item">'
      + '<div class="work-head"><code class="muted work-id">' + esc(f.id) + '</code>'
      + '<div class="work-title">' + esc(f.title) + '</div></div>'
      + '<div class="work-meta">' + pill(f.severity, f.severity)
      + pill(f.status === 'confirmed' ? 'clean' : f.status === 'rejected' ? 'skipped' : 'partial', f.status)
      + (f.by ? '<span class="muted">reported by ' + esc(f.by) + '</span>' : '') + '</div>'
      + (f.target ? '<div class="path">' + esc(f.target) + '</div>' : '')
      + (collision ? collisionBanner(collision) : '')
      + '</div>';
  };
  el('findings').innerHTML = '<div class="queue-group"><div class="group-title">Standing &amp; actionable <span class="count">'
    + standingFindings.length + '</span></div>'
    + (standingFindings.length ? standingFindings.map(findingRow).join('') : empty('No standing findings.')) + '</div>'
    + '<details class="archive"' + (rejectedArchiveOpen ? ' open' : '') + '><summary>Rejected <span class="count">' + rejectedFindings.length + '</span></summary>'
    + (rejectedFindings.length ? rejectedFindings.map(findingRow).join('') : empty('No rejected findings.')) + '</details>';
  el('findings').querySelector('details.archive').addEventListener('toggle', (event) => {
    rejectedArchiveOpen = event.currentTarget.open;
  });

  const submissionCard = (model) => {
    const f = model.finding;
    let kind = model.readiness === 'ready' ? 'clean' : model.readiness === 'submitted' ? 'reviewed' : 'partial';
    let label = model.readiness === 'ready' ? 'ready' : model.readiness === 'submitted' ? 'submitted' : 'blocked';
    let dead = false;
    let metaExtra = '<span class="muted">' + model.requiredComplete + '/' + model.requiredTotal + ' required checks</span>';
    let copy = model.values.summary ? '<span class="submission-summary-copy">' + esc(model.values.summary) + '</span>' : '';
    // A submitted item's real state is its advisory outcome, not the flat
    // "submitted" label — F15 (closed/rejected) must never render like F18
    // (still an untriaged draft).
    if (model.readiness === 'submitted' && model.advisory) {
      const badge = advisoryBadge(model.advisory);
      kind = badge.kind; label = badge.label; dead = badge.dead;
      metaExtra = '<span class="muted">' + esc(model.advisory.ghsaId) + '</span>';
      if (model.advisory.outcomeReason) copy = '<span class="submission-summary-copy">“' + esc(model.advisory.outcomeReason) + '”</span>';
    }
    return '<button type="button" class="submission-card' + (dead ? ' dead' : '') + '" data-submission-id="' + esc(model.id)
      + '" data-focus-key="submission-' + esc(model.id) + '">'
      + '<div class="work-head"><code class="muted work-id">' + esc(model.id) + '</code>'
      + '<div class="work-title">' + esc(model.values.title || f.title) + '</div></div>'
      + '<div class="work-meta">' + (model.rank ? '<span class="muted">rank #' + model.rank + '</span>' : '')
      + pill(model.values.severity, model.values.severity)
      + pill(kind, label)
      + metaExtra + '</div>'
      + copy
      + (model.blockers.length && model.readiness !== 'submitted' ? '<span class="blocker-count">' + model.blockers.length + ' blocker(s) · open for details</span>' : '')
      + (model.fenceHit ? collisionBanner(model.fenceHit) : '')
      + '</button>';
  };
  const submissionSeverity = (model) => SEV[model.values.severity] ?? 9;
  const readinessScore = (model) => model.requiredTotal ? model.requiredComplete / model.requiredTotal : 0;
  const compareReadiness = (a, b) =>
    readinessScore(b) - readinessScore(a)
      || a.blockers.length - b.blockers.length
      || submissionSeverity(a) - submissionSeverity(b)
      || String(a.id).localeCompare(String(b.id), undefined, { numeric:true });
  const candidateRanking = [...readySubmissions, ...needsWorkSubmissions].sort(compareReadiness);
  candidateRanking.forEach((model, index) => { model.rank = index + 1; });
  const sortSubmissions = (list) => [...list].sort(compareReadiness);
  const readySorted = sortSubmissions(readySubmissions);
  const needsWorkSorted = sortSubmissions(needsWorkSubmissions);
  const reportedSorted = sortSubmissions(reportedSubmissions);
  el('ready-count').textContent = readySorted.length;
  el('needs-work-count').textContent = needsWorkSorted.length;
  el('reported-count').textContent = reportedSorted.length;
  // Readiness honesty: a candidate is never presented as cleanly "ready" while
  // an unresolved fence still applies to it — say so in the summary too.
  const readyAtRisk = readySorted.filter((model) => model.fenceHit).length;
  el('submission-summary').textContent = readySorted.length + ' ready · ' + needsWorkSorted.length + ' blocked · ' + reportedSorted.length + ' submitted'
    + (readyAtRisk ? ' · ⚠ ' + readyAtRisk + ' ready but §8-at-risk' : '') + ' · ranked by readiness';
  el('submissions-ready').innerHTML = readySorted.length ? readySorted.map(submissionCard).join('') : empty('No submission is ready.');
  el('submissions-needs-work').innerHTML = needsWorkSorted.length ? needsWorkSorted.map(submissionCard).join('') : empty('No blocked candidates.');
  el('submissions-reported').innerHTML = reportedSorted.length ? reportedSorted.map(submissionCard).join('') : empty('No findings marked reported yet.');

  // ---- advisories: Anza's real disposition, plus the burn ledger
  const advisoryCard = (advisory) => {
    const badge = advisoryBadge(advisory);
    const collision = advisory.findingId ? collisionFor({ id: advisory.findingId }, advisory, fences) : null;
    const sevLine = (advisory.anzaSeverity || advisory.ourSeverity)
      ? '<div class="advisory-sev">' + (advisory.ourSeverity ? 'our: ' + pill(advisory.ourSeverity, advisory.ourSeverity) : '')
        + (advisory.anzaSeverity ? ' anza: ' + pill(advisory.anzaSeverity, advisory.anzaSeverity) : '') + '</div>' : '';
    return '<article class="advisory-card' + (badge.dead ? ' dead' : '') + '">'
      + '<div class="work-head"><code class="muted work-id">' + esc(advisory.ghsaId) + '</code>'
      + '<div class="work-title">' + esc(advisory.title || advisory.ghsaId) + '</div></div>'
      + '<div class="work-meta">' + pill(badge.kind, badge.label)
      + (advisory.findingId ? '<code class="muted">' + esc(advisory.findingId) + '</code>' : '') + '</div>'
      + sevLine
      + (collision ? collisionBanner(collision) : '')
      + (advisory.outcomeReason ? '<div class="advisory-reason">“' + esc(advisory.outcomeReason) + '”</div>' : '')
      + '<div class="advisory-meta">'
      + (advisory.product ? '<span>' + esc(advisory.product) + '</span>' : '')
      + (advisory.affectedVersions ? '<span>affected ' + esc(advisory.affectedVersions) + '</span>' : '')
      + (advisory.patchedVersions ? '<span>patched ' + esc(advisory.patchedVersions) + '</span>' : '')
      + (advisory.submittedAt ? '<span>filed ' + esc(onDay(advisory.submittedAt) + at(advisory.submittedAt)) + ' UTC−3</span>' : '')
      + (advisory.burnTx ? '<span class="mono">tx ' + esc(truncMid(advisory.burnTx)) + '</span>' : '')
      + (present(advisory.burnSol) ? '<span>' + esc(solFmt(advisory.burnSol)) + ' SOL</span>' : '')
      + (advisory.url ? '<a href="' + esc(advisory.url) + '" target="_blank" rel="noreferrer noopener">advisory ↗</a>' : '')
      + '</div>'
      + '</article>';
  };
  el('advisories').innerHTML = advisories.length ? advisories.map(advisoryCard).join('') : empty('No advisories recorded yet.');
  {
    const totalSol = advisories.reduce((a, adv) => a + (Number(adv.burnSol) || 0), 0);
    const counts = { pending:0, rejected:0, accepted:0, paid:0, withdrawn:0 };
    advisories.forEach((adv) => { const k = Object.prototype.hasOwnProperty.call(counts, adv.outcome) ? adv.outcome : 'pending'; counts[k] += 1; });
    const parts = ['rejected','pending','accepted','paid'].map((k) => counts[k] + ' ' + k);
    el('burn-ledger').innerHTML = '<b>' + esc(solFmt(totalSol)) + ' SOL burned</b> · ' + parts.map(esc).join(' · ');
  }

  // ---- false-negative cross-check: files cleared by review, contradicted by
  // a merged, credited competitor report in the same path.
  const acceptedFences = fences.filter((fn) => fn.kind === 'accepted_report');
  const contradictions = [];
  for (const file of files) {
    const cleanReviewers = [...new Set((file.reviews || []).filter((r) => r.verdict === 'clean').map((r) => r.agent))];
    if (!cleanReviewers.length) continue;
    for (const fn of acceptedFences) {
      if ((fn.paths || []).some((p) => pathsMatch(file.path, p))) contradictions.push({ path: file.path, reviewers: cleanReviewers, fence: fn });
    }
  }
  el('contradictions').innerHTML = contradictions.length
    ? contradictions.map((c) => '<div class="contradiction-item">'
        + '<div class="path">' + esc(c.path) + '</div>'
        + '<div class="muted" style="margin-top:4px">marked clean by ' + esc(c.reviewers.join(', ')) + '</div>'
        + '<div class="muted" style="margin-top:4px">contradicted by <code class="mono">' + esc(c.fence.ref || c.fence.id) + '</code>'
        + (c.fence.url ? ' — <a href="' + esc(c.fence.url) + '" target="_blank" rel="noreferrer noopener">' + esc(c.fence.title || 'view') + '</a>' : '') + '</div>'
        + (c.fence.quote ? '<div class="fence-quote">“' + esc(c.fence.quote) + '”</div>' : '')
        + '</div>').join('')
    : empty('No contradictions — cleared files are holding.');

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
    + '<div class="md' + (m.deletedAt ? ' message-deleted' : '') + '">' + (m.deletedAt ? 'Message deleted by human ' + esc(ago(m.deletedAt)) + '.' : markdown(m.text)) + '</div>';

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
  restoreRenderState(renderState);
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
