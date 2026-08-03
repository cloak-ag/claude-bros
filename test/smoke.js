/**
 * End-to-end test: speaks real MCP JSON-RPC to a live relay as two agents.
 * Run: node test/smoke.js
 */
import { Room } from '../server/room.js';
import { createServer } from '../server/http.js';

const TOKEN = 'testtoken';
let passed = 0;
let failed = 0;

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label} \x1b[2m${detail}\x1b[0m`);
  }
};

const room = new Room({ name: 'test', file: null });
const server = createServer({ room, token: TOKEN, quiet: true });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let id = 0;
const rpc = async (agent, method, params) => {
  const res = await fetch(`${base}/mcp?agent=${agent}&token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return res.status === 202 ? null : res.json();
};
const call = async (agent, name, args = {}) => {
  const out = await rpc(agent, 'tools/call', { name, arguments: args });
  return { text: out.result.content[0].text, isError: Boolean(out.result.isError) };
};
/** Ids shift whenever a section is added above, so never hardcode them. */
const newTask = async (agent, args) => (await call(agent, 'task_add', args)).text.match(/\b(T\d+)\b/)[1];

console.log('\n  handshake');
const init = await rpc('alpha', 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
});
check('initialize returns a protocol version', init.result?.protocolVersion === '2025-06-18', JSON.stringify(init));
check('server identifies itself', init.result?.serverInfo?.name === 'claude-bros');
check('initialization briefing is client-neutral and self-bootstrapping',
  ['Claude', 'Codex', 'Grok', 'FIRST ACTION, ALWAYS'].every((text) => init.result?.instructions?.includes(text)));
check('initialize records client implementation without making it a role',
  room.state.agents.alpha.client?.name === 'test' && !room.state.agents.alpha.role);
check('notifications get 202, no body', (await rpc('alpha', 'notifications/initialized')) === null);
const tools = await rpc('alpha', 'tools/list');
check('tools/list exposes the full surface', tools.result.tools.length === 24, `got ${tools.result.tools.length}`);
check('every tool has a schema', tools.result.tools.every((t) => t.inputSchema?.type === 'object'));
check('graph and governance are discoverable tools', ['graph', 'poll_create', 'poll_vote', 'polls']
  .every((name) => tools.result.tools.some((tool) => tool.name === name)));
const resources = await rpc('alpha', 'resources/list');
check('MCP advertises graph, capability, and connection resources',
  ['bros://board/graph', 'bros://server/capabilities', 'bros://server/connecting']
  .every((uri) => resources.result.resources.some((resource) => resource.uri === uri)));
const templates = await rpc('alpha', 'resources/templates/list');
check('resource template discovery is implemented for strict clients', Array.isArray(templates.result.resourceTemplates));
const graphResource = await rpc('alpha', 'resources/read', { uri: 'bros://board/graph' });
check('agents can read the graph without a browser', graphResource.result.contents[0].text.includes('"nodes"'));
const capabilityResource = await rpc('alpha', 'resources/read', { uri: 'bros://server/capabilities' });
check('agents can learn server changes without a prompt', capabilityResource.result.contents[0].text.includes('collaborationProtocol'));
const connectingResource = await rpc('alpha', 'resources/read', { uri: 'bros://server/connecting' });
check('agents can discover the client-neutral connection contract',
  connectingResource.result.contents[0].text.includes('streamable-http'));

console.log('\n  auth');
const noToken = await fetch(`${base}/mcp?agent=alpha`, { method: 'POST', body: '{}' });
check('requests without the token are rejected', noToken.status === 401);
check('health check needs no token', (await (await fetch(`${base}/healthz`)).json()).ok === true);
const bearer = await fetch(`${base}/mcp?agent=bearer-client`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }),
});
check('standard bearer authorization works without a query-string token', bearer.status === 200);
check('public connection discovery needs no token',
  (await (await fetch(`${base}/api/connect`)).json()).transport === 'streamable-http');
const identityless = await fetch(`${base}/mcp?token=${TOKEN}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }),
});
const identitylessBody = await identityless.json();
check('MCP rejects a missing configured identity clearly',
  identityless.status === 400 && identitylessBody.error?.message.includes('Do not guess'));
const badVersion = await fetch(`${base}/mcp?agent=alpha&token=${TOKEN}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '1900-01-01' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }),
});
check('unsupported MCP protocol headers are rejected', badVersion.status === 400);
const getMcp = await fetch(`${base}/mcp?agent=alpha&token=${TOKEN}`);
check('stateless MCP GET clearly declines an SSE stream', getMcp.status === 405 && getMcp.headers.get('allow') === 'POST');
const emptyBatch = await fetch(`${base}/mcp?agent=alpha&token=${TOKEN}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]',
});
check('empty JSON-RPC batches are invalid', emptyBatch.status === 400);
const wrongType = await fetch(`${base}/mcp?agent=alpha&token=${TOKEN}`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
});
check('Streamable HTTP rejects non-JSON request bodies', wrongType.status === 415);
const hostileOrigin = await fetch(`${base}/mcp?agent=alpha&token=${TOKEN}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
});
check('MCP rejects cross-origin browser requests to prevent DNS rebinding', hostileOrigin.status === 403);
const sameOrigin = await fetch(`${base}/mcp?agent=alpha&token=${TOKEN}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }),
});
check('same-origin browser MCP requests remain valid', sameOrigin.status === 200);

console.log('\n  two agents');
await call('alpha', 'join');
await call('beta', 'join');
const board = await call('alpha', 'board');
check('alpha sees beta on the board', board.text.includes('beta') && board.text.includes('available'));

console.log('\n  task collision guard');
await call('alpha', 'task_add', { title: 'Review password reset flow', scope: 'auth' });
const claimed = await call('alpha', 'task_claim', { id: 'T1' });
check('first claim succeeds', !claimed.isError && claimed.text.includes('You own T1'));
await call('beta', 'inbox'); // collaboration event: see who claimed it before attempting overlap
const tamper = await call('beta', 'task_update', { id: 'T1', status: 'open' });
check('a non-owner cannot bypass governance by reopening another agent task',
  tamper.isError && tamper.text.includes('task_reassign'));
const stolen = await call('beta', 'task_claim', { id: 'T1' });
check('second agent is blocked from the same task',
  stolen.isError && stolen.text.includes('being worked by alpha') && stolen.text.includes('last active'), stolen.text);
const done = await call('alpha', 'task_update', { id: 'T1', status: 'done', notes: 'tokens are 256-bit, ruled out' });
check('task can be completed', done.text.includes('now done'));

console.log('\n  task dependencies');
// T1 is already done above — so a task depending on it must be claimable right away.
await call('alpha', 'task_add', { title: 'Verify the password reset fix', depends_on: 'T1' });
await call('beta', 'inbox'); // consume the completed-task handoff before choosing the next task
const depMet = await call('beta', 'task_claim', { id: 'T2' });
check('a task whose dependency is done can be claimed', !depMet.isError, depMet.text);
await call('alpha', 'task_add', { title: 'Exploit the password reset', scope: 'auth' });
await call('alpha', 'task_add', { title: 'Write the advisory', depends_on: 'T3' });
const depBlock = await call('beta', 'task_claim', { id: 'T4' });
check('a task with an unfinished dependency is rejected as blocked',
  depBlock.isError && depBlock.text.includes('depends on T3') && room.task('T4').status === 'blocked', depBlock.text);
const depOpen = await call('alpha', 'task_update', { id: 'T3', status: 'done' });
check('completing the dependency reopens the blocked task', room.task('T4').status === 'open', JSON.stringify(room.task('T4')));
await call('beta', 'inbox'); // consume the dependency-complete broadcast

console.log('\n  messaging');
await call('beta', 'send', { text: 'Found a reflected param on /search', to: 'alpha' });
const inbox = await call('alpha', 'inbox');
check('alpha receives the direct message', inbox.text.includes('reflected param'));
check('messages are consumed once', (await call('alpha', 'inbox')).text.includes('No unread'));
check('sender does not receive their own broadcast', (await call('beta', 'inbox')).text.includes('No unread'));
const badTarget = await call('alpha', 'send', { text: 'hi', to: 'gamma' });
check('sending to an unknown agent errors usefully', badTarget.isError && badTarget.text.includes('Known agents'));
await call('alpha', 'send', { text: 'review my F1 @beta when you get a chance' });
const mentioned = room.state.messages[room.state.messages.length - 1];
check('@mention is recognised for a known agent', mentioned.mention === 'beta');
check('an @mention is treated as urgent', mentioned.urgent === true);
await call('alpha', 'send', { text: 'check @ghost-agent in scope' });
const ghostMention = room.state.messages[room.state.messages.length - 1];
check('@mention of an unknown name is not marked urgent', ghostMention.urgent === false && ghostMention.mention === null);

console.log('\n  long-polling inbox');
const started = Date.now();
const waiting = call('alpha', 'inbox', { wait_seconds: 10 });
setTimeout(() => call('beta', 'send', { text: 'ping while you wait', to: 'alpha' }), 300);
const waited = await waiting;
const elapsed = Date.now() - started;
check('a blocked agent wakes the instant mail arrives', waited.text.includes('ping while you wait') && elapsed < 3000, `${elapsed}ms`);

console.log('\n  findings');
await call('beta', 'finding_add', {
  title: 'IDOR on /api/v1/orders/{id}',
  severity: 'high',
  target: '/api/v1/orders/42',
  evidence: 'returns another user order',
});
const review = await call('alpha', 'inbox');
check('a finding pings the partner for peer review', review.text.includes('F1') && review.text.includes('peer-review'));
await call('alpha', 'finding_update', { id: 'F1', status: 'confirmed', note: 'reproduced with a second account' });
const findings = await call('beta', 'findings');
check('peer confirmation is recorded', findings.text.includes('"status": "confirmed"'));

console.log('\n  finding → task auto-link');
await call('beta', 'finding_add', {
  title: 'Stored XSS in the dashboard',
  severity: 'high',
  target: '/dashboard',
  evidence: 'agent message text is injected unescaped',
  creates_task: true,
});
const linkTask = room.state.tasks.find((t) => t.title.includes('Verify F2'));
check('a finding with creates_task spawns a verification task', Boolean(linkTask), JSON.stringify(room.state.tasks));
check('the verification task is assigned to the partner, not the reporter',
  linkTask?.owner === 'alpha', `owner=${linkTask?.owner}`);
check('the finding records its verification task', room.state.findings.find((f) => f.id === 'F2')?.verificationTask === linkTask?.id);

console.log('\n  board search');
const searchHit = await (await fetch(`${base}/api/search?q=idor&token=${TOKEN}`)).json();
check('search finds the matching finding', searchHit.count >= 1 && searchHit.results.some((r) => r.type === 'finding' && r.id === 'F1'), JSON.stringify(searchHit));
const searchAuth = await (await fetch(`${base}/api/search?q=idor`)).json();
check('search requires the token', !searchAuth?.results);

console.log('\n  relay version');
const version = await (await fetch(`${base}/api/version`)).json();
check('version endpoint is public', version.name === 'claude-bros' && Number.isInteger(version.toolCount));
check('version exposes the tool surface', Array.isArray(version.tools) && version.tools.includes('finding_add'));

console.log('\n  healing an older state file');
const older = `${process.env.TMPDIR || '/tmp'}/bros-old-${process.pid}.json`;
(await import('node:fs')).writeFileSync(older, JSON.stringify({
  room: 'old',
  agents: {},
  // written before the goal counter existed — exactly what bit the live board
  counters: { message: 4, task: 2, finding: 1 },
  goals: [{ id: 'GNaN', title: 'broken id' }, { id: 'GNaN', title: 'also broken' }],
  tasks: [{ id: 'T1', title: 'linked to the broken goal', goal: 'GNaN', status: 'done' }, { id: 'T2', title: 'ok' }],
  findings: [], files: {}, messages: [], log: [], env: {}, aliases: {},
}));
const healed = new Room({ name: 'old', file: older });
check('undefined counters are reset to a number', Number.isFinite(healed.state.counters.goal));
check('broken ids are regenerated uniquely',
  new Set(healed.state.goals.map((g) => g.id)).size === 2 && healed.state.goals.every((g) => /^G\d+$/.test(g.id)),
  JSON.stringify(healed.state.goals.map((g) => g.id)));
check('references are re-pointed at the new id', healed.state.tasks[0].goal === healed.state.goals[0].id);
check('sound ids are left alone', healed.state.tasks[1].id === 'T2');
check('the counter continues past ids already in use', healed.state.counters.task >= 2);
check('goal progress works again after healing', healed.goals()[0].done === 1);
const unseq = `${process.env.TMPDIR || '/tmp'}/bros-unseq-${process.pid}.json`;
(await import('node:fs')).writeFileSync(unseq, JSON.stringify({
  room: 'unseq', agents: {}, counters: { message: 2 },
  messages: [{ id: 'M1', from: 'a', to: 'all', text: 'one', ts: new Date().toISOString(), readBy: {} },
             { id: 'M2', from: 'a', to: 'all', text: 'two', ts: new Date().toISOString(), readBy: {} }],
  tasks: [], findings: [], goals: [], files: {}, env: {}, log: [], aliases: [], digests: [],
}));
const seqd = new Room({ name: 'unseq', file: unseq });
check('history written before sequencing gets numbered', seqd.state.messages.every((m) => Number.isFinite(m.seq)));
check('the sequence counter continues from the history', seqd.state.counters.seq === 2);
(await import('node:fs')).unlinkSync(unseq);
(await import('node:fs')).unlinkSync(older);

console.log('\n  join briefing');
const fresh = await call('gamma', 'join');
check('the briefing names the agent', fresh.text.includes('You are exactly "gamma"'));
check('the briefing makes connection identity authoritative',
  fresh.text.includes('sole source of truth') && fresh.text.includes('relay migrations'));
check('it lists an ordered set of next actions', fresh.text.includes('## DO THESE NOW, IN ORDER'));
check('it teaches the whole protocol', ['GOALS', 'TASKS', 'FILES', 'FINDINGS'].every((s) => fresh.text.includes(s)));
check('it carries the ground rules', fresh.text.includes('authorizes') && fresh.text.includes('live-fire'));
check('with no environment set it says to set one', fresh.text.includes('has recorded the shared environment'));
check('with no goals it says to propose them', fresh.text.includes('NO GOALS yet'));
check('the full board follows the briefing', fresh.text.includes('# Board:'));

check('a human posting via REST does not join the roster', await (async () => {
  await fetch(`${base}/api/send?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'human', to: 'alpha', text: 'nudge from the human' }),
  });
  return !room.state.agents.human && room.state.messages.some((m) => m.from === 'human');
})());

console.log('\n  agents that predate the briefing');
room.touch('oldtimer');                       // arrived without ever calling join
delete room.state.agents.oldtimer.briefedAt;  // exactly what an old record looks like
const nagged = await call('oldtimer', 'board');
check('every response nags an unbriefed agent', nagged.text.includes('have not read the operating briefing'));
check('the nag tells it exactly what to do', nagged.text.includes('Call the `join` tool now'));
check('the real response still comes through', nagged.text.includes('# Board:'));
const nagged2 = await call('oldtimer', 'files');
check('it keeps nagging on other tools too', nagged2.text.includes('have not read the operating briefing'));
await call('oldtimer', 'join', {});
check('calling join clears it', !(await call('oldtimer', 'board')).text.includes('have not read the operating briefing'));
check('briefed agents are never nagged', !(await call('alpha', 'board')).text.includes('have not read the operating briefing'));

console.log('\n  shared environment');
await call('alpha', 'env_set', { key: 'repo', value: 'agave' });
const pinned = await call('alpha', 'env_set', { key: 'commit', value: '4f21b82a54' });
check('env values are recorded', pinned.text.includes('Set commit = 4f21b82a54'));
check('the environment shows on the board', (await call('beta', 'board')).text.includes('repo = agave'));
const moved = await call('beta', 'env_set', { key: 'commit', value: 'deadbeef' });
check('changing a pinned value is called out', moved.text.includes('"4f21b82a54" → "deadbeef"'));
check('and everyone is alerted about it', (await call('alpha', 'inbox')).text.includes('Shared environment changed'));
const briefed = await call('gamma', 'join', {});
check('a later briefing reflects the environment that now exists',
  briefed.text.includes('## SHARED ENVIRONMENT') && briefed.text.includes('repo = agave'));

console.log('\n  goals');
await call('alpha', 'goal_add', { title: 'Find consensus-breaking bugs in votor', detail: 'agave @ 4f21b82a54' });
const badGoal = await call('alpha', 'task_add', { title: 'x', goal: 'G99' });
check('linking to a goal that does not exist is refused', badGoal.isError && badGoal.text.includes('No goal G99'));
await newTask('alpha', { title: 'Audit vote aggregation', goal: 'G1' });
const goalTask = await newTask('alpha', { title: 'Audit cert verification', goal: 'G1' });
await call('alpha', 'task_update', { id: goalTask, status: 'done' });
const goalList = await call('beta', 'goals');
check('goal progress counts linked tasks', goalList.text.includes('1/2 tasks'), goalList.text);
check('a new goal is broadcast to the others', (await call('beta', 'inbox')).text.includes('New shared goal G1'));

console.log('\n  file coverage');
await call('alpha', 'file_review', { path: 'votor/src/consensus_pool.rs', verdict: 'clean', note: 'insert_certificate paths check out' });
const agreed = await call('beta', 'file_review', { path: 'votor/src/consensus_pool.rs', verdict: 'clean', note: 'agree' });
check('agreement is reported back', agreed.text.includes('partner agrees') && agreed.text.includes('alpha'));
const dispute = await call('beta', 'file_review', { path: 'votor/src/event_handler.rs', verdict: 'suspicious', note: 'rooting logic looks off' });
check('a first review has nothing to disagree with', !dispute.text.includes('DISAGREEMENT'));
const clash2 = await call('alpha', 'file_review', { path: 'votor/src/event_handler.rs', verdict: 'clean', note: 'looks fine to me' });
check('disagreement is surfaced loudly', clash2.text.includes('DISAGREEMENT') && clash2.text.includes('beta said "suspicious"'), clash2.text);
const map = await call('alpha', 'files');
check('the coverage map marks peer review and disputes',
  map.text.includes('== votor/src/consensus_pool.rs') && map.text.includes('!! votor/src/event_handler.rs'), map.text);
const one = await call('alpha', 'files', { path: 'votor/src/event_handler.rs' });
check('a single file shows every reviewer and note', one.text.includes('rooting logic looks off') && one.text.includes('looks fine to me'));
check('an unreviewed file says so', (await call('alpha', 'files', { path: 'nope.rs' })).text.includes('You are first'));
const boardWithAll = await call('alpha', 'board');
check('goals and coverage appear on the board agents read',
  boardWithAll.text.includes('## Goals') && boardWithAll.text.includes('## File coverage'), '');
await call('alpha', 'finding_add', { title: 'Cert reuse', severity: 'high', target: 'votor/src/consensus_pool.rs:412',
  evidence: 'the same certificate is accepted twice across epoch boundaries' });
check('findings auto-link to the file they name',
  room.state.files['votor/src/consensus_pool.rs'].findings.length === 1);

console.log('\n  hook endpoint');
await call('beta', 'send', { text: 'one more thing', to: 'alpha' });
const unread = await (await fetch(`${base}/api/unread?agent=alpha&token=${TOKEN}`)).json();
check('the Stop hook can see pending mail', unread.count === 1 && unread.messages[0].text === 'one more thing');
const stillThere = await (await fetch(`${base}/api/unread?agent=alpha&token=${TOKEN}`)).json();
check('peeking does not consume mail', stillThere.count === 1);

console.log('\n  rename');
const survivor = await newTask('alpha', { title: 'Task that must survive a rename' });
await call('alpha', 'inbox'); await call('alpha', 'board');
await call('alpha', 'task_claim', { id: survivor });
const renamed = room.rename('alpha', 'renamed-agent');
check('rename reports what it moved', renamed.ok && renamed.references > 0, JSON.stringify(renamed));
check('the old name is gone', !room.state.agents.alpha);
check('the new name inherits the identity record', Boolean(room.state.agents['renamed-agent']?.joinedAt));
check('claimed work follows the rename', room.task(survivor).owner === 'renamed-agent');
check('authored findings follow the rename', room.state.findings.every((f) => f.by !== 'alpha'));
check('message history follows the rename', room.state.messages.every((m) => m.from !== 'alpha' && m.to !== 'alpha'));
const afterRename = await call('renamed-agent', 'board');
check('the renamed agent is recognised on reconnect', afterRename.text.includes('you are "renamed-agent"'));
check('renaming onto a taken name is refused', room.rename('renamed-agent', 'beta').error.includes('already taken'));
check('renaming a stranger is refused', room.rename('nobody', 'x').error.includes('No agent called'));

console.log('\n  old names forward instead of duplicating');
const stale = await call('alpha', 'board');
check('a machine still using the old name is forwarded, not duplicated',
  stale.text.includes('you are "renamed-agent"'), stale.text.slice(0, 90));
check('no empty duplicate is created', !room.state.agents.alpha);
room.rename('renamed-agent', 'chain-target');
check('forwarding follows a chain of renames', room.resolveName('alpha') === 'chain-target');
const chained = await call('alpha', 'board');
check('the chain works over the wire too', chained.text.includes('you are "chain-target"'));
room.rename('beta', 'renamed-agent');
check('a freed name that gets reused stops forwarding', room.resolveName('renamed-agent') === 'renamed-agent');
room.rename('renamed-agent', 'beta');
room.rename('chain-target', 'alpha');

console.log('\n  forget');
await call('delta', 'join', {});
room.state.agents.delta.lastSeen = 0;  // simulate a session that has gone away
check('an agent that never contributed can be removed', room.forget('delta').ok);
check('removing a stranger is refused', room.forget('nobody').error.includes('No agent called'));
await call('epsilon', 'join', {});
await call('epsilon', 'send', { text: 'I said something worth keeping' });
room.state.agents.epsilon.lastSeen = 0;
const talked = room.forget('epsilon');
check('an agent that only ever talked is still protected', !talked.ok && talked.error.includes('1 message(s)'), talked.error);
check('online agents are protected even with no contributions', (() => {
  room.touch('zeta');
  return !room.forget('zeta').ok && room.forget('zeta').error.includes('ONLINE');
})());
const forced = room.forget('epsilon', { force: true });
check('--force removes it anyway', forced.ok && forced.keptMessages === 1);
check('what they said survives being forgotten', room.state.messages.some((m) => m.from === 'epsilon'));
check('dangling aliases are cleaned up', !Object.values(room.state.aliases || {}).includes('epsilon'));

console.log('\n  evidence-required findings');
const bare = await call('alpha', 'finding_add', { title: 'Something is wrong', target: 'x.rs:1' });
check('a title-only finding is rejected', bare.isError && bare.text.includes('needs evidence or repro'));
const noTarget = await call('alpha', 'finding_add', { title: 'x', evidence: 'a'.repeat(30) });
check('a finding with no target is rejected', noTarget.isError && noTarget.text.includes('requires "target"'));
const good = await call('alpha', 'finding_add', {
  title: 'Real one', target: 'votor/src/x.rs:42',
  evidence: 'insert_certificate mutates pool state before verify_certificate returns',
});
check('a finding with real evidence is accepted', !good.isError && good.text.includes('Logged'));

console.log('\n  board-read before claiming');
const bId = await newTask('beta', { title: 'guarded task' });
await call('alpha', 'inbox');
room.state.agents.alpha.boardAt = 0;
const blind = await call('alpha', 'task_claim', { id: bId });
check('claiming without looking at the board is refused', blind.isError && blind.text.includes('Call `board` first'));
await call('alpha', 'board');
await call('alpha', 'inbox');
check('claiming after reading the board works', !(await call('alpha', 'task_claim', { id: bId })).isError);
await call('beta', 'send', { text: 'unread blocker', to: 'alpha' });
const bId2 = await newTask('beta', { title: 'second guarded task' });
const withMail = await call('alpha', 'task_claim', { id: bId2 });
check('claiming with unread mail is refused', withMail.isError && withMail.text.includes('unread message'));
await call('alpha', 'inbox');

console.log('\n  stale claims lapse');
const lapsed = await newTask('beta', { title: 'held by someone who vanished' });
await call('beta', 'inbox'); await call('beta', 'board');
const heldOk = await call('beta', 'task_claim', { id: lapsed });
check('the owner could claim it in the first place', !heldOk.isError, heldOk.text);
room.state.agents.beta.lastSeen = Date.now() - 40 * 60_000;
check('a claim from a silent owner is released', room.releaseStaleClaims().includes(lapsed));
check('the task is open again', room.task(lapsed).status === 'open');
check('who held it is remembered', room.task(lapsed).lastOwner === 'beta');
room.state.agents.beta.lastSeen = Date.now();

console.log('\n  claims lapse on any glance, not just board/claim');
const dashLapse = await newTask('beta', { title: 'lapsed by a plain state read' });
await call('beta', 'inbox'); await call('beta', 'board');
await call('beta', 'task_claim', { id: dashLapse });
room.state.agents.beta.lastSeen = Date.now() - 40 * 60_000;
await (await fetch(`${base}/api/state?token=${TOKEN}`)).json();
check('a dashboard state read lapses a stale claim', room.task(dashLapse).status === 'open');
room.state.agents.beta.lastSeen = Date.now();

console.log('\n  claim window is tunable via env');
const winTask = await newTask('beta', { title: 'short-window claim' });
await call('beta', 'inbox'); await call('beta', 'board');
await call('beta', 'task_claim', { id: winTask });
room.state.agents.beta.lastSeen = Date.now() - 7 * 60_000;
const prevWin = process.env.BROS_CLAIM_STALE_MS;
process.env.BROS_CLAIM_STALE_MS = '6000';
const releasedWin = room.releaseStaleClaims();
if (prevWin === undefined) delete process.env.BROS_CLAIM_STALE_MS; else process.env.BROS_CLAIM_STALE_MS = prevWin;
check('a 6-second window releases a 7-minute-silent owner', releasedWin.includes(winTask));
room.state.agents.beta.lastSeen = Date.now();

console.log('\n  message dedup, sequencing, threading');
const first = await call('beta', 'send', { text: 'exactly the same words', to: 'alpha' });
const again = await call('beta', 'send', { text: 'exactly the same words', to: 'alpha' });
check('an identical resend is suppressed', again.text.includes('not sending it twice'), again.text);
check('the first one still went', first.text.includes('Sent'));
check('messages carry increasing sequence numbers',
  room.state.messages.every((m, i, all) => i === 0 || (m.seq || 0) > (all[i - 1].seq || 0)));
const threaded = await call('beta', 'send', { text: 'answering that', to: 'alpha', reply_to: 'F1' });
check('a reply records what it answers', threaded.text.includes('re: F1'));
check('a bad reply_to is refused', (await call('beta', 'send', { text: 'x', reply_to: 'nope' })).isError);

console.log('\n  identity collision is refused, not just warned');
await call('zulu', 'join', {});
room.recordEndpoint('zulu', 'host-a.example');
room.state.agents.zulu.lastSeen = Date.now();
const stolen2 = room.join('zulu', { host: 'host-b.example' });
check('a second machine cannot take a live name', !stolen2.ok && stolen2.error.includes('already in use'));
check('the refusal says what to do', stolen2.error.includes('different --as name'));
room.state.agents.zulu.lastSeen = Date.now() - 45 * 60_000;
check('the name frees up once that machine goes quiet', room.join('zulu', { host: 'host-b.example' }).ok);
room.state.agents.zulu.hosts = ['host-b.example'];  // tidy up the deliberate collision

console.log('\n  digest');
for (let i = 0; i < 22; i += 1) await call('beta', 'send', { text: `digest filler ${i}` });
const dig = await call('alpha', 'digest');
check('a digest is generated from activity', dig.text.includes('## D') && dig.text.includes('findings standing'));
check('it summarises rather than replays', !dig.text.includes('digest filler 3'));

console.log('\n  identity clash detection');
check('one machine is not a clash', room.recordEndpoint('alpha', 'relay-host') === null);
check('same machine twice is still not a clash', room.recordEndpoint('alpha', 'relay-host') === null);
const clash = room.recordEndpoint('alpha', 'host-c.example');
check('a second machine using the name is flagged', Array.isArray(clash) && clash.length === 2, JSON.stringify(clash));
check('the clash is listed on the board', room.conflicts()[0]?.name === 'alpha');
const warned = await call('alpha', 'board');
check('agents are warned in the board tool output',
  warned.text.includes('WARNING') && warned.text.includes('host-c.example'));
check('the warning names the fix', warned.text.includes('--as name'));
room.state.agents.alpha.hosts = ['relay-host'];
// zulu picked up a second host ('relay-host' from its join call, then the fake
// one in the collision test) — clear it or the board keeps warning about zulu.
room.state.agents.zulu.hosts = ['relay-host'];
check('clearing the extra host clears the warning', !(await call('alpha', 'board')).text.includes('WARNING'));

console.log('\n  persistence layer');
{
  const fsFile = await import('node:fs');
  const osFile = await import('node:os');
  const pathFile = await import('node:path');
  const dir = fsFile.mkdtempSync(pathFile.join(osFile.tmpdir(), 'bros-state-mode-'));
  const file = pathFile.join(dir, 'private.json');
  const r = new Room({ name: 'private', file });
  r.note('tester', 'write a private state file');
  await new Promise((resolve) => setTimeout(resolve, 350));
  check('file-backed state is owner-only', (fsFile.statSync(file).mode & 0o777) === 0o600);

  const staleFile = pathFile.join(dir, 'stale-presence.json');
  fsFile.writeFileSync(staleFile, JSON.stringify({
    room: 'restored',
    agents: { alpha: { name: 'alpha', lastSeen: Date.now(), hosts: ['old-relay', 'old-client'] } },
  }));
  const restored = new Room({ name: 'restored', file: staleFile });
  check('file restore clears stale endpoint hosts without renaming the agent',
    restored.state.agents.alpha.name === 'alpha' &&
    restored.state.agents.alpha.lastSeen === 0 &&
    restored.state.agents.alpha.hosts.length === 0);
  fsFile.rmSync(dir, { recursive: true });
}
// A fake persistence layer stands in for Postgres: the contract is load/save,
// and these are the bugs that made the real one unusable.
{
  const saved = [];
  let failNext = false;
  const fake = {
    load: async () => ({ room: 'p', agents: { a: { name: 'a', lastSeen: Date.now(), hosts: ['old-db-host'] } }, messages: [{ id: 'M1', seq: 1, from: 'a', to: 'all', text: 'from the db', ts: new Date().toISOString(), readBy: {} }], counters: { message: 1, seq: 1 } }),
    save: async (name, state) => { if (failNext) throw new Error('connection reset'); saved.push(state.messages.length); },
  };
  const r = await new Room({ name: 'p', file: null, persistence: fake }).init();
  check('state loads from the persistence layer', r.state.messages[0]?.text === 'from the db');
  check('database restore also clears stale endpoint presence',
    r.state.agents.a.lastSeen === 0 && r.state.agents.a.hosts.length === 0);
  check('an in-memory room with no file does not error on init',
    (await new Room({ name: 'mem', file: null }).init()).state.messages.length === 0);

  r.send('a', { to: 'all', text: 'one' });
  r.send('a', { to: 'all', text: 'two' });
  check('writes are debounced, not one per mutation', saved.length === 0);
  await r.flush();
  check('flush writes immediately', saved.length === 1);

  failNext = true;
  r.send('a', { to: 'all', text: 'three' });
  let crashed = false;
  process.once('unhandledRejection', () => { crashed = true; });
  await r.flush();
  await new Promise((res) => setImmediate(res));
  check('a failing write is caught, not an unhandled rejection', !crashed);
}

// getPool() is async; a caller that forgets to await it used to poison every query
{
  const db = await import('../server/db.js');
  const fakePool = { query: async () => ({ rows: [{ state: { room: 'q', messages: [] } }] }) };
  const asPromise = Promise.resolve(fakePool);
  const loaded = await db.loadState('q', asPromise);
  check('db helpers accept a promised pool, not just a resolved one', loaded?.room === 'q');
  let msg = '';
  try { await db.getPool(undefined); } catch (e) { msg = e.message; }
  check('a missing DATABASE_URL says so plainly', msg.includes('DATABASE_URL is not set'), msg);
}

check('serve honours BROS_ROOM, which the deploy configs set',
  /flags\.room \|\| process\.env\.BROS_ROOM/.test(
    (await import('node:fs')).readFileSync(new URL('../bin/claude-bros.js', import.meta.url), 'utf8')));

console.log('\n  egress: compression and revalidation');
{
  const url = `${base}/api/state?token=${TOKEN}`;
  // Node's fetch adds Accept-Encoding: gzip on its own, so ask for identity
  // explicitly to see what an un-compressing client would actually receive.
  const plain = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
  const gz = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  check('state is served with an ETag', Boolean(plain.headers.get('etag')));
  check('Cache-Control allows revalidation', plain.headers.get('cache-control') === 'no-cache');
  check('Vary: Accept-Encoding is set', plain.headers.get('vary') === 'Accept-Encoding');
  check('gzip is honoured when offered', gz.headers.get('content-encoding') === 'gzip');
  check('identity is honoured when gzip is refused', !plain.headers.get('content-encoding'));
  const rawLen = Number(plain.headers.get('content-length'));
  const gzLen = Number(gz.headers.get('content-length'));
  check('compression actually shrinks the payload', gzLen < rawLen, `${gzLen} vs ${rawLen}`);

  const tag = plain.headers.get('etag');
  const again = await fetch(url, { headers: { 'If-None-Match': tag } });
  check('an unchanged board revalidates to 304', again.status === 304, `got ${again.status}`);
  check('the 304 carries no body', (await again.text()).length === 0);

  await call('alpha', 'status', { text: 'poking the board to bump its version' });
  const afterChange = await fetch(url, { headers: { 'If-None-Match': tag } });
  check('a changed board returns 200 with fresh content', afterChange.status === 200);
  check('the ETag moves when the board changes', afterChange.headers.get('etag') !== tag);
}

console.log('\n  shared-brain graph');
{
  const { buildGraph, relatedTo } = await import('../server/graph.js');
  const g = buildGraph(room.state);
  check('the graph has a node per entity',
    g.nodes.some((n) => n.type === 'agent') && g.nodes.some((n) => n.type === 'task')
    && g.nodes.some((n) => n.type === 'finding') && g.nodes.some((n) => n.type === 'file'));
  check('tasks link to the goal they serve', g.edges.some((e) => e.kind === 'serves'));
  check('agents link to their current or completed work', g.edges.some((e) => ['working_on', 'built'].includes(e.kind)));
  check('reviewers link to the files they read', g.edges.some((e) => e.kind === 'reviewed'));
  check('every edge points at a node that exists', (() => {
    const ids = new Set(g.nodes.map((n) => n.id));
    return g.edges.every((e) => ids.has(e.from) && ids.has(e.to));
  })());
  check('degree is computed for sizing', g.nodes.every((n) => Number.isFinite(n.degree)));

  // finding_add auto-links only the FIRST path in `target`. A second file named
  // in the prose is exactly what inference is for.
  await call('alpha', 'file_review', { path: 'votor/src/prose_target.rs', verdict: 'clean', note: 'read it' });
  await call('alpha', 'file_review', { path: 'votor/src/second_file.rs', verdict: 'clean', note: 'read it too' });
  await call('alpha', 'finding_add', {
    title: 'Prose-located bug', target: 'votor/src/prose_target.rs:120',
    evidence: 'the guard is skipped when votor/src/second_file.rs warms the cache first',
  });
  const g2 = buildGraph(room.state);
  const explicit = g2.edges.find((e) => e.kind === 'found_in' && e.to === 'file:votor/src/prose_target.rs');
  const inferred = g2.edges.find((e) => e.kind === 'found_in' && e.to === 'file:votor/src/second_file.rs');
  check('the target file is linked', Boolean(explicit));
  check('a file named only in the evidence prose is also linked', Boolean(inferred),
    JSON.stringify(g2.edges.filter((e) => e.kind === 'found_in').map((e) => e.to)));
  check('the recorded link is not marked inferred', explicit?.inferred === false);
  check('the guessed link IS marked inferred, never passed off as recorded', inferred?.inferred === true);

  const rel = await call('alpha', 'related', { id: 'votor/src/prose_target.rs' });
  check('the related tool walks the graph', rel.text.includes('Directly connected'), rel.text.slice(0, 120));
  check('it reports how things connect', /\[(reviewed|found_in|working_on|built|serves|reported)\]/.test(rel.text));
  const graphView = await call('alpha', 'graph', { type: 'agent' });
  check('the graph is directly readable through MCP', graphView.text.includes('# Shared brain graph') && graphView.text.includes('agent:'));
  check('an unknown id fails usefully', (await call('alpha', 'related', { id: 'nope-nope' })).isError);
  check('related accepts a finding id too', !(await call('alpha', 'related', { id: 'F1' })).isError);
}

console.log('\n  dashboard');
const page = await fetch(`${base}/?token=${TOKEN}`);
const pageText = await page.text();
check('dashboard renders', page.status === 200 && pageText.includes('claude-bros'));
check('every element the dashboard script writes to exists in its markup', (() => {
  // A missing container makes el(...) null, tick() throws on the first write,
  // and the whole board renders blank — which is exactly what shipped once.
  const targets = new Set([...pageText.matchAll(/el\('([a-z]+)'\)/g)].map((m) => m[1]));
  const ids = new Set([...pageText.matchAll(/id="([a-z]+)"/g)].map((m) => m[1]));
  return [...targets].every((t) => ids.has(t));
})(), [...new Set([...pageText.matchAll(/el\('([a-z]+)'\)/g)].map((m) => m[1]))]
  .filter((t) => !pageText.includes(`id="${t}"`)).join(', '));
check('dashboard tab links carry the token and point at real routes',
  /class="tab[^"]*" href="\/\?token=/.test(pageText) && /class="tab[^"]*" href="\/help\?token=/.test(pageText));
check('dashboard ships the seconds-granular heartbeat', pageText.includes('last activity') && pageText.includes('quiet'));
check('dashboard separates active and archived work', pageText.includes('Active queue') && pageText.includes('Standing &amp; actionable'));
check('dashboard includes governance and contribution history', pageText.includes('Polls — team decisions') && pageText.includes('built/completed'));
check('dashboard distinguishes MCP client implementation from agent role',
  pageText.includes('Client: ') && pageText.includes('a.client.title || a.client.name'));
check('shared environment uses separated responsive key/value rows',
  pageText.includes('class="env-row"')
    && pageText.includes('grid-template-columns:minmax(140px,220px) minmax(0,1fr)')
    && !pageText.includes('<div class="envgrid">'));
check('coverage is a searchable full-width ledger', pageText.includes('coverage-filter') && pageText.includes('data-coverage-row'));
check('dashboard renders message threads', pageText.includes('replyto') && pageText.includes('thread'));
// Regression for the dashboard rewrite: esc() must actually escape (agent text is
// injected into innerHTML) and the state fetch must build a real ?token= query.
const escSource = pageText.match(/const esc =[^}]+}/)?.[0] || '';
check('dashboard esc() actually escapes, no stored XSS',
  escSource.includes("'&':'&amp;'") && escSource.includes("'<':'&lt;'"), escSource.slice(0, 80));
const fetchSource = pageText.match(/const token =[^;]+;[^;]*;[^;]*;/)?.[0] || '';
check('dashboard fetches state with a real token query',
  pageText.includes("'?token=' + encodeURIComponent(token)") && !pageText.includes("'&' + location.search"), fetchSource.slice(0, 80));
const stateFetch = await (await fetch(`${base}/api/state?token=${TOKEN}`)).json();
check('the dashboard state endpoint is live', stateFetch.room === room.name);

console.log('\n  CLI argument layer — the subcommand must not leak into args');
// Regression for the argv split: `join <url>` must record the URL, not "join",
// and `send "hello"` must send "hello", not "send hello".
// NB: async spawn, not spawnSync — spawnSync blocks this process's event loop,
// so the test relay here in this same process could never answer the child.
const { spawn } = await import('node:child_process');
const osMod = await import('node:os');
const fsMod = await import('node:fs');
const pathMod = await import('node:path');
const cli = pathMod.join(import.meta.dirname, '..', 'bin', 'claude-bros.js');
const runCli = (args, envHome, cwd) => new Promise((resolve) => {
  const child = spawn('node', [cli, ...args], { env: { ...process.env, HOME: envHome }, cwd });
  // Hook commands read optional JSON from stdin; close the test pipe so they
  // see EOF exactly as Claude Code's hook runner provides it.
  child.stdin.end();
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, out, err }));
});

{
  const secret = 'must-not-appear-in-generated-client-config';
  const generated = await runCli([
    'connect', `https://relay.example/?token=${secret}`, '--as', 'cross-client', '--client', 'all',
  ], osMod.tmpdir(), process.cwd());
  check('connect generates Claude, Codex, Grok, and generic MCP setup',
    generated.code === 0
      && generated.out.includes('.mcp.json')
      && generated.out.includes('.codex/config.toml')
      && generated.out.includes('grok.com/connectors')
      && generated.out.includes('Streamable HTTP'));
  check('connect preserves identity while removing legacy query tokens',
    generated.out.includes('/mcp?agent=cross-client') && !generated.out.includes(`?token=${secret}`));
  check('connect never echoes a supplied secret', !generated.out.includes(secret));
}

{
  const secret = 'do-not-write-this-token-to-service-logs';
  const hiddenDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'bros-hidden-token-'));
  const hidden = await new Promise((resolve) => {
    const child = spawn('node', [cli, 'serve', '--port', '0', '--data', pathMod.join(hiddenDir, 'state.json')], {
      env: { ...process.env, BROS_TOKEN: secret, BROS_HIDE_TOKEN: 'true' }, cwd: hiddenDir,
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    setTimeout(() => child.kill('SIGTERM'), 400);
    child.on('close', () => resolve(output));
  });
  check('serve can redact its bearer token from service logs',
    !hidden.includes(secret) && hidden.includes('<token>'), hidden);
  fsMod.rmSync(hiddenDir, { recursive: true, force: true });
}

// The join CLI installs hooks into `.claude/settings.local.json` — sandbox the
// cwd so the test never touches a real repo's settings file.
const sandbox = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'bros-cli-'));
fsMod.mkdirSync(pathMod.join(sandbox, '.claude'), { recursive: true });
fsMod.writeFileSync(pathMod.join(sandbox, '.claude', 'settings.local.json'), JSON.stringify({
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node /stale/claude-bros.js hook --event stop', timeout: 3 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'node /stale/claude-bros.js hook --event session-start', timeout: 3 }] }],
  },
}));
const unreachableRelay = 'http://127.0.0.1:9';
const j = await runCli(['join', unreachableRelay, '--as', 'cliagent', '--token', 't'], sandbox, sandbox);
let cliCfg = null;
let projectCfg = null;
try {
  cliCfg = JSON.parse(fsMod.readFileSync(pathMod.join(sandbox, '.claude-bros', 'config.json'), 'utf8'));
  projectCfg = JSON.parse(fsMod.readFileSync(pathMod.join(sandbox, '.claude', 'claude-bros.json'), 'utf8'));
} catch {}
check('join records the real relay URL, not the command name',
  cliCfg?.url === unreachableRelay, JSON.stringify(cliCfg));
check('join still passes its --as and --token through', cliCfg?.agent === 'cliagent' && cliCfg?.token === 't');
check('join stores an authoritative project-scoped identity',
  projectCfg?.agent === 'cliagent' && projectCfg?.token === 't', JSON.stringify(projectCfg));
check('join exits cleanly even when the relay is unreachable', j.code === 0, j.out + j.err);
// Regression for the SessionStart hook being dropped in the CLI rewrite: join
// must install BOTH hook events, into the project-scoped settings.local.json.
let hookSettings = null;
try {
  hookSettings = JSON.parse(fsMod.readFileSync(pathMod.join(sandbox, '.claude', 'settings.local.json'), 'utf8'));
} catch {}
const hookEvents = Object.keys(hookSettings?.hooks || {});
check('join installs the Stop hook', hookEvents.includes('Stop'), JSON.stringify(hookEvents));
check('join installs the SessionStart hook too', hookEvents.includes('SessionStart'), JSON.stringify(hookEvents));
check('hook commands carry the right event flag',
  hookSettings?.hooks?.Stop?.[0]?.hooks?.[0]?.command.includes('--event stop') &&
  hookSettings?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command.includes('--event session-start'),
  JSON.stringify(hookSettings?.hooks));
const firstConfigPath = pathMod.join(sandbox, '.claude', 'claude-bros.json');
check('each hook is pinned to this project config',
  hookSettings?.hooks?.Stop?.[0]?.hooks?.[0]?.command.includes(firstConfigPath) &&
  hookSettings?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command.includes(firstConfigPath),
  JSON.stringify(hookSettings?.hooks));
check('rejoin replaces stale hook binary paths and timeout',
  !JSON.stringify(hookSettings).includes('/stale/') &&
  hookSettings?.hooks?.Stop?.[0]?.hooks?.[0]?.timeout === 10,
  JSON.stringify(hookSettings?.hooks));
// ...and a second join does not duplicate the entries.
const j2 = await runCli(['join', unreachableRelay, '--as', 'cliagent', '--token', 't'], sandbox, sandbox);
let hookSettings2 = null;
try {
  hookSettings2 = JSON.parse(fsMod.readFileSync(pathMod.join(sandbox, '.claude', 'settings.local.json'), 'utf8'));
} catch {}
check('a second join does not duplicate hooks',
  hookSettings2?.hooks?.Stop?.length === 1 && hookSettings2?.hooks?.SessionStart?.length === 1,
  JSON.stringify(hookSettings2?.hooks?.Stop?.length));
const stableRejoin = await runCli(['join'], sandbox, sandbox);
check('rejoin without arguments preserves the configured identity',
  stableRejoin.code === 0 && JSON.parse(fsMod.readFileSync(firstConfigPath, 'utf8')).agent === 'cliagent',
  stableRejoin.out + stableRejoin.err);
const conflictingRejoin = await runCli(['join', '--as', 'different-agent'], sandbox, sandbox);
check('rejoin refuses a silent identity switch',
  conflictingRejoin.code === 1 && conflictingRejoin.err.includes('claude-bros rename cliagent different-agent'),
  conflictingRejoin.out + conflictingRejoin.err);

// Two projects under one HOME must never borrow each other's hook identity.
const secondProject = pathMod.join(sandbox, 'second-project');
fsMod.mkdirSync(pathMod.join(secondProject, '.claude'), { recursive: true });
await runCli(['join', unreachableRelay, '--as', 'second-agent', '--token', 't'], sandbox, secondProject);
const secondConfigPath = pathMod.join(secondProject, '.claude', 'claude-bros.json');
const secondHooks = JSON.parse(fsMod.readFileSync(pathMod.join(secondProject, '.claude', 'settings.local.json'), 'utf8'));
check('a second project gets its own hook config path',
  secondHooks.hooks.SessionStart[0].hooks[0].command.includes(secondConfigPath) &&
  !secondHooks.hooks.SessionStart[0].hooks[0].command.includes(firstConfigPath));

// Point both local configs at this test relay. The shared global config now
// belongs to the second project; explicit hook configs must still keep A and B.
fsMod.writeFileSync(firstConfigPath, JSON.stringify({ url: base, agent: 'cliagent', token: TOKEN }));
fsMod.writeFileSync(secondConfigPath, JSON.stringify({ url: base, agent: 'second-agent', token: TOKEN }));
const firstStart = await runCli(['hook', '--event', 'session-start', '--config', firstConfigPath], sandbox, sandbox);
const secondStart = await runCli(['hook', '--event', 'session-start', '--config', secondConfigPath], sandbox, secondProject);
check('same-HOME project hooks retain different configured names',
  firstStart.out.includes('agent \\"cliagent\\"') && !firstStart.out.includes('agent \\"second-agent\\"') &&
  secondStart.out.includes('agent \\"second-agent\\"') && !secondStart.out.includes('agent \\"cliagent\\"'),
  `first=${firstStart.out} second=${secondStart.out}`);

const sendHome = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'bros-send-'));
fsMod.mkdirSync(pathMod.join(sendHome, '.claude-bros'), { recursive: true });
fsMod.writeFileSync(pathMod.join(sendHome, '.claude-bros', 'config.json'), JSON.stringify({
  url: base, agent: 'clisender', token: TOKEN, role: '', scope: '',
}));
const s = await runCli(['send', 'hello-cli', '--to', 'alpha'], sendHome, sendHome);
const sentByCli = room.state.messages.find((m) => m.from === 'human' && m.text.includes('hello-cli'));
check('send sends the exact text, no command name prepended',
  s.code === 0 && sentByCli?.text === 'hello-cli', `${s.out} text=${sentByCli?.text}`);
fsMod.rmSync(sandbox, { recursive: true, force: true });
fsMod.rmSync(sendHome, { recursive: true, force: true });

server.close();
console.log(`\n  ${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
