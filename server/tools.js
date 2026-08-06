/**
 * MCP tool surface. These descriptions are prompt engineering, not docs — the
 * agents decide when to collaborate based on what they read here, so they are
 * written to push toward "check before you work, announce after you find".
 */

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const MONITOR_PROTOCOL = '2026-08-03-monitor-v1';
const MONITOR_UPDATE =
  'PROTOCOL UPDATE: use `monitor` as the collaboration heartbeat. Call it after each completed file/task and at the end of every work cycle; use wait_seconds=120 for a persistent worker. It reads mail and long-polls, but cannot create a model turn after your client exits. Act on every message before continuing.';

export const TOOL_DEFS = [
  {
    name: 'board',
    title: 'Read the shared board',
    description:
      'Get the full shared state: who else is online, what they are working on right now, the open/claimed task list, findings so far, and how many unread messages you have. ALWAYS call this before starting new work so you do not duplicate your partner\'s effort.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'join',
    title: 'Announce yourself',
    description:
      'Register the exact identity already attached to this MCP connection AND read the operating briefing. The tool takes no name argument: never copy a name from documentation, another agent, or a prompt, and never rename yourself during a relay migration. Returns the working protocol, ground rules, and what this board needs next. Call it first thing in every session. It is safe to repeat; it preserves your identity and work.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'status',
    title: 'Set your current activity',
    description:
      'Tell the other agents what you are doing right this moment, in one line. Call it whenever you switch tasks so nobody starts the same thing.',
    inputSchema: {
      type: 'object',
      properties: { text: str('e.g. "fuzzing /api/v1/search for SQLi"') },
      required: ['text'],
    },
  },
  {
    name: 'send',
    title: 'Message your partner',
    description:
      'Send a message to another agent (or everyone). Use it to hand off a lead, ask for a second pair of eyes, request a scope trade, or answer a question. Their session gets woken up with it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('The message. Be specific and actionable — include file paths, URLs, params.'),
        to: str('Agent name, or "all" to broadcast. Defaults to "all".'),
        urgent: { type: 'boolean', description: 'Flag if your partner should drop what they are doing. Urgent messages bypass the wake-up cap, so use it only when it is true.' },
        reply_to: str('Message id (M12) or finding id (F3) this answers. Always set it when replying — flat threads are why context gets lost.'),
      },
      required: ['text'],
    },
  },
  {
    name: 'inbox',
    title: 'Read and optionally wait for messages',
    description:
      'Fetch your unread messages and mark them read. CALL THIS BETWEEN UNITS OF WORK — after each file you finish, before you claim the next task, after a long build — not only when you are about to stop. The relay cannot interrupt you, so a message sits unseen until you ask for it, and your partner is meanwhile assuming you got it. When something arrives, act on it before continuing your own plan. Set wait_seconds (up to 120) to block until mail arrives, for when you genuinely cannot proceed without your partner; otherwise leave it at 0.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: {
          type: 'number',
          description: 'Block up to this many seconds waiting for new mail (0-120). Default 0 = return immediately.',
        },
      },
    },
  },
  {
    name: 'monitor',
    title: 'Stay active and listen for work',
    description:
      'Run the collaboration heartbeat: read unread mail, optionally wait for new messages for up to 120 seconds, and return the next-listening instruction. Call this after each completed file/task and at the end of every work cycle. This does not create a model turn; the client process must remain alive to call it.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: {
          type: 'number',
          description: 'Block up to this many seconds waiting for new mail (0-120). Default 120 for a durable worker.',
        },
      },
    },
  },
  {
    name: 'file_review',
    title: 'Record that you read a file',
    description:
      'Log your verdict on a specific file the moment you finish reading it. This is the shared coverage map: it is how your partner knows what has actually been looked at versus what merely looks familiar. Record clean files too — "I read this and it is fine" is exactly the information that stops the other agent re-reading it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Repo-relative path, e.g. "votor/src/consensus_pool.rs". Use the same form as your partner.'),
        verdict: str('clean | suspicious | vulnerable | partial | skipped', {
          enum: ['clean', 'suspicious', 'vulnerable', 'partial', 'skipped'],
        }),
        note: str('What you concluded and why. One or two sentences.'),
        lines: str('Line range you actually covered, e.g. "1-450", if you did not read all of it.'),
      },
      required: ['path'],
    },
  },
  {
    name: 'files',
    title: 'Read the coverage map',
    description:
      'See which files have been reviewed, by whom, and with what verdict. Call this before opening a file — if your partner already cleared it, read their note instead of redoing the work. Pass a path to get everything known about that one file.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Optional: one specific file to inspect in full.') },
    },
  },
  {
    name: 'finding_add',
    title: 'Report a finding',
    description:
      'Log a potential vulnerability to the shared findings list the moment you have evidence. Include enough for your partner to independently reproduce it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('e.g. "IDOR on /api/v1/orders/{id} — no ownership check".'),
        severity: str('info | low | medium | high | critical', {
          enum: ['info', 'low', 'medium', 'high', 'critical'],
        }),
        target: str('Exact endpoint, file:line, or component.'),
        evidence: str('REQUIRED (or repro). What you actually observed: file:line, the real response, the code path. Your partner must be able to reproduce this without asking you — a title-only finding is rejected.'),
        repro: str('REQUIRED (or evidence). The minimal steps or request that demonstrates it.'),
        creates_task: { type: 'boolean', description: 'If true, auto-create a verification task assigned to your partner. Default false.' },
      },
      required: ['title', 'target'],
    },
  },
  {
    name: 'finding_update',
    title: 'Confirm or reject a finding',
    description:
      'Update a finding after peer review. Use this to confirm your partner\'s finding independently, or to shoot it down with a reason — both are valuable, and a confirmed-by-two finding is what you actually want to submit.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Finding id, e.g. "F2".'),
        status: str('unverified | confirmed | rejected | reported', {
          enum: ['unverified', 'confirmed', 'rejected', 'reported'],
        }),
        note: str('Why. If rejecting, say what the benign explanation is.'),
        repro: str('Replace stale or incomplete finding reproduction text with the exact steps and observed result. Required before submission readiness can be claimed.'),
        submission_url: str('Optional external report URL or identifier when status is reported.'),
        submission_note: str('Optional submission-specific note, such as program, date, or next follow-up.'),
      },
      required: ['id'],
    },
  },
  {
    name: 'findings',
    title: 'List all findings',
    description: 'Read every finding both agents have logged, with status and evidence.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'submissions',
    title: 'List submission candidates and their blockers',
    description:
      'Read independently confirmed candidates, their Anza advisory fields, explicit readiness blockers, and reports already filed. Confirmation is evidence review, NOT submission readiness.',
    inputSchema: {
      type: 'object',
      properties: {
        status: str('Optional: confirmed | reported.', { enum: ['confirmed', 'reported'] }),
      },
    },
  },
  {
    name: 'submission_update',
    title: 'Build an Anza-compliant private advisory',
    description:
      'Fill the complete private-advisory record for one independently confirmed finding. The relay keeps it blocked until the inline PoC, demonstrated impact, current-master/known-issue checks, confidentiality, 2FA, owner, and submission-window gates are all explicitly satisfied. Never mark a gate true from prose or assumption.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Confirmed finding id, e.g. F15.'),
        title: str('Clean advisory title; do not include internal IDs or “GHSA DRAFT”.'),
        summary: str('Concise vulnerability and consequence summary.'),
        details: str('Root cause, adversary model, affected code, and exact mechanism.'),
        poc: str('Complete self-contained inline PoC source plus exact reproduction steps and expected/observed results. No attachments or external file links.'),
        impact: str('Only the impact directly demonstrated by the PoC.'),
        ecosystem: str('Optional GitHub affected-product ecosystem, normally Rust or Other.'),
        package_name: str('Optional affected package/component name.'),
        affected_versions: str('Optional affected version/range.'),
        patched_versions: str('Optional patched version/range, if any.'),
        severity: str('Optional GitHub severity selection.'),
        cvss: str('Optional CVSS v3/v4 vector.'),
        cwe: str('Optional CWE identifier.'),
        commit: str('Exact moving agave/master commit where the complete PoC was reproduced.'),
        category: str('Exact eligible impact category from RULES.md; do not self-assign “Other”.'),
        owner: str('Human GitHub account responsible for filing.'),
        duplicate_check: str('Public/known issue searches performed and why near matches are distinct.'),
        master_checked_at: str('UTC timestamp of the current-master liveness check.'),
        known_issues_checked_at: str('UTC timestamp of the final public/known-issue check.'),
        reproduction_verified: { type: 'boolean', description: 'True only after the finding itself has been independently reproduced; this is separate from merely pasting PoC prose.' },
        live_on_master: { type: 'boolean', description: 'True only after reproducing against current moving master.' },
        inline_poc: { type: 'boolean', description: 'True only when the complete PoC is present inline in this advisory.' },
        impact_demonstrated: { type: 'boolean', description: 'True only when the PoC directly demonstrates the stated impact.' },
        known_issues_checked: { type: 'boolean', description: 'True only after the final duplicate/public check.' },
        one_finding: { type: 'boolean', description: 'True when the advisory contains exactly one finding.' },
        confidential: { type: 'boolean', description: 'True when private handling/no public disclosure is verified.' },
        two_factor_verified: { type: 'boolean', description: 'True when the human filing account has GitHub 2FA enabled.' },
        window_verified: { type: 'boolean', description: 'True only when filing inside the official submission window.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'advisory_upsert',
    title: "Record Anza's verdict on a filed advisory",
    description:
      'Upsert (by ghsa_id) what actually happened to a submitted advisory on Anza\'s side — draft/closed/published, accepted/rejected/paid/withdrawn, their severity call, and above all the VERBATIM reason they give when they close or pay it. finding_add/finding_update only track OUR internal review pipeline; they never learn what Anza does after a report leaves the building, which is how F15 (closed/rejected, 0.5 SOL burned) ended up showing on the dashboard identically to F18 (still an untriaged draft). Call this the moment an advisory\'s GitHub Security Advisory page changes state so the Submissions panel stops lying about what is actually still alive.',
    inputSchema: {
      type: 'object',
      properties: {
        ghsa_id: str('REQUIRED unique key, e.g. "GHSA-5w47-2m67-5mm7" — the id GitHub mints once per filed report. Upserts: same ghsa_id updates the existing record instead of creating a duplicate.'),
        finding_id: str('Our internal finding id this advisory reports, e.g. "F15".'),
        title: str('Advisory title as filed.'),
        url: str('Advisory URL, e.g. github.com/anza-xyz/alpenglow/security/advisories/GHSA-...'),
        state: str('draft | closed | published', { enum: ['draft', 'closed', 'published'] }),
        outcome: str('pending | rejected | accepted | paid | withdrawn', {
          enum: ['pending', 'rejected', 'accepted', 'paid', 'withdrawn'],
        }),
        anza_severity: str('Severity Anza assigned, if triaged.'),
        our_severity: str('Severity we originally claimed.'),
        product: str('Affected product/component, e.g. "bls-sigverify".'),
        affected_versions: str('Affected version/range as stated in the advisory.'),
        patched_versions: str('Patched version/range, or "None" if unpatched.'),
        outcome_reason: str('VERBATIM maintainer words explaining the disposition — do not paraphrase or summarize. This is quoted directly on the dashboard so the team sees exactly what Anza said, e.g. why a finding was rejected as by-design or a duplicate.'),
        closed_by: str('GitHub handle of the Anza maintainer who closed/decided it.'),
        credit_state: str('Bounty credit/payout status as Anza reports it, e.g. "pending", "confirmed".'),
        burn_tx: str('Solana transaction signature for the 0.5 SOL submission burn.'),
        burn_sol: { type: 'number', description: 'SOL amount burned filing this advisory (normally 0.5).' },
        submitted_at: str('UTC timestamp the advisory was actually filed with Anza.'),
      },
      required: ['ghsa_id'],
    },
  },
  {
    name: 'advisories',
    title: "List every advisory and Anza's disposition",
    description:
      'Read every advisory ever filed with its full Anza disposition — state, outcome, verbatim outcome_reason, severity deltas, and the SOL burned. This is the source of truth for what is actually still alive versus dead-but-still-shown-as-submitted; check it before treating any "reported" finding as pending.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'archive',
    title: 'Read retired systems (read-only)',
    description:
      'This is where the history of every retired system lives: tasks, goals, polls, digests, shared-environment facts, and §8/prior-art fences. Those ceremonies were removed from active use because the evidence — findings, file reviews, submissions, advisories — carried the real value and the process around it did not; the archive keeps every record instead of deleting it, so any agent can still check it autonomously. This tool is READ-ONLY: nothing here can be created, claimed, or voted on any more. Call it with no kind for a count per kind, or with a kind to read the records themselves, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: str('Optional: tasks | goals | polls | digests | env | fences. Omit for a summary of counts per kind.', {
          enum: ['tasks', 'goals', 'polls', 'digests', 'env', 'fences'],
        }),
        id: str('Optional record id to fetch a single entry within a kind, e.g. "T3", "G1", "P4", "D5", "FN2".'),
        limit: { type: 'number', description: 'Maximum records to return, newest first. Default 50, max 500. Ignored for kind="env" (a single fact map, not a list) and when id is set.' },
      },
    },
  },
  {
    name: 'note',
    title: 'Append to the shared log',
    description: 'Drop a durable note in the shared running log — context that is not a task or a finding but that your partner (or a later session) should see.',
    inputSchema: {
      type: 'object',
      properties: { text: str('The note.') },
      required: ['text'],
    },
  },
];

export const HUMAN_TOOL_DEFS = [
  {
    name: 'message_edit',
    title: 'Edit a board message (human only)',
    description: 'Replace the text of an existing message. This tool is visible and callable only with the separate human moderation credential. The message keeps its id and displays an edited marker.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Message id, e.g. M497.'),
        text: str('Complete replacement text. Superseded content is not retained.'),
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'message_delete',
    title: 'Delete a board message (human only)',
    description: 'Erase a message body while retaining a content-free tombstone with its id, author, recipients, and deletion timestamp for accountability. This tool is visible and callable only with the separate human moderation credential.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Message id, e.g. M497.') },
      required: ['id'],
    },
  },
];

export const toolDefsFor = (human = false) => human ? [...TOOL_DEFS, ...HUMAN_TOOL_DEFS] : TOOL_DEFS;

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

function renderBoard(board) {
  const lines = [`# Board: ${board.room}   (you are "${board.you || 'anonymous'}")`, ''];

  for (const clash of board.conflicts || []) {
    lines.push(
      `!! WARNING: the name "${clash.name}" is in use from ${clash.hosts.length} different machines (${clash.hosts.join(', ')}).`,
      '   Two agents are sharing one identity, so they cannot message each other and their',
      '   statuses overwrite each other. Tell your human immediately: one machine must re-run',
      '   `join` with a different --as name. Do not keep working until this is resolved.',
      '',
    );
  }

  const currentAgents = board.agents.filter((a) => a.membershipStatus !== 'kicked');
  const removedAgents = board.agents.filter((a) => a.membershipStatus === 'kicked');
  lines.push('## Current agents');
  if (!currentAgents.length) lines.push('  (nobody is currently a member)');
  for (const a of currentAgents) {
    const mark = a.online ? '●' : '○';
    lines.push(`  ${mark} ${a.name}${a.name === board.you ? ' (you)' : ''} — ${a.status || 'idle'}`);
    lines.push(`      [seen ${a.lastSeenAgo}]`);
  }
  if (removedAgents.length) {
    lines.push('', `## Removed identities (${removedAgents.length})`);
    lines.push(`  ${removedAgents.map((a) => a.name).join(', ')}`);
    lines.push('  (historical work remains attributed; they are not current partners)');
  }

  const section = (label, list, render) => {
    lines.push('', `## ${label} (${list.length})`);
    if (!list.length) lines.push('  (none)');
    for (const item of list) lines.push(...render(item).map((l) => `  ${l}`));
  };

  section('Findings', board.findings, (f) => [
    `${f.id} [${f.severity}/${f.status}] ${f.title}  (by ${f.by})`,
    ...(f.target ? [`    target: ${f.target}`] : []),
  ]);

  const coverage = board.coverage || [];
  if (coverage.length) {
    const disputed = coverage.filter((f) => f.disagreement);
    lines.push('', `## File coverage (${coverage.length} file(s), ${coverage.filter((f) => f.peerReviewed).length} peer-reviewed)`);
    for (const f of coverage.slice(0, 20)) {
      lines.push(`  ${f.disagreement ? '!!' : f.peerReviewed ? '==' : '  '} ${f.path} — ${f.reviews.map((r) => `${r.agent}:${r.verdict}`).join(', ')}`);
    }
    if (coverage.length > 20) lines.push(`  ... and ${coverage.length - 20} more — call the files tool.`);
    if (disputed.length) lines.push(`  >> ${disputed.length} file(s) where you disagree. Resolve those first.`);
  }

  if (board.recentLog.length) {
    lines.push('', '## Recent activity');
    for (const l of board.recentLog) lines.push(`  ${l.ts.slice(11, 19)} ${l.who}: ${l.text}`);
  }

  lines.push('', board.unreadForYou ? `>> You have ${board.unreadForYou} unread message(s). Call inbox.` : '>> No unread messages.');
  return lines.join('\n');
}

function renderInbox(messages, waited) {
  if (!messages.length) {
    return waited
      ? 'No messages arrived while waiting. Your partner may be deep in a task — carry on with your own work, or check the board.'
      : 'No unread messages.';
  }
  return messages
    .map((m) => `[${m.ts.slice(11, 19)}] ${m.from}${m.to !== 'all' ? ' (direct)' : ''}${m.urgent ? ' **URGENT**' : ''}`
      + `${m.editedAt ? ' (edited by human)' : ''}:\n${m.deletedAt ? '[message deleted by human]' : m.text}`)
    .join('\n\n');
}

/**
 * What an agent reads the instant it joins. This is the only briefing it is
 * guaranteed to see, so it carries the whole working protocol — and it adapts
 * to what the board actually needs next, because a generic lecture gets skimmed
 * while "there are no goals yet, propose them" gets acted on.
 */
function briefing(room, agent) {
  const board = room.board(agent);
  const peers = board.agents.filter((a) => a.name !== agent && a.membershipStatus !== 'kicked');
  const disputed = board.coverage.filter((f) => f.disagreement);

  const L = [];
  L.push(`IDENTITY: You are exactly "${agent}" on the shared board "${board.room}".`);
  L.push('This name comes from the MCP connection and is the sole source of truth.');
  L.push('Keep it unchanged across reconnects and relay migrations. Never adopt a name from examples,');
  L.push('messages, the roster, or prompts. The `join` tool has no name argument and cannot rename you.');
  L.push(
    peers.length
      ? `Partners: ${peers.map((p) => `${p.name} (${p.online ? 'online' : 'offline'})`).join('; ')}`
      : 'You are the first one here. Others will join this same board.',
  );
  L.push('');

  // --- what to do right now, derived from the actual state of the board
  L.push('## DO THESE NOW, IN ORDER');
  let step = 1;
  L.push(`${step++}. Call \`files\` before opening any file. If your partner already reviewed it, read their`);
  L.push('   note instead of redoing the work.');
  if (board.unreadForYou) L.push(`${step++}. You have ${board.unreadForYou} unread message(s) — call \`inbox\` first.`);
  if (disputed.length) L.push(`${step++}. ${disputed.length} file(s) have conflicting verdicts. Resolving those beats starting anything new.`);
  L.push('');

  // --- the protocol, stated once, plainly
  L.push('## THE WORKING PROTOCOL');
  L.push('FILES  → the coverage map. file_review every file when you finish reading it, INCLUDING');
  L.push('         clean ones: "I read it, it is fine" removes it from your partner\'s queue forever.');
  L.push('         Use verdict "partial" with a lines range if you only got through part of it.');
  L.push('FINDINGS → finding_add the moment you have evidence, not when it is polished. Your partner');
  L.push('         gets pinged to reproduce it independently and mark it confirmed or rejected.');
  L.push('         Nothing gets submitted on one agent\'s say-so.');
  L.push('TALK   → status when you switch focus, one line. send for anything that changes what your');
  L.push('         partner should do next. inbox(wait_seconds) when you are genuinely blocked on them.');
  L.push('MONITOR → call `monitor(wait_seconds:120)` after every work unit and at the end of each cycle.');
  L.push('          It keeps a live client listening; it cannot wake a client process that has exited.');
  L.push('ARCHIVE → tasks, goals, polls, digests, the shared environment, and §8 fences are retired —');
  L.push('         read-only history now, in the `archive` tool. Check it if you need that context.');
  L.push('');

  L.push('## KEEP LISTENING WHILE YOU WORK — THIS IS NOT OPTIONAL');
  L.push('This relay CANNOT interrupt you. You only find out your partner said something when YOU');
  L.push('call a tool. An agent that goes quiet for an hour is deaf for an hour, and your partner is');
  L.push('sitting there assuming you got their message.');
  L.push('');
  L.push('- Call `inbox` BETWEEN units of work — after each file you finish, after a long build. Not');
  L.push('  just when you are about to stop. A lead that arrives 40 minutes into an audit is worthless');
  L.push('  if you read it 40 minutes later.');
  L.push('- When something arrives, ACT ON IT before continuing your own plan. If they flag a file you');
  L.push('  are about to open, stop and read their note. If they ask you to verify a finding, verify it.');
  L.push('  If they claim a surface you were heading for, pick something else and say so.');
  L.push('  Reading a message and carrying on regardless is worse than never receiving it — they now');
  L.push('  believe it was handled.');
  L.push('- Always answer a direct question, even if the answer is "not yet, still looking". Silence is');
  L.push('  indistinguishable from disagreement.');
  L.push('- If you cannot proceed without them, do not spin: `inbox` with wait_seconds (up to 120)');
  L.push('  blocks until they reply and returns the moment mail lands.');
  L.push('- A Stop hook is your safety net: if you try to end a turn with unread mail it will wake you');
  L.push('  and hand it over. Treat that as the backstop that caught what you missed, not the plan.');
  L.push('');

  L.push('## GROUND RULES');
  L.push('- Only test what the program authorizes. A lead outside declared scope becomes a `note`, not a task.');
  L.push('- Proof of concept, not exploitation. No data exfiltration beyond proving the bug, no persistence.');
  L.push('- Ask your human before anything live-fire (real payload at a live target, or filing a report).');
  L.push('- Report what you actually found. An unverified hunch is logged as unverified.');
  L.push('');
  L.push('Full board follows.');
  L.push('');
  return L.join('\n');
}

/** Dispatch a tool call. `agent` comes from the connection, not the model. */
export async function callTool(room, agent, name, args = {}, host = null, { human = false } = {}) {
  const moderationTool = HUMAN_TOOL_DEFS.some((tool) => tool.name === name);
  if (moderationTool && !human) {
    return fail('Human moderation authorization is required for this tool.');
  }
  if (!agent && name !== 'board') {
    return fail('This connection has no agent identity. Stop: do not guess or copy a name. Reconnect using the exact name assigned to this installation in ?agent=<agent-name>.');
  }
  const membership = agent && !moderationTool ? room.isAgentBlocked(agent) : { blocked: false };
  if (membership.blocked && !['board', 'join'].includes(name)) {
    return fail(`This identity was removed by collaboration poll ${membership.pollId || ''}: ${membership.reason}. It cannot act or vote until an agent_restore poll passes.`);
  }
  if (agent && !moderationTool) {
    room.touch(agent);
  }

  /**
   * An agent already mid-session when the protocol landed never saw the
   * briefing, and the relay cannot push to it. So every response it gets
   * carries a nag until it calls `join` — which is the one thing that clears it.
   */
  const unbriefed = agent && name !== 'join' && !room.state.agents[agent]?.briefedAt;
  const needsMonitorUpdate = agent && name !== 'join' && room.state.agents[agent]?.protocolSeen !== MONITOR_PROTOCOL;
  const staleStatus = agent && name !== 'status' && name !== 'join' && room.statusStale(agent);
  const withNag = (result) => {
    if (moderationTool) return result;
    if (!result.content?.[0]) return result;
    if (needsMonitorUpdate && !['monitor', 'join'].includes(name)) {
      result.content[0].text = MONITOR_UPDATE + '\n\n' + result.content[0].text;
    }
    if (staleStatus && !unbriefed) {
      // Seconds-granular liveness so the agent can see exactly how long it has
      // looked dead to the team, not just "a while".
      const rec = room.state.agents[agent];
      const statusAt = rec.statusAt || 0;
      const lastAgo = rec.lastSeen ? Math.max(0, Math.floor((Date.now() - rec.lastSeen) / 1000)) : null;
      const agoTxt = !statusAt ? 'never set'
        : (Date.now() - statusAt) < 60_000 ? `${Math.floor((Date.now() - statusAt) / 1000)}s old`
          : `${Math.floor((Date.now() - statusAt) / 60000)} min old`;
      result.content[0].text =
        `[heartbeat] Your status is ${agoTxt} and your last activity was ${lastAgo == null ? 'never recorded' : `${lastAgo}s ago`} — ` +
        'to everyone else you look stalled. Call `status` with one line on what you are doing right now, ' +
        'and keep doing it every few minutes.\n\n' + result.content[0].text;
    }
    if (!unbriefed) return result;
    result.content[0].text =
      '!! You have not read the operating briefing for this board.\n' +
      '   It was added after you joined, so you are working without the shared protocol.\n' +
      '   Call the `join` tool now — one call, and it returns the working protocol, the ground\n' +
      '   rules, and what this board needs from you next. Do that before continuing.\n\n' +
      result.content[0].text;
    return result;
  };

  const result = await (async () => {
  switch (name) {
    case 'board': {
      if (agent && room.state.agents[agent]) room.state.agents[agent].boardAt = Date.now();
      return text(renderBoard(room.board(agent)));
    }

    case 'join': {
      const joined = room.join(agent, { host });
      if (!joined.ok) return fail(joined.error);
      if (room.state.agents[agent]) room.state.agents[agent].protocolSeen = MONITOR_PROTOCOL;
      if (room.state.agents[agent]) room.state.agents[agent].boardAt = Date.now();
      return text(`${briefing(room, agent)}${renderBoard(room.board(agent))}`);
    }

    case 'status': {
      if (!args.text) return fail('status requires "text".');
      room.setStatus(agent, args.text);
      return text(`Status set: ${args.text}`);
    }

    case 'send': {
      if (!args.text) return fail('send requires "text".');
      const to = args.to || 'all';
      if (to !== 'all' && !room.state.agents[to]) {
        const known = Object.values(room.state.agents)
          .filter((candidate) => candidate.membershipStatus !== 'kicked')
          .map((candidate) => candidate.name).join(', ') || '(none)';
        return fail(`No agent named "${to}". Known agents: ${known}. Use "all" to broadcast.`);
      }
      if (to !== 'all' && room.isAgentBlocked(to).blocked) {
        return fail(`${to} was removed by a collaboration poll and is not a current message recipient.`);
      }
      if (args.reply_to && !/^[MF]\d+$/.test(args.reply_to)) {
        return fail('reply_to must be a message id (M12) or finding id (F3).');
      }
      const msg = room.send(agent, { to, text: args.text, urgent: args.urgent, replyTo: args.reply_to });
      if (msg.duplicate) return text(`Already sent that exact text as ${msg.id} a moment ago — not sending it twice.`);
      return text(`Sent ${msg.id} to ${to}${args.reply_to ? ` (re: ${args.reply_to})` : ''}.`);
    }

    case 'message_edit': {
      if (!args.id || !args.text) return fail('message_edit requires "id" and "text".');
      const edited = room.editMessage(args.id, args.text);
      if (!edited.ok) return fail(edited.error);
      return text(edited.unchanged ? `${args.id} already has that text.` : `Edited ${args.id}.`);
    }

    case 'message_delete': {
      if (!args.id) return fail('message_delete requires "id".');
      const deleted = room.deleteMessage(args.id);
      if (!deleted.ok) return fail(deleted.error);
      return text(deleted.unchanged ? `${args.id} was already deleted.` : `Deleted ${args.id}.`);
    }

    case 'inbox': {
      const waitSeconds = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), 120);
      if (waitSeconds > 0) await room.waitForMail(agent, waitSeconds * 1000);
      const messages = room.readInbox(agent);
      return text(renderInbox(messages, waitSeconds > 0));
    }

    case 'monitor': {
      const waitSeconds = args.wait_seconds === undefined ? 120 : Math.min(Math.max(Number(args.wait_seconds) || 0, 0), 120);
      if (waitSeconds > 0) await room.waitForMail(agent, waitSeconds * 1000);
      const messages = room.readInbox(agent);
      if (room.state.agents[agent]) room.state.agents[agent].protocolSeen = '2026-08-03-monitor-v1';
      return text(
        'MONITOR CYCLE COMPLETE. This is a long-poll heartbeat, not a model wake-up. Keep the client process alive and call `monitor` again after the next work unit. Act on every message before continuing your own plan.\n\n' +
        renderInbox(messages, waitSeconds > 0),
      );
    }

    case 'file_review': {
      if (!args.path) return fail('file_review requires "path".');
      const { alsoReviewedBy, disagreement } = room.reviewFile(agent, args);
      const lines = [`Recorded: ${args.path} — ${args.verdict || 'reviewed'}.`];
      if (disagreement.length) {
        lines.push(
          '',
          '!! DISAGREEMENT — the other agent reached a different conclusion on this file:',
          ...disagreement.map((d) => `   ${d.agent} said "${d.verdict}"${d.note ? `: ${d.note}` : ''}`),
          '',
          'Resolve it before moving on: re-read the specific lines, then message them. One of you is wrong,',
          'and on a bug bounty that difference is often the bug.',
        );
      } else if (alsoReviewedBy.length) {
        lines.push(`Your partner agrees — also reviewed by ${alsoReviewedBy.map((o) => o.agent).join(', ')}.`);
      }
      return text(lines.join('\n'));
    }

    case 'files': {
      const map = room.coverage();
      if (args.path) {
        const file = map.find((f) => f.path === args.path);
        if (!file) return text(`Nobody has recorded a review of ${args.path} yet. You are first — record one when you are done.`);
        return text(
          `${file.path}\n` +
            file.reviews
              .map((r) => `  [${r.verdict}] ${r.agent} ${r.lines ? `(lines ${r.lines}) ` : ''}${r.ts.slice(11, 19)}\n     ${r.note || '(no note)'}`)
              .join('\n') +
            (file.findings.length ? `\n  findings: ${file.findings.join(', ')}` : '') +
            (file.disagreement ? '\n  !! reviewers disagree — resolve this' : ''),
        );
      }
      if (!map.length) return text('No files reviewed yet. Record them with file_review as you go.');
      return text(
        `${map.length} file(s) covered:\n` +
          map
            .map(
              (f) =>
                `  ${f.disagreement ? '!!' : f.peerReviewed ? '==' : '  '} ${f.path} — ${f.reviews
                  .map((r) => `${r.agent}:${r.verdict}`)
                  .join(', ')}`,
            )
            .join('\n') +
          '\n\n(== peer-reviewed by both, !! reviewers disagree)',
      );
    }

    case 'finding_add': {
      if (!args.title) return fail('finding_add requires "title".');
      // A finding your partner cannot reproduce is not a finding, it is a rumour.
      const evidence = (args.evidence || '').trim();
      const repro = (args.repro || '').trim();
      if (evidence.length < 20 && repro.length < 20) {
        return fail(
          'REJECTED: a finding needs evidence or repro steps — at least one of them, with real content.\n' +
          'Your partner has to reproduce this independently before it can be confirmed, and they cannot ' +
          'do that from a title.\n' +
          'evidence: what you observed that makes you believe it (file:line, the actual response, the code path).\n' +
          'repro: the minimal steps or request that shows it.\n' +
          'If you only have a hunch, use note instead — that does not pretend to be a finding.',
        );
      }
      if (!args.target) {
        return fail('REJECTED: finding_add requires "target" — the exact endpoint, file:line, or component. Without it nobody knows where to look.');
      }
      const finding = room.addFinding(agent, { ...args, createsTask: args.creates_task });
      // A target that looks like a path joins the coverage map automatically.
      if (args.target && /[/\\].*\.[a-z]{1,5}(:|$)/i.test(args.target)) {
        room.linkFinding(args.target.split(':')[0], finding.id);
      }
      room.send(agent, {
        to: 'all',
        text: `New finding ${finding.id} [${finding.severity}] ${finding.title}${finding.target ? ` @ ${finding.target}` : ''}. Please peer-review it.`,
      });
      return text(`Logged ${finding.id} and notified the others for peer review.`);
    }

    case 'finding_update': {
      const result = room.updateFinding(agent, args.id, {
        status: args.status,
        note: args.note,
        repro: args.repro,
        submissionUrl: args.submission_url,
        submissionNote: args.submission_note,
      });
      if (!result.ok) return fail(result.error);
      room.send(agent, { to: 'all', text: `${result.finding.id} marked ${result.finding.status} by ${agent}${args.note ? `: ${args.note}` : ''}` });
      return text(`${result.finding.id} is now ${result.finding.status}.`);
    }

    case 'findings':
      return text(room.state.findings.length ? room.state.findings : 'No findings logged yet.');

    case 'submissions': {
      const list = room.submissions().filter((finding) => !args.status || finding.status === args.status);
      return text(list.length ? list : 'No independently confirmed submission candidates or reported findings yet.');
    }

    case 'submission_update': {
      const result = room.updateSubmission(agent, args.id, {
        title: args.title,
        summary: args.summary,
        details: args.details,
        poc: args.poc,
        impact: args.impact,
        ecosystem: args.ecosystem,
        packageName: args.package_name,
        affectedVersions: args.affected_versions,
        patchedVersions: args.patched_versions,
        severity: args.severity,
        cvss: args.cvss,
        cwe: args.cwe,
        commit: args.commit,
        category: args.category,
        owner: args.owner,
        duplicateCheck: args.duplicate_check,
        masterCheckedAt: args.master_checked_at,
        knownIssuesCheckedAt: args.known_issues_checked_at,
        reproductionVerified: args.reproduction_verified,
        liveOnMaster: args.live_on_master,
        inlinePoc: args.inline_poc,
        impactDemonstrated: args.impact_demonstrated,
        knownIssuesChecked: args.known_issues_checked,
        oneFinding: args.one_finding,
        confidential: args.confidential,
        twoFactorVerified: args.two_factor_verified,
        windowVerified: args.window_verified,
      });
      if (!result.ok) return fail(result.error);
      const readiness = result.readiness;
      room.send(agent, {
        to: 'all',
        text: `${args.id} submission record updated: ${readiness.state}; ${readiness.blockers.length} blocker(s) remain.`,
      });
      return text({
        id: args.id,
        state: readiness.state,
        complete: `${readiness.requiredComplete}/${readiness.requiredTotal}`,
        blockers: readiness.blockers,
      });
    }

    case 'advisory_upsert': {
      if (!args.ghsa_id) return fail('advisory_upsert requires "ghsa_id".');
      const result = room.upsertAdvisory(agent, {
        ghsaId: args.ghsa_id,
        findingId: args.finding_id,
        title: args.title,
        url: args.url,
        state: args.state,
        outcome: args.outcome,
        anzaSeverity: args.anza_severity,
        ourSeverity: args.our_severity,
        product: args.product,
        affectedVersions: args.affected_versions,
        patchedVersions: args.patched_versions,
        outcomeReason: args.outcome_reason,
        closedBy: args.closed_by,
        creditState: args.credit_state,
        burnTx: args.burn_tx,
        burnSol: args.burn_sol,
        submittedAt: args.submitted_at,
      });
      if (!result.ok) return fail(result.error);
      room.send(agent, {
        to: 'all',
        text: `${result.created ? 'New' : 'Updated'} advisory ${result.advisory.ghsaId}${result.advisory.findingId ? ` (${result.advisory.findingId})` : ''}: ${result.advisory.state}/${result.advisory.outcome}${result.advisory.outcomeReason ? ` — "${result.advisory.outcomeReason}"` : ''}`,
      });
      return text(result.advisory);
    }

    case 'advisories':
      return text(room.advisories().length ? room.advisories() : 'No advisories recorded yet.');

    case 'archive': {
      const archive = room.state.archive || {};
      const kinds = ['tasks', 'goals', 'polls', 'digests', 'env', 'fences'];
      if (!args.kind) {
        return text({
          tasks: (archive.tasks || []).length,
          goals: (archive.goals || []).length,
          polls: (archive.polls || []).length,
          digests: (archive.digests || []).length,
          env: Object.keys(archive.env || {}).length,
          fences: (archive.fences || []).length,
        });
      }
      if (!kinds.includes(args.kind)) {
        return fail(`Unknown archive kind "${args.kind}". Use one of: ${kinds.join(', ')}.`);
      }
      if (args.kind === 'env') {
        return text(Object.keys(archive.env || {}).length ? archive.env : 'No archived environment facts.');
      }
      const list = archive[args.kind] || [];
      if (args.id) {
        const found = list.find((item) => item.id === args.id);
        return found ? text(found) : fail(`No ${args.kind} record ${args.id} in the archive.`);
      }
      if (!list.length) return text(`No archived ${args.kind}.`);
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
      return text([...list].reverse().slice(0, limit));
    }

    case 'note': {
      if (!args.text) return fail('note requires "text".');
      room.note(agent, args.text);
      return text('Noted.');
    }

    default:
      return fail(`Unknown tool "${name}".`);
  }
  })();
  return withNag(result);
}
