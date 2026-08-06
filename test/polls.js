/**
 * This file used to test poll_create/poll_vote/polls, task_claim collision
 * governance, and the automatic inactivity-kick poll. All of that is retired
 * — the goal/task/poll ceremony carried little of the value agents actually
 * produced on a real engagement, while the evidence (findings, file reviews,
 * submissions) did. Nothing is deleted, though: every record either system
 * ever created moves into `state.archive`, readable by any agent through the
 * read-only `archive` tool. This file now tests that migration and that tool.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room } from '../server/room.js';
import { callTool } from '../server/tools.js';

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

// ------------------------------------------------------------- archive shape

const room = new Room({ name: 'archive-test' });
for (const name of ['alice', 'bob', 'charlie']) check(room.join(name).ok, `${name} joins`);

check('a fresh room starts with an empty, correctly-shaped archive',
  Array.isArray(room.state.archive.tasks) && Array.isArray(room.state.archive.goals)
    && Array.isArray(room.state.archive.polls) && Array.isArray(room.state.archive.digests)
    && Array.isArray(room.state.archive.fences)
    && typeof room.state.archive.env === 'object' && !Array.isArray(room.state.archive.env),
  JSON.stringify(room.state.archive));
check('no top-level legacy collections exist on a fresh room',
  room.state.tasks === undefined && room.state.goals === undefined && room.state.polls === undefined
    && room.state.digests === undefined && room.state.env === undefined && room.state.fences === undefined);

// addTask/addFence remain real internal plumbing (finding_add's creates_task,
// the seed script) even with their MCP tools retired — they write straight
// into the archive.
const assigned = room.addTask('alice', { title: 'orphanable work', assignTo: 'charlie' });
check('addTask still works and lands in the archive, not top-level state',
  room.state.archive.tasks.some((t) => t.id === assigned.id) && room.state.tasks === undefined);
check('task() reads from the archive', room.task(assigned.id)?.id === assigned.id);

const fence = room.addFence('bob', { kind: 'section8_issue', ref: 'agave#1', paths: ['a.rs'] });
check('addFence still works and lands in the archive', room.state.archive.fences.some((f) => f.id === fence.id));
check('fences() reads from the archive, newest published first', room.fences().some((f) => f.ref === 'agave#1'));

// -------------------------------------------------- kicked identities persist
//
// The kick/restore mechanism (poll_create action:agent_kick/agent_restore) is
// gone, but a membershipStatus set by history must keep blocking that
// identity — there is simply no tool left that can lift it.
room.state.agents.charlie.membershipStatus = 'kicked';
room.state.agents.charlie.blockReason = 'removed by a since-retired poll';
check('a historically-kicked identity is still blocked', room.isAgentBlocked('charlie').blocked);
const rejoin = room.join('charlie');
check('a kicked identity still cannot silently rejoin', !rejoin.ok && rejoin.kicked);
const blockedSend = await callTool(room, 'alice', 'send', { to: 'charlie', text: 'still there?' });
check('a kicked identity is still not a valid message recipient', blockedSend.isError);
delete room.state.agents.charlie.membershipStatus;
delete room.state.agents.charlie.blockReason;

// --------------------------------------------------------- the archive tool

const summary = await callTool(room, 'alice', 'archive', {});
check('archive with no kind returns a per-kind summary',
  summary.content[0].text.includes('"tasks": 1') && summary.content[0].text.includes('"fences": 1')
    && summary.content[0].text.includes('"goals": 0'), summary.content[0].text);

const badKind = await callTool(room, 'alice', 'archive', { kind: 'bogus' });
check('archive rejects an unknown kind', badKind.isError && badKind.content[0].text.includes('Unknown archive kind'));

const taskById = await callTool(room, 'alice', 'archive', { kind: 'tasks', id: assigned.id });
check('archive with kind+id returns the single record', taskById.content[0].text.includes(assigned.id));
const missingId = await callTool(room, 'alice', 'archive', { kind: 'tasks', id: 'T999' });
check('archive with an id that does not exist fails usefully', missingId.isError);

const envKind = await callTool(room, 'alice', 'archive', { kind: 'env' });
check('archive with no records yet says so, not an empty array', envKind.content[0].text.includes('No archived environment facts'));
room.state.archive.env.repo = { value: 'agave', by: 'alice', ts: new Date().toISOString() };
const envAfter = await callTool(room, 'alice', 'archive', { kind: 'env' });
check('archive with kind=env returns the fact map, not a list', envAfter.content[0].text.includes('"repo"') && envAfter.content[0].text.includes('agave'));

// Newest-first ordering and the limit clamp.
for (let i = 0; i < 5; i += 1) room.addTask('bob', { title: `task ${i}` });
const limited = await callTool(room, 'alice', 'archive', { kind: 'tasks', limit: 2 });
const limitedIds = [...limited.content[0].text.matchAll(/"id": "(T\d+)"/g)].map((m) => m[1]);
check('archive returns records newest-first', limitedIds[0] > limitedIds[1], JSON.stringify(limitedIds));
check('archive respects the limit parameter', limitedIds.length === 2, JSON.stringify(limitedIds));

// ------------------------------------------------------- retired tools are gone

for (const name of ['task_add', 'task_claim', 'task_update', 'goal_add', 'goal_update', 'goals',
  'poll_create', 'poll_vote', 'polls', 'env_set', 'digest', 'fence_add', 'fences', 'related', 'graph']) {
  const result = await callTool(room, 'alice', name, {});
  check(`${name} is an unknown tool now`, result.isError && result.content[0].text.includes(`Unknown tool "${name}"`));
}

// ------------------------------------------------------ rename touches archive
//
// Task/poll history in the archive still needs to follow a rename — it is
// preserved data, and stale names inside it would be a silent correctness bug.
const ownedTask = room.addTask('alice', { title: 'alice owns this directly', assignTo: 'alice' });
room.state.archive.polls.push({
  id: 'P1', question: 'old question', status: 'passed', createdBy: 'alice',
  eligible: ['alice', 'bob'], votes: { alice: { choice: 'yes', ts: new Date().toISOString() } },
  action: { type: 'task_reassign', taskId: assigned.id, to: 'alice' },
});
check('rename succeeds', room.rename('alice', 'alice-2').ok);
const renamedPoll = room.state.archive.polls.find((p) => p.id === 'P1');
check('archived poll electorate follows the rename', renamedPoll.eligible.includes('alice-2') && !renamedPoll.eligible.includes('alice'));
check('archived poll ballots follow the rename', Boolean(renamedPoll.votes['alice-2']) && !renamedPoll.votes.alice);
check('archived poll action target follows the rename', renamedPoll.action.to === 'alice-2');
check('archived task ownership follows the rename', room.task(ownedTask.id).owner === 'alice-2');
check('archived task creator follows the rename', room.task(assigned.id).createdBy === 'alice-2');
check('forget() still reports ownership sourced from the archive',
  room.forget('alice-2', { force: true }).owns.includes(ownedTask.id));

// ------------------------------------------------------------------ migration
//
// Exactly what a pre-archive relay's data/<room>.json looks like: top-level
// tasks/goals/polls/digests/env/fences, some with malformed ids from an even
// older schema. This must load without error and without losing anything.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bros-archive-migration-'));
const stateFile = path.join(tmp, 'state.json');
const ts = new Date().toISOString();
fs.writeFileSync(stateFile, JSON.stringify({
  room: 'legacy', agents: { legacy: { name: 'legacy', lastSeen: 0 } },
  findings: [], files: {}, messages: [], log: [], aliases: {},
  counters: { message: 0, task: 0, finding: 0, goal: 0, poll: 'bad', seq: 0, fence: 0 },
  tasks: [{ id: 'T1', title: 'old task', status: 'open', history: [] }],
  goals: [{ id: 'broken', title: 'malformed id from an older schema' }],
  polls: [{ id: 'broken', question: 'old poll', votes: null }],
  digests: [{ id: 'D1', ts, fromSeq: 0, toSeq: 2, lines: ['2 messages from legacy'] }],
  env: { repo: { value: 'agave', by: 'legacy', ts } },
  fences: [{ id: 'FN1', kind: 'accepted_report', ref: 'agave#1', paths: ['a.rs'] }],
}), { mode: 0o600 });

const healed = new Room({ name: 'legacy', file: stateFile });
check('migration heals a malformed archived poll id', /^P\d+$/.test(healed.state.archive.polls[0].id));
check('migration heals a malformed archived goal id', /^G\d+$/.test(healed.state.archive.goals[0].id));
check('migration does not touch sound archived ids', healed.state.archive.tasks[0].id === 'T1');
check('the counter heals from a non-numeric value and continues past ids in use',
  Number.isFinite(healed.state.counters.poll) && healed.state.counters.poll >= 1);
check('every legacy record survives the migration, nothing lost',
  healed.state.archive.tasks.length === 1 && healed.state.archive.goals.length === 1
    && healed.state.archive.polls.length === 1 && healed.state.archive.digests.length === 1
    && healed.state.archive.fences.length === 1 && healed.state.archive.env.repo?.value === 'agave');
check('top-level legacy keys are gone once migrated',
  healed.state.tasks === undefined && healed.state.goals === undefined && healed.state.polls === undefined
    && healed.state.digests === undefined && healed.state.env === undefined && healed.state.fences === undefined);

await new Promise((resolve) => setTimeout(resolve, 350)); // let the debounced save land
const reloaded = new Room({ name: 'legacy', file: stateFile });
check('a second load of an already-migrated file does not duplicate anything',
  reloaded.state.archive.tasks.length === 1 && reloaded.state.archive.goals.length === 1
    && reloaded.state.archive.polls.length === 1 && reloaded.state.archive.digests.length === 1
    && reloaded.state.archive.fences.length === 1);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`archive tests passed (${checks} checks)`);
