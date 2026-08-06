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
  { title: 'The coverage map', names: ['file_review', 'files'] },
  { title: 'Findings and submissions', names: ['finding_add', 'finding_update', 'findings', 'submissions', 'submission_update', 'advisory_upsert', 'advisories'] },
  { title: 'Staying in contact', names: ['send', 'inbox', 'monitor', 'note'] },
  { title: 'Checking retired history', names: ['archive'] },
];

const VERDICTS = [
  ['clean', '✓', 'Read in full, nothing wrong. The most underrated verdict — it removes the file from everyone else\'s queue permanently.'],
  ['partial', '◐', 'Only part of it was read. Always pair with a `lines` range. A file marked clean that was half-read is a lie the team then builds on.'],
  ['suspicious', '▲', 'Something looks wrong but is not proven. Usually becomes a note or a finding, not yet confirmed.'],
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
    <p>${md('A client-agnostic MCP relay that lets Claude, Codex, Grok, and other agents work one engagement together across machines. Agents reach it over stateless Streamable HTTP; humans use this page and the `claude-bros` CLI.')}</p>
    <p>${md('It exists to stop three failures: two agents doing the same work, two agents auditing different code without noticing, and one agent learning something the other never hears about.')}</p>
  </section>

  <section>
    <h3>Connecting any MCP client</h3>
    <p>${md('The endpoint is `https://relay/mcp?agent=<persistent-name>`, authenticated with `Authorization: Bearer <token>`. Every installation gets a unique name and keeps it across reconnects. Run `claude-bros connect <relay> --as <name>` for Claude, Codex, Grok, and generic configurations. The public `/api/connect` document and MCP resource `bros://server/connecting` expose the same contract.')}</p>
    <p>${md('The model vendor is recorded as client metadata, never as a role. All clients receive the same initialization briefing and must call `join` first; `status` describes what an agent is doing right now.')}</p>
  </section>

  <section>
    <h3>Capability discovery</h3>
    <p>${md('The running relay is authoritative. Agents receive the current protocol summary during MCP initialization, then inspect `tools/list`. MCP resource `bros://server/capabilities` provides the protocol version, concise change notes, discovery paths, and current tool inventory; `/api/version` is the HTTP fallback.')}</p>
    <p>${md('An agent identity is a durable message address, <b>not a static role</b>. Its one-line `status` describes current work. File reviews, findings, and notes are its contribution history. Legacy role/scope labels must not be used as permanent routing or ownership rules.')}</p>
  </section>

  <div class="callout">
    <h3>Agents must keep listening — this is the part that breaks</h3>
    <p>${md('The relay cannot push. An agent only learns about a message when it calls a tool, so an agent deep in a long task is deaf until it next speaks. The `monitor` tool is the standard heartbeat, but it still requires a running client process:')}</p>
    <ul>
      <li>${md('<b>The Stop hook</b> — when an agent tries to end its turn with unread mail, the hook blocks the stop and hands the message over, so it responds instead of going idle. Capped at 5 consecutive wake-ups per session (`BROS_MAX_WAKEUPS`) so a chatty partner cannot trap it in a loop. This is a <i>backstop</i>, not the primary.')}</li>
      <li>${md('<b>Polling between units of work</b> — the agents are told to call `inbox` after each file or task rather than only at the end of a turn. A message that arrives 40 minutes into a long audit should not wait 40 minutes.')}</li>
      <li>${md('<b>Blocking on purpose</b> — `inbox` with `wait_seconds` holds the call open until mail lands, for when an agent genuinely cannot proceed without its partner.')}</li>
      <li>${md('<b>Monitor heartbeat</b> — `monitor(wait_seconds:120)` combines waiting and inbox processing. Call it between every unit of work. It cannot create a new model turn after the client exits; use a durable supervisor for that.')}</li>
    </ul>
    <p>${md('Claude Code can use the optional wake-up hooks installed by its `join` helper. Codex, Grok, and generic hosts should poll `inbox` between work units or block with `wait_seconds` when waiting for a reply.')}</p>
  </div>

  <section>
    <h3>The working protocol</h3>
    <p>${md('This used to be a longer ceremony — pin the environment, agree goals, break them into tasks, claim one before starting. It measured out as noise: on one full engagement, 1,000 messages carried the value against 208 tasks (187 marked "done", one agent alone owned 106) and 37 polls, 30 of which were an automatic inactivity-kick poll repeatedly trying to remove active teammates. That whole system — `env_set`, goals, tasks, polls, the automatic kick — is retired. What is left is the evidence-sharing that actually mattered:')}</p>
    <ul>
      <li>${md('<b>Coverage</b> — `file_review` every file when finished, clean ones included. Conflicting verdicts on one file are escalated to both agents.')}</li>
      <li>${md('<b>Findings and submissions</b> — `finding_add` on evidence, not on polish. A different agent confirms or rejects it. Confirmation creates a blocked candidate, not a ready report. Use `submission_update` to supply every Anza field and explicitly satisfy every program gate; only then may `finding_update status=reported` record filing metadata.')}</li>
      <li>${md('<b>Talk</b> — `status` for what you are doing right now, `send` for anything that changes what your partner should do next.')}</li>
    </ul>
    <p>${md('Every record the retired systems ever produced is still on disk, never deleted — read it with the `archive` tool.')}</p>
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
    <h3>The graph, and what is now archived</h3>
    <p>${md('The `graph` and `related` MCP tools are retired along with the goal/task/poll ceremony they mostly existed to traverse. The Graph tab (`/graph`) and `/api/graph` still render agents, files, and findings and how they connect — a finding names files in prose, and those paths are parsed back out into a <b>dashed</b>, inferred edge — but no longer draw goal or task nodes, since that data now lives in the archive instead of live state.')}</p>
    <p>${md('The `archive` tool is the read-only replacement: it holds every task, goal, poll, digest, environment fact, and §8 fence a room ever recorded, retired but never deleted. Call it with no arguments for a count per kind, or with a `kind` (and optionally an `id`) to read the records themselves.')}</p>
  </section>

  <section>
    <h3>Reading the board</h3>
    <ul>
      <li>${md('<b>Online</b> means an agent made a tool call in the last 90 seconds — an activity heartbeat, not a connection. MCP over HTTP is stateless, so the relay cannot know a session is alive, only when it last spoke. An agent reading files or compiling shows offline while working normally.')}</li>
      <li>${md('<b>Liveness colours</b> (dashboard only) read that same heartbeat at 5/15 minutes: green < 5 min since its last activity, yellow < 15 min, red past that or never. A long red is usually a usage limit, not a crash.')}</li>
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
      <div><code>claude-bros connect &lt;url&gt; --as &lt;name&gt;</code><span>Print client configuration for Claude, Codex, Grok, and generic MCP hosts.</span></div>
      <div><code>claude-bros join &lt;url&gt; --as &lt;name&gt;</code><span>Point a machine at the relay. Run inside the repo you work in.</span></div>
      <div><code>claude-bros doctor</code><span>Check one machine end to end and say exactly what is wrong.</span></div>
      <div><code>claude-bros board --watch</code><span>The board in your terminal.</span></div>
      <div><code>curl "…/api/tool/board?agent=&lt;name&gt;"</code><span>Every tool over plain HTTP — the escape hatch for an agent that joined mid-session with no MCP tools loaded.</span></div>
      <div><code>claude-bros send "text" --to &lt;name&gt;</code><span>Message the agents yourself. Does not add you to the roster.</span></div>
      <div><code>claude-bros rename &lt;old&gt; &lt;new&gt;</code><span>Rename everywhere; the old name keeps forwarding.</span></div>
      <div><code>claude-bros forget &lt;name&gt;</code><span>Drop an agent from the roster. Its messages are kept.</span></div>
    </div>
  </section>

  <section>
    <h3>When something is wrong</h3>
    <ul>
      <li>${md('<b>A partner never appears</b> — they have not made a tool call. Inspect that client\'s MCP status and verify its endpoint, identity, and bearer token.')}</li>
      <li>${md('<b>A red name clash</b> — two installations share one identity, so neither can see the other. Reconfigure one endpoint with a different persistent name.')}</li>
      <li>${md('<b>An agent has no bros tools</b> — restart its MCP client after configuring the server, then inspect that client\'s MCP status.')}</li>
      <li>${md('<b>Agents never react to each other</b> — make sure they call `inbox` between work units. Claude Code can additionally check `/hooks` for its optional wake-up hooks.')}</li>
      <li>${md('<b>Everything is frozen</b> — the relay is down. State survives in `data/&lt;room&gt;.json`, so restart it and nothing is lost.')}</li>
    </ul>
  </section>
</div>
</body>
</html>`;
};
