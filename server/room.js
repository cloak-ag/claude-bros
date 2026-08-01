import fs from 'node:fs';
import path from 'node:path';

const ONLINE_WINDOW_MS = 90_000;
const STATUS_STALE_MS = 5 * 60_000;      // a status older than this is not "what they are doing"
const CLAIM_STALE_MS = 30 * 60_000;      // an owner silent this long no longer holds their claim
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
  constructor({ name, file }) {
    this.name = name;
    this.file = file;
    this.waiters = [];
    this.saveTimer = null;
    this.state = {
      room: name,
      createdAt: nowIso(),
      agents: {},
      messages: [],
      tasks: [],
      findings: [],
      goals: [],
      files: {},
      env: {},
      digests: [],
      log: [],
      aliases: {},
      counters: { message: 0, task: 0, finding: 0, goal: 0, seq: 0 },
    };
    this.#load();
  }

  #load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const disk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Counters must MERGE, not replace. A file written before a counter
      // existed leaves it undefined, and `undefined + 1` is NaN — which then
      // mints ids like "GNaN" that nothing can ever reference.
      this.state = { ...this.state, ...disk, counters: { ...this.state.counters, ...(disk.counters || {}) } };
      this.#repairIds();
      // Nobody is online across a restart until they check in again.
      for (const agent of Object.values(this.state.agents)) agent.lastSeen = 0;
    } catch (err) {
      console.error(`[bros] could not read ${this.file}, starting fresh:`, err.message);
    }
  }

  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
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
    const kinds = [
      ['goal', 'G', this.state.goals, (from, to) => this.state.tasks.forEach((t) => { if (t.goal === from) t.goal = to; })],
      ['task', 'T', this.state.tasks, null],
      ['finding', 'F', this.state.findings, (from, to) => Object.values(this.state.files).forEach((f) => {
        f.findings = (f.findings || []).map((id) => (id === from ? to : id));
      })],
      ['message', 'M', this.state.messages, null],
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
    if (repaired) {
      console.log(`[bros] repaired ${repaired} malformed id(s) from an older state file`);
      this.save();
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
      role: '',
      scope: '',
      status: 'idle',
      joinedAt: nowIso(),
      lastSeen: 0,
    });
    agent.lastSeen = Date.now();
    this.save();
    return agent;
  }

  join(name, { role = '', scope = '' , host = null } = {}) {
    // Two machines under one name is the worst failure mode: statuses overwrite
    // and neither side can message the other. Refuse rather than warn, unless
    // the machine holding the name has gone quiet long enough to be gone.
    const existing = this.state.agents[name];
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
    if (role) agent.role = role;
    if (scope) agent.scope = scope;
    // Reading the briefing is what `join` is for; record that it happened so
    // agents that arrived before the briefing existed can be nagged into it.
    agent.briefedAt = nowIso();
    if (fresh) this.note(name, `joined as ${role || 'agent'}`);
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
    return Object.values(this.state.agents).map((a) => ({
      ...a,
      online: Date.now() - (a.lastSeen || 0) < ONLINE_WINDOW_MS,
      statusAgeMs: Date.now() - (a.statusAt || 0),
      statusStale: Date.now() - (a.statusAt || 0) > STATUS_STALE_MS,
      lastSeenAgo: a.lastSeen ? `${Math.round((Date.now() - a.lastSeen) / 1000)}s ago` : 'never',
    }));
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

    this.state.counters.seq = (Number(this.state.counters.seq) || 0) + 1;
    const msg = {
      id: this.#id('message', 'M'),
      seq: this.state.counters.seq,
      from,
      to,
      text,
      urgent: Boolean(urgent),
      replyTo: replyTo || null,
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

  addTask(from, { title, scope = '', notes = '', assignTo = '' }) {
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
    };
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
      if (task.status !== 'claimed' || !task.owner) continue;
      const owner = this.state.agents[task.owner];
      const quiet = Date.now() - (owner?.lastSeen || 0);
      if (quiet < CLAIM_STALE_MS) continue;
      task.history.push({ ts: nowIso(), who: 'system', what: `claim lapsed — ${task.owner} silent ${Math.round(quiet / 60000)} min` });
      task.lastOwner = task.owner;
      task.owner = null;
      task.status = 'open';
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
    this.releaseStaleClaims();
    const task = this.task(id);
    if (!task) return { ok: false, error: `No task ${id}.` };
    if (task.owner && task.owner !== agent && task.status !== 'open') {
      const owner = this.state.agents[task.owner];
      const quiet = Math.round((Date.now() - (owner?.lastSeen || 0)) / 60000);
      return {
        ok: false,
        error: `${id} is being worked by ${task.owner} (last active ${quiet} min ago). Pick another one — `
          + `it frees up automatically after 30 min of their silence.`,
        task,
      };
    }
    if (task.status === 'done') return { ok: false, error: `${id} is already done.`, task };
    task.owner = agent;
    task.status = 'claimed';
    task.updatedAt = nowIso();
    task.history.push({ ts: nowIso(), who: agent, what: 'claimed' });
    this.touch(agent);
    this.save();
    return { ok: true, task };
  }

  updateTask(agent, id, { status, notes }) {
    const task = this.task(id);
    if (!task) return { ok: false, error: `No task ${id}.` };
    if (status) task.status = status;
    if (notes) task.notes = task.notes ? `${task.notes}\n${notes}` : notes;
    task.updatedAt = nowIso();
    task.history.push({ ts: nowIso(), who: agent, what: `${status || 'note'}${notes ? `: ${notes}` : ''}` });
    this.touch(agent);
    this.save();
    return { ok: true, task };
  }

  tasks(status) {
    const all = this.state.tasks;
    return status ? all.filter((t) => t.status === status) : all;
  }

  // -------------------------------------------------------------- findings

  addFinding(agent, { title, severity = 'info', target = '', evidence = '', repro = '' }) {
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
    return finding;
  }

  updateFinding(agent, id, { status, note }) {
    const finding = this.state.findings.find((f) => f.id === id);
    if (!finding) return { ok: false, error: `No finding ${id}.` };
    if (status) finding.status = status;
    if (note) finding.evidence = finding.evidence ? `${finding.evidence}\n[${agent}] ${note}` : `[${agent}] ${note}`;
    this.save();
    return { ok: true, finding };
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
      if (t.createdBy === from) t.createdBy = to;
      for (const h of t.history || []) if (h.who === from) h.who = to;
    }
    for (const f of this.state.findings) if (f.by === from) { f.by = to; touched += 1; }
    for (const l of this.state.log) if (l.who === from) l.who = to;

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
      return { ok: false, error: `"${name}" is ONLINE right now — it is somebody's running session. Stop that Claude Code first, or pass --force.` };
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
      goals: this.goals(),
      coverage: this.coverage(),
      env: this.state.env,
      recentLog: this.state.log.slice(-15),
      digests: this.state.digests.slice(-3),
      conflicts: this.conflicts(),
    };
  }
}
