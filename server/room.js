import fs from 'node:fs';
import path from 'node:path';

const ONLINE_WINDOW_MS = 90_000;
const STATUS_STALE_MS = 5 * 60_000;      // a status older than this is not "what they are doing"
const DEDUP_WINDOW_MS = 5 * 60_000;      // identical text from one agent inside this window is a repeat
const COLLISION_GRACE_MS = 30 * 60_000;  // a name is free again once its machine has been silent this long
const MAX_MESSAGES = 1000;
const MAX_LOG = 500;
// Collections retired from active use (tasks, goals, polls, digests, env,
// fences) but never deleted — see `archive` below and the `archive` MCP tool.
const ARCHIVE_KINDS = ['tasks', 'goals', 'polls', 'digests', 'fences'];

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
      findings: [],
      files: {},
      log: [],
      aliases: {},
      advisories: [],
      // Retired systems (tasks, goals, polls, digests, env, fences) live here,
      // read-only, so any agent can still check them via the `archive` tool —
      // see #migrateToArchive() for how an older state file lands here intact.
      archive: { tasks: [], goals: [], polls: [], digests: [], env: {}, fences: [] },
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
  /**
   * Retired systems (tasks, goals, polls, digests, env, fences) are never
   * deleted — they move under `archive`, additively and idempotently, so the
   * read-only `archive` tool can always show a pre-archive room its full
   * history. A state file already on the new shape (no top-level survivors)
   * is a no-op; records already present in `archive` (matched by id, or by
   * key for `env`) are never duplicated by a second migration pass.
   */
  #migrateToArchive() {
    if (!this.state.archive || typeof this.state.archive !== 'object' || Array.isArray(this.state.archive)) {
      this.state.archive = {};
    }
    const archive = this.state.archive;
    for (const key of ARCHIVE_KINDS) {
      if (!Array.isArray(archive[key])) archive[key] = [];
    }
    if (!archive.env || typeof archive.env !== 'object' || Array.isArray(archive.env)) archive.env = {};

    let movedRecords = 0;
    for (const key of ARCHIVE_KINDS) {
      const legacy = this.state[key];
      if (Array.isArray(legacy) && legacy.length) {
        // Dedup only against what archive[key] already held BEFORE this pass —
        // a normal load never re-migrates (the top-level key is deleted right
        // below), so this only guards a hand-edited/partial state file. It must
        // not compare legacy items against each other: an older, still-broken
        // schema can carry more than one record sharing the same malformed id,
        // and #repairIds (right after this runs) is what gives each its own —
        // deduping them here would silently drop one instead of healing it.
        const known = new Set(archive[key].map((item) => item.id));
        for (const item of legacy) {
          if (known.has(item.id)) continue;
          archive[key].push(item);
          movedRecords += 1;
        }
      }
      delete this.state[key];
    }
    let movedEnvKeys = 0;
    if (this.state.env && typeof this.state.env === 'object' && !Array.isArray(this.state.env)) {
      for (const [key, value] of Object.entries(this.state.env)) {
        if (archive.env[key] !== undefined) continue;
        archive.env[key] = value;
        movedEnvKeys += 1;
      }
    }
    delete this.state.env;

    if (movedRecords || movedEnvKeys) {
      console.log(`[bros] archived ${movedRecords} legacy record(s) and ${movedEnvKeys} environment field(s) from top-level state`);
    }
  }

  #repairIds() {
    this.#migrateToArchive();
    const archive = this.state.archive;

    // These collections did not all exist in early state files. Be deliberately
    // conservative here: a missing collection is healed, while existing audit
    // history is never discarded.
    let healed = 0;
    for (const key of ['messages', 'findings', 'log', 'advisories']) {
      if (!Array.isArray(this.state[key])) { this.state[key] = []; healed += 1; }
    }
    if (!this.state.agents || typeof this.state.agents !== 'object' || Array.isArray(this.state.agents)) { this.state.agents = {}; healed += 1; }
    if (!this.state.files || typeof this.state.files !== 'object' || Array.isArray(this.state.files)) { this.state.files = {}; healed += 1; }
    if (!this.state.aliases || typeof this.state.aliases !== 'object' || Array.isArray(this.state.aliases)) { this.state.aliases = {}; healed += 1; }
    if (!this.state.counters || typeof this.state.counters !== 'object') { this.state.counters = {}; healed += 1; }

    const kinds = [
      ['goal', 'G', archive.goals, (from, to) => archive.tasks.forEach((t) => { if (t.goal === from) t.goal = to; })],
      ['task', 'T', archive.tasks, null],
      ['finding', 'F', this.state.findings, (from, to) => {
        Object.values(this.state.files).forEach((f) => {
          f.findings = (f.findings || []).map((id) => (id === from ? to : id));
        });
        archive.fences.forEach((fence) => {
          if (Array.isArray(fence.appliesTo)) fence.appliesTo = fence.appliesTo.map((id) => (id === from ? to : id));
        });
      }],
      ['message', 'M', this.state.messages, null],
      ['poll', 'P', archive.polls, null],
      ['fence', 'FN', archive.fences, null],
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

    // Polls and tasks initially shipped after the rest of the board schema.
    // Heal the few fields needed to read old/draft archived records reliably.
    for (const poll of archive.polls) {
      if (!poll.votes || typeof poll.votes !== 'object' || Array.isArray(poll.votes)) { poll.votes = {}; healed += 1; }
      if (!Array.isArray(poll.eligible)) { poll.eligible = Object.keys(this.state.agents).filter((name) => !this.#isKicked(name)); healed += 1; }
      if (!poll.status) { poll.status = 'open'; healed += 1; }
      if (!poll.createdAt) { poll.createdAt = nowIso(); healed += 1; }
      if (!poll.updatedAt) { poll.updatedAt = poll.createdAt; healed += 1; }
    }
    for (const task of archive.tasks) {
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

  /**
   * Presence + one-line status only. Task ownership used to be folded in here,
   * but the task system is retired (see `archive`) — a compact roster is the
   * point, not a place to re-derive it.
   */
  roster() {
    return Object.values(this.state.agents).map((record) => {
      // role/scope may exist in restored pre-task-model state. Keep them on
      // disk for lossless migration, but never expose them as current identity.
      const { role: _legacyRole, scope: _legacyScope, ...a } = record;
      return {
        ...a,
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

  // ----------------------------------------------------------- tasks (archived)
  //
  // task_add/task_claim/task_update and the stale-claim/kick timers are
  // retired — see the engagement note at the top of this file. `addTask` and
  // `task` remain as internal plumbing only: `addFinding`'s `creates_task`
  // option still records a verification task, straight into the archive,
  // where it is readable via the `archive` tool but no longer claimable.

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
    this.state.archive.tasks.push(task);
    this.touch(from);
    this.save();
    this.#wake();
    return task;
  }

  task(id) {
    return this.state.archive.tasks.find((t) => t.id === id) || null;
  }

  // ----------------------------------------------------------- membership
  //
  // poll_create/poll_vote/polls and the automatic inactivity-kick generator
  // are retired — every poll a room ever held (including the ones that kicked
  // or restored an identity) is preserved verbatim in `archive.polls`. What
  // stays live is only the resulting membership flag on the agent record
  // itself, so a `membershipStatus: 'kicked'` from before this change keeps
  // blocking that identity; there is no tool left to kick or restore one.

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

  // ------------------------------------------------------------- fences (archived)
  //
  // A "fence" is a piece of Anza ground-truth that forecloses a class of
  // finding: a public §8 issue/PR published before we filed (prior-art —
  // RULES §8 excludes it), or a competitor's report Anza already accepted in
  // a given file (reworking that class wastes a burn). fence_add is retired
  // as a tool — new fences arrive only through this method directly (e.g. the
  // seed script) — but existing fence records stay live data: the Findings,
  // Submissions, and Advisories panels compare `publishedAt`/`mergedAt`
  // against a finding's `submittedAt` to render the collision warning, and
  // the false-negative cross-check reads `paths` on accepted_report fences.

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
    this.state.archive.fences.push(fence);
    this.touch(agent);
    this.save();
    return fence;
  }

  /** All fences, most recently published (falling back to added) first. */
  fences() {
    return [...this.state.archive.fences].sort((a, b) =>
      String(b.publishedAt || b.mergedAt || b.createdAt || '')
        .localeCompare(String(a.publishedAt || a.mergedAt || a.createdAt || '')));
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
    // Archived collections keep their agent references consistent too — a
    // rename should not leave old history pointing at a name nobody answers to.
    for (const t of this.state.archive.tasks) {
      if (t.owner === from) { t.owner = to; touched += 1; }
      if (t.lastOwner === from) t.lastOwner = to;
      t.participants = (t.participants || []).map((name) => (name === from ? to : name));
      if (t.createdBy === from) t.createdBy = to;
      for (const h of t.history || []) if (h.who === from) h.who = to;
    }
    for (const f of this.state.findings) if (f.by === from) { f.by = to; touched += 1; }
    for (const l of this.state.log) if (l.who === from) l.who = to;
    for (const poll of this.state.archive.polls) {
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
    const owns = this.state.archive.tasks.filter((t) => t.owner === name).map((t) => t.id);
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

  // -------------------------------------------------------------- snapshot
  //
  // digest generation is retired along with the rest of the ceremony it
  // summarised (tasks/goals/polls) — `archive.digests` still holds every
  // digest a room ever produced, readable through the `archive` tool.

  board(viewer) {
    return {
      room: this.state.room,
      you: viewer,
      agents: this.roster(),
      unreadForYou: viewer ? this.unread(viewer).length : 0,
      findings: this.state.findings.slice(-25),
      submissions: this.submissions(),
      advisories: this.advisories(),
      fences: this.fences(),
      coverage: this.coverage(),
      recentLog: this.state.log.slice(-15),
      conflicts: this.conflicts(),
    };
  }
}
