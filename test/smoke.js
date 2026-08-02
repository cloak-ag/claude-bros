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
check('notifications get 202, no body', (await rpc('alpha', 'notifications/initialized')) === null);
const tools = await rpc('alpha', 'tools/list');
check('tools/list exposes the full surface', tools.result.tools.length === 19, `got ${tools.result.tools.length}`);
check('every tool has a schema', tools.result.tools.every((t) => t.inputSchema?.type === 'object'));

console.log('\n  auth');
const noToken = await fetch(`${base}/mcp?agent=alpha`, { method: 'POST', body: '{}' });
check('requests without the token are rejected', noToken.status === 401);
check('health check needs no token', (await (await fetch(`${base}/healthz`)).json()).ok === true);

console.log('\n  two agents');
await call('alpha', 'join', { role: 'static analysis', scope: 'auth + config' });
await call('beta', 'join', { role: 'recon', scope: 'endpoints' });
const board = await call('alpha', 'board');
check('alpha sees beta on the board', board.text.includes('beta') && board.text.includes('recon'));

console.log('\n  task collision guard');
await call('alpha', 'task_add', { title: 'Review password reset flow', scope: 'auth' });
const claimed = await call('alpha', 'task_claim', { id: 'T1' });
check('first claim succeeds', !claimed.isError && claimed.text.includes('You own T1'));
const stolen = await call('beta', 'task_claim', { id: 'T1' });
check('second agent is blocked from the same task',
  stolen.isError && stolen.text.includes('being worked by alpha') && stolen.text.includes('last active'), stolen.text);
const done = await call('alpha', 'task_update', { id: 'T1', status: 'done', notes: 'tokens are 256-bit, ruled out' });
check('task can be completed', done.text.includes('now done'));

console.log('\n  messaging');
await call('beta', 'send', { text: 'Found a reflected param on /search', to: 'alpha' });
const inbox = await call('alpha', 'inbox');
check('alpha receives the direct message', inbox.text.includes('reflected param'));
check('messages are consumed once', (await call('alpha', 'inbox')).text.includes('No unread'));
check('sender does not receive their own broadcast', (await call('beta', 'inbox')).text.includes('No unread'));
const badTarget = await call('alpha', 'send', { text: 'hi', to: 'gamma' });
check('sending to an unknown agent errors usefully', badTarget.isError && badTarget.text.includes('Known agents'));

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
const fresh = await call('gamma', 'join', { role: 'tester' });
check('the briefing names the agent', fresh.text.includes('You are "gamma"'));
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
const renamed = room.rename('alpha', 'the-mentalist');
check('rename reports what it moved', renamed.ok && renamed.references > 0, JSON.stringify(renamed));
check('the old name is gone', !room.state.agents.alpha);
check('the new name inherits the record', room.state.agents['the-mentalist']?.role === 'static analysis');
check('claimed work follows the rename', room.task(survivor).owner === 'the-mentalist');
check('authored findings follow the rename', room.state.findings.every((f) => f.by !== 'alpha'));
check('message history follows the rename', room.state.messages.every((m) => m.from !== 'alpha' && m.to !== 'alpha'));
const afterRename = await call('the-mentalist', 'board');
check('the renamed agent is recognised on reconnect', afterRename.text.includes('you are "the-mentalist"'));
check('renaming onto a taken name is refused', room.rename('the-mentalist', 'beta').error.includes('already taken'));
check('renaming a stranger is refused', room.rename('nobody', 'x').error.includes('No agent called'));

console.log('\n  old names forward instead of duplicating');
const stale = await call('alpha', 'board');
check('a machine still using the old name is forwarded, not duplicated',
  stale.text.includes('you are "the-mentalist"'), stale.text.slice(0, 90));
check('no empty duplicate is created', !room.state.agents.alpha);
room.rename('the-mentalist', 'reacher');
check('forwarding follows a chain of renames', room.resolveName('alpha') === 'reacher');
const chained = await call('alpha', 'board');
check('the chain works over the wire too', chained.text.includes('you are "reacher"'));
room.rename('beta', 'the-mentalist');
check('a freed name that gets reused stops forwarding', room.resolveName('the-mentalist') === 'the-mentalist');
room.rename('the-mentalist', 'beta');
room.rename('reacher', 'alpha');

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
room.recordEndpoint('zulu', '10.0.0.1');
room.state.agents.zulu.lastSeen = Date.now();
const stolen2 = room.join('zulu', { host: '10.0.0.2' });
check('a second machine cannot take a live name', !stolen2.ok && stolen2.error.includes('already in use'));
check('the refusal says what to do', stolen2.error.includes('different --as name'));
room.state.agents.zulu.lastSeen = Date.now() - 45 * 60_000;
check('the name frees up once that machine goes quiet', room.join('zulu', { host: '10.0.0.2' }).ok);
room.state.agents.zulu.hosts = ['10.0.0.2'];  // tidy up the deliberate collision

console.log('\n  digest');
for (let i = 0; i < 22; i += 1) await call('beta', 'send', { text: `digest filler ${i}` });
const dig = await call('alpha', 'digest');
check('a digest is generated from activity', dig.text.includes('## D') && dig.text.includes('findings standing'));
check('it summarises rather than replays', !dig.text.includes('digest filler 3'));

console.log('\n  identity clash detection');
check('one machine is not a clash', room.recordEndpoint('alpha', 'relay-host') === null);
check('same machine twice is still not a clash', room.recordEndpoint('alpha', 'relay-host') === null);
const clash = room.recordEndpoint('alpha', '192.168.15.31');
check('a second machine using the name is flagged', Array.isArray(clash) && clash.length === 2, JSON.stringify(clash));
check('the clash is listed on the board', room.conflicts()[0]?.name === 'alpha');
const warned = await call('alpha', 'board');
check('agents are warned in the board tool output',
  warned.text.includes('WARNING') && warned.text.includes('192.168.15.31'));
check('the warning names the fix', warned.text.includes('--as name'));
room.state.agents.alpha.hosts = ['relay-host'];
// zulu picked up a second host ('relay-host' from its join call, then the fake
// one in the collision test) — clear it or the board keeps warning about zulu.
room.state.agents.zulu.hosts = ['relay-host'];
check('clearing the extra host clears the warning', !(await call('alpha', 'board')).text.includes('WARNING'));

console.log('\n  dashboard');
const page = await fetch(`${base}/?token=${TOKEN}`);
const pageText = await page.text();
check('dashboard renders', page.status === 200 && pageText.includes('claude-bros'));
check('dashboard ships the seconds-granular heartbeat', pageText.includes('last activity') && pageText.includes('quiet'));
check('dashboard renders message threads', pageText.includes('replyto') && pageText.includes('thread'));

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
const runCli = (args, envHome) => new Promise((resolve) => {
  const child = spawn('node', [cli, ...args], { env: { ...process.env, HOME: envHome } });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, out, err }));
});

const sandbox = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'bros-cli-'));
const j = await runCli(['join', 'http://cli-test.invalid:7777', '--as', 'cliagent', '--token', 't'], sandbox);
let cliCfg = null;
try {
  cliCfg = JSON.parse(fsMod.readFileSync(pathMod.join(sandbox, '.claude-bros', 'config.json'), 'utf8'));
} catch {}
check('join records the real relay URL, not the command name',
  cliCfg?.url === 'http://cli-test.invalid:7777', JSON.stringify(cliCfg));
check('join still passes its --as and --token through', cliCfg?.agent === 'cliagent' && cliCfg?.token === 't');
check('join exits cleanly even when the relay is unreachable', j.code === 0, j.out + j.err);

const sendHome = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'bros-send-'));
fsMod.mkdirSync(pathMod.join(sendHome, '.claude-bros'), { recursive: true });
fsMod.writeFileSync(pathMod.join(sendHome, '.claude-bros', 'config.json'), JSON.stringify({
  url: base, agent: 'clisender', token: TOKEN, role: '', scope: '',
}));
const s = await runCli(['send', 'hello-cli', '--to', 'alpha'], sendHome);
const sentByCli = room.state.messages.find((m) => m.from === 'human' && m.text.includes('hello-cli'));
check('send sends the exact text, no command name prepended',
  s.code === 0 && sentByCli?.text === 'hello-cli', `${s.out} text=${sentByCli?.text}`);
fsMod.rmSync(sandbox, { recursive: true, force: true });
fsMod.rmSync(sendHome, { recursive: true, force: true });

server.close();
console.log(`\n  ${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
