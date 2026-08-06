import fs from 'node:fs';
import path from 'node:path';

const ONLINE_WINDOW_MS = 90_000;
const STATUS_STALE_MS = 5 * 60_000;      // a status older than this is not "what they are doing"
// an owner silent this long no longer holds their claim — tunable via BROS_CLAIM_STALE_MS (ms)
const claimStaleMs = () => Number(process.env.BROS_CLAIM_STALE_MS) || 30 * 60_000;
// Inactive membership is a team decision, not an automatic deletion. After
// this window the relay opens a kick poll for active teammates to decide.
const kickCandidateMs = () => Number(process.env.BROS_KICK_CANDIDATE_MS) || 30 * 60_000;
const KICK_REJECTED_COOLDOWN_MS = 24 * 60 * 60_000;
const DEDUP_WINDOW_MS = 5 * 60_000;      // identical text from one agent inside this window is a repeat
const COLLISION_GRACE_MS = 30 * 60_000;  // a name is free again once its machine has been silent this long
const DIGEST_EVERY_MESSAGES = 20;
const DIGEST_EVERY_MS = 15 * 60_000;
const MAX_MESSAGES = 1000;
const MAX_LOG = 500;

const nowIso = () => new Date().toISOString();

/**
 * The shared brain. One Room = one collaboration session between agents.
 * Single-threaded Node means every mutation below is already atomic with
 * respect to the others, which is what makes task claiming safe.
 */
export class Room {
  constructor({ name, file, persistence = null }) {
    this.name = name;
    this.file = file;
    this.persistence = persistence;
    this.waiters = [];
    this.saveTimer = null;
    // Bumped on every mutation. Lets the HTTP layer cache a serialised response
    // and answer an unchanged poll with 304 instead of re-sending the board.
    this.version = 1;
    this.state = {
      room: name,
      createdAt: nowIso(),
      agents: {},
      messages: [],
      tasks: [],
      findings: [],
      goals: [],
      polls: [],
      files: {},
      env: {},
      digests: [],
      log: [],
      aliases: {},
      advisories: [],
      fences: [],
      counters: { message: 0, task: 0, finding: 0, goal: 0, poll: 0, seq: 0, fence: 0 },
    };
    // Synchronous load for file-based or pure in-memory (used by tests);
    // async init() for PostgreSQL
    if (!persistence) {
      this.#loadSync();
    }
  }

  #loadSync() {
    // Pure in-memory (file is null/undefined) - just initialize empty state
    if (!this.file) return;
    if (!fs.existsSync(this.file)) return;
    try {
      const disk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...this.state, ...disk, counters: { ...this.state.counters, ...(disk.counters || {}) } };
      this.#repairIds();
      this.#resetPresence();
    } catch (err) {
      console.error(`[bros] could not read ${this.file}, starting fresh:`, err.message);
    }
  }

  async init() {
    // If persistence layer provided (PostgreSQL), use it
    if (this.persistence?.load) {
      const state = await this.persistence.load(this.name);
      if (state) {
        this.state = { ...this.state, ...state, counters: { ...this.state.counters, ...(state.counters || {}) } };
        this.#repairIds();
        this.#resetPresence();
        return this;
      }
    }
    // Fallback to file-based. No file at all means in-memory (tests) — there is
    // nothing to read, and readFileSync(null) would throw.
    if (!this.file || !fs.existsSync(this.file)) return this;
    try {
      const disk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...this.state, ...disk, counters: { ...this.state.counters, ...(disk.counters || {}) } };
      this.#repairIds();
      this.#resetPresence();
    } catch (err) {
      console.error(`[bros] could not read ${this.file}, starting fresh:`, err.message);
    }
    return this;
  }

  /**
   * Presence is process-local, not historical board data. A saved host says
   * only where an identity connected before the last restart; retaining it
   * makes a restored or migrated board report false name clashes as soon as
   * the same agent reaches the new relay. Active endpoints repopulate this on
   * their next request, so real simultaneous collisions are still detected.
   */
  #resetPresence() {
    for (const agent of Object.values(this.state.agents)) {
      agent.lastSeen = 0;
      agent.hosts = [];
    }
  }

  save() {
    this.version += 1;
    // Persistence layer (PostgreSQL). Debounced like the file path, because a
    // busy board mutates several times per tool call and each write ships the
    // whole document. The promise is always caught — an unhandled rejection
    // from a DB blip would take the relay down.
    if (this.persistence?.save) {
      if (this.saveTimer) return;
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, 250);
      this.saveTimer.unref?.();
      return;
    }
    // Fallback to file-based
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        // The board can contain embargoed findings and agent messages. Keep
        // every atomic replacement private instead of inheriting umask 022.
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('[bros] save failed:', err.message);
      }
    }, 250);
    this.saveTimer.unref?.();
  }

  /**
   * Heal a state file written by an older version: reset any counter that is
   * not a finite number, re-id anything that got a broken id, and move each
   * counter past the highest id actually in use so nothing collides.
   */
  #repairIds() {
    // These collections did not all exist in early state files. Be deliberately
    // conservative here: a missing collection is healed, while existing audit
    // history is never discarded.
    let healed = 0;
    for (const key of ['messages', 'tasks', 'findings', 'goals', 'polls', 'digests', 'log', 'advisories', 'fences']) {
      if (!Array.isArray(this.state[key])) { this.state[key] = []; healed += 1; }
    }
    if (!this.state.agents || typeof this.state.agents !== 'object' || Array.isArray(this.state.agents)) { this.state.agents = {}; healed += 1; }
    if (!this.state.files || typeof this.state.files !== 'object' || Array.isArray(this.state.files)) { this.state.files = {}; healed += 1; }
    if (!this.state.aliases || typeof this.state.aliases !== 'object' || Array.isArray(this.state.aliases)) { this.state.aliases = {}; healed += 1; }
    if (!this.state.counters || typeof this.state.counters !== 'object') { this.state.counters = {}; healed += 1; }

    const kinds = [
      ['goal', 'G', this.state.goals, (from, to) => this.state.tasks.forEach((t) => { if (t.goal === from) t.goal = to; })],
      ['task', 'T', this.state.tasks, null],
      ['finding', 'F', this.state.findings, (from, to) => {
        Object.values(this.state.files).forEach((f) => {
          f.findings = (f.findings || []).map((id) => (id === from ? to : id));
        });
        this.state.fences.forEach((fence) => {
          if (Array.isArray(fence.appliesTo)) fence.appliesTo = fence.appliesTo.map((id) => (id === from ? to : id));
        });
      }],
      ['message', 'M', this.state.messages, null],
      ['poll', 'P', this.state.polls, null],
      ['fence', 'FN', this.state.fences, null],
    ];

    let repaired = 0;
    for (const [kind, prefix, items, relink] of kinds) {
      if (!Number.isFinite(this.state.counters[kind])) this.state.counters[kind] = 0;
      const list = items || [];
      // Highest sound id first, so regenerated ids continue past it.
      for (const item of list) {
        const n = Number.parseInt(String(item.id ?? '').slice(prefix.length), 10);
        if (Number.isFinite(n)) this.state.counters[kind] = Math.max(this.state.counters[kind], n);
      }
      for (const item of list) {
        const n = Number.parseInt(String(item.id ?? '').slice(prefix.length), 10);
        if (Number.isFinite(n)) continue;
        const from = item.id;
        this.state.counters[kind] += 1;
        item.id = `${prefix}${this.state.counters[kind]}`;
        relink?.(from, item.id);
        repaired += 1;
      }
    }
    // Messages written before sequencing existed have no seq, so catch-up and
    // digests would skip the entire history. Number them in order, once.
    let numbered = 0;
    let seq = Number.isFinite(this.state.counters.seq) ? this.state.counters.seq : 0;
    for (const m of this.state.messages) {
      if (Number.isFinite(m.seq)) { seq = Math.max(seq, m.seq); continue; }
      seq += 1;
      m.seq = seq;
      numbered += 1;
    }
    this.state.counters.seq = seq;

    // Polls initially shipped after the rest of the board schema. Heal the
    // few fields required to evaluate old/draft records deterministically.
    for (const poll of this.state.polls) {
      if (!poll.votes || typeof poll.votes !== 'object' || Array.isArray(poll.votes)) { poll.votes = {}; healed += 1; }
      if (!Array.isArray(poll.eligible)) { poll.eligible = Object.keys(this.state.agents).filter((name) => !this.#isKicked(name)); healed += 1; }
      if (!poll.status) { poll.status = 'open'; healed += 1; }
      if (!poll.createdAt) { poll.createdAt = nowIso(); healed += 1; }
      if (!poll.updatedAt) { poll.updatedAt = poll.createdAt; healed += 1; }
      poll.quorum = this.#pollQuorum(poll);
      poll.requiredYes = this.#pollRequiredYes(poll);
    }
    for (const task of this.state.tasks) {
      if (!Array.isArray(task.participants)) {
        task.participants = [...new Set([
          task.owner,
          task.lastOwner,
          ...(task.history || []).filter((entry) => entry.what === 'claimed').map((entry) => entry.who),
        ].filter(Boolean))];
        healed += 1;
      }
    }

    if (repaired || numbered || healed) {
      const parts = [];
      if (repaired) parts.push(`${repaired} malformed id(s)`);
      if (numbered) parts.push(`${numbered} unsequenced message(s)`);
      if (healed) parts.push(`${healed} malformed state field(s)`);
      console.log(`[bros] migrated ${parts.join(' and ')} from an older state file`);
      this.save();
    }
  }

  /**
   * Write immediately rather than on the debounce. Used on shutdown, where a
   * pending timer would otherwise be lost with the process.
   */
  async flush() {
    if (!this.persistence?.save) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await this.persistence.save(this.name, this.state);
    } catch (err) {
      console.error('[bros] state save failed:', err.message);
    }
  }

  #id(kind, prefix) {
    this.state.counters[kind] += 1;
    return `${prefix}${this.state.counters[kind]}`;
  }

  // ---------------------------------------------------------------- agents

  touch(name) {
    if (!name) return null;
    const agent = (this.state.agents[name] ||= {
      name,
      status: 'idle',
      joinedAt: nowIso(),
      lastSeen: 0,
    });
    agent.lastSeen = Date.now();
    this.save();
    return agent;
  }

  recordClient(name, clientInfo = {}, protocolVersion = null) {
    const agent = this.touch(name);
    if (!agent) return null;
    const next = {
      name: String(clientInfo.name || 'unknown'),
      ...(clientInfo.title ? { title: String(clientInfo.title) } : {}),
      ...(clientInfo.version ? { version: String(clientInfo.version) } : {}),
      ...(protocolVersion ? { protocolVersion: String(protocolVersion) } : {}),
    };
    if (JSON.stringify(agent.client) !== JSON.stringify(next)) {
      agent.client = next;
      this.save();
    }
    return agent;
  }

  join(name, { host = null } = {}) {
    // Two machines under one name is the worst failure mode: statuses overwrite
    // and neither side can message the other. Refuse rather than warn, unless
    // the machine holding the name has gone quiet long enough to be gone.
    const existing = this.state.agents[name];
    if (existing?.membershipStatus === 'kicked') {
      return {
        ok: false,
        kicked: true,
        error: `"${name}" was removed by collaboration poll ${existing.kickedByPoll || ''}. `
          + 'A passed restore poll is required before this identity can rejoin.',
      };
    }
    if (existing && host) {
      const others = (existing.hosts || []).filter((h) => h !== host);
      const quietFor = Date.now() - (existing.lastSeen || 0);
      if (others.length && quietFor < COLLISION_GRACE_MS) {
        return {
          ok: false,
          collision: true,
          error:
            `"${name}" is already in use from ${others.join(', ')} and was active ` +
            `${Math.round(quietFor / 60000)} min ago. Pick a different --as name — two machines sharing ` +
            'one identity cannot see each other. (The name frees up after 30 min of silence.)',
        };
      }
    }
    const fresh = !this.state.agents[name];
    const agent = this.touch(name);
    // Reading the briefing is what `join` is for; record that it happened so
    // agents that arrived before the briefing existed can be nagged into it.
    agent.briefedAt = nowIso();
    if (fresh) this.note(name, 'joined');
    this.save();
    return { ok: true, agent };
  }

  setStatus(name, status) {
    const agent = this.touch(name);
    agent.status = status;
    agent.statusAt = Date.now();
    this.save();
    return agent;
  }

  /** True when an agent has not said what it is doing recently enough to trust. */
  statusStale(name) {
    const agent = this.state.agents[name];
    if (!agent) return false;
    return Date.now() - (agent.statusAt || 0) > STATUS_STALE_MS;
  }

  /**
   * Two machines using the same agent name look like one agent, silently — the
   * board shows a single row and neither side realises they are talking to
   * themselves. Track where each name connects from so that is impossible to miss.
   */
  recordEndpoint(name, host) {
    const agent = this.state.agents[name];
    if (!agent || !host) return null;
    agent.hosts ||= [];
    if (!agent.hosts.includes(host)) {
      agent.hosts.push(host);
      this.save();
    }
    return agent.hosts.length > 1 ? agent.hosts : null;
  }

  /** Names that are being used from more than one machine. */
  conflicts() {
    return Object.values(this.state.agents)
      .filter((a) => (a.hosts || []).length > 1)
      .map((a) => ({ name: a.name, hosts: a.hosts }));
  }

  roster() {
    return Object.values(this.state.agents).map((record) => {
      // role/scope may exist in restored pre-task-model state. Keep them on
      // disk for lossless migration, but never expose them as current identity.
      const { role: _legacyRole, scope: _legacyScope, ...a } = record;
      const taken = this.state.tasks.filter((task) => (task.participants || []).includes(a.name)
        || task.owner === a.name || task.lastOwner === a.name
        || (task.history || []).some((entry) => entry.who === a.name && entry.what === 'claimed'));
      return {
        ...a,
        currentTasks: taken.filter((task) => task.owner === a.name && ['claimed', 'blocked'].includes(task.status))
          .map((task) => ({ id: task.id, title: task.title, status: task.status })),
        tasksTaken: taken.map((task) => task.id),
        completedTasks: taken.filter((task) => task.status === 'done')
          .map((task) => ({ id: task.id, title: task.title, notes: task.notes || '' })),
        online: a.membershipStatus !== 'kicked' && Date.now() - (a.lastSeen || 0) < ONLINE_WINDOW_MS,
        statusAgeMs: Date.now() - (a.statusAt || 0),
        statusStale: Date.now() - (a.statusAt || 0) > STATUS_STALE_MS,
        lastSeenAgo: a.lastSeen ? `${Math.round((Date.now() - a.lastSeen) / 1000)}s ago` : 'never',
      };
    });
  }

  // -------------------------------------------------------------- messages

  send(from, { to = 'all', text, urgent = false, replyTo = null }) {
    // A relay blip makes a client resend; identical text from one agent inside
    // the window is that, not a second thought.
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    const repeat = this.state.messages.find(
      (m) => m.from === from && m.to === to && m.text === text && Date.parse(m.ts) >= cutoff,
    );
    if (repeat) return { ...repeat, duplicate: true };

    // Detect @mentions in the text
    const mentionMatch = text.match(/@([a-zA-Z0-9_-]+)/);
    const mention = mentionMatch ? mentionMatch[1] : null;
    const isMention = mention && mention in this.state.agents && !this.#isKicked(mention);

    this.state.counters.seq = (Number(this.state.counters.seq) || 0) + 1;
    const msg = {
      id: this.#id('message', 'M'),
      seq: this.state.counters.seq,
      from,
      to,
      text,
      urgent: Boolean(urgent) || isMention, // Mentions are treated as urgent
      replyTo: replyTo || null,
      mention: isMention ? mention : null, // Store the mentioned agent
      ts: nowIso(),
      readBy: {},
    };
    this.state.messages.push(msg);
    if (this.state.messages.length > MAX_MESSAGES) {
      this.state.messages.splice(0, this.state.messages.length - MAX_MESSAGES);
    }
    // Only refresh senders who are already agents. A human posting through the
    // CLI should not appear on the roster as a phantom teammate.
    if (this.state.agents[from]) this.touch(from);
    this.save();
    this.#wake();
    return msg;
  }

  /** Human moderation replaces content without retaining the superseded text. */
  editMessage(id, text) {
    const message = this.state.messages.find((entry) => entry.id === id);
    if (!message) return { ok: false, error: `No message ${id}.` };
    if (message.deletedAt) return { ok: false, error: `${id} was deleted and cannot be edited.` };
    const next = String(text || '').trim();
    if (!next) return { ok: false, error: 'Replacement text is required.' };
    if (next === message.text) return { ok: true, message, unchanged: true };
    message.text = next;
    message.editedAt = nowIso();
    message.editedBy = 'human';
    message.editCount = (message.editCount || 0) + 1;
    this.state.log.push({ ts: message.editedAt, who: 'human', what: `edited ${id}` });
    this.save();
    return { ok: true, message };
  }

  /** Keep the id/thread tombstone for auditability, but erase the content. */
  deleteMessage(id) {
    const message = this.state.messages.find((entry) => entry.id === id);
    if (!message) return { ok: false, error: `No message ${id}.` };
    if (message.deletedAt) return { ok: true, message, unchanged: true };
    message.text = '';
    message.urgent = false;
    message.mention = null;
    message.deletedAt = nowIso();
    message.deletedBy = 'human';
    this.state.log.push({ ts: message.deletedAt, who: 'human', what: `deleted ${id}` });
    this.save();
    return { ok: true, message };
  }

  isFor(msg, agent) {
    if (msg.from === agent) return false;
    return msg.to === 'all' || msg.to === agent;
  }

  unread(agent) {
    return this.state.messages.filter((m) => this.isFor(m, agent) && !m.readBy[agent]);
  }

  readInbox(agent, { markRead = true } = {}) {
    const pending = this.unread(agent);
    if (markRead) {
      const ts = nowIso();
      for (const m of pending) m.readBy[agent] = ts;
      if (pending.length) this.save();
    }
    return pending.map(({ readBy, ...rest }) => rest);
  }

  /** Resolves as soon as `agent` has mail, or after `ms`. Powers long-polling. */
  waitForMail(agent, ms) {
    if (this.unread(agent).length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { agent, resolve: null };
      const done = (value) => {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(value);
      };
      waiter.resolve = () => done(true);
      waiter.timer = setTimeout(() => done(false), ms);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  #wake() {
    for (const waiter of [...this.waiters]) {
      if (this.unread(waiter.agent).length) waiter.resolve();
    }
  }

  // ----------------------------------------------------------------- tasks

  addTask(from, { title, scope = '', notes = '', assignTo = '', dependsOn = '' }) {
    const task = {
      id: this.#id('task', 'T'),
      title,
      scope,
      notes,
      status: assignTo ? 'claimed' : 'open',
      owner: assignTo || null,
      createdBy: from,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      history: [{ ts: nowIso(), who: from, what: assignTo ? `created, assigned to ${assignTo}` : 'created' }],
      participants: assignTo ? [assignTo] : [],
    };
    if (dependsOn) task.dependsOn = dependsOn;
    this.state.tasks.push(task);
    this.touch(from);
    this.save();
    this.#wake();
    return task;
  }

  task(id) {
    return this.state.tasks.find((t) => t.id === id) || null;
  }

  /**
   * A claim is a live signal, not a lock. An agent that hits a usage limit and
   * disappears must not hold work hostage, so a claim lapses once its owner has
   * been silent long enough.
   */
  releaseStaleClaims() {
    const released = [];
    for (const task of this.state.tasks) {
      if (!['claimed', 'blocked'].includes(task.status) || !task.owner) continue;
      const owner = this.state.agents[task.owner];
      const quiet = Date.now() - (owner?.lastSeen || 0);
      if (quiet < claimStaleMs()) continue;
      const previousStatus = task.status;
      task.history.push({ ts: nowIso(), who: 'system', what: `claim lapsed — ${task.owner} silent ${Math.round(quiet / 60000)} min` });
      task.lastOwner = task.owner;
      task.owner = null;
      const dependency = task.dependsOn && this.task(task.dependsOn);
      task.status = previousStatus === 'blocked' && dependency?.status !== 'done' ? 'blocked' : 'open';
      task.updatedAt = nowIso();
      released.push(task.id);
    }
    if (released.length) {
      this.note('system', `claims lapsed: ${released.join(', ')}`);
      this.save();
    }
    return released;
  }

  /** The whole point of the relay: two agents cannot claim the same work. */
  claimTask(agent, id) {
    if (this.#isKicked(agent)) return { ok: false, error: `${agent} is kicked and cannot claim tasks.` };
    this.releaseStaleClaims();
    const task = this.task(id);
    if (!task) return { ok: false, error: `No task ${id}.` };
    if (task.owner && task.owner !== agent) {
      const owner = this.state.agents[task.owner];
      const quiet = Math.round((Date.now() - (owner?.lastSeen || 0)) / 60000);
      return {
        ok: false,
        error: `${id} is being worked by ${task.owner} (last active ${quiet} min ago). Pick another one — `
          + `it frees up automatically after ${Math.round(claimStaleMs() / 60000)} min of their silence.`,
        task,
      };
    }
    if (task.status === 'done') return { ok: false, error: `${id} is already done.`, task };

    // Check dependencies
    if (task.dependsOn) {
      const dep = this.task(task.dependsOn);
      if (dep && dep.status !== 'done') {
        task.status = 'blocked';
        this.save();
        return {
          ok: false,
          error: `${id} depends on ${task.dependsOn} (status: ${dep.status}). It will unblock when the dependency is done.`,
          task,
        };
      }
    }

    task.owner = agent;
    task.participants ||= [];
    if (!task.participants.includes(agent)) task.participants.push(agent);
    task.status = 'claimed';
    task.updatedAt = nowIso();
    task.history.push({ ts: nowIso(), who: agent, what: 'claimed' });
    this.touch(agent);
    this.save();
    return { ok: true, task };
  }

  updateTask(agent, id, { status, notes }) {
    if (this.#isKicked(agent)) return { ok: false, error: `${agent} is kicked and cannot update tasks.` };
    const task = this.task(id);
    if (!task) return { ok: false, error: `No task ${id}.` };
    if (task.owner && task.owner !== agent) {
      return {
        ok: false,
        error: `${id} belongs to ${task.owner}. You cannot change or release another agent's task directly. `
          + 'Use poll_create with task_reassign or task_release.',
      };
    }
    if (status) task.status = status;
    if (notes) task.notes = task.notes ? `${task.notes}\n${notes}` : notes;
    task.updatedAt = nowIso();
    task.history.push({ ts: nowIso(), who: agent, what: `${status || 'note'}${notes ? `: ${notes}` : ''}` });
    this.touch(agent);

    // If this task was completed, unblock any tasks depending on it
    if (status === 'done') {
      for (const t of this.state.tasks) {
        if (t.dependsOn === id && t.status === 'blocked') {
          t.status = 'open';
          t.history.push({ ts: nowIso(), who: 'system', what: `unblocked — dependency ${id} completed` });
        }
      }
    }

    this.save();
    return { ok: true, task };
  }

  tasks(status) {
    const all = this.state.tasks;
    return status ? all.filter((t) => t.status === status) : all;
  }

  // ------------------------------------------------------------------ polls

  /** Whether governance has disabled this identity without erasing its work. */
  #isKicked(name) {
    return this.state.agents?.[name]?.membershipStatus === 'kicked';
  }

  isAgentBlocked(name) {
    const agent = this.state.agents[name];
    return agent?.membershipStatus === 'kicked'
      ? { blocked: true, reason: agent.blockReason || 'removed by collaboration poll', pollId: agent.kickedByPoll || null }
      : { blocked: false };
  }

  #pollQuorum(poll) {
    const voters = poll.eligible?.length || 0;
    return voters ? Math.floor(voters / 2) + 1 : 0;
  }

  #pollRequiredYes(poll) {
    const voters = poll.eligible?.length || 0;
    // Removing a teammate is deliberately harder than moving work. The target
    // is excluded from `eligible`, so it cannot veto or approve its own kick.
    if (poll.action?.type === 'agent_kick') return Math.max(1, Math.ceil(voters * 2 / 3));
    return voters ? Math.floor(voters / 2) + 1 : 0;
  }

  #pollTally(poll) {
    const choices = Object.values(poll.votes || {}).map((vote) => vote.choice);
    return {
      yes: choices.filter((choice) => choice === 'yes').length,
      no: choices.filter((choice) => choice === 'no').length,
      abstain: choices.filter((choice) => choice === 'abstain').length,
      cast: choices.length,
      eligible: poll.eligible.length,
      quorum: poll.quorum,
      requiredYes: poll.requiredYes,
    };
  }

  #pollView(poll) {
    return { ...poll, tally: this.#pollTally(poll) };
  }

  #validatePollAction(action) {
    if (!action) return { ok: true, action: null };
    if (!action.type) return { ok: false, error: 'A poll action requires a type.' };
    if (action.type === 'task_release' || action.type === 'task_reassign') {
      const task = this.task(action.taskId);
      if (!task) return { ok: false, error: `No task ${action.taskId}.` };
      if (task.status === 'done') return { ok: false, error: `${action.taskId} is already done.` };
      if (action.type === 'task_reassign') {
        if (!action.to || !this.state.agents[action.to]) return { ok: false, error: `No agent called "${action.to || ''}".` };
        if (this.#isKicked(action.to)) return { ok: false, error: `${action.to} is kicked and cannot receive work.` };
        if (Date.now() - (this.state.agents[action.to].lastSeen || 0) >= ONLINE_WINDOW_MS) {
          return { ok: false, error: `${action.to} is inactive and cannot receive reassigned work.` };
        }
      }
      return { ok: true, action: { type: action.type, taskId: action.taskId, ...(action.to ? { to: action.to } : {}) } };
    }
    if (action.type === 'agent_kick' || action.type === 'agent_restore') {
      const name = action.agent;
      const agent = this.state.agents[name];
      if (!agent) return { ok: false, error: `No agent called "${name || ''}".` };
      if (action.type === 'agent_kick') {
        if (this.#isKicked(name)) return { ok: false, error: `${name} is already kicked.` };
        if (Date.now() - (agent.lastSeen || 0) < ONLINE_WINDOW_MS) {
          return { ok: false, error: `${name} is online. Kick polls are only allowed for inactive agents.` };
        }
      } else if (!this.#isKicked(name)) {
        return { ok: false, error: `${name} is not kicked.` };
      }
      return { ok: true, action: { type: action.type, agent: name } };
    }
    return { ok: false, error: `Unknown poll action "${action.type}".` };
  }

  /**
   * Create a durable yes/no/abstain poll. Eligible *active* voters are
   * snapshotted so a long historical roster cannot make a decision impossible
   * and later joins cannot move the goalposts. The creator is always included.
   * Ordinary actions need a strict majority; kicks need two thirds (target excluded).
   */
  createPoll(agent, { question, action = null, reason = '' }) {
    if (!this.state.agents[agent]) return { ok: false, error: `No agent called "${agent}".` };
    if (this.#isKicked(agent)) return { ok: false, error: `${agent} is kicked and cannot create polls.` };
    if (typeof question !== 'string' || !question.trim()) return { ok: false, error: 'A poll question is required.' };
    const checked = this.#validatePollAction(action);
    if (!checked.ok) return checked;

    let eligible = Object.keys(this.state.agents).filter((name) =>
      !this.#isKicked(name)
      && (name === agent || Date.now() - (this.state.agents[name].lastSeen || 0) < ONLINE_WINDOW_MS));
    if (checked.action?.type === 'agent_kick') eligible = eligible.filter((name) => name !== checked.action.agent);
    if (!eligible.length) return { ok: false, error: 'No eligible voters for this poll.' };
    const ts = nowIso();
    const poll = {
      id: this.#id('poll', 'P'),
      question: question.trim(),
      reason: typeof reason === 'string' ? reason.trim() : '',
      action: checked.action,
      createdBy: agent,
      createdAt: ts,
      updatedAt: ts,
      status: 'open',
      eligible,
      votes: {},
    };
    poll.quorum = this.#pollQuorum(poll);
    poll.requiredYes = this.#pollRequiredYes(poll);
    this.state.polls.push(poll);
    this.note(agent, `opened poll ${poll.id}: ${poll.question}`);
    this.save();
    this.#wake();
    return { ok: true, poll: this.#pollView(poll) };
  }

  poll(id) {
    const poll = this.state.polls.find((item) => item.id === id);
    return poll ? this.#pollView(poll) : null;
  }

  listPolls(status = '') {
    return this.state.polls
      .filter((poll) => !status || poll.status === status)
      .map((poll) => this.#pollView(poll));
  }

  /**
   * Surface inactive memberships to the team without silently removing them.
   * One system poll is opened per candidate after sustained inactivity. Active
   * agents remain the electorate and must explicitly approve the kick.
   */
  proposeInactiveKickPolls() {
    const now = Date.now();
    const activeVoters = Object.values(this.state.agents)
      .filter((agent) => !this.#isKicked(agent.name) && now - (agent.lastSeen || 0) < ONLINE_WINDOW_MS)
      .map((agent) => agent.name);
    if (!activeVoters.length) return [];

    const opened = [];
    for (const target of Object.values(this.state.agents)) {
      if (this.#isKicked(target.name) || activeVoters.includes(target.name)) continue;
      const lastActivity = Math.max(
        Number(target.lastSeen) || 0,
        Date.parse(target.joinedAt || '') || 0,
        Date.parse(target.restoredAt || '') || 0,
      );
      const inactiveFor = now - lastActivity;
      if (inactiveFor < kickCandidateMs()) continue;

      const earlier = [...this.state.polls].reverse()
        .find((poll) => poll.action?.type === 'agent_kick' && poll.action.agent === target.name);
      if (earlier?.status === 'open') continue;
      if (earlier?.status === 'rejected'
        && now - Date.parse(earlier.closedAt || earlier.updatedAt || 0) < KICK_REJECTED_COOLDOWN_MS) continue;

      const eligible = activeVoters.filter((name) => name !== target.name);
      if (!eligible.length) continue;
      const owned = this.state.tasks
        .filter((task) => task.owner === target.name && task.status !== 'done')
        .map((task) => task.id);
      const minutes = Math.max(0, Math.floor(inactiveFor / 60_000));
      const ts = nowIso();
      const poll = {
        id: this.#id('poll', 'P'),
        question: `Remove inactive agent ${target.name}?`,
        reason: `${target.name} has been inactive for ${minutes} minutes.`
          + (owned.length ? ` Passing this poll releases ${owned.join(', ')}.` : ' Historical contributions remain attributed.'),
        action: { type: 'agent_kick', agent: target.name },
        createdBy: 'system',
        createdAt: ts,
        updatedAt: ts,
        status: 'open',
        eligible,
        votes: {},
        systemManaged: true,
      };
      poll.quorum = this.#pollQuorum(poll);
      poll.requiredYes = this.#pollRequiredYes(poll);
      this.state.polls.push(poll);
      this.state.log.push({ ts, who: 'system', text: `opened inactivity poll ${poll.id} for ${target.name}` });
      if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
      opened.push(this.#pollView(poll));
    }
    if (opened.length) {
      this.save();
      this.#wake();
    }
    return opened;
  }

  votePoll(agent, id, choice) {
    const poll = this.state.polls.find((item) => item.id === id);
    if (!poll) return { ok: false, error: `No poll ${id}.` };
    if (poll.status !== 'open') return { ok: false, error: `${id} is already ${poll.status}.`, poll: this.#pollView(poll) };
    if (this.#isKicked(agent)) return { ok: false, error: `${agent} is kicked and cannot vote.` };
    if (!poll.eligible.includes(agent)) return { ok: false, error: `${agent} is not eligible to vote in ${id}.` };
    if (!['yes', 'no', 'abstain'].includes(choice)) return { ok: false, error: 'Vote must be yes, no, or abstain.' };
    if (poll.votes[agent]) return { ok: false, duplicate: true, error: `${agent} already voted in ${id}.` };

    poll.votes[agent] = { choice, ts: nowIso() };
    poll.updatedAt = nowIso();
    this.touch(agent);
    const finalized = this.#finalizePollIfDecided(poll);
    this.save();
    this.#wake();
    return { ok: true, poll: this.#pollView(poll), finalized };
  }

  /** Finalize only a mathematically decided result; nobody can close voting early. */
  closePoll(agent, id) {
    const poll = this.state.polls.find((item) => item.id === id);
    if (!poll) return { ok: false, error: `No poll ${id}.` };
    if (poll.status !== 'open') return { ok: true, alreadyClosed: true, poll: this.#pollView(poll) };
    if (!poll.eligible.includes(agent) || this.#isKicked(agent)) return { ok: false, error: `${agent} cannot close ${id}.` };
    const finalized = this.#finalizePollIfDecided(poll);
    if (!finalized) {
      const tally = this.#pollTally(poll);
      return { ok: false, pending: true, error: `${id} is not decided yet (${tally.cast}/${tally.eligible} votes cast).`, poll: this.#pollView(poll) };
    }
    this.save();
    return { ok: true, poll: this.#pollView(poll) };
  }

  #finalizePollIfDecided(poll) {
    const tally = this.#pollTally(poll);
    const remaining = tally.eligible - tally.cast;
    let passed = false;
    if (tally.yes >= poll.requiredYes) passed = true;
    else if (tally.cast < poll.quorum || tally.yes + remaining >= poll.requiredYes) return false;

    poll.status = passed ? 'passed' : 'rejected';
    poll.closedAt = nowIso();
    poll.updatedAt = poll.closedAt;
    poll.result = { ...tally, passed };
    if (passed && poll.action) poll.execution = this.#executePollAction(poll);
    this.note('system', `poll ${poll.id} ${poll.status}${poll.execution && !poll.execution.ok ? `; action failed: ${poll.execution.error}` : ''}`);
    return true;
  }

  #executePollAction(poll) {
    const action = poll.action;
    const ts = nowIso();
    if (action.type === 'task_release' || action.type === 'task_reassign') {
      const task = this.task(action.taskId);
      if (!task) return { ok: false, error: `No task ${action.taskId}.` };
      if (task.status === 'done') return { ok: false, error: `${task.id} became done before the poll passed.` };
      const previous = task.owner;
      task.participants ||= [];
      if (previous && !task.participants.includes(previous)) task.participants.push(previous);
      if (action.type === 'task_reassign') {
        if (!this.state.agents[action.to] || this.#isKicked(action.to)) return { ok: false, error: `${action.to} cannot receive work.` };
        if (Date.now() - (this.state.agents[action.to].lastSeen || 0) >= ONLINE_WINDOW_MS) {
          return { ok: false, error: `${action.to} became inactive before the poll passed.` };
        }
        if (previous) task.lastOwner = previous;
        task.owner = action.to;
        if (!task.participants.includes(action.to)) task.participants.push(action.to);
        task.status = 'claimed';
        task.history ||= [];
        task.history.push({ ts, who: 'system', what: `reassigned by poll ${poll.id}: ${previous || 'unowned'} → ${action.to}` });
      } else {
        task.lastOwner = previous;
        task.owner = null;
        const dependency = task.dependsOn && this.task(task.dependsOn);
        task.status = dependency && dependency.status !== 'done' ? 'blocked' : 'open';
        task.history ||= [];
        task.history.push({ ts, who: 'system', what: `released by poll ${poll.id} from ${previous || 'unowned'}` });
      }
      task.updatedAt = ts;
      return { ok: true, taskId: task.id, previousOwner: previous, owner: task.owner, status: task.status };
    }

    const target = this.state.agents[action.agent];
    if (!target) return { ok: false, error: `No agent called "${action.agent}".` };
    if (action.type === 'agent_restore') {
      target.membershipStatus = 'active';
      target.status = 'idle';
      target.statusAt = Date.now();
      target.restoredAt = ts;
      target.restoredByPoll = poll.id;
      delete target.blockReason;
      delete target.kickedAt;
      delete target.kickedByPoll;
      return { ok: true, agent: action.agent, membershipStatus: 'active' };
    }
    if (Date.now() - (target.lastSeen || 0) < ONLINE_WINDOW_MS) {
      return { ok: false, error: `${action.agent} came online before the kick poll passed.` };
    }
    target.membershipStatus = 'kicked';
    target.status = 'kicked';
    target.statusAt = Date.now();
    target.kickedAt = ts;
    target.kickedByPoll = poll.id;
    target.blockReason = `removed by passed poll ${poll.id}`;
    const releasedTasks = [];
    for (const task of this.state.tasks) {
      if (task.owner !== action.agent || task.status === 'done') continue;
      task.lastOwner = action.agent;
      task.owner = null;
      const dependency = task.dependsOn && this.task(task.dependsOn);
      task.status = dependency && dependency.status !== 'done' ? 'blocked' : 'open';
      task.updatedAt = ts;
      task.history ||= [];
      task.history.push({ ts, who: 'system', what: `owner kicked by poll ${poll.id}; attribution preserved, claim released` });
      releasedTasks.push(task.id);
    }
    return { ok: true, agent: action.agent, membershipStatus: 'kicked', releasedTasks };
  }

  // -------------------------------------------------------------- findings

  addFinding(agent, { title, severity = 'info', target = '', evidence = '', repro = '', createsTask = false }) {
    const finding = {
      id: this.#id('finding', 'F'),
      title,
      severity,
      target,
      evidence,
      repro,
      status: 'unverified',
      by: agent,
      ts: nowIso(),
    };
    this.state.findings.push(finding);
    this.touch(agent);
    this.save();
    this.#wake();

    // Auto-create a verification task for the partner
    if (createsTask) {
      // Find an agent who isn't the reporter
      const partner = Object.values(this.state.agents).find((candidate) =>
        candidate.name !== agent
        && !this.#isKicked(candidate.name)
        && Date.now() - (candidate.lastSeen || 0) < ONLINE_WINDOW_MS)?.name;
      const task = this.addTask(agent, {
        title: `Verify ${finding.id}: ${title}`,
        scope: 'peer review',
        notes: `Auto-created from finding ${finding.id}. Independently reproduce: ${evidence || repro || 'see finding details.'}`,
        assignTo: partner,
        goal: finding.severity === 'critical' || finding.severity === 'high' ? undefined : undefined,
      });
      // Link finding to task
      finding.verificationTask = task.id;
      this.save();
    }

    return finding;
  }

  submissionReadiness(finding) {
    const submission = finding.submission || {};
    const blockers = [];
    const requireText = (key, label) => {
      if (!String(submission[key] || '').trim()) blockers.push(label);
    };
    const requireGate = (key, label) => {
      if (submission[key] !== true) blockers.push(label);
    };

    requireText('title', 'clean report title');
    requireText('summary', 'Summary');
    requireText('details', 'Details / vulnerability mechanism');
    requireText('poc', 'complete inline PoC and reproduction');
    requireText('impact', 'Impact');
    requireText('commit', 'exact agave/master commit reproduced');
    requireText('category', 'RULES.md impact category');
    requireText('owner', 'human submission owner');
    requireText('masterCheckedAt', 'current-master check timestamp');
    requireText('knownIssuesCheckedAt', 'known/public-issue check timestamp');
    requireGate('reproductionVerified', 'finding independently reproduced');
    requireGate('liveOnMaster', 'confirmed live on current master');
    requireGate('inlinePoc', 'PoC is self-contained and inline');
    requireGate('impactDemonstrated', 'PoC demonstrates the claimed impact');
    requireGate('knownIssuesChecked', 'known/public issues checked');
    requireGate('oneFinding', 'one finding per advisory');
    requireGate('confidential', 'private/confidential handling confirmed');
    requireGate('twoFactorVerified', 'human owner GitHub 2FA verified');
    requireGate('windowVerified', 'submission window verified at filing time');

    return {
      state: finding.status === 'reported' ? 'reported' : blockers.length ? 'blocked' : 'ready',
      ready: finding.status === 'reported' || blockers.length === 0,
      blockers,
      requiredComplete: 19 - blockers.length,
      requiredTotal: 19,
    };
  }

  updateSubmission(agent, id, patch = {}) {
    const finding = this.state.findings.find((f) => f.id === id);
    if (!finding) return { ok: false, error: `No finding ${id}.` };
    if (!['confirmed', 'reported'].includes(finding.status)) {
      return { ok: false, error: `${id} must be independently confirmed before submission work is recorded.` };
    }
    const allowed = [
      'title', 'summary', 'details', 'poc', 'impact', 'ecosystem', 'packageName',
      'affectedVersions', 'patchedVersions', 'severity', 'cvss', 'cwe', 'commit',
      'category', 'owner', 'duplicateCheck', 'masterCheckedAt', 'knownIssuesCheckedAt',
      'reproductionVerified',
      'liveOnMaster', 'inlinePoc', 'impactDemonstrated', 'knownIssuesChecked',
      'oneFinding', 'confidential', 'twoFactorVerified', 'windowVerified',
    ];
    const next = { ...(finding.submission || {}) };
    for (const key of allowed) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    next.updatedBy = agent;
    next.updatedAt = nowIso();
    finding.submission = next;
    this.touch(agent);
    this.save();
    return { ok: true, finding, readiness: this.submissionReadiness(finding) };
  }

  updateFinding(agent, id, { status, note, repro, submissionUrl = '', submissionNote = '' }) {
    const finding = this.state.findings.find((f) => f.id === id);
    if (!finding) return { ok: false, error: `No finding ${id}.` };
    if (status === 'confirmed' && finding.status === 'unverified' && finding.by === agent) {
      return { ok: false, error: `${id} must be confirmed by an agent other than its reporter.` };
    }
    if (status === 'reported' && !['confirmed', 'reported'].includes(finding.status)) {
      return { ok: false, error: `${id} must be confirmed before it can be marked reported.` };
    }
    const submissionMetadata = submissionUrl || submissionNote
      ? {
          ...(finding.submission || {}),
          ...(submissionUrl ? { url: submissionUrl } : {}),
          ...(submissionNote ? { note: submissionNote } : {}),
          updatedBy: agent,
          updatedAt: nowIso(),
        }
      : finding.submission;
    if (status === 'reported') {
      const readiness = this.submissionReadiness({ ...finding, submission: submissionMetadata });
      if (!readiness.ready) {
        return {
          ok: false,
          error: `${id} is not submission-ready: ${readiness.blockers.join('; ')}.`,
          readiness,
        };
      }
    }
    if (submissionMetadata !== finding.submission) finding.submission = submissionMetadata;
    if (status && status !== finding.status) {
      finding.history ||= [];
      finding.history.push({ ts: nowIso(), who: agent, from: finding.status, to: status });
      finding.status = status;
      if (status === 'confirmed') {
        finding.confirmedAt = nowIso();
        finding.confirmedBy = agent;
      }
      if (status === 'reported') {
        finding.reportedAt = nowIso();
        finding.reportedBy = agent;
      }
    }
    if (note) finding.evidence = finding.evidence ? `${finding.evidence}\n[${agent}] ${note}` : `[${agent}] ${note}`;
    if (repro !== undefined) finding.repro = String(repro).trim();
    if (status === 'reported') {
      finding.submission = {
        ...(finding.submission || {}),
        by: agent,
        ts: nowIso(),
      };
    }
    this.save();
    return { ok: true, finding };
  }

  submissions() {
    const severity = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    return this.state.findings
      .filter((finding) => ['confirmed', 'reported'].includes(finding.status))
      .map((finding) => ({ ...finding, readiness: this.submissionReadiness(finding) }))
      .sort((a, b) => {
        // Keep the MCP queue in the same order as the dashboard: ready
        // candidates first, then the candidates closest to ready, then filed
        // history. Severity is only a tie-breaker inside a readiness tier.
        const tier = (finding) => finding.status === 'reported'
          ? 2
          : finding.readiness.ready ? 0 : 1;
        const score = (finding) => finding.readiness.requiredTotal
          ? finding.readiness.requiredComplete / finding.readiness.requiredTotal : 0;
        return tier(a) - tier(b)
          || score(b) - score(a)
          || a.readiness.blockers.length - b.readiness.blockers.length
          || (severity[a.severity] ?? 9) - (severity[b.severity] ?? 9)
          || String(b.reportedAt || b.confirmedAt || b.ts || '').localeCompare(String(a.reportedAt || a.confirmedAt || a.ts || ''));
      });
  }

  // -------------------------------------------------------------- advisories
  //
  // Anza's real-world disposition of a submitted finding: what they filed it
  // as, what it turned out to be worth, and — critically — the verbatim
  // reason when they close it. `finding.status` only tracks *our* internal
  // review pipeline (unverified -> confirmed -> reported); it never learns
  // what happens after a report leaves the building. An advisory is that
  // missing half, one row per GHSA advisory, upserted as Anza's page changes.

  /**
   * Create or update an advisory by its GHSA id (the natural unique key —
   * Anza mints it once per filed report, so it is a safer identity than a
   * locally-sequential counter would be across a relay restart/merge).
   */
  upsertAdvisory(agent, patch = {}) {
    const ghsaId = String(patch.ghsaId || '').trim();
    if (!ghsaId) return { ok: false, error: 'ghsaId is required.' };
    const allowed = [
      'findingId', 'title', 'url', 'state', 'outcome', 'anzaSeverity', 'ourSeverity',
      'product', 'affectedVersions', 'patchedVersions', 'outcomeReason', 'closedBy',
      'creditState', 'burnTx', 'burnSol', 'submittedAt',
    ];
    let advisory = this.state.advisories.find((a) => a.ghsaId === ghsaId);
    const created = !advisory;
    if (!advisory) {
      advisory = { ghsaId, state: 'draft', outcome: 'pending', createdAt: nowIso() };
      this.state.advisories.push(advisory);
    }
    for (const key of allowed) {
      if (patch[key] !== undefined) advisory[key] = patch[key];
    }
    advisory.updatedBy = agent;
    advisory.updatedAt = nowIso();
    this.touch(agent);
    this.save();
    return { ok: true, advisory, created };
  }

  /** All advisories, most recently submitted (or updated) first. */
  advisories() {
    return [...this.state.advisories].sort((a, b) =>
      String(b.submittedAt || b.updatedAt || b.createdAt || '')
        .localeCompare(String(a.submittedAt || a.updatedAt || a.createdAt || '')));
  }

  /** Lookup an advisory linked to a given finding id, if any. */
  advisoryForFinding(findingId) {
    return this.state.advisories.find((a) => a.findingId === findingId) || null;
  }

  // ------------------------------------------------------------------ fences
  //
  // A "fence" is a piece of Anza ground-truth that forecloses a class of
  // finding: a public §8 issue/PR published before we filed (prior-art —
  // RULES §8 excludes it), or a competitor's report Anza already accepted in
  // a given file (reworking that class wastes a burn). Fences are additive,
  // append-only evidence records; nothing here decides eligibility — the
  // consumer (dashboard/tools) compares `publishedAt`/`mergedAt` against a
  // finding's `submittedAt` to render the collision warning.

  addFence(agent, patch = {}) {
    const fence = {
      id: this.#id('fence', 'FN'),
      kind: patch.kind || 'section8_issue',
      ref: patch.ref || '',
      url: patch.url || '',
      title: patch.title || '',
      quote: patch.quote || '',
      publishedAt: patch.publishedAt || null,
      mergedAt: patch.mergedAt || null,
      appliesTo: Array.isArray(patch.appliesTo) ? patch.appliesTo : [],
      paths: Array.isArray(patch.paths) ? patch.paths : [],
      note: patch.note || '',
      addedBy: agent,
      createdAt: nowIso(),
    };
    this.state.fences.push(fence);
    this.touch(agent);
    this.save();
    return fence;
  }

  /** All fences, most recently published (falling back to added) first. */
  fences() {
    return [...this.state.fences].sort((a, b) =>
      String(b.publishedAt || b.mergedAt || b.createdAt || '')
        .localeCompare(String(a.publishedAt || a.mergedAt || a.createdAt || '')));
  }

  // ----------------------------------------------------------------- goals

  addGoal(agent, { title, detail = '' }) {
    const goal = {
      id: this.#id('goal', 'G'),
      title,
      detail,
      status: 'active',
      createdBy: agent,
      ts: nowIso(),
    };
    this.state.goals.push(goal);
    this.touch(agent);
    this.save();
    this.#wake();
    return goal;
  }

  updateGoal(agent, id, { status, detail }) {
    const goal = this.state.goals.find((g) => g.id === id);
    if (!goal) return { ok: false, error: `No goal ${id}.` };
    if (status) goal.status = status;
    if (detail) goal.detail = detail;
    this.note(agent, `${id} ${status || 'updated'}`);
    this.save();
    return { ok: true, goal };
  }

  /** Goals carry their own progress, derived from the tasks pointed at them. */
  goals() {
    return this.state.goals.map((goal) => {
      const tasks = this.state.tasks.filter((t) => t.goal === goal.id);
      const done = tasks.filter((t) => t.status === 'done').length;
      return {
        ...goal,
        taskCount: tasks.length,
        done,
        percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
        owners: [...new Set(tasks.map((t) => t.owner).filter(Boolean))],
      };
    });
  }

  // ------------------------------------------------------------ environment

  /**
   * The facts both agents must agree on before any finding means anything:
   * which repo, which commit, how it builds. Without this two agents can audit
   * different code and never notice.
   */
  setEnv(agent, key, value) {
    const previous = this.state.env[key];
    this.state.env[key] = { value, by: agent, ts: nowIso() };
    this.save();
    const changed = previous && previous.value !== value;
    if (changed) {
      this.send(agent, {
        to: 'all',
        text: `Shared environment changed — ${key} is now "${value}" (was "${previous.value}"). Make sure you are on the same one.`,
        urgent: true,
      });
    }
    return { key, value, changed, previous: previous?.value };
  }

  // ----------------------------------------------------------------- files

  /**
   * The coverage map. In a code audit the expensive question is "has anyone
   * actually read this file, and what did they conclude?" — so every review is
   * recorded per agent, and disagreements are kept rather than overwritten.
   */
  reviewFile(agent, { path: filePath, verdict = 'reviewed', note = '', lines = '' }) {
    const file = (this.state.files[filePath] ||= {
      path: filePath,
      reviews: [],
      findings: [],
      firstSeen: nowIso(),
    });
    const previous = file.reviews.filter((r) => r.agent !== agent);
    file.reviews = [...previous, { agent, verdict, note, lines, ts: nowIso() }];
    file.lastTouched = nowIso();

    const others = previous.map((r) => ({ agent: r.agent, verdict: r.verdict, note: r.note }));
    const disagreement = others.filter((o) => o.verdict !== verdict);

    this.touch(agent);
    this.save();
    if (disagreement.length) this.#wake();
    return { file, alsoReviewedBy: others, disagreement };
  }

  linkFinding(filePath, findingId) {
    if (!filePath) return;
    const file = (this.state.files[filePath] ||= { path: filePath, reviews: [], findings: [], firstSeen: nowIso() });
    if (!file.findings.includes(findingId)) file.findings.push(findingId);
    this.save();
  }

  coverage() {
    return Object.values(this.state.files)
      .map((file) => {
        const verdicts = [...new Set(file.reviews.map((r) => r.verdict))];
        return {
          ...file,
          reviewers: file.reviews.map((r) => r.agent),
          verdicts,
          disagreement: verdicts.length > 1,
          peerReviewed: file.reviews.length > 1,
        };
      })
      .sort((a, b) => (b.lastTouched || '').localeCompare(a.lastTouched || ''));
  }

  // ------------------------------------------------------------------- log

  note(who, text) {
    this.state.log.push({ ts: nowIso(), who, text });
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
    this.save();
    return { ok: true };
  }

  // ---------------------------------------------------------------- rename

  /**
   * Rename an agent everywhere at once. Names are foreign keys across messages,
   * tasks, findings and the log, so a partial rename would orphan real work.
   */
  /**
   * A renamed agent's other machine still has the old name baked into its MCP
   * URL, and would silently recreate it as an empty duplicate on next contact.
   * Old names therefore forward to the new one until that machine catches up.
   */
  resolveName(name) {
    let resolved = name;
    for (let hops = 0; hops < 10 && this.state.aliases?.[resolved]; hops += 1) {
      resolved = this.state.aliases[resolved];
    }
    return resolved;
  }

  rename(from, to) {
    if (!from || !to) return { ok: false, error: 'Both a current and a new name are required.' };
    if (from === to) return { ok: false, error: 'Those are the same name.' };
    if (!this.state.agents[from]) {
      const known = Object.keys(this.state.agents).join(', ') || '(nobody)';
      return { ok: false, error: `No agent called "${from}". On the board: ${known}` };
    }
    if (this.state.agents[to]) {
      return { ok: false, error: `"${to}" is already taken. Pick a name nobody is using.` };
    }

    const agent = this.state.agents[from];
    delete this.state.agents[from];
    agent.name = to;
    // Endpoints belong to the machine, not the name — a rename is not a clash.
    agent.hosts = [];
    this.state.agents[to] = agent;

    let touched = 0;
    for (const m of this.state.messages) {
      if (m.from === from) { m.from = to; touched += 1; }
      if (m.to === from) m.to = to;
      if (m.readBy[from] !== undefined) {
        m.readBy[to] = m.readBy[from];
        delete m.readBy[from];
      }
    }
    for (const t of this.state.tasks) {
      if (t.owner === from) { t.owner = to; touched += 1; }
      if (t.lastOwner === from) t.lastOwner = to;
      t.participants = (t.participants || []).map((name) => (name === from ? to : name));
      if (t.createdBy === from) t.createdBy = to;
      for (const h of t.history || []) if (h.who === from) h.who = to;
    }
    for (const f of this.state.findings) if (f.by === from) { f.by = to; touched += 1; }
    for (const l of this.state.log) if (l.who === from) l.who = to;
    for (const poll of this.state.polls) {
      if (poll.createdBy === from) poll.createdBy = to;
      poll.eligible = (poll.eligible || []).map((name) => (name === from ? to : name));
      if (poll.votes?.[from] !== undefined) {
        poll.votes[to] = poll.votes[from];
        delete poll.votes[from];
      }
      if (poll.action?.agent === from) poll.action.agent = to;
      if (poll.action?.to === from) poll.action.to = to;
    }

    this.state.aliases ||= {};
    this.state.aliases[from] = to;
    // `to` is a live name now, so it can no longer forward anywhere...
    delete this.state.aliases[to];
    // ...and anything that forwarded to `from` should skip straight to `to`.
    for (const [old, target] of Object.entries(this.state.aliases)) {
      if (target === from) this.state.aliases[old] = to;
    }

    this.note('system', `${from} is now known as ${to}`);
    this.save();
    return { ok: true, from, to, references: touched };
  }

  /**
   * Remove an agent from the roster. Messages are deliberately kept — what
   * someone said stays true after they leave, and on an audit those notes are
   * often the most valuable thing they produced.
   */
  forget(name, { force = false } = {}) {
    if (!this.state.agents[name]) {
      const known = Object.keys(this.state.agents).join(', ') || '(nobody)';
      return { ok: false, error: `No agent called "${name}". On the board: ${known}` };
    }
    const owns = this.state.tasks.filter((t) => t.owner === name).map((t) => t.id);
    const found = this.state.findings.filter((f) => f.by === name).map((f) => f.id);
    const reviewed = Object.values(this.state.files).filter((f) => f.reviews.some((r) => r.agent === name)).map((f) => f.path);
    const said = this.state.messages.filter((m) => m.from === name).length;
    const online = Date.now() - (this.state.agents[name].lastSeen || 0) < ONLINE_WINDOW_MS;

    // Contributing counts as participation even when nothing is formally owned:
    // an agent that has only ever talked is still somebody's live session.
    if (!force && online) {
      return { ok: false, error: `"${name}" is ONLINE right now — it is somebody's running MCP client. Stop that client first, or pass --force.` };
    }
    if (!force && (owns.length || found.length || reviewed.length || said)) {
      const parts = [];
      if (owns.length) parts.push(`${owns.length} task(s)`);
      if (found.length) parts.push(`${found.length} finding(s)`);
      if (reviewed.length) parts.push(`${reviewed.length} file review(s)`);
      if (said) parts.push(`${said} message(s)`);
      return {
        ok: false,
        error:
          `"${name}" has contributed real work — ${parts.join(', ')}. Removing it loses the roster entry ` +
          'for an agent that participated. Rename it instead, or pass --force if you are sure ' +
          '(the work itself stays on the board either way).',
        owns,
        found,
        reviewed,
        said,
      };
    }

    delete this.state.agents[name];
    for (const [old, target] of Object.entries(this.state.aliases || {})) {
      if (target === name || old === name) delete this.state.aliases[old];
    }
    const keptMessages = this.state.messages.filter((m) => m.from === name).length;
    this.note('system', `${name} removed from the roster`);
    this.save();
    return { ok: true, name, keptMessages, owns, found, reviewed };
  }

  // --------------------------------------------------------------- digest

  /**
   * After a hundred messages nobody can catch up by scrolling. A digest is the
   * delta since the last one: what got decided, not what got said.
   */
  maybeDigest() {
    const last = this.state.digests[this.state.digests.length - 1];
    const sinceSeq = last?.toSeq || 0;
    const fresh = this.state.messages.filter((m) => (m.seq || 0) > sinceSeq);
    const elapsed = Date.now() - (last ? Date.parse(last.ts) : Date.parse(this.state.createdAt));
    if (fresh.length < DIGEST_EVERY_MESSAGES && elapsed < DIGEST_EVERY_MS) return null;
    if (!fresh.length) return null;

    const since = last ? Date.parse(last.ts) : 0;
    const after = (ts) => Date.parse(ts) > since;
    const lines = [];

    const newFindings = this.state.findings.filter((f) => after(f.ts));
    if (newFindings.length) {
      lines.push(`${newFindings.length} new finding(s): ` + newFindings.map((f) => `${f.id} [${f.severity}] ${f.title.slice(0, 60)}`).join('; '));
    }
    const confirmed = this.state.findings.filter((f) => f.status === 'confirmed');
    const rejected = this.state.findings.filter((f) => f.status === 'rejected');
    lines.push(`findings standing: ${confirmed.length} confirmed, ${rejected.length} rejected, ${this.state.findings.length} total`);

    const doneNow = this.state.tasks.filter((t) => t.status === 'done' && after(t.updatedAt));
    if (doneNow.length) lines.push(`closed: ${doneNow.map((t) => t.id).join(', ')}`);
    const open = this.state.tasks.filter((t) => t.status === 'open');
    if (open.length) lines.push(`still open: ${open.map((t) => t.id).join(', ')}`);

    const reviewed = Object.values(this.state.files).filter((f) => after(f.lastTouched || f.firstSeen));
    if (reviewed.length) lines.push(`${reviewed.length} file(s) reviewed since last digest`);
    const disputed = this.coverage().filter((f) => f.disagreement);
    if (disputed.length) lines.push(`DISPUTED: ${disputed.map((f) => f.path).join(', ')}`);

    const quiet = this.roster().filter((a) => !a.online).map((a) => a.name);
    if (quiet.length) lines.push(`quiet: ${quiet.join(', ')}`);
    const talkers = [...new Set(fresh.map((m) => m.from))];
    lines.push(`${fresh.length} messages from ${talkers.join(', ')}`);

    const digest = {
      id: `D${this.state.digests.length + 1}`,
      ts: nowIso(),
      fromSeq: sinceSeq,
      toSeq: Math.max(...fresh.map((m) => m.seq || 0)),
      lines,
    };
    this.state.digests.push(digest);
    if (this.state.digests.length > 50) this.state.digests.shift();
    this.save();
    return digest;
  }

  // -------------------------------------------------------------- snapshot

  board(viewer) {
    return {
      room: this.state.room,
      you: viewer,
      agents: this.roster(),
      unreadForYou: viewer ? this.unread(viewer).length : 0,
      tasks: {
        open: this.tasks('open'),
        claimed: this.tasks('claimed'),
        blocked: this.tasks('blocked'),
        done: this.tasks('done').slice(-10),
      },
      findings: this.state.findings.slice(-25),
      submissions: this.submissions(),
      advisories: this.advisories(),
      fences: this.fences(),
      goals: this.goals(),
      coverage: this.coverage(),
      env: this.state.env,
      recentLog: this.state.log.slice(-15),
      digests: this.state.digests.slice(-3),
      polls: {
        open: this.listPolls('open'),
        recent: this.listPolls().filter((poll) => poll.status !== 'open').slice(-10),
      },
      conflicts: this.conflicts(),
    };
  }
}
