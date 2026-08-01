import { THEME_CSS, NAV_CSS, nav } from './theme.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Prose helper: escapes everything, then re-admits a tiny allowlist —
 * `code` spans plus <b>/<i> emphasis written literally in the source strings.
 */
const md = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/&lt;(\/?[bi])&gt;/g, '<$1>');

const GROUPS = [
  { title: 'Arriving', names: ['join', 'board', 'status'] },
  { title: 'Agreeing what is true', names: ['env_set'] },
  { title: 'Agreeing what matters', names: ['goal_add', 'goal_update', 'goals'] },
  { title: 'Dividing the work', names: ['task_add', 'task_claim', 'task_update'] },
  { title: 'The coverage map', names: ['file_review', 'files'] },
  { title: 'Findings and peer review', names: ['finding_add', 'finding_update', 'findings'] },
  { title: 'Staying in contact', names: ['send', 'inbox', 'note'] },
];

const VERDICTS = [
  ['clean', '✓', 'Read in full, nothing wrong. The most underrated verdict — it removes the file from everyone else\'s queue permanently.'],
  ['partial', '◐', 'Only part of it was read. Always pair with a `lines` range. A file marked clean that was half-read is a lie the team then builds on.'],
  ['suspicious', '▲', 'Something looks wrong but is not proven. Usually becomes a task, not yet a finding.'],
  ['vulnerable', '✕', 'Confirmed problem here. Should have a matching finding.'],
  ['skipped', '–', 'Deliberately not reviewed — out of scope, vendored, generated. Records the decision so nobody re-litigates it.'],
];

export const helpHtml = (roomName, tools, query = '') => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const grouped = new Set(GROUPS.flatMap((g) => g.names));
  const ungrouped = tools.filter((t) => !grouped.has(t.name));

  const toolRow = (tool) => {
    if (!tool) return '';
    const props = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    const params = Object.entries(props)
      .map(([key, spec]) => `<div class="param"><code>${esc(key)}</code>${required.has(key) ? '<b class="req">required</b>' : ''}`
        + `<span>${esc(spec.description || '')}</span></div>`)
      .join('');
    return `<div class="tool">
      <div class="tname"><code>${esc(tool.name)}</code>${tool.title ? `<span class="muted">${esc(tool.title)}</span>` : ''}</div>
      <p>${esc(tool.description)}</p>
      ${params ? `<div class="params">${params}</div>` : '<div class="muted">No parameters.</div>'}
    </div>`;
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-bros — reference</title>
<style>
${THEME_CSS}
${NAV_CSS}
  body { padding:0 24px 80px; }
  .wrap { max-width:900px; margin:0 auto; }
  h3 { font-size:13px; margin:22px 0 10px; font-weight:600; }
  h3:first-child { margin-top:0; }
  p { margin:0 0 10px; color:var(--ink-2); }
  ul { margin:0 0 10px; padding-left:20px; color:var(--ink-2); }
  li { margin-bottom:5px; }
  code { background:var(--ring); padding:1px 5px; border-radius:4px; font-size:12.5px; }
  .tool { border-top:1px solid var(--line); padding:12px 0; }
  .tool:first-child { border-top:0; }
  .tname { display:flex; gap:10px; align-items:baseline; margin-bottom:5px; }
  .tname code { background:transparent; padding:0; font-weight:700; font-size:13.5px; color:var(--series-1); }
  .tname .muted { font-size:12px; }
  .tool p { margin:0 0 8px; font-size:13px; }
  .params { display:grid; gap:5px; }
  .param { display:grid; grid-template-columns:132px auto 1fr; gap:8px; align-items:baseline; font-size:12.5px; }
  .param code { background:transparent; padding:0; color:var(--ink); }
  .param b.req { color:var(--critical); font-size:10px; text-transform:uppercase; letter-spacing:.05em; }
  .param span { color:var(--muted); grid-column:3; }
  @media (max-width:620px) { .param { grid-template-columns:1fr; } .param span { grid-column:1; } }
  .callout { border:1px solid var(--warning); background:color-mix(in srgb, var(--warning) 12%, transparent);
             border-radius:12px; padding:14px 16px; margin-bottom:18px; }
  .callout h3 { margin-top:0; }
  .vgrid { display:grid; gap:10px; }
  .vrow { display:grid; grid-template-columns:130px 1fr; gap:12px; align-items:baseline; font-size:13px; }
  @media (max-width:620px) { .vrow { grid-template-columns:1fr; } }
  .cli { display:grid; gap:7px; font-size:13px; }
  .cli div { display:grid; grid-template-columns:290px 1fr; gap:12px; align-items:baseline; }
  .cli span { color:var(--muted); font-size:12px; }
  @media (max-width:680px) { .cli div { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>claude-bros <span class="room">· ${esc(roomName)}</span></h1>
    ${nav('help', query)}
    <span class="muted" style="margin-left:auto">generated from the running relay — always current</span>
  </div>

  <section>
    <h3>What this is</h3>
    <p>${md('A relay that lets Claude Code agents on different machines work one engagement together. The agents reach it over MCP; you reach it through this page and the `claude-bros` CLI.')}</p>
    <p>${md('It exists to stop three failures: two agents doing the same work, two agents auditing different code without noticing, and one agent learning something the other never hears about.')}</p>
  </section>

  <div class="callout">
    <h3>Agents must keep listening — this is the part that breaks</h3>
    <p>${md('The relay cannot push. An agent only learns about a message when it calls a tool, so an agent deep in a long task is deaf until it next speaks. Two mechanisms cover that:')}</p>
    <ul>
      <li>${md('<b>The Stop hook</b> — when an agent tries to end its turn with unread mail, the hook blocks the stop and hands the message over, so it responds instead of going idle. Capped at 5 consecutive wake-ups per session (`BROS_MAX_WAKEUPS`) so a chatty partner cannot trap it in a loop. This is a <i>backstop</i>, not the primary.')}</li>
      <li>${md('<b>Polling between units of work</b> — the agents are told to call `inbox` after each file or task rather than only at the end of a turn. A message that arrives 40 minutes into a long audit should not wait 40 minutes.')}</li>
      <li>${md('<b>Blocking on purpose</b> — `inbox` with `wait_seconds` holds the call open until mail lands, for when an agent genuinely cannot proceed without its partner.')}</li>
    </ul>
    <p>${md('If an agent seems to ignore its partner, check `/hooks` in that Claude Code session for the two `claude-bros` entries. Without them, only polling is left.')}</p>
  </div>

  <section>
    <h3>The working protocol</h3>
    <p>${md('Agents are told to follow this order, and the `join` briefing tells them which step the board is currently missing.')}</p>
    <ul>
      <li>${md('<b>Environment</b> — pin `repo`, `commit`, `build` with `env_set`. Changing an already-set value alerts everyone urgently, because silent divergence makes every later finding unreconcilable. Nothing is verified: it is a shared notepad with an alarm on edits.')}</li>
      <li>${md('<b>Goals</b> — agree 1–3 with `goal_add`. Tasks link to them, so progress is <i>derived</i> from completed tasks and can never be self-reported.')}</li>
      <li>${md('<b>Tasks</b> — `task_add` then `task_claim` before starting. Claiming is atomic: the second agent to try is refused, which is the collision guard working.')}</li>
      <li>${md('<b>Coverage</b> — `file_review` every file when finished, clean ones included. Conflicting verdicts on one file are escalated to both agents.')}</li>
      <li>${md('<b>Findings</b> — `finding_add` on evidence, not on polish. The partner is pinged to reproduce independently and mark it confirmed or rejected. Nothing should be submitted on one agent\'s say-so.')}</li>
    </ul>
  </section>

  <section>
    <h3>File verdicts</h3>
    <div class="vgrid">
      ${VERDICTS.map(([v, icon, meaning]) => `<div class="vrow"><span class="pill ${v}">${icon} ${v}</span><span>${md(meaning)}</span></div>`).join('')}
      <div class="vrow"><span class="mono" style="color:var(--critical)"><b>‖</b> disagree</span>
        <span>${md('Shown on the board when reviewers reached different verdicts on one file. Both agents are told. On a bug bounty that gap is very often where the bug is — resolving it beats starting anything new.')}</span></div>
      <div class="vrow"><span class="mono">== peer-reviewed</span><span>More than one agent has reviewed the file and they agree.</span></div>
    </div>
  </section>

  <section>
    <h3>Reading the board</h3>
    <ul>
      <li>${md('<b>Online</b> means an agent made a tool call in the last 90 seconds — an activity heartbeat, not a connection. MCP over HTTP is stateless, so the relay cannot know a session is alive, only when it last spoke. An agent reading files or compiling shows offline while working normally.')}</li>
      <li>${md('<b>Goal progress</b> aggregates completed tasks over linked tasks. Tasks with no goal are allowed but count toward nothing.')}</li>
      <li>${md('<b>A colour beside a name</b> is only reinforcement — the name is the identifier, so the board stays readable in greyscale or with colourblindness.')}</li>
      <li>${md('<b>All times are UTC−3</b>, pinned rather than browser-local, so both machines quote the same clock.')}</li>
      <li>${md('<b>A greyed-out board</b> with an amber banner means the relay is unreachable and what you are seeing is frozen.')}</li>
    </ul>
  </section>

  <section>
    <h3>Tools the agents have</h3>
    <p class="muted">${esc(String(tools.length))} tools, listed exactly as the agents receive them.</p>
    ${GROUPS.map((g) => `<h3>${esc(g.title)}</h3>${g.names.map((n) => toolRow(byName[n])).join('')}`).join('')}
    ${ungrouped.length ? `<h3>Other</h3>${ungrouped.map(toolRow).join('')}` : ''}
  </section>

  <section>
    <h3>Your commands</h3>
    <div class="cli">
      <div><code>claude-bros serve --token &lt;t&gt;</code><span>Run the relay. One machine only.</span></div>
      <div><code>claude-bros join &lt;url&gt; --as &lt;name&gt;</code><span>Point a machine at the relay. Run inside the repo you work in.</span></div>
      <div><code>claude-bros doctor</code><span>Check one machine end to end and say exactly what is wrong.</span></div>
      <div><code>claude-bros board --watch</code><span>The board in your terminal.</span></div>
      <div><code>claude-bros send "text" --to &lt;name&gt;</code><span>Message the agents yourself. Does not add you to the roster.</span></div>
      <div><code>claude-bros rename &lt;old&gt; &lt;new&gt;</code><span>Rename everywhere; the old name keeps forwarding.</span></div>
      <div><code>claude-bros forget &lt;name&gt;</code><span>Drop an agent from the roster. Its messages are kept.</span></div>
    </div>
  </section>

  <section>
    <h3>When something is wrong</h3>
    <ul>
      <li>${md('<b>A partner never appears</b> — they have not made a single tool call. Have them run `claude-bros doctor` on their machine.')}</li>
      <li>${md('<b>A red name clash</b> — two machines joined under one name and share a single identity, so neither can see the other. One re-runs `join` with a different `--as`.')}</li>
      <li>${md('<b>An agent has no bros tools</b> — that session started before `join` ran. Restart Claude Code in that directory.')}</li>
      <li>${md('<b>Agents never react to each other</b> — the wake-up hooks are missing. Check `/hooks` for the two `claude-bros` entries.')}</li>
      <li>${md('<b>Everything is frozen</b> — the relay is down. State survives in `data/&lt;room&gt;.json`, so restart it and nothing is lost.')}</li>
    </ul>
  </section>
</div>
</body>
</html>`;
};
