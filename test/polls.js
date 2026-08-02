import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room } from '../server/room.js';

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const room = new Room({ name: 'poll-test' });
for (const name of ['alice', 'bob', 'charlie']) check(room.join(name).ok, `${name} joins`);

// A kick is limited to inactive agents, excludes its target from voting, and
// needs two-thirds approval. Historical ownership remains in task history.
const assigned = room.addTask('alice', { title: 'orphanable work', assignTo: 'charlie' });
let result = room.createPoll('alice', {
  question: 'Kick Charlie while Charlie is online?',
  action: { type: 'agent_kick', agent: 'charlie' },
});
check(!result.ok && /online/.test(result.error), 'cannot propose kicking an online agent');
room.state.agents.charlie.lastSeen = 0;
result = room.createPoll('alice', {
  question: 'Remove inactive Charlie and release the claim?',
  reason: 'Charlie has stopped responding.',
  action: { type: 'agent_kick', agent: 'charlie' },
});
check(result.ok, 'inactive kick poll created');
const kickId = result.poll.id;
assert.deepEqual(result.poll.eligible, ['alice', 'bob']); checks += 1;
assert.equal(result.poll.quorum, 2); checks += 1;
assert.equal(result.poll.requiredYes, 2); checks += 1;
check(room.votePoll('alice', kickId, 'yes').ok, 'first kick vote accepted');
result = room.votePoll('alice', kickId, 'yes');
check(!result.ok && result.duplicate, 'duplicate vote rejected');
result = room.votePoll('bob', kickId, 'yes');
check(result.ok && result.poll.status === 'passed', 'two-thirds kick poll passes');
assert.equal(room.state.agents.charlie.membershipStatus, 'kicked'); checks += 1;
assert.equal(room.task(assigned.id).owner, null); checks += 1;
assert.equal(room.task(assigned.id).lastOwner, 'charlie'); checks += 1;
check(room.task(assigned.id).history.some((entry) => /attribution preserved/.test(entry.what)), 'kick preserves ownership attribution');
check(room.isAgentBlocked('charlie').blocked, 'kicked agent is blocked');
check(!room.claimTask('charlie', assigned.id).ok, 'kicked identity cannot claim tasks');
check(!room.updateTask('charlie', assigned.id, { notes: 'should not land' }).ok, 'kicked identity cannot update tasks');
result = room.join('charlie');
check(!result.ok && result.kicked, 'kicked identity cannot silently rejoin');

// Restoration itself is explicit governance, after which the same historical
// identity can reconnect rather than being replaced with a blank roster row.
result = room.createPoll('alice', {
  question: 'Restore Charlie?',
  action: { type: 'agent_restore', agent: 'charlie' },
});
check(result.ok && result.poll.eligible.length === 2, 'restore poll excludes kicked voters');
const restoreId = result.poll.id;
room.votePoll('alice', restoreId, 'yes');
result = room.votePoll('bob', restoreId, 'yes');
check(result.poll.status === 'passed', 'restore poll passed');
check(!room.isAgentBlocked('charlie').blocked, 'restored identity unblocked');
check(room.join('charlie').ok, 'restored identity can rejoin');

// Task changes are applied exactly once when the strict-majority threshold is
// reached. Closing cannot be used to truncate an undecided vote.
result = room.createPoll('alice', {
  question: 'Assign the abandoned task to Bob?',
  action: { type: 'task_reassign', taskId: assigned.id, to: 'bob' },
});
const reassignId = result.poll.id;
assert.equal(result.poll.requiredYes, 2); checks += 1;
result = room.closePoll('alice', reassignId);
check(!result.ok && result.pending, 'undecided poll cannot be closed early');
room.votePoll('alice', reassignId, 'yes');
result = room.votePoll('bob', reassignId, 'yes');
check(result.poll.status === 'passed', 'task reassignment passes');
assert.equal(room.task(assigned.id).owner, 'bob'); checks += 1;
assert.equal(room.task(assigned.id).status, 'claimed'); checks += 1;
assert.equal(room.task(assigned.id).history.filter((entry) => entry.what.includes(`reassigned by poll ${reassignId}`)).length, 1); checks += 1;
check(room.closePoll('alice', reassignId).alreadyClosed, 'closing a finished poll is idempotent');

result = room.createPoll('bob', {
  question: 'Release the task again?',
  action: { type: 'task_release', taskId: assigned.id },
});
const releaseId = result.poll.id;
room.votePoll('alice', releaseId, 'yes');
room.votePoll('bob', releaseId, 'yes');
assert.equal(room.task(assigned.id).owner, null); checks += 1;
assert.equal(room.task(assigned.id).status, 'open'); checks += 1;

// Eligibility is a creation-time snapshot. Abstentions count toward quorum but
// not approval, and a result rejects once approval is mathematically impossible.
result = room.createPoll('alice', { question: 'Adopt a new convention?' });
const rejectedId = result.poll.id;
room.join('dave');
result = room.votePoll('dave', rejectedId, 'yes');
check(!result.ok && /not eligible/.test(result.error), 'late join cannot move poll electorate');
room.votePoll('alice', rejectedId, 'no');
result = room.votePoll('bob', rejectedId, 'no');
check(result.poll.status === 'rejected', 'poll rejects once threshold is unreachable after quorum');
assert.equal(room.listPolls('open').length, 0); checks += 1;
check(room.listPolls('passed').length >= 3, 'poll list filters by status');
check(room.board('alice').polls.recent.some((poll) => poll.id === rejectedId), 'board exposes recent poll decisions');

// Renaming preserves voter identity and agent references inside poll history.
result = room.createPoll('alice', {
  question: 'Restore ownership to Charlie?',
  action: { type: 'task_reassign', taskId: assigned.id, to: 'charlie' },
});
const renamePollId = result.poll.id;
room.votePoll('alice', renamePollId, 'yes');
check(room.rename('alice', 'alice-2').ok, 'agent rename succeeds');
const renamedPoll = room.poll(renamePollId);
check(renamedPoll.eligible.includes('alice-2') && !renamedPoll.eligible.includes('alice'), 'poll electorate follows rename');
check(Boolean(renamedPoll.votes['alice-2']) && !renamedPoll.votes.alice, 'cast ballot follows rename');

// A malformed record from an early/draft schema is repaired without dropping
// data, and the poll counter advances beyond IDs already on disk.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bros-polls-'));
const stateFile = path.join(tmp, 'state.json');
fs.writeFileSync(stateFile, JSON.stringify({
  room: 'legacy',
  agents: { legacy: { name: 'legacy', lastSeen: 0 } },
  polls: [{ id: 'broken', question: 'Old question', votes: null }],
  counters: { poll: 'bad' },
}), { mode: 0o600 });
const healed = new Room({ name: 'legacy', file: stateFile });
assert.equal(healed.state.polls.length, 1); checks += 1;
assert.match(healed.state.polls[0].id, /^P\d+$/); checks += 1;
assert.deepEqual(healed.state.polls[0].votes, {}); checks += 1;
assert.deepEqual(healed.state.polls[0].eligible, ['legacy']); checks += 1;
result = healed.createPoll('legacy', { question: 'New question' });
check(result.ok && Number(result.poll.id.slice(1)) > Number(healed.state.polls[0].id.slice(1)), 'healed counter does not collide');

const durableFile = path.join(tmp, 'durable.json');
const durable = new Room({ name: 'durable', file: durableFile });
durable.join('voter');
const durablePoll = durable.createPoll('voter', { question: 'Survive a relay restart?' });
durable.votePoll('voter', durablePoll.poll.id, 'yes');
await new Promise((resolve) => setTimeout(resolve, 350));
const reloaded = new Room({ name: 'durable', file: durableFile });
const afterRestart = reloaded.poll(durablePoll.poll.id);
check(afterRestart?.status === 'passed', 'poll and decision survive a file-backed restart');
assert.equal(afterRestart.tally.yes, 1); checks += 1;
assert.equal(fs.statSync(durableFile).mode & 0o777, 0o600); checks += 1;

console.log(`poll tests passed (${checks} checks)`);
