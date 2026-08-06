/**
 * End-to-end test: speaks real MCP JSON-RPC to a live relay as two agents.
 * Run: node test/smoke.js
 */
import { Room } from '../server/room.js';
import { createServer } from '../server/http.js';
import { callTool } from '../server/tools.js';

const TOKEN = 'testtoken';
const HUMAN_TOKEN = 'human-test-token';
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
const server = createServer({ room, token: TOKEN, humanToken: HUMAN_TOKEN, quiet: true });
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
/**
 * task_add/task_claim are retired MCP tools — task_add's write path (`Room#addTask`)
 * is still real, live internal plumbing (finding_add's `creates_task` uses it), so
 * tests that need a task go straight through it instead of a tool that no longer exists.
 */
const newTask = (agent, args) => room.addTask(agent, args).id;

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
check('tools/list exposes the full surface', tools.result.tools.length === 17, `got ${tools.result.tools.length}`);
const humanToolsRes = await fetch(`${base}/mcp?agent=operator&token=${HUMAN_TOKEN}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
});
const humanTools = await humanToolsRes.json();
check('only the human credential discovers message moderation tools',
  humanTools.result.tools.length === 19
    && ['message_edit', 'message_delete'].every((name) => humanTools.result.tools.some((tool) => tool.name === name))
    && !tools.result.tools.some((tool) => tool.name.startsWith('message_')));
check('every tool has a schema', tools.result.tools.every((t) => t.inputSchema?.type === 'object'));
check('the read-only archive tool is discoverable, retired tools are gone',
  tools.result.tools.some((tool) => tool.name === 'archive')
    && ['task_add', 'task_claim', 'task_update', 'goal_add', 'goal_update', 'goals',
      'poll_create', 'poll_vote', 'polls', 'env_set', 'digest', 'fence_add', 'fences', 'related', 'graph']
      .every((name) => !tools.result.tools.some((tool) => tool.name === name)));
check('monitor heartbeat is discoverable', tools.result.tools.some((tool) => tool.name === 'monitor'));
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
const monitorHeartbeat = await call('alpha', 'monitor', { wait_seconds: 0 });
check('monitor heartbeat reads mail and teaches the next cycle',
  monitorHeartbeat.text.includes('MONITOR CYCLE COMPLETE') && room.state.agents.alpha.protocolSeen === '2026-08-03-monitor-v1');
await call('beta', 'join');
const board = await call('alpha', 'board');
check('alpha sees beta on the board', board.text.includes('beta') && board.text.includes('idle'));

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

const moderationTarget = (await call('beta', 'send', { text: 'draft wording', to: 'alpha' })).text.match(/M\d+/)[0];
const deniedEdit = await fetch(`${base}/api/messages/${moderationTarget}?token=${TOKEN}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'agent tamper' }),
});
check('the shared agent credential cannot edit messages', deniedEdit.status === 403);
const editedMessage = await fetch(`${base}/api/messages/${moderationTarget}?token=${HUMAN_TOKEN}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'approved wording' }),
});
check('the human credential edits without retaining superseded content',
  editedMessage.status === 200
    && room.state.messages.find((m) => m.id === moderationTarget)?.text === 'approved wording'
    && room.state.messages.find((m) => m.id === moderationTarget)?.editedBy === 'human');
const moderatedInbox = await call('alpha', 'inbox');
check('agents see the edited marker and replacement text',
  moderatedInbox.text.includes('edited by human') && moderatedInbox.text.includes('approved wording'));
const deletedMessage = await fetch(`${base}/api/messages/${moderationTarget}`, {
  method: 'DELETE', headers: { 'X-Bros-Human-Token': HUMAN_TOKEN },
});
const tombstone = room.state.messages.find((m) => m.id === moderationTarget);
check('human deletion erases content but retains an audited tombstone',
  deletedMessage.status === 200 && tombstone?.text === '' && tombstone?.deletedBy === 'human' && tombstone?.id === moderationTarget);
const deniedTool = await call('alpha', 'message_delete', { id: mentioned.id });
check('ordinary agents cannot invoke a hidden moderation tool directly',
  deniedTool.isError && deniedTool.text.includes('Human moderation authorization'));
const humanDeleteToolRes = await fetch(`${base}/mcp?agent=operator&token=${HUMAN_TOKEN}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'message_delete', arguments: { id: ghostMention.id } } }),
});
const humanDeleteTool = await humanDeleteToolRes.json();
check('human MCP moderation works without creating a phantom operator agent',
  humanDeleteTool.result.content[0].text.includes(`Deleted ${ghostMention.id}`) && !room.state.agents.operator);

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
const ready = await call('beta', 'submissions');
check('confirmed findings enter the submission queue blocked, not falsely ready',
  ready.text.includes('F1') && ready.text.includes('"state": "blocked"') && ready.text.includes('complete inline PoC'));
check('unverified reproduction is an explicit submission blocker',
  ready.text.includes('finding independently reproduced'));
await call('beta', 'finding_update', {
  id: 'F1',
  repro: 'Create a synthetic order for account B, request it as account A, and observe the cross-account response; second account reproduced the same result.',
});
const refreshedFinding = await call('beta', 'findings');
check('finding reproduction text can be corrected after verification',
  refreshedFinding.text.includes('synthetic order for account B'));
const prematureReport = await call('beta', 'finding_update', {
  id: 'F1', status: 'reported', submission_url: 'https://reports.example/premature',
});
check('a blocked candidate cannot be marked reported',
  prematureReport.isError && prematureReport.text.includes('not submission-ready'));
const submissionDraft = await call('beta', 'submission_update', {
  id: 'F1',
  title: 'Order endpoint exposes another customer’s order',
  summary: 'An authenticated user can read an order owned by another account.',
  details: 'The handler loads the requested order without comparing its owner to the authenticated subject.',
  poc: 'Inline test: create users A and B, create order for B, request /orders/{B_ORDER} as A, and assert the response contains B’s order.',
  impact: 'Authenticated cross-account disclosure of order contents, demonstrated by the inline test.',
  ecosystem: 'Other',
  package_name: 'orders-api',
  affected_versions: 'current master',
  patched_versions: 'none',
  severity: 'high',
  cvss: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N',
  cwe: 'CWE-639',
  commit: '0123456789abcdef0123456789abcdef01234567',
  category: 'direct loss of confidentiality',
  owner: 'human-owner',
  duplicate_check: 'Searched public issues and advisories for the endpoint and ownership failure; no match.',
  master_checked_at: '2026-08-05T16:01:00Z',
  known_issues_checked_at: '2026-08-05T16:02:00Z',
  reproduction_verified: true,
  live_on_master: true,
  inline_poc: true,
  impact_demonstrated: true,
  known_issues_checked: true,
  one_finding: true,
  confidential: true,
  two_factor_verified: true,
  window_verified: true,
});
check('complete Anza fields move a candidate to ready',
  submissionDraft.text.includes('"state": "ready"') && submissionDraft.text.includes('"complete": "19/19"'));
await call('beta', 'finding_add', {
  title: 'Second candidate still missing report gates',
  severity: 'critical',
  target: '/ranked-readiness',
  evidence: 'A separate reproducible candidate intentionally remains incomplete for queue ordering.',
});
await call('alpha', 'finding_update', { id: 'F2', status: 'confirmed', note: 'independently reproduced for ordering test' });
const rankedText = (await call('beta', 'submissions')).text;
const rankedSubmissions = JSON.parse(rankedText.slice(rankedText.lastIndexOf('\n[') + 1));
check('MCP submissions are ranked by readiness, not severity',
  rankedSubmissions[0]?.id === 'F1' && rankedSubmissions[1]?.id === 'F2');
await call('alpha', 'finding_update', {
  id: 'F1', status: 'reported', submission_url: 'https://reports.example/F1',
  submission_note: 'Filed with the program',
});
const reported = await call('beta', 'submissions', { status: 'reported' });
check('reported findings retain submission metadata',
  reported.text.includes('https://reports.example/F1') && reported.text.includes('Filed with the program'));

console.log('\n  advisories & fences');
const advisoryCreate = await call('alpha', 'advisory_upsert', {
  ghsa_id: 'GHSA-test-0001',
  finding_id: 'F1',
  title: 'Order endpoint exposes another customer’s order',
  state: 'closed',
  outcome: 'rejected',
  anza_severity: 'low',
  our_severity: 'high',
  outcome_reason: 'This is intentional / by design.',
  burn_tx: 'testtxsig123',
  burn_sol: 0.5,
  submitted_at: '2026-08-05T18:12:31Z',
});
check('advisory_upsert creates a new advisory', !advisoryCreate.isError && advisoryCreate.text.includes('GHSA-test-0001') && advisoryCreate.text.includes('"outcome": "rejected"'));
const advisoryUpdate = await call('alpha', 'advisory_upsert', { ghsa_id: 'GHSA-test-0001', credit_state: 'confirmed' });
check('advisory_upsert updates by ghsa_id instead of duplicating', advisoryUpdate.text.includes('"creditState": "confirmed"'));
const advisoriesList = await call('beta', 'advisories');
check('advisories lists what was upserted', advisoriesList.text.includes('GHSA-test-0001') && (advisoriesList.text.match(/GHSA-test-0001/g) || []).length === 1);
const missingGhsa = await call('alpha', 'advisory_upsert', {});
check('advisory_upsert requires ghsa_id', missingGhsa.isError);

// fence_add is a retired MCP tool; fences are still real, live data (the
// Findings/Submissions/Advisories collision banners and the false-negative
// cross-check depend on them) — addFence remains callable directly, exactly
// like the seed script uses it.
const fenceCreate = room.addFence('beta', {
  kind: 'section8_issue',
  ref: 'agave#14335',
  url: 'https://github.com/anza-xyz/agave/issues/14335',
  title: 'Reduce the bound of vote ingest in BLS sigverify',
  quote: 'we admit votes from root_slot - 8 to root_slot + 30k.',
  publishedAt: '2026-08-05T12:47:35Z',
  appliesTo: ['F1'],
  paths: ['bls-sigverify/src/bls_sigverifier.rs'],
  note: 'Published before F1 was filed.',
});
check('addFence records a §8 fence with an id', /^FN\d+$/.test(fenceCreate.id) && fenceCreate.ref === 'agave#14335');
check('fences() lists what was added', room.fences().some((f) => f.ref === 'agave#14335' && f.kind === 'section8_issue'));
check('the fence is archived, readable via the archive tool',
  (await call('alpha', 'archive', { kind: 'fences' })).text.includes('agave#14335'));

console.log('\n  finding → task auto-link');
const xssFindingBefore = room.state.findings.length;
await call('beta', 'finding_add', {
  title: 'Stored XSS in the dashboard',
  severity: 'high',
  target: '/dashboard',
  evidence: 'agent message text is injected unescaped',
  creates_task: true,
});
const xssFinding = room.state.findings[xssFindingBefore];
const linkTask = room.state.archive.tasks.find((t) => t.title.includes(`Verify ${xssFinding.id}`));
check('a finding with creates_task spawns a verification task', Boolean(linkTask), JSON.stringify(room.state.archive.tasks));
check('the verification task is assigned to the partner, not the reporter',
  linkTask?.owner === 'alpha', `owner=${linkTask?.owner}`);
check('the finding records its verification task', xssFinding?.verificationTask === linkTask?.id);
check('the auto-created task lives in the archive, readable via the archive tool',
  (await call('alpha', 'archive', { kind: 'tasks', id: linkTask.id })).text.includes(linkTask.id));

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
check('broken ids are regenerated uniquely, now inside the archive',
  new Set(healed.state.archive.goals.map((g) => g.id)).size === 2 && healed.state.archive.goals.every((g) => /^G\d+$/.test(g.id)),
  JSON.stringify(healed.state.archive.goals.map((g) => g.id)));
check('references are re-pointed at the new id', healed.state.archive.tasks[0].goal === healed.state.archive.goals[0].id);
check('sound ids are left alone', healed.state.archive.tasks[1].id === 'T2');
check('the counter continues past ids already in use', healed.state.counters.task >= 2);
check('top-level tasks/goals no longer exist once archived', healed.state.tasks === undefined && healed.state.goals === undefined);
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

console.log('\n  archive migration is idempotent and lossless');
{
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const osMod = await import('node:os');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'bros-archive-'));
  const file = pathMod.join(dir, 'legacy.json');
  const nowTs = new Date().toISOString();
  // Exactly the pre-archive shape the live relay's data/bounty.json is in:
  // top-level tasks/goals/polls/digests/env/fences, 208/37/50/14-scale but
  // small here — the migration path does not care about volume.
  const legacyState = {
    room: 'legacy-archive', agents: {}, findings: [], files: {}, messages: [], log: [], aliases: {},
    counters: { message: 0, task: 0, finding: 0, goal: 0, poll: 0, seq: 0, fence: 0 },
    tasks: [{ id: 'T1', title: 'old task', status: 'open', history: [] }, { id: 'T2', title: 'old task 2', status: 'done', history: [] }],
    goals: [{ id: 'G1', title: 'old goal', status: 'active' }],
    polls: [{ id: 'P1', question: 'old poll', status: 'passed', votes: {}, eligible: ['x'], createdAt: nowTs, updatedAt: nowTs }],
    digests: [{ id: 'D1', ts: nowTs, fromSeq: 0, toSeq: 3, lines: ['3 messages from x'] }],
    env: { repo: { value: 'agave', by: 'x', ts: nowTs }, commit: { value: 'deadbeef', by: 'x', ts: nowTs } },
    fences: [{ id: 'FN1', kind: 'accepted_report', ref: 'agave#1', paths: ['a.rs'] }],
  };
  fsMod.writeFileSync(file, JSON.stringify(legacyState));

  const firstLoad = new Room({ name: 'legacy-archive', file });
  check('migration is lossless: every legacy record survives under archive',
    firstLoad.state.archive.tasks.length === 2 && firstLoad.state.archive.goals.length === 1
      && firstLoad.state.archive.polls.length === 1 && firstLoad.state.archive.digests.length === 1
      && firstLoad.state.archive.fences.length === 1
      && Object.keys(firstLoad.state.archive.env).length === 2,
    JSON.stringify(firstLoad.state.archive));
  check('migrated records keep their original ids and fields verbatim',
    firstLoad.state.archive.fences[0].ref === 'agave#1'
      && firstLoad.state.archive.env.commit.value === 'deadbeef'
      && firstLoad.state.archive.polls[0].status === 'passed');
  check('the top-level legacy keys are gone once migrated',
    firstLoad.state.tasks === undefined && firstLoad.state.goals === undefined
      && firstLoad.state.polls === undefined && firstLoad.state.digests === undefined
      && firstLoad.state.env === undefined && firstLoad.state.fences === undefined);

  await new Promise((resolve) => setTimeout(resolve, 350)); // let the debounced save land
  const secondLoad = new Room({ name: 'legacy-archive', file });
  check('a second load of the already-migrated file does not duplicate records',
    secondLoad.state.archive.tasks.length === 2 && secondLoad.state.archive.goals.length === 1
      && secondLoad.state.archive.polls.length === 1 && secondLoad.state.archive.digests.length === 1
      && secondLoad.state.archive.fences.length === 1
      && Object.keys(secondLoad.state.archive.env).length === 2,
    JSON.stringify(secondLoad.state.archive));

  const readAll = await callTool(firstLoad, 'agent-x', 'archive', {});
  check('archive with no kind returns a per-kind summary',
    readAll.content[0].text.includes('"tasks": 2') && readAll.content[0].text.includes('"goals": 1')
      && readAll.content[0].text.includes('"env": 2'), readAll.content[0].text);
  const readTasks = await callTool(firstLoad, 'agent-x', 'archive', { kind: 'tasks' });
  check('archive with kind=tasks returns the archived task records',
    readTasks.content[0].text.includes('T1') && readTasks.content[0].text.includes('T2'));
  const readOne = await callTool(firstLoad, 'agent-x', 'archive', { kind: 'fences', id: 'FN1' });
  check('archive with kind and id returns a single record', readOne.content[0].text.includes('agave#1'));
  const readEnv = await callTool(firstLoad, 'agent-x', 'archive', { kind: 'env' });
  check('archive with kind=env returns the fact map, not a list', readEnv.content[0].text.includes('deadbeef'));
  const badKind = await callTool(firstLoad, 'agent-x', 'archive', { kind: 'bogus' });
  check('archive rejects an unknown kind', badKind.isError);

  fsMod.rmSync(dir, { recursive: true, force: true });
}

console.log('\n  join briefing');
const fresh = await call('gamma', 'join');
check('the briefing names the agent', fresh.text.includes('You are exactly "gamma"'));
check('the briefing makes connection identity authoritative',
  fresh.text.includes('sole source of truth') && fresh.text.includes('relay migrations'));
check('it lists an ordered set of next actions', fresh.text.includes('## DO THESE NOW, IN ORDER'));
check('it teaches the working protocol', ['FILES', 'FINDINGS', 'MONITOR', 'ARCHIVE'].every((s) => fresh.text.includes(s)));
check('it points retired systems at the read-only archive tool',
  fresh.text.includes('retired') && fresh.text.includes('archive'));
check('it carries the ground rules', fresh.text.includes('authorizes') && fresh.text.includes('live-fire'));
check('the full board follows the briefing', fresh.text.includes('# Board:'));

check('a human posting via REST does not join the roster', await (async () => {
  await fetch(`${base}/api/send?token=${HUMAN_TOKEN}`, {
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
check('coverage appears on the board agents read', boardWithAll.text.includes('## File coverage'), '');
await call('alpha', 'finding_add', { title: 'Cert reuse', severity: 'high', target: 'votor/src/consensus_pool.rs:412',
  evidence: 'the same certificate is accepted twice across epoch boundaries' });
check('findings auto-link to the file they name',
  room.state.files['votor/src/consensus_pool.rs'].findings.length === 1);

console.log('\n  hook endpoint');
await call('alpha', 'inbox'); // drain everything accumulated above so the count below is exact
await call('beta', 'send', { text: 'one more thing', to: 'alpha' });
const unread = await (await fetch(`${base}/api/unread?agent=alpha&token=${TOKEN}`)).json();
check('the Stop hook can see pending mail', unread.count === 1 && unread.messages[0].text === 'one more thing');
const stillThere = await (await fetch(`${base}/api/unread?agent=alpha&token=${TOKEN}`)).json();
check('peeking does not consume mail', stillThere.count === 1);

console.log('\n  rename');
// task_claim is a retired tool; addTask can still assign directly (as
// finding_add's creates_task does), which is enough to prove a rename
// carries ownership through the archive.
const survivor = newTask('alpha', { title: 'Task that must survive a rename', assignTo: 'alpha' });
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

console.log('\n  shared-brain graph (module intact; graph/related MCP tools retired)');
{
  // graph.js itself is untouched — only the `graph`/`related` MCP tools (and
  // the /graph web page) that exposed it to agents are gone. state.tasks/
  // state.goals no longer exist (archived), so it now degrades gracefully to
  // agent/file/finding nodes instead of erroring.
  const { buildGraph, relatedTo } = await import('../server/graph.js');
  const g = buildGraph(room.state);
  check('the graph still has a node per non-archived entity',
    g.nodes.some((n) => n.type === 'agent') && g.nodes.some((n) => n.type === 'finding') && g.nodes.some((n) => n.type === 'file'));
  check('it degrades gracefully with no task/goal nodes, rather than erroring',
    !g.nodes.some((n) => n.type === 'task') && !g.nodes.some((n) => n.type === 'goal'));
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

  const rel = relatedTo(room.state, 'votor/src/prose_target.rs', 1);
  check('relatedTo() still walks the graph directly', rel.neighbours.length > 0, JSON.stringify(rel?.start));
  check('the graph/related tools are gone from the MCP surface',
    (await call('alpha', 'related', { id: 'votor/src/prose_target.rs' })).text.includes('Unknown tool')
      && (await call('alpha', 'graph', {})).text.includes('Unknown tool'));
}

console.log('\n  dashboard');
const page = await fetch(`${base}/?token=${TOKEN}`);
const pageText = await page.text();
check('dashboard renders', page.status === 200 && pageText.includes('claude-bros'));
check('dashboard client script parses in a browser', (() => {
  const script = pageText.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  try { new Function(script); return true; } catch { return false; }
})());
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
check('dashboard separates standing findings from a rejected archive', pageText.includes('Standing &amp; actionable') && pageText.includes('Rejected'));
check('dashboard has a first-class submissions section',
  pageText.includes('<h2>Submissions</h2>') && pageText.includes('Ready to submit')
    && pageText.includes('Needs report work') && pageText.includes('Submitted'));
check('submission queues are bounded, scrollable, and open complete modal reports',
  pageText.includes('class="submission-list"') && pageText.includes('max-height:360px')
    && pageText.includes('role="dialog"') && pageText.includes('data-submission-id')
    && pageText.includes("modalField('PoC / reproduction'")
    && pageText.includes("modalField('RULES.md category'"));
check('submissions are explicitly ranked by readiness before severity',
  pageText.includes('ranked by readiness') && pageText.includes('readinessScore(b) - readinessScore(a)')
    && pageText.includes('candidateRanking.forEach'));
check('live refresh preserves selection, modal, scroll and focus state',
  pageText.includes('hasDashboardSelection()') && pageText.includes('captureRenderState()')
    && pageText.includes('restoreRenderState(renderState)')
    && pageText.includes('modalScroll') && pageText.includes('data-preserve-scroll'));
check('dashboard separates removed identities from current members',
  pageText.includes('Current members') && pageText.includes('Removed identities'));
check('dashboard distinguishes MCP client implementation from agent role',
  pageText.includes('Client: ') && pageText.includes('a.client.title || a.client.name'));
check('the retired Goals/Tasks/Polls/Digest/§8-fences panels are gone from the dashboard',
  !pageText.includes('<h2>Goals</h2>') && !pageText.includes('<h2>Tasks</h2>')
    && !pageText.includes('Polls — team decisions') && !pageText.includes('Digest — what got decided')
    && !pageText.includes('§8 fences') && !pageText.includes('<h2>Shared environment</h2>')
    && !pageText.includes('class="env-row"'));
check('the Agents panel is compact — presence and a one-line status, no task lists',
  pageText.includes('Agents — live heartbeat') && pageText.includes('status-line')
    && !pageText.includes('built/completed') && !pageText.includes('no claimed task'));
check('the false-negative cross-check panel (fed by archived fences) is still present',
  pageText.includes('Cleared files with accepted bugs') && pageText.includes('acceptedFences'));
check('coverage is a searchable full-width ledger', pageText.includes('coverage-filter') && pageText.includes('data-coverage-row'));
check('dashboard renders message threads', pageText.includes('replyto') && pageText.includes('thread'));
check('dashboard gives traffic a tall viewport and Markdown renderer',
  pageText.includes('traffic-section') && pageText.includes('const markdown') && pageText.includes('max-height:none'));
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

console.log('\n  false-negative cross-check (derived, client-rendered)');
// The exact false negative that hit block_id_repair_service.rs: five agents
// call a file "clean", then Anza credits an OTHER hunter's accepted report
// in that same path. Seed that scenario plus one ordinary clean file that is
// NOT fenced, so a false positive would also be caught.
for (const reviewer of ['reviewer-1', 'reviewer-2', 'reviewer-3', 'reviewer-4', 'reviewer-5']) {
  room.reviewFile(reviewer, {
    path: 'core/src/repair/block_id_repair_service.rs',
    verdict: 'clean',
    note: `${reviewer}: audited proof size handling, looks fine.`,
  });
}
room.reviewFile('reviewer-1', { path: 'core/src/banking_stage.rs', verdict: 'clean', note: 'nothing unusual.' });
const crossCheckFence = room.addFence('beta', {
  kind: 'accepted_report',
  ref: 'agave#99999',
  url: 'https://github.com/anza-xyz/agave/pull/99999',
  title: 'block id repair: enforce strict proof size check',
  quote: 'A bug bounty report showed the responder could shorten the proof.',
  paths: ['core/src/repair/block_id_repair_service.rs'],
  note: 'Competitor report ACCEPTED — do not rework.',
});
const crossCheckState = await (await fetch(`${base}/api/state?token=${TOKEN}`)).json();
check('the fenced path and its 5 clean reviews are both live on /api/state',
  crossCheckState.fences.some((f) => f.ref === 'agave#99999')
    && crossCheckState.files['core/src/repair/block_id_repair_service.rs']?.reviews.filter((r) => r.verdict === 'clean').length === 5);
// Run the ACTUAL shipped cross-check — extracted verbatim out of the
// dashboard's client script, not a re-implementation — against that live
// data, exactly as the dashboard's tick() does before writing #contradictions.
const pathsMatchSrc = pageText.match(/const pathsMatch = \(a, b\) => \{[\s\S]*?\n\};/)?.[0] || '';
const contradictionSrc = pageText.match(/const acceptedFences = fences\.filter[\s\S]*?: empty\('No contradictions[^']*'\);/)?.[0] || '';
check('extracted the real pathsMatch() and false-negative scan source from the shipped dashboard',
  Boolean(pathsMatchSrc) && Boolean(contradictionSrc),
  `pathsMatch ${pathsMatchSrc.length} chars, scan ${contradictionSrc.length} chars`);
const runContradictionScan = new Function('files', 'fences', 'esc', 'empty', `
  ${pathsMatchSrc}
  ${contradictionSrc.replace("el('contradictions').innerHTML =", 'var html =')}
  return html;
`);
const contradictionHtml = runContradictionScan(
  Object.values(crossCheckState.files), crossCheckState.fences,
  (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])),
  (msg) => `<div class="empty">${msg}</div>`,
);
check('cleared-files cross-check flags block_id_repair_service.rs with all 5 reviewers and the accepted-report fence',
  contradictionHtml.includes('core/src/repair/block_id_repair_service.rs')
    && contradictionHtml.includes('reviewer-1, reviewer-2, reviewer-3, reviewer-4, reviewer-5')
    && contradictionHtml.includes('agave#99999')
    && (contradictionHtml.match(/contradiction-item/g) || []).length === 1,
  contradictionHtml.slice(0, 200));
check('cleared-files cross-check does not false-positive on an unfenced clean file',
  !contradictionHtml.includes('banking_stage.rs'));
check('empty state reads exactly "No contradictions — cleared files are holding."',
  runContradictionScan([], [], (s) => s, (msg) => msg) === 'No contradictions — cleared files are holding.');

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
const previousHumanToken = process.env.BROS_HUMAN_TOKEN;
process.env.BROS_HUMAN_TOKEN = HUMAN_TOKEN;
const s = await runCli(['send', 'hello-cli', '--to', 'alpha'], sendHome, sendHome);
if (previousHumanToken === undefined) delete process.env.BROS_HUMAN_TOKEN;
else process.env.BROS_HUMAN_TOKEN = previousHumanToken;
const sentByCli = room.state.messages.find((m) => m.from === 'human' && m.text.includes('hello-cli'));
check('send sends the exact text, no command name prepended',
  s.code === 0 && sentByCli?.text === 'hello-cli', `${s.out} text=${sentByCli?.text}`);
fsMod.rmSync(sandbox, { recursive: true, force: true });
fsMod.rmSync(sendHome, { recursive: true, force: true });

server.close();
console.log(`\n  ${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
