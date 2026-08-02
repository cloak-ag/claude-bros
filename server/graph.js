/**
 * The board is already a graph — goals, tasks, findings, files and agents all
 * reference each other. This turns those references into nodes and edges so
 * both the dashboard and the agents can ask "what is connected to this?".
 *
 * Node types are distinguished by SHAPE in the UI, not colour: only three hues
 * clear the colourblind-separation gate for scattered marks, so colour is spent
 * on status (where are the problems) which is the more useful question.
 */

/** Everything that looks like a source path, so finding targets can hit files. */
const PATH_RE = /[\w.@-]+(?:\/[\w.@-]+)+\.[a-z]{1,5}/gi;

const severityWeight = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * Findings record their location as prose — "votor/src/common.rs:29 (DELTA_TIMEOUT),
 * votor/src/timer_manager/timers.rs:86-140". Pull the paths back out so a finding
 * links to every file it actually names, not just the one that was linked explicitly.
 */
function pathsIn(text, known) {
  const found = new Set();
  for (const raw of String(text || '').match(PATH_RE) || []) {
    if (known.has(raw)) { found.add(raw); continue; }
    // A finding may name a path with more or fewer leading segments than the
    // coverage map uses; match on suffix so both forms meet.
    for (const path of known) {
      if (path.endsWith(raw) || raw.endsWith(path)) { found.add(path); break; }
    }
  }
  return [...found];
}

export function buildGraph(state) {
  const nodes = [];
  const edges = [];
  const add = (node) => { nodes.push(node); return node.id; };
  const link = (from, to, kind, inferred = false) => {
    if (!from || !to || from === to) return;
    edges.push({ from, to, kind, inferred });
  };

  const knownFiles = new Set(Object.keys(state.files || {}));

  for (const agent of Object.values(state.agents || {})) {
    const online = Date.now() - (agent.lastSeen || 0) < 90_000;
    const currentTasks = (state.tasks || [])
      .filter((task) => task.owner === agent.name && ['claimed', 'blocked'].includes(task.status));
    const tasksTaken = (state.tasks || []).filter((task) =>
      (task.participants || []).includes(agent.name)
      || task.owner === agent.name
      || task.lastOwner === agent.name
      || (task.history || []).some((entry) => entry.who === agent.name && entry.what === 'claimed'));
    const completed = tasksTaken.filter((task) => task.status === 'done');
    add({
      id: `agent:${agent.name}`, type: 'agent', label: agent.name,
      status: online ? 'good' : 'idle',
      detail: currentTasks.length
        ? `current: ${currentTasks.map((task) => `${task.id} ${task.title}`).join('; ')}`
        : 'available — no current task',
      meta: {
        online,
        currentTasks: currentTasks.map((task) => task.id),
        tasksTaken: tasksTaken.map((task) => task.id),
        completed: completed.map((task) => ({ id: task.id, title: task.title, notes: task.notes || '' })),
      },
    });
  }

  for (const goal of state.goals || []) {
    const own = (state.tasks || []).filter((t) => t.goal === goal.id);
    const done = own.filter((t) => t.status === 'done').length;
    add({
      id: `goal:${goal.id}`, type: 'goal', label: goal.id,
      status: goal.status === 'done' ? 'good' : goal.status === 'dropped' ? 'idle' : 'open',
      detail: goal.title,
      meta: { done, total: own.length, percent: own.length ? Math.round((done / own.length) * 100) : 0 },
    });
  }

  for (const task of state.tasks || []) {
    add({
      id: `task:${task.id}`, type: 'task', label: task.id,
      status: task.status === 'done' ? 'good' : task.status === 'blocked' ? 'warn' : 'open',
      detail: task.title,
      meta: { state: task.status, owner: task.owner || null },
    });
    link(`task:${task.id}`, `goal:${task.goal}`, 'serves');
    if (task.owner) link(`agent:${task.owner}`, `task:${task.id}`, task.status === 'done' ? 'built' : 'working_on');
    for (const entry of task.history || []) {
      if (entry.what !== 'claimed' || entry.who === task.owner) continue;
      link(`agent:${entry.who}`, `task:${task.id}`, 'worked_on');
    }
    const dep = task.dependsOn || task.depends_on;
    if (dep) link(`task:${task.id}`, `task:${dep}`, 'depends');
  }

  for (const file of Object.values(state.files || {})) {
    const verdicts = new Set((file.reviews || []).map((r) => r.verdict));
    const status =
      verdicts.has('vulnerable') ? 'bad'
        : verdicts.size > 1 ? 'warn'
          : verdicts.has('suspicious') ? 'warn'
            : verdicts.has('clean') ? 'good' : 'open';
    add({
      id: `file:${file.path}`, type: 'file', label: file.path.split('/').pop(),
      status,
      detail: file.path,
      meta: {
        reviewers: (file.reviews || []).map((r) => r.agent),
        verdicts: [...verdicts],
        disputed: verdicts.size > 1,
      },
    });
    for (const review of file.reviews || []) link(`agent:${review.agent}`, `file:${file.path}`, 'reviewed');
  }

  for (const finding of state.findings || []) {
    add({
      id: `finding:${finding.id}`, type: 'finding', label: finding.id,
      status: finding.status === 'rejected' ? 'idle'
        : ['critical', 'high'].includes(finding.severity) ? 'bad'
          : finding.severity === 'medium' ? 'warn'
            : finding.status === 'confirmed' ? 'good' : 'open',
      detail: finding.title,
      meta: { severity: finding.severity, state: finding.status, by: finding.by, weight: severityWeight[finding.severity] ?? 0 },
    });
    if (finding.by) link(`agent:${finding.by}`, `finding:${finding.id}`, 'reported');
    if (finding.verificationTask) link(`finding:${finding.id}`, `task:${finding.verificationTask}`, 'verified_by');

    // Explicit links recorded on the file itself.
    for (const [path, file] of Object.entries(state.files || {})) {
      if ((file.findings || []).includes(finding.id)) link(`finding:${finding.id}`, `file:${path}`, 'found_in');
    }
    // Plus anything the finding names in prose.
    for (const path of pathsIn(`${finding.target} ${finding.evidence}`, knownFiles)) {
      if (!edges.some((e) => e.from === `finding:${finding.id}` && e.to === `file:${path}`)) {
        link(`finding:${finding.id}`, `file:${path}`, 'found_in', true);
      }
    }
  }

  // Drop edges pointing at nodes that do not exist (a task naming a dead goal).
  const ids = new Set(nodes.map((n) => n.id));
  const live = edges.filter((e) => ids.has(e.from) && ids.has(e.to));

  const degree = new Map();
  for (const e of live) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;

  return { nodes, edges: live };
}

/**
 * What an agent needs: everything touching one thing, and how it is connected.
 * `hops` of 2 pulls in the second ring — the files a finding names, plus who
 * else reviewed those files.
 */
export function relatedTo(state, query, hops = 1) {
  const { nodes, edges } = buildGraph(state);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const needle = String(query || '').toLowerCase();
  const start = nodes.find((n) => n.id.toLowerCase() === needle)
    || nodes.find((n) => n.label.toLowerCase() === needle)
    || nodes.find((n) => n.id.toLowerCase().endsWith(`:${needle}`))
    || nodes.find((n) => n.detail?.toLowerCase() === needle)
    || nodes.find((n) => n.detail?.toLowerCase().includes(needle));
  if (!start) return null;

  const seen = new Map([[start.id, 0]]);
  const trail = [];
  let frontier = [start.id];
  for (let depth = 1; depth <= hops; depth += 1) {
    const next = [];
    for (const id of frontier) {
      for (const e of edges) {
        const other = e.from === id ? e.to : e.to === id ? e.from : null;
        if (!other) continue;
        trail.push({ ...e, depth });
        if (seen.has(other)) continue;
        seen.set(other, depth);
        next.push(other);
      }
    }
    frontier = next;
  }

  return {
    start,
    hops,
    neighbours: [...seen.entries()]
      .filter(([id]) => id !== start.id)
      .map(([id, depth]) => ({ ...byId.get(id), depth }))
      .sort((a, b) => a.depth - b.depth || b.degree - a.degree),
    edges: trail.filter((e, i, all) => all.findIndex((x) => x.from === e.from && x.to === e.to && x.kind === e.kind) === i),
  };
}
