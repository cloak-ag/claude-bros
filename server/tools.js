/**
 * MCP tool surface. These descriptions are prompt engineering, not docs — the
 * agents decide when to collaborate based on what they read here, so they are
 * written to push toward "check before you work, announce after you find".
 */

import { buildGraph, relatedTo } from './graph.js';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

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
      'Register the exact identity already attached to this MCP connection AND read the operating briefing. The tool takes no name argument: never copy a name from documentation, another agent, or a prompt, and never rename yourself during a relay migration. Returns the shared environment, active goals, working protocol, ground rules, and what this board needs next. Call it first thing in every session. It is safe to repeat; it preserves your identity and work.',
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
    name: 'task_add',
    title: 'Add work to the shared board',
    description:
      'Put a unit of work on the shared board so it gets done exactly once. Break the engagement into these up front, then claim the ones you will do.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('One line, imperative. e.g. "Review password reset token generation".'),
        scope: str('Which surface this touches, e.g. "backend/auth".'),
        notes: str('Context, hypotheses, or anything the person who picks it up needs.'),
        assign_to: str('Optionally assign directly to an agent by name instead of leaving it open.'),
        goal: str('Goal id this serves, e.g. "G1". Link it — that is what makes goal progress real.'),
        depends_on: { type: 'string', description: 'Optional task id (e.g. "T3") that must be done before this task can be claimed. Keeps the board from drifting into unblocked work.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'env_set',
    title: 'Record a shared environment fact',
    description:
      'Pin down what you and your partner are both working against: the repo, the exact commit, how it builds, the live target URL. Set these before real work starts — if two agents audit different commits, every finding is worthless. Changing an existing value alerts everyone.',
    inputSchema: {
      type: 'object',
      properties: {
        key: str('Short key. Conventional ones: repo, commit, build, run, target, scope_url, notes.'),
        value: str('The value, e.g. "agave @ 4f21b82a54" or "cargo build -p solana-votor".'),
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'goal_add',
    title: 'Set a shared goal',
    description:
      'Declare what this engagement is actually trying to achieve, above the level of individual tasks. Agree these with your partner early; tasks then link to them so everyone can see whether the work is converging on the goal or drifting.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('The objective, e.g. "Find consensus-breaking bugs in the Alpenglow votor path".'),
        detail: str('What success looks like, what is in and out of scope.'),
      },
      required: ['title'],
    },
  },
  {
    name: 'goal_update',
    title: 'Update a goal',
    description: 'Mark a goal done or dropped, or refine what it means. Drop goals that turn out to be dead ends so the board reflects reality.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Goal id, e.g. "G1".'),
        status: str('active | done | dropped', { enum: ['active', 'done', 'dropped'] }),
        detail: str('Revised description.'),
      },
      required: ['id'],
    },
  },
  {
    name: 'goals',
    title: 'List goals and progress',
    description: 'See every goal with how many of its tasks are done and who is working on them.',
    inputSchema: { type: 'object', properties: {} },
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
    name: 'task_claim',
    title: 'Claim a task',
    description:
      'Atomically take ownership of an open task. If your partner already claimed it you will be told to pick another — that is the collision guard, respect it and move on.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Task id, e.g. "T3".') },
      required: ['id'],
    },
  },
  {
    name: 'task_update',
    title: 'Update a task',
    description: 'Move a task to in-progress/blocked/done and leave notes on what you learned, including dead ends (a ruled-out surface is useful to your partner).',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Task id.'),
        status: str('One of: open, claimed, blocked, done.', { enum: ['open', 'claimed', 'blocked', 'done'] }),
        notes: str('What happened. Dead ends count — say what you ruled out.'),
      },
      required: ['id'],
    },
  },
  {
    name: 'poll_create',
    title: 'Open a team decision',
    description:
      'Create a durable team poll. Use a plain decision for coordination, or attach an action to release/reassign a task, remove an inactive agent, or restore one. Actions execute automatically only after the required votes pass; historical work attribution is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        question: str('The yes/no question the team is deciding.'),
        reason: str('Concrete context teammates need before voting.'),
        action: str('Optional action: task_reassign | task_release | agent_kick | agent_restore.', {
          enum: ['task_reassign', 'task_release', 'agent_kick', 'agent_restore'],
        }),
        task_id: str('Task id for task_reassign/task_release.'),
        assign_to: str('Agent receiving work for task_reassign.'),
        agent: str('Agent identity for agent_kick/agent_restore. Only inactive agents can be kicked.'),
      },
      required: ['question'],
    },
  },
  {
    name: 'poll_vote',
    title: 'Vote on a team decision',
    description:
      'Cast your one durable vote on an open poll. Read the question, reason, and attached action with polls first. A passed action is applied atomically.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Poll id, e.g. "P3".'),
        choice: str('yes | no | abstain', { enum: ['yes', 'no', 'abstain'] }),
      },
      required: ['id', 'choice'],
    },
  },
  {
    name: 'polls',
    title: 'Read team decisions',
    description:
      'List open or decided team polls with vote thresholds, tallies, actions, and execution results. Call this with board and inbox whenever you rejoin or become available.',
    inputSchema: {
      type: 'object',
      properties: {
        status: str('Optional: open | passed | rejected.', { enum: ['open', 'passed', 'rejected'] }),
        id: str('Optional poll id to read in full.'),
      },
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
    name: 'related',
    title: 'What else touches this?',
    description:
      'Traverse the shared brain around one thing — a file path, a finding id (F3), a task id (T7), a goal (G1) or an agent name. Returns everything connected to it and how: who reviewed that file, which findings name it, which tasks serve the same goal. Call this BEFORE opening a file or picking up a finding: it is the fastest way to inherit the context your partners already built instead of rediscovering it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('What to look up: "votor/src/consensus_pool.rs", "F3", "T7", "G1", or an agent name.'),
        hops: { type: 'number', description: 'How far to walk: 1 = direct connections (default), 2 = the second ring, which is where non-obvious links show up.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'graph',
    title: 'Read the shared brain as a graph',
    description:
      'Read the same connected graph shown in the web Graph tab, directly through MCP. It includes agents, their current and completed tasks, goals, findings, files, and the relationships between them. Use it when joining or choosing work so you inherit the structure the team already built. The interactive view is at /graph on this relay; append the same token already configured for this MCP connection.',
    inputSchema: {
      type: 'object',
      properties: {
        type: str('Optional node type: agent | goal | task | finding | file.', {
          enum: ['agent', 'goal', 'task', 'finding', 'file'],
        }),
        status: str('Optional status filter: open | good | warn | bad | idle.'),
        limit: { type: 'number', description: 'Maximum nodes to return, 1-100. Default 50.' },
      },
    },
  },
  {
    name: 'digest',
    title: 'Catch up without scrolling',
    description:
      'Get the rolling summary of what has been DECIDED — findings confirmed or rejected, tasks closed, files reviewed, who has gone quiet — rather than everything that was said. Call it when you return to a busy board instead of reading hundreds of messages. Generated automatically every 20 messages or 15 minutes.',
    inputSchema: {
      type: 'object',
      properties: { last: { type: 'number', description: 'How many digests back to show. Default 3.' } },
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

  lines.push('## Agents');
  if (!board.agents.length) lines.push('  (nobody has joined yet)');
  for (const a of board.agents) {
    const mark = a.online ? '●' : '○';
    const current = a.currentTasks || [];
    const taken = a.tasksTaken || [];
    const built = a.completedTasks || [];
    lines.push(`  ${mark} ${a.name}${a.name === board.you ? ' (you)' : ''} — ${current.length ? current.map((task) => `${task.id} ${task.title}`).join('; ') : 'available (no current task)'}`);
    lines.push(`      activity: ${a.status || 'idle'}  [seen ${a.lastSeenAgo}]`);
    if (taken.length) lines.push(`      took: ${taken.join(', ')}${built.length ? `; built/completed: ${built.map((task) => task.id).join(', ')}` : ''}`);
  }

  const section = (label, list, render) => {
    lines.push('', `## ${label} (${list.length})`);
    if (!list.length) lines.push('  (none)');
    for (const item of list) lines.push(...render(item).map((l) => `  ${l}`));
  };

  const envEntries = Object.entries(board.env || {});
  if (envEntries.length) {
    lines.push('## Shared environment');
    for (const [key, entry] of envEntries) lines.push(`  ${key} = ${entry.value}`);
  } else {
    lines.push('## Shared environment', '  (not recorded — set repo and commit with env_set before real work)');
  }

  section('Goals', board.goals || [], (g) => [
    `${g.id} [${g.status}] ${g.title}  —  ${g.done}/${g.taskCount} tasks done (${g.percent}%)`,
    ...(g.detail ? [`    ${g.detail}`] : []),
  ]);

  section('Open tasks', board.tasks.open, (t) => [
    `${t.id} ${t.title}${t.scope ? `  [${t.scope}]` : ''}${t.goal ? `  → ${t.goal}` : ''}`,
    ...(t.notes ? [`    ${t.notes.split('\n')[0]}`] : []),
  ]);
  section('In progress', board.tasks.claimed, (t) => [`${t.id} ${t.title} — ${t.owner}`]);
  if (board.tasks.blocked.length) section('Blocked', board.tasks.blocked, (t) => [`${t.id} ${t.title} — ${t.owner || 'unowned'}`]);
  if (board.polls?.open?.length) section('Open polls', board.polls.open, (p) => [
    `${p.id} ${p.question} — ${p.tally.yes} yes / ${p.tally.no} no / ${p.tally.abstain} abstain (${p.tally.cast}/${p.tally.eligible} cast)`,
    ...(p.action ? [`    action: ${JSON.stringify(p.action)}`] : []),
  ]);
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
    .map((m) => `[${m.ts.slice(11, 19)}] ${m.from}${m.to !== 'all' ? ' (direct)' : ''}${m.urgent ? ' **URGENT**' : ''}:\n${m.text}`)
    .join('\n\n');
}

function renderPoll(poll) {
  const tally = poll.tally || { yes: 0, no: 0, abstain: 0, cast: 0, eligible: 0 };
  const lines = [
    `${poll.id} [${poll.status}] ${poll.question}`,
    `  votes: ${tally.yes} yes / ${tally.no} no / ${tally.abstain} abstain; ${tally.cast}/${tally.eligible} cast; ${poll.requiredYes} yes required`,
  ];
  if (poll.reason) lines.push(`  reason: ${poll.reason}`);
  if (poll.action) lines.push(`  action: ${JSON.stringify(poll.action)}`);
  if (poll.execution) lines.push(`  execution: ${JSON.stringify(poll.execution)}`);
  const missing = (poll.eligible || []).filter((name) => !poll.votes?.[name]);
  if (poll.status === 'open' && missing.length) lines.push(`  waiting on: ${missing.join(', ')}`);
  return lines.join('\n');
}

/**
 * What an agent reads the instant it joins. This is the only briefing it is
 * guaranteed to see, so it carries the whole working protocol — and it adapts
 * to what the board actually needs next, because a generic lecture gets skimmed
 * while "there are no goals yet, propose them" gets acted on.
 */
function briefing(room, agent) {
  const board = room.board(agent);
  const peers = board.agents.filter((a) => a.name !== agent);
  const online = peers.filter((a) => a.online);
  const goals = board.goals.filter((g) => g.status === 'active');
  const env = Object.entries(room.state.env || {});
  const openTasks = board.tasks.open;
  const disputed = board.coverage.filter((f) => f.disagreement);
  const openPolls = board.polls?.open || [];

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
  if (!env.length) {
    L.push(`${step++}. Nobody has recorded the shared environment. Set it with env_set: at minimum`);
    L.push('   `repo` and `commit`, plus `build` if it compiles and `target` if there is a live host.');
    L.push('   If two agents audit different commits, every finding you produce is worthless.');
  } else {
    L.push(`${step++}. Confirm your local checkout matches the shared environment below. If it does not,`);
    L.push('   fix your checkout — do not change the shared value unless you agreed it with your partner.');
  }
  if (!goals.length) {
    L.push(`${step++}. There are NO GOALS yet. This is your job before any auditing: propose one to three`);
    L.push('   with goal_add, then `send` them to your partner and get agreement. Goals are what stop');
    L.push('   two agents doing thorough work on things nobody needed.');
  } else {
    L.push(`${step++}. Read the ${goals.length} active goal(s) below. Everything you do links to one of them.`);
  }
  if (openTasks.length) {
    L.push(`${step++}. ${openTasks.length} unclaimed task(s) are waiting. Call task_claim on one BEFORE you start it.`);
  } else {
    L.push(`${step++}. No unclaimed tasks. Break your scope into tasks with task_add (link them with goal:"G1"),`);
    L.push('   then claim the ones you will do.');
  }
  L.push(`${step++}. Call \`files\` before opening any file. If your partner already reviewed it, read their`);
  L.push('   note instead of redoing the work.');
  if (board.unreadForYou) L.push(`${step++}. You have ${board.unreadForYou} unread message(s) — call \`inbox\` first.`);
  if (openPolls.length) L.push(`${step++}. ${openPolls.length} team poll(s) need a decision — call \`polls\`, then \`poll_vote\` after reading the reason and action.`);
  if (disputed.length) L.push(`${step++}. ${disputed.length} file(s) have conflicting verdicts. Resolving those beats starting anything new.`);
  L.push('');

  // --- the protocol, stated once, plainly
  L.push('## THE WORKING PROTOCOL');
  L.push('GOALS  → what the engagement is for. goal_add / goals. Agree them with your partner.');
  L.push('TASKS  → units of work under a goal. task_add(goal:"G1") → task_claim → task_update.');
  L.push('         Agents have no static roles. Your current claimed task is your responsibility; your');
  L.push('         completed task history is the durable record of what you built or investigated.');
  L.push('         NEVER start work you have not claimed. If task_claim says your partner owns it,');
  L.push('         pick something else — that is the collision guard doing its job.');
  L.push('FILES  → the coverage map. file_review every file when you finish reading it, INCLUDING');
  L.push('         clean ones: "I read it, it is fine" removes it from your partner\'s queue forever.');
  L.push('         Use verdict "partial" with a lines range if you only got through part of it.');
  L.push('FINDINGS → finding_add the moment you have evidence, not when it is polished. Your partner');
  L.push('         gets pinged to reproduce it independently and mark it confirmed or rejected.');
  L.push('         Nothing gets submitted on one agent\'s say-so.');
  L.push('TALK   → status when you switch tasks. send for anything that changes what your partner');
  L.push('         should do next. inbox(wait_seconds) when you are genuinely blocked on them.');
  L.push('POLLS  → poll_create for shared decisions and stale-work reassignment; polls → poll_vote.');
  L.push('         Do not silently steal work or erase an agent. A passed poll moves the claim while');
  L.push('         preserving the previous agent\'s task history and completed contributions.');
  L.push('');

  L.push('## KEEP LISTENING WHILE YOU WORK — THIS IS NOT OPTIONAL');
  L.push('This relay CANNOT interrupt you. You only find out your partner said something when YOU');
  L.push('call a tool. An agent that goes quiet for an hour is deaf for an hour, and your partner is');
  L.push('sitting there assuming you got their message.');
  L.push('');
  L.push('- Call `inbox` BETWEEN units of work — after each file you finish, before you claim the next');
  L.push('  task, after a long build. Not just when you are about to stop. A lead that arrives 40');
  L.push('  minutes into an audit is worthless if you read it 40 minutes later.');
  L.push('- When something arrives, ACT ON IT before continuing your own plan. If they flag a file you');
  L.push('  are about to open, stop and read their note. If they ask you to verify a finding, verify it.');
  L.push('  If they claim a surface you were heading for, pick something else and say so.');
  L.push('  Reading a message and carrying on regardless is worse than never receiving it — they now');
  L.push('  believe it was handled.');
  L.push('- Always answer a direct question, even if the answer is "not yet, still on T3". Silence is');
  L.push('  indistinguishable from disagreement.');
  L.push('- If you cannot proceed without them, do not spin: `inbox` with wait_seconds (up to 120)');
  L.push('  blocks until they reply and returns the moment mail lands.');
  L.push('- A Stop hook is your safety net: if you try to end a turn with unread mail it will wake you');
  L.push('  and hand it over. Treat that as the backstop that caught what you missed, not the plan.');
  L.push('');

  if (env.length) {
    L.push('## SHARED ENVIRONMENT');
    for (const [key, entry] of env) L.push(`  ${key} = ${entry.value}   (set by ${entry.by})`);
    L.push('');
  }
  if (goals.length) {
    L.push('## ACTIVE GOALS');
    for (const g of goals) L.push(`  ${g.id} ${g.title} — ${g.done}/${g.taskCount} tasks done`);
    L.push('');
  }

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
export async function callTool(room, agent, name, args = {}, host = null) {
  if (!agent && name !== 'board') {
    return fail('This connection has no agent identity. Stop: do not guess or copy a name. Reconnect using the exact name assigned to this installation in ?agent=<agent-name>.');
  }
  const membership = agent ? room.isAgentBlocked(agent) : { blocked: false };
  if (membership.blocked && !['board', 'join'].includes(name)) {
    return fail(`This identity was removed by collaboration poll ${membership.pollId || ''}: ${membership.reason}. It cannot act or vote until an agent_restore poll passes.`);
  }
  if (agent) room.touch(agent);

  /**
   * An agent already mid-session when the protocol landed never saw the
   * briefing, and the relay cannot push to it. So every response it gets
   * carries a nag until it calls `join` — which is the one thing that clears it.
   */
  const unbriefed = agent && name !== 'join' && !room.state.agents[agent]?.briefedAt;
  const staleStatus = agent && name !== 'status' && name !== 'join' && room.statusStale(agent);
  const withNag = (result) => {
    if (!result.content?.[0]) return result;
    const currentWork = agent
      ? room.state.tasks.filter((task) => task.owner === agent && ['claimed', 'blocked'].includes(task.status))
      : [];
    const openWork = room.state.tasks.filter((task) => task.status === 'open');
    const openDecisions = room.listPolls('open').filter((poll) => poll.eligible.includes(agent) && !poll.votes?.[agent]);
    if (!currentWork.length && openWork.length && !['task_claim', 'join'].includes(name)) {
      result.content[0].text =
        `[available] You have no current task and ${openWork.length} task(s) are open. Read board/inbox, then claim one now; ` +
        'do not remain idle while teammates are offline.\n\n' + result.content[0].text;
    }
    if (openDecisions.length && !['polls', 'poll_vote', 'join'].includes(name)) {
      result.content[0].text =
        `[decision] Your vote is still needed on ${openDecisions.map((poll) => poll.id).join(', ')}. Call polls, read the reason/action, and vote.\n\n` +
        result.content[0].text;
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
      '   Call the `join` tool now — one call, and it returns the environment, the goals,\n' +
      '   the working rules, and what this board needs from you next. Do that before continuing.\n\n' +
      result.content[0].text;
    return result;
  };

  const result = await (async () => {
  switch (name) {
    case 'board': {
      if (agent && room.state.agents[agent]) room.state.agents[agent].boardAt = Date.now();
      room.releaseStaleClaims();
      room.maybeDigest();
      return text(renderBoard(room.board(agent)));
    }

    case 'join': {
      const joined = room.join(agent, { host });
      if (!joined.ok) return fail(joined.error);
      if (room.state.agents[agent]) room.state.agents[agent].boardAt = Date.now();
      return text(`${briefing(room, agent)}${renderBoard(room.board(agent))}`);
    }

    case 'env_set': {
      if (!args.key || !args.value) return fail('env_set requires "key" and "value".');
      const result = room.setEnv(agent, args.key, args.value);
      return text(
        result.changed
          ? `Changed ${result.key}: "${result.previous}" → "${result.value}". Everyone has been alerted.`
          : `Set ${result.key} = ${result.value}`,
      );
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
        const known = Object.keys(room.state.agents).join(', ') || '(none)';
        return fail(`No agent named "${to}". Known agents: ${known}. Use "all" to broadcast.`);
      }
      if (args.reply_to && !/^[MF]\d+$/.test(args.reply_to)) {
        return fail('reply_to must be a message id (M12) or finding id (F3).');
      }
      const msg = room.send(agent, { to, text: args.text, urgent: args.urgent, replyTo: args.reply_to });
      if (msg.duplicate) return text(`Already sent that exact text as ${msg.id} a moment ago — not sending it twice.`);
      return text(`Sent ${msg.id} to ${to}${args.reply_to ? ` (re: ${args.reply_to})` : ''}.`);
    }

    case 'inbox': {
      const waitSeconds = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), 120);
      if (waitSeconds > 0) await room.waitForMail(agent, waitSeconds * 1000);
      const messages = room.readInbox(agent);
      return text(renderInbox(messages, waitSeconds > 0));
    }

    case 'task_add': {
      if (!args.title) return fail('task_add requires "title".');
      if (args.goal && !room.state.goals.some((g) => g.id === args.goal)) {
        return fail(`No goal ${args.goal}. Existing goals: ${room.state.goals.map((g) => g.id).join(', ') || '(none yet)'}`);
      }
      if (args.depends_on && !room.state.tasks.some((t) => t.id === args.depends_on)) {
        return fail(`No task ${args.depends_on} to depend on.`);
      }
      const task = room.addTask(agent, {
        title: args.title,
        scope: args.scope,
        notes: args.notes,
        assignTo: args.assign_to,
        dependsOn: args.depends_on,
      });
      if (args.goal) {
        task.goal = args.goal;
        room.save();
      }
      return text(
        `Added ${task.id}: ${task.title}${task.owner ? ` (assigned to ${task.owner})` : ' (open)'}` +
          (args.goal ? ` → ${args.goal}` : '\nNo goal linked. If this serves a shared goal, add one with goal_add and link it.') +
          (args.depends_on ? ` [depends on ${args.depends_on}]` : '')
      );
    }

    case 'goal_add': {
      if (!args.title) return fail('goal_add requires "title".');
      const goal = room.addGoal(agent, { title: args.title, detail: args.detail });
      room.send(agent, { to: 'all', text: `New shared goal ${goal.id}: ${goal.title}. Link your tasks to it with task_add goal="${goal.id}".` });
      return text(`Added ${goal.id}: ${goal.title}`);
    }

    case 'goal_update': {
      const result = room.updateGoal(agent, args.id, { status: args.status, detail: args.detail });
      if (!result.ok) return fail(result.error);
      return text(`${result.goal.id} is now ${result.goal.status}.`);
    }

    case 'goals': {
      const list = room.goals();
      if (!list.length) return text('No goals set yet. Agree one with your partner and call goal_add.');
      return text(
        list
          .map(
            (g) =>
              `${g.id} [${g.status}] ${g.title}\n` +
              `   progress: ${g.done}/${g.taskCount} tasks${g.owners.length ? ` — ${g.owners.join(', ')}` : ''}` +
              (g.detail ? `\n   ${g.detail}` : ''),
          )
          .join('\n\n'),
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

    case 'task_claim': {
      // Claiming without looking is how two agents end up on the same surface.
      const record = room.state.agents[agent];
      const sawBoard = Date.now() - (record?.boardAt || 0);
      const unread = room.unread(agent).length;
      if (unread) {
        return fail(`You have ${unread} unread message(s). Read them with \`inbox\` first — one of them may already claim this or redirect you — then claim.`);
      }
      if (sawBoard > 5 * 60_000) {
        return fail('Call `board` first (you have not looked in the last 5 minutes), then claim. The board is how you find out what your partners already took.');
      }
      const result = room.claimTask(agent, args.id);
      if (!result.ok) return fail(result.error);
      room.send(agent, { to: 'all', text: `${agent} claimed ${result.task.id}: ${result.task.title}. Send context or overlap warnings now, using reply_to when applicable.` });
      return text(`You own ${result.task.id}: ${result.task.title}\n${result.task.notes || ''}`);
    }

    case 'task_update': {
      const result = room.updateTask(agent, args.id, { status: args.status, notes: args.notes });
      if (!result.ok) return fail(result.error);
      if (args.status === 'done' || args.status === 'blocked') {
        room.send(agent, {
          to: 'all',
          text: `${agent} marked ${result.task.id} ${result.task.status}: ${result.task.title}.${args.notes ? ` Outcome: ${args.notes}` : ' Ask for the outcome before duplicating this work.'}`,
        });
      }
      return text(`${result.task.id} is now ${result.task.status}.`);
    }

    case 'poll_create': {
      const actions = new Set(['task_reassign', 'task_release', 'agent_kick', 'agent_restore']);
      if (args.action && !actions.has(args.action)) {
        return fail(`Unknown poll action "${args.action}". Use task_reassign, task_release, agent_kick, or agent_restore.`);
      }
      let action = null;
      if (args.action === 'task_reassign') action = { type: args.action, taskId: args.task_id, to: args.assign_to };
      else if (args.action === 'task_release') action = { type: args.action, taskId: args.task_id };
      else if (args.action === 'agent_kick' || args.action === 'agent_restore') action = { type: args.action, agent: args.agent };
      const result = room.createPoll(agent, { question: args.question, reason: args.reason, action });
      if (!result.ok) return fail(result.error);
      room.send(agent, {
        to: 'all',
        urgent: Boolean(action),
        text: `Vote needed on ${result.poll.id}: ${result.poll.question}${result.poll.reason ? ` — ${result.poll.reason}` : ''}${action ? ` Action: ${JSON.stringify(action)}.` : ''} Call polls, then poll_vote.`,
      });
      return text(renderPoll(result.poll));
    }

    case 'poll_vote': {
      const result = room.votePoll(agent, args.id, args.choice);
      if (!result.ok) return fail(result.error);
      if (result.finalized) {
        room.send(agent, {
          to: 'all',
          text: `${result.poll.id} ${result.poll.status}. ${result.poll.execution ? `Action result: ${JSON.stringify(result.poll.execution)}` : 'Decision recorded.'}`,
        });
      }
      return text(renderPoll(result.poll));
    }

    case 'polls': {
      if (args.id) {
        const poll = room.poll(args.id);
        return poll ? text(renderPoll(poll)) : fail(`No poll ${args.id}.`);
      }
      const list = room.listPolls(args.status || '');
      return text(list.length ? list.map(renderPoll).join('\n\n') : `No ${args.status || ''} polls found.`.replace('  ', ' '));
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
          'If you only have a hunch, use task_add or note instead — those do not pretend to be findings.',
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
      const result = room.updateFinding(agent, args.id, { status: args.status, note: args.note });
      if (!result.ok) return fail(result.error);
      room.send(agent, { to: 'all', text: `${result.finding.id} marked ${result.finding.status} by ${agent}${args.note ? `: ${args.note}` : ''}` });
      return text(`${result.finding.id} is now ${result.finding.status}.`);
    }

    case 'findings':
      return text(room.state.findings.length ? room.state.findings : 'No findings logged yet.');

    case 'related': {
      if (!args.id) return fail('related requires "id" — a file path, finding id, task id, goal id or agent name.');
      const hops = Math.min(Math.max(Number(args.hops) || 1, 1), 3);
      const found = relatedTo(room.state, args.id, hops);
      if (!found) return fail(`Nothing on the board matches "${args.id}". Try a file path, F/T/G id, or an agent name.`);
      if (!found.neighbours.length) {
        return text(`${found.start.type} ${found.start.label} — ${found.start.detail}\n\nNothing is connected to it yet. If you are working on it, that is worth fixing: claim a task, or record a file_review so your partners can see it.`);
      }
      const lines = [`${found.start.type} ${found.start.label} — ${found.start.detail}`, ''];
      for (let d = 1; d <= hops; d += 1) {
        const ring = found.neighbours.filter((n) => n.depth === d);
        if (!ring.length) continue;
        lines.push(`## ${d === 1 ? 'Directly connected' : `${d} hops away`} (${ring.length})`);
        for (const n of ring) {
          const how = found.edges.find((e) => e.from === n.id || e.to === n.id);
          lines.push(`  ${n.type.padEnd(8)} ${n.label}${n.detail && n.detail !== n.label ? ` — ${n.detail.slice(0, 70)}` : ''}${how ? `  [${how.kind}]` : ''}`);
        }
        lines.push('');
      }
      return text(lines.join('\n'));
    }

    case 'graph': {
      const graph = buildGraph(room.state);
      const allowedStatus = new Set(['open', 'good', 'warn', 'bad', 'idle']);
      if (args.status && !allowedStatus.has(args.status)) {
        return fail('graph status must be one of: open, good, warn, bad, idle.');
      }
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
      let nodes = graph.nodes;
      if (args.type) nodes = nodes.filter((node) => node.type === args.type);
      if (args.status) nodes = nodes.filter((node) => node.status === args.status);
      nodes = nodes
        .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
        .slice(0, limit);
      const visible = new Set(nodes.map((node) => node.id));
      const edges = graph.edges.filter((edge) => visible.has(edge.from) || visible.has(edge.to));
      const counts = graph.nodes.reduce((acc, node) => {
        acc[node.type] = (acc[node.type] || 0) + 1;
        return acc;
      }, {});
      const lines = [
        '# Shared brain graph',
        `All nodes: ${Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(' · ')} · edges ${graph.edges.length}`,
        'Interactive view: open `/graph?token=<your already-configured token>` on the same relay origin.',
        '',
        `## Nodes (${nodes.length}${nodes.length < graph.nodes.length ? ` of ${graph.nodes.length}` : ''})`,
      ];
      for (const node of nodes) {
        lines.push(`  ${node.id} [${node.status}] degree=${node.degree} — ${node.detail || node.label}`);
        if (node.type === 'agent') {
          const current = node.meta.currentTasks || [];
          const built = node.meta.completed || [];
          lines.push(`      current: ${current.join(', ') || 'none (available)'}; built/completed: ${built.map((task) => task.id).join(', ') || 'none recorded'}`);
        }
      }
      lines.push('', `## Relationships touching these nodes (${edges.length})`);
      for (const edge of edges.slice(0, 150)) {
        lines.push(`  ${edge.from} --${edge.kind}${edge.inferred ? ' (inferred)' : ''}--> ${edge.to}`);
      }
      if (edges.length > 150) lines.push(`  ... ${edges.length - 150} more; filter by type or call related on a node id.`);
      return text(lines.join('\n'));
    }

    case 'digest': {
      room.maybeDigest();
      const list = room.state.digests.slice(-Number(args.last || 3));
      if (!list.length) return text('No digests yet — they are generated every 20 messages or 15 minutes of activity.');
      return text(list.map((d) => `## ${d.id}  ${d.ts.slice(11, 19)} UTC (messages ${d.fromSeq + 1}-${d.toSeq})\n` + d.lines.map((l) => `  - ${l}`).join('\n')).join('\n\n'));
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
