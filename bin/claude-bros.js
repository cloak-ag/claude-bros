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

function tailscaleAddress() {
  try {
    const out = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 2000 });
    if (out.status === 0) {
      const ip = out.stdout.trim().split(/\s+/)[0];
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    }
  } catch {}
  return null;
}

// --------------------------------------------------------------------- serve

function serve(flags) {
  // Cloud Run injects PORT, we also support BROS_PORT for local override
  const port = Number(flags.port || process.env.PORT || process.env.BROS_PORT || 7777);
  const host = flags.host || '0.0.0.0';
  const name = flags.room || 'bounty';
  const dataFile = flags.data || path.join(ROOT, 'data', `${name}.json`);
  // Token priority: --no-token > --token > BROS_TOKEN env > auto-generate
  let token = null;
  if (flags['no-token']) {
    token = null;
  } else if (flags.token) {
    token = String(flags.token);
  } else if (process.env.BROS_TOKEN) {
    token = process.env.BROS_TOKEN;
  } else {
    token = crypto.randomBytes(6).toString('hex');
  }

  const room = new Room({ name, file: dataFile });
  const server = createServer({ room, token });

  server.listen(port, host, () => {
    const ips = lanAddresses();
    const lan = ips[0] || '127.0.0.1';
    const ts = tailscaleAddress();
    const auth = token ? `&token=${token}` : '';

    // Post a system note so running agents learn about updates without restart
    room.note('system', 'RELAY_UPDATED: new tools available — use /api/tool/<name> now, re-join on next restart');
    room.save();

    console.log(`\n  ${c.v('claude-bros')} relay up — room ${c.b(name)}`);
    console.log(`  ${c.dim(`state: ${dataFile}`)}\n`);
    console.log(`  ${c.b('Dashboard (LAN)')}  http://${lan}:${port}/${token ? `?token=${token}` : ''}`);
    if (ts) console.log(`  ${c.b('Dashboard (Tailscale)')}  http://${ts}:${port}/${token ? `?token=${token}` : ''} ${c.g('← works across networks')}`);
    if (ips.length > 1) console.log(`  ${c.dim(`other LAN interfaces: ${ips.slice(1).join(', ')}`)}`);
    console.log(`\n  ${c.b('On THIS machine')} ${c.dim('— run inside the repo you are working in:')}\n`);
    const primary = ts || lan;
    console.log(`    ${c.g(`node ${path.join(ROOT, 'bin', 'claude-bros.js')} join http://${primary}:${port} --as <your-name>${token ? ` --token ${token}` : ''}`)}`);
    console.log(`\n  ${c.b('On the OTHER machine')} ${c.dim('— no git needed, it pulls the code from here:')}\n`);
    console.log(`    ${c.g(`mkdir -p ~/claude-bros && curl -fsSL "http://${primary}:${port}/bundle.tgz${token ? `?token=${token}` : ''}" | tar xz -C ~/claude-bros`)}`);
    console.log(`    ${c.g(`node ~/claude-bros/bin/claude-bros.js join http://${primary}:${port} --as <partner-name>${token ? ` --token ${token}` : ''}`)}`);
    if (ts && !flags['no-tailscale-note']) {
      console.log(`\n  ${c.g('Tip:')} Tailscale detected — the Tailscale URL works from anywhere your tailnet reaches. No LAN required.`);
    }
    console.log(`\n  ${c.dim('Ctrl-C to stop. State survives restarts.')}\n`);
  });

  server.on('error', (err) => {
    console.error(c.r(`\n  Could not listen on ${host}:${port} — ${err.message}`));
    process.exit(1);
  });
}

// ---------------------------------------------------------------------- join

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

  // Try LAN first, then Tailscale fallback
  let mcpUrl = null;
  let workingUrl = null;
  const urlsToTry = [base];

  // If base is a LAN IP, also try Tailscale
  if (/^https?:\/\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(base)) {
    try {
      const ts = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 2000 });
      if (ts.status === 0) {
        const tsIp = ts.stdout.trim().split(/\s+/)[0];
        if (tsIp && /^\d+\.\d+\.\d+\.\d+$/.test(tsIp)) {
          const tsUrl = base.replace(/https?:\/\/[^:]+/, `http://${tsIp}`);
          if (!urlsToTry.includes(tsUrl)) urlsToTry.push(tsUrl);
        }
      }
    } catch {}
  }

  for (const url of urlsToTry) {
    const params = new URLSearchParams({ agent });
    if (token) params.set('token', token);
    const testUrl = `${url}/mcp?${params}`;
    const health = spawnSync('node', ['-e', `
      fetch(${JSON.stringify(`${url}/healthz`)}).then(r => r.json())
        .then(j => { console.log('reachable: ' + url); process.exit(0); })
        .catch(e => { process.exit(1); });
    `], { encoding: 'utf8' });
    if (health.status === 0) {
      workingUrl = url;
      mcpUrl = testUrl;
      break;
    }
  }

  if (!workingUrl) {
    // Last resort: use the original URL anyway, registration is local
    const params = new URLSearchParams({ agent });
    if (token) params.set('token', token);
    mcpUrl = `${base}/mcp?${params}`;
    workingUrl = base;
    console.log(`  ${c.y('!')} could not reach relay — using original URL anyway (you can retry later)`);
  }

  writeConfig({ url: base, agent, token, role, scope, fallbackUrl: workingUrl });
  console.log(`\n  ${c.v('claude-bros')} — joining as ${c.b(agent)}`);
  console.log(`  ${c.dim(`relay: ${workingUrl}`)}${workingUrl !== base ? ` ${c.g('(Tailscale fallback)')}` : ''}`);

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

async function installHooks(cwd) {
  const local = path.join(cwd, '.claude', 'settings.json');
  const global = path.join(os.homedir(), '.claude', 'settings.json');
  const targets = fs.existsSync(local) ? [local] : [global];
  let changed = false;
  let settingsPath = targets[0];

  for (const target of targets) {
    let settings = { hooks: {} };
    try {
      settings = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      settings = { hooks: {} };
    }
    settings.hooks = settings.hooks || {};
    settings.hooks.Stop = settings.hooks.Stop || [];
    const hasOurs = settings.hooks.Stop.some(
      (h) => h.command && h.command.includes('claude-bros.js hook --event stop'),
    );
    if (!hasOurs) {
      settings.hooks.Stop.push({
        command: `node ${path.join(ROOT, 'bin', 'claude-bros.js')} hook --event stop`,
        matchers: [],
      });
      fs.writeFileSync(target, JSON.stringify(settings, null, 2));
      changed = true;
      settingsPath = target;
    }
  }
  if (changed) return { changed, settingsPath };
  return { changed: false, settingsPath };
}

function hook(flags) {
  if (flags.event === 'stop') {
    const config = readConfig();
    if (!config || !config.url || !config.agent) {
      console.log('[claude-bros] no config — run `claude-bros join` first');
      return;
    }
    const base = config.url;
    const agent = config.agent;
    const token = config.token;
    const params = new URLSearchParams({ agent });
    if (token) params.set('token', token);
    const url = `${base}/mcp?${params}`;

    // Quick inbox check
    const res = spawnSync('node', ['-e', `
      fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inbox', arguments: { wait_seconds: 0 } } })
      }).then(r => r.json()).then(j => {
        const text = j.result?.content?.[0]?.text || '';
        if (text.includes('No unread')) process.exit(0);
        console.log(text.slice(0, 2000));
        process.exit(0);
      }).catch(e => { console.error(e); process.exit(1); });
    `], { encoding: 'utf8', timeout: 5000 });
    if (res.status === 0 && res.stdout.trim()) {
      const text = res.stdout.trim();
      if (!text.includes('No unread')) {
        console.error(JSON.stringify({
          decision: 'block',
          reason: `[claude-bros] You have unread message(s) from your partner:\n${text}\n\nCall the bros inbox tool to read them properly, then act on them. If nothing there needs action, update your status and stop.`,
        }));
      }
    }
  }
}

// --------------------------------------------------------------------- CLI

const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0];

switch (cmd) {
  case 'serve':
    serve(flags);
    break;
  case 'join':
    join(positional, flags);
    break;
  case 'hook':
    hook(flags);
    break;
  default:
    console.error(c.r(`\n  Usage: claude-bros <serve|join|hook> ...`));
    console.log(c.dim(`
  serve                          Start the relay (port 7777, token auto-generated)
    --port N                       Port (default 7777, or BROS_PORT)
    --room NAME                    Room name (default "bounty", file: data/bounty.json)
    --host HOST                    Bind address (default 0.0.0.0)
    --no-token                     Disable token auth (LAN only!)
    --no-tailscale-note            Don't show Tailscale tip even if detected
  join <http://host:port> --as <name> [--token T] [--role "..."] [--scope "..."]
  hook --event stop                Called by the Stop hook (installed automatically)
    `));
    process.exit(1);
}