#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Room } from '../server/room.js';
import { createServer } from '../server/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_DIR = path.join(os.homedir(), '.claude-bros');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  v: (s) => `\x1b[35m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
};

const writeConfig = (config) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  fs.chmodSync(CONFIG_FILE, 0o600);
};

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// --------------------------------------------------------------------- serve

function serve(flags) {
  const port = Number(flags.port || process.env.BROS_PORT || 7777);
  const host = flags.host || '0.0.0.0';
  const name = flags.room || 'bounty';
  const dataFile = flags.data || path.join(ROOT, 'data', `${name}.json`);
  const token = flags['no-token'] ? null : flags.token || crypto.randomBytes(6).toString('hex');

  const room = new Room({ name, file: dataFile });
  const server = createServer({ room, token });

  server.listen(port, host, () => {
    const ips = lanAddresses();
    const lan = ips[0] || '127.0.0.1';
    const auth = token ? `&token=${token}` : '';

    console.log(`\n  ${c.v('claude-bros')} relay up — room ${c.b(name)}`);
    console.log(`  ${c.dim(`state: ${dataFile}`)}\n`);
    console.log(`  ${c.b('Dashboard')}  http://${lan}:${port}/${token ? `?token=${token}` : ''}`);
    if (ips.length > 1) console.log(`  ${c.dim(`other interfaces: ${ips.slice(1).join(', ')}`)}`);
    console.log(`\n  ${c.b('On THIS machine')} ${c.dim('— run inside the repo you are working in:')}\n`);
    console.log(`    ${c.g(`node ${path.join(ROOT, 'bin', 'claude-bros.js')} join http://${lan}:${port} --as <your-name>${token ? ` --token ${token}` : ''}`)}`);
    console.log(`\n  ${c.b('On the OTHER machine')} ${c.dim('— no git needed, it pulls the code from here:')}\n`);
    console.log(`    ${c.g(`mkdir -p ~/claude-bros && curl -fsSL "http://${lan}:${port}/bundle.tgz${token ? `?token=${token}` : ''}" | tar xz -C ~/claude-bros`)}`);
    console.log(`    ${c.g(`node ~/claude-bros/bin/claude-bros.js join http://${lan}:${port} --as <partner-name>${token ? ` --token ${token}` : ''}`)}`);
    console.log(`\n  ${c.dim('Ctrl-C to stop. State survives restarts.')}\n`);
  });

  server.on('error', (err) => {
    console.error(c.r(`\n  Could not listen on ${host}:${port} — ${err.message}\n`));
    if (err.code === 'EADDRINUSE') console.error(c.dim('  Another relay is probably already running. Try --port 7778.\n'));
    process.exit(1);
  });

  const bye = () => {
    console.log(c.dim('\n  relay down\n'));
    server.close(() => process.exit(0));
    // server.close() alone waits for keep-alive sockets to drain, and a browser
    // holding the dashboard open never drains. The old process then lingers and
    // keeps serving that pinned connection with stale code, so a restart looks
    // like it did nothing. Cut the connections, and hard-exit if anything stalls.
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

// ---------------------------------------------------------------------- join

function installHooks(projectDir) {
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      console.log(c.y(`  ! ${settingsPath} is not valid JSON — skipping hook install.`));
      return null;
    }
  }

  const cmd = `node ${path.join(ROOT, 'bin', 'claude-bros.js')} hook`;
  settings.hooks ||= {};

  const add = (event, command) => {
    settings.hooks[event] ||= [];
    const already = settings.hooks[event].some((entry) =>
      (entry.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('claude-bros.js hook')),
    );
    if (already) return false;
    settings.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 10 }] });
    return true;
  };

  const added = [add('Stop', `${cmd} --event stop`), add('SessionStart', `${cmd} --event session-start`)];
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, changed: added.some(Boolean) };
}

function join(positional, flags) {
  const base = (positional[0] || flags.url || '').replace(/\/+$/, '').replace(/\/mcp$/, '');
  const agent = flags.as || flags.agent;
  if (!base || !agent) {
    console.error(c.r('\n  Usage: claude-bros join <http://relay-host:7777> --as <name> [--token T] [--role "..."] [--scope "..."]\n'));
    process.exit(1);
  }

  const token = flags.token && flags.token !== true ? String(flags.token) : null;
  // Re-running join to refresh things should not wipe the role and scope.
  const prior = readConfig();
  const carried = prior && prior.agent === agent ? prior : {};
  const role = flags.role || carried.role || '';
  const scope = flags.scope || carried.scope || '';
  const params = new URLSearchParams({ agent });
  if (token) params.set('token', token);
  const mcpUrl = `${base}/mcp?${params}`;

  writeConfig({ url: base, agent, token, role, scope });
  console.log(`\n  ${c.v('claude-bros')} — joining as ${c.b(agent)}`);
  console.log(`  ${c.dim(`relay: ${base}`)}`);

  const health = spawnSync('node', ['-e', `
    fetch(${JSON.stringify(`${base}/healthz`)}).then(r => r.json())
      .then(j => { console.log('reachable, room: ' + j.room); })
      .catch(e => { console.error('UNREACHABLE: ' + e.message); process.exit(1); });
  `], { encoding: 'utf8' });
  if (health.status === 0) console.log(`  ${c.g('✓')} relay ${health.stdout.trim()}`);
  else {
    console.log(`  ${c.r('✗')} cannot reach the relay. Check the IP, the port, and the host firewall.`);
    console.log(`  ${c.dim('Continuing anyway — registration is local, you can retry the connection later.')}`);
  }

  const result = spawnSync('claude', ['mcp', 'add', '--transport', 'http', 'bros', mcpUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    console.log(`  ${c.y('!')} could not run \`claude mcp add\` automatically. Run this yourself:\n`);
    console.log(`    ${c.g(`claude mcp add --transport http bros "${mcpUrl}"`)}`);
  } else {
    console.log(`  ${c.g('✓')} MCP server "bros" registered for this directory`);
  }

  const hooks = installHooks(process.cwd());
  if (hooks) {
    console.log(`  ${c.g('✓')} wake-up hooks ${hooks.changed ? 'installed in' : 'already present in'} ${path.relative(process.cwd(), hooks.settingsPath)}`);
  }

  // BROS.md must track the protocol. Writing it only when absent let it rot
  // silently while the tool surface moved on underneath it.
  const memo = path.join(process.cwd(), 'BROS.md');
  const rendered = fs
    .readFileSync(path.join(ROOT, 'templates', 'BROS.md'), 'utf8')
    .replaceAll('{{AGENT}}', agent)
    .replaceAll('{{ROLE}}', role || 'to be agreed with your partner')
    .replaceAll('{{SCOPE}}', scope || 'to be agreed with your partner');
  const current = fs.existsSync(memo) ? fs.readFileSync(memo, 'utf8') : null;
  if (current === null) {
    fs.writeFileSync(memo, rendered);
    console.log(`  ${c.g('✓')} wrote BROS.md (the operating agreement for your agent)`);
  } else if (current !== rendered) {
    fs.writeFileSync(`${memo}.bak`, current);
    fs.writeFileSync(memo, rendered);
    console.log(`  ${c.g('✓')} refreshed BROS.md — it predated the current protocol (old copy: BROS.md.bak)`);
  } else {
    console.log(`  ${c.g('✓')} BROS.md already up to date`);
  }

  console.log(`\n  ${c.b('Now start Claude Code in this directory and open with:')}`);
  console.log(`    ${c.g(`"Read BROS.md. You are ${agent}. Join the board and let's start."`)}\n`);
}

// ---------------------------------------------------------------------- hook

async function hook(flags) {
  // A hook must never break the session: any failure exits 0 and stays quiet.
  const config = readConfig();
  if (!config) process.exit(0);

  let input = {};
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    /* no stdin, carry on */
  }

  const q = new URLSearchParams({ agent: config.agent });
  if (config.token) q.set('token', config.token);

  const get = async (route) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${config.url}${route}?${q}`, { signal: controller.signal });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  if (flags.event === 'session-start') {
    const board = await get('/api/board');
    if (!board) process.exit(0);
    const peers = board.agents.filter((a) => a.name !== config.agent);
    const context = [
      `[claude-bros] You are agent "${config.agent}" on the shared board "${board.room}".`,
      peers.length
        ? `Partners: ${peers.map((p) => `${p.name} (${p.online ? 'online' : 'offline'}) — ${p.status}`).join('; ')}`
        : 'No partners have joined yet.',
      `${board.tasks.open.length} open task(s), ${board.tasks.claimed.length} in progress, ${board.findings.length} finding(s).`,
      board.unreadForYou ? `You have ${board.unreadForYou} unread message(s) — call the inbox tool.` : '',
      'FIRST: call the bros `join` tool. It returns your full operating briefing for this engagement —',
      'the shared environment, the goals, what the board needs next, and the rules. Do not start work before reading it.',
    ].filter(Boolean).join('\n');

    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }));
    process.exit(0);
  }

  // Stop: if mail is waiting, keep the agent awake so it can respond to its partner.
  const unread = await get('/api/unread');
  if (!unread?.count) process.exit(0);

  const counterFile = path.join(CONFIG_DIR, 'wakeups.json');
  let counters = {};
  try {
    counters = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
  } catch {
    /* first run */
  }
  const key = input.session_id || 'default';
  const entry = counters[key] || { count: 0, ts: 0 };
  // Consecutive wake-ups only count within a short window; a quiet gap resets it.
  if (Date.now() - entry.ts > 120_000) entry.count = 0;

  // The cap stops a chatty partner looping you forever, but an URGENT message
  // is the case the cap must not swallow.
  const urgent = unread.messages.some((m) => m.urgent);
  const limit = Number(process.env.BROS_MAX_WAKEUPS || 5);
  if (entry.count >= limit && !urgent) process.exit(0);

  entry.count += 1;
  entry.ts = Date.now();
  counters[key] = entry;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(counterFile, JSON.stringify(counters));
  } catch {
    /* best effort */
  }

  const preview = unread.messages
    .slice(0, 5)
    .map((m) => `- ${m.from}${m.urgent ? ' (URGENT)' : ''}: ${m.text.slice(0, 300)}`)
    .join('\n');

  console.log(JSON.stringify({
    decision: 'block',
    reason:
      `[claude-bros] ${urgent ? '** URGENT ** ' : ''}${unread.count} unread message(s) from your partner:\n${preview}\n\n` +
      (urgent ? 'At least one is URGENT — deal with it before anything else, and reply so they know you saw it.\n' : '') +
      'Call the bros inbox tool to read them properly, then act on them. ' +
      'If nothing there needs action, update your status and stop.',
  }));
  process.exit(0);
}

// -------------------------------------------------------------------- rename

/** Rewrites every `bros` MCP registration that points at `from`. */
function reregister(from, to) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  let projects;
  try {
    projects = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')).projects || {};
  } catch {
    return [];
  }

  const updated = [];
  for (const [dir, cfg] of Object.entries(projects)) {
    const current = cfg.mcpServers?.bros?.url;
    if (!current || !current.includes(`agent=${encodeURIComponent(from)}`)) continue;
    const next = current.replace(`agent=${encodeURIComponent(from)}`, `agent=${encodeURIComponent(to)}`);
    if (!fs.existsSync(dir)) {
      console.log(`  ${c.y('!')} ${dir} no longer exists — skipping`);
      continue;
    }
    spawnSync('claude', ['mcp', 'remove', 'bros'], { cwd: dir, stdio: 'ignore' });
    const add = spawnSync('claude', ['mcp', 'add', '--transport', 'http', 'bros', next], { cwd: dir, stdio: 'ignore' });
    if (add.status === 0) updated.push(dir);
    else console.log(`  ${c.y('!')} could not re-register in ${dir}, do it by hand:\n    claude mcp add --transport http bros "${next}"`);
  }
  return updated;
}

async function rename(positional) {
  const [from, to] = positional;
  if (!from || !to) {
    console.error(c.r('\n  Usage: claude-bros rename <current-name> <new-name>\n'));
    process.exit(1);
  }
  if (/[^a-zA-Z0-9._-]/.test(to)) {
    console.error(c.r(`\n  "${to}" has characters that break URLs and shell commands.`));
    console.error(`  ${c.dim('Use letters, numbers, dots, dashes and underscores — e.g. "nigolla-tesla".')}\n`);
    process.exit(1);
  }

  const config = readConfig();
  const isMe = config?.agent === from;
  const result = await remote('/api/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });

  if (result.ok) {
    console.log(`\n  ${c.g('✓')} board updated: ${c.b(from)} → ${c.b(to)} ${c.dim(`(${result.references} references moved)`)}`);
  } else if (isMe && /No agent called/.test(result.error || '')) {
    // Someone already renamed us on the board; this machine just needs to catch up.
    console.log(`\n  ${c.dim('board was already renamed — updating this machine only')}`);
  } else {
    console.error(c.r(`\n  ${result.error}\n`));
    process.exit(1);
  }

  if (isMe) {
    writeConfig({ ...config, agent: to });
    console.log(`  ${c.g('✓')} your local config now says ${c.b(to)}`);
    const dirs = reregister(from, to);
    for (const dir of dirs) console.log(`  ${c.g('✓')} MCP re-registered in ${dir}`);
    console.log(`\n  ${c.y('Restart Claude Code')} in that directory — it is still connected as ${from}.\n`);
  } else {
    console.log(`\n  ${c.y('!')} ${from} runs on another machine. They must run this there:`);
    console.log(`    ${c.g(`node ~/claude-bros/bin/claude-bros.js rename ${from} ${to}`)}`);
    console.log(`  ${c.dim('...or their Claude Code will keep reconnecting under the old name.')}\n`);
  }
}

async function forget(positional, flags) {
  const [name] = positional;
  if (!name) {
    console.error(c.r('\n  Usage: claude-bros forget <agent-name> [--force]\n'));
    process.exit(1);
  }
  const config = readConfig();
  if (config?.agent === name && !flags.force) {
    console.error(c.r(`\n  "${name}" is THIS machine's agent. Removing it would leave your Claude Code`));
    console.error(`  ${c.dim('connected to a name that is not on the board. Rename it instead, or pass --force.')}\n`);
    process.exit(1);
  }

  const result = await remote('/api/forget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, force: Boolean(flags.force) }),
  });
  if (!result.ok) {
    console.error(c.r(`\n  ${result.error}\n`));
    process.exit(1);
  }
  console.log(`\n  ${c.g('✓')} removed ${c.b(name)} from the roster`);
  if (result.keptMessages) {
    console.log(`  ${c.dim(`${result.keptMessages} message(s) kept — what they said is still on the board.`)}`);
  }
  console.log('');
}

// -------------------------------------------------------------------- doctor

async function doctor() {
  const pass = (m) => console.log(`  ${c.g('✓')} ${m}`);
  const fail = (m, fix) => {
    console.log(`  ${c.r('✗')} ${m}`);
    if (fix) console.log(`    ${c.y('→')} ${fix}`);
    problems += 1;
  };
  let problems = 0;

  console.log(`\n  ${c.v('claude-bros doctor')}`);
  console.log(`  ${c.dim(`checking directory: ${process.cwd()}`)}\n`);

  const config = readConfig();
  if (!config) {
    fail('You have never run `join` on this machine.', 'Run the join command from your setup guide.');
    console.log(`\n  ${c.r('Stopping — nothing else can work without that.')}\n`);
    process.exit(1);
  }
  pass(`You are ${c.b(config.agent)}, relay ${config.url}`);

  // 1. Is the relay reachable at all?
  let health;
  try {
    const res = await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) });
    health = await res.json();
    pass(`Relay reachable — room "${health.room}"`);
  } catch (err) {
    fail(`Cannot reach the relay (${err.message})`,
      'The other machine must be running `serve`, and you must be on the same network. Check the IP.');
    console.log(`\n  ${c.r('Stopping — fix the network first.')}\n`);
    process.exit(1);
  }

  // 2. Is the token right?
  const q = new URLSearchParams({ agent: config.agent });
  if (config.token) q.set('token', config.token);
  const boardRes = await fetch(`${config.url}/api/board?${q}`);
  if (boardRes.status === 401) {
    fail('Token rejected.', 'Get the exact token from your partner and re-run join.');
    process.exit(1);
  }
  pass('Token accepted');

  // 3. Is the MCP server registered for THIS directory? (the usual mistake)
  let registered = null;
  try {
    const claudeJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    registered = claudeJson.projects?.[process.cwd()]?.mcpServers?.bros?.url || null;
  } catch {
    /* fall through to the failure below */
  }
  if (!registered) {
    fail('No "bros" MCP server registered for this directory.',
      `You are in ${process.cwd()} — is this really your bug bounty repo? Re-run join here.`);
  } else if (!registered.includes(`agent=${config.agent}`)) {
    fail(`Registered URL says a different agent name: ${registered}`,
      'Re-run join with the right --as name.');
  } else {
    pass('MCP server registered for this directory');
  }

  // 4. Hooks
  const settingsPath = path.join(process.cwd(), '.claude', 'settings.local.json');
  let hooked = false;
  try {
    hooked = JSON.stringify(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).includes('claude-bros.js hook');
  } catch {
    /* not installed */
  }
  if (hooked) pass('Wake-up hooks installed');
  else fail('Wake-up hooks missing.', 'Re-run join in this directory. Without them nobody wakes you.');

  // 5. The real proof: an actual MCP call over the wire, as you. `board` is
  //    read-only, so this checks in without overwriting whatever role and
  //    scope your agent has already set for itself.
  try {
    const res = await fetch(`${config.url}/mcp?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board', arguments: {} } }),
    });
    const out = await res.json();
    if (out.result?.content?.[0]?.text?.includes(`you are "${config.agent}"`)) {
      pass(`MCP call succeeded — the relay sees you as ${c.b(config.agent)}`);
    } else {
      fail(`Relay did not recognise your identity: ${JSON.stringify(out).slice(0, 200)}`);
    }
  } catch (err) {
    fail(`MCP call failed: ${err.message}`);
  }

  // 6. Who else is actually there?
  const board = await (await fetch(`${config.url}/api/board?${q}`)).json();
  const others = board.agents.filter((a) => a.name !== config.agent);
  console.log(`\n  ${c.b('On the board:')}`);
  for (const a of board.agents) {
    console.log(`    ${a.online ? c.g('●') : c.dim('○')} ${a.name}${a.name === config.agent ? c.dim(' (you)') : ''} ${c.dim(`— ${a.role || 'no role'}`)}`);
  }
  if (!others.length) {
    console.log(`\n  ${c.y('!')} Nobody else has joined yet.`);
    console.log(`    ${c.dim('Your partner has not made a single tool call. Have them run')}`);
    console.log(`    ${c.dim('this same doctor command on their machine.')}`);
  }

  console.log(
    problems
      ? `\n  ${c.r(`${problems} problem(s) above — fix the ✗ lines.`)}\n`
      : `\n  ${c.g('All good.')} ${c.dim('Restart Claude Code in this directory if you have not since joining.')}\n`,
  );
  process.exit(problems ? 1 : 0);
}

// ------------------------------------------------------------ board / send

async function remote(route, options) {
  const config = readConfig();
  if (!config) {
    console.error(c.r('\n  Not joined yet. Run: claude-bros join <url> --as <name>\n'));
    process.exit(1);
  }
  const q = new URLSearchParams({ agent: config.agent });
  if (config.token) q.set('token', config.token);
  try {
    const res = await fetch(`${config.url}${route}?${q}`, options);
    return await res.json();
  } catch (err) {
    console.error(c.r(`\n  Relay unreachable at ${config.url} — ${err.message}\n`));
    process.exit(1);
  }
}

async function board(flags) {
  const render = async () => {
    const b = await remote('/api/board');
    const out = [`\n  ${c.v('room')} ${c.b(b.room)}   ${c.dim(new Date().toLocaleTimeString())}\n`];
    out.push(`  ${c.b('AGENTS')}`);
    for (const a of b.agents) {
      out.push(`    ${a.online ? c.g('●') : c.dim('○')} ${c.b(a.name)} ${c.dim(a.role)}`);
      out.push(`      ${a.status} ${c.dim(`(${a.lastSeenAgo})`)}`);
    }
    const list = (label, items, fmt) => {
      out.push(`\n  ${c.b(label)}`);
      if (!items.length) out.push(`    ${c.dim('none')}`);
      for (const i of items) out.push(`    ${fmt(i)}`);
    };
    list('OPEN', b.tasks.open, (t) => `${c.v(t.id)} ${t.title}`);
    list('IN PROGRESS', b.tasks.claimed, (t) => `${c.v(t.id)} ${t.title} ${c.dim(`— ${t.owner}`)}`);
    list('FINDINGS', b.findings, (f) => {
      const sev = ['high', 'critical'].includes(f.severity) ? c.r(f.severity) : f.severity === 'medium' ? c.y(f.severity) : c.dim(f.severity);
      return `${c.v(f.id)} [${sev}/${f.status}] ${f.title} ${c.dim(`— ${f.by}`)}`;
    });
    out.push('');
    return out.join('\n');
  };

  if (flags.watch) {
    for (;;) {
      process.stdout.write('\x1b[2J\x1b[H' + (await render()));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log(await render());
}

async function send(positional, flags) {
  const text = positional.join(' ');
  if (!text) {
    console.error(c.r('\n  Usage: claude-bros send "message" [--to the-mentalist] [--urgent]\n'));
    process.exit(1);
  }
  await remote('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, to: flags.to || 'all', urgent: Boolean(flags.urgent), from: flags.from || 'human' }),
  });
  console.log(c.g(`\n  sent to ${flags.to || 'everyone'}\n`));
}

// ---------------------------------------------------------------------- main

const HELP = `
  ${c.v('claude-bros')} — let Claude Code agents on different machines work together

  ${c.b('claude-bros serve')} [--port 7777] [--room name] [--token T | --no-token]
      Run the relay. One machine only; the other connects to it over the LAN.

  ${c.b('claude-bros join')} <http://host:7777> --as <name> [--token T] [--role "..."] [--scope "..."]
      Point this machine's Claude Code at the relay: registers the MCP server,
      installs the wake-up hooks, and writes BROS.md. Run inside your work repo.

  ${c.b('claude-bros rename')} <current> <new>
      Rename an agent everywhere — board, tasks, findings, message history —
      and re-point this machine's MCP registration at the new name.

  ${c.b('claude-bros forget')} <name> [--force]
      Remove an agent from the roster. Refuses if it still owns tasks, findings
      or file reviews. Messages it sent are always kept.

  ${c.b('claude-bros doctor')}
      Check this machine end to end and say exactly what is wrong. Run it
      inside your bug bounty repo. Start here when something is not working.

  ${c.b('claude-bros board')} [--watch]        Show the shared board in your terminal.
  ${c.b('claude-bros send')} "text" [--to X]   Message the agents yourself, as a human.
`;

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseArgs(rest);

switch (command) {
  case 'serve': serve(flags); break;
  case 'join': join(positional, flags); break;
  case 'hook': await hook(flags); break;
  case 'rename': await rename(positional); break;
  case 'forget': await forget(positional, flags); break;
  case 'doctor': await doctor(); break;
  case 'board': await board(flags); break;
  case 'send': await send(positional, flags); break;
  default:
    console.log(HELP);
    process.exit(command && command !== 'help' && command !== '--help' ? 1 : 0);
}
