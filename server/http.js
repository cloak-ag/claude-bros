import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS, callTool } from './tools.js';
import { dashboardHtml } from './dashboard.js';
import { helpHtml } from './help.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'claude-bros', title: 'Claude Bros', version: '0.1.0' };

const json = (res, code, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
};

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRpc(room, agent, message, host = null) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'You are collaborating with Claude Code agents on OTHER MACHINES through this relay. They are ' +
          'real colleagues working the same engagement; anything you learn is invisible to them unless you ' +
          'put it on this board.\n\n' +
          'FIRST ACTION, ALWAYS: call `join`. It returns your full operating briefing and tells you exactly ' +
          'what this board needs next — do not start work before reading it.\n\n' +
          'The protocol in one line each:\n' +
          '- env_set: agree repo/commit/build before anything, or you may be auditing different code.\n' +
          '- goal_add / goals: agree what the engagement is for.\n' +
          '- task_add(goal) → task_claim → task_update: never start work you have not claimed.\n' +
          '- files / file_review: check coverage before opening a file; record every file you finish, clean ones included.\n' +
          '- finding_add: log evidence immediately; your partner reproduces and confirms it.\n' +
          '- status / send / inbox: say what you are doing, hand off leads, block on your partner when you must.\n\n' +
          'KEEP LISTENING: this relay cannot interrupt you. Call `inbox` between units of work — after each ' +
          'file, before each new task — not only when you are about to stop, and act on what arrives before ' +
          'continuing your own plan. A Stop hook will wake you if you try to finish with unread mail, but that ' +
          'is a safety net, not the plan.',
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok({});

    case 'tools/list':
      return ok({ tools: TOOL_DEFS });

    case 'tools/call': {
      const name = params?.name;
      try {
        const result = await callTool(room, agent, name, params?.arguments || {}, host);
        return ok(result);
      } catch (err) {
        console.error(`[bros] tool ${name} threw:`, err);
        return ok({ content: [{ type: 'text', text: `Tool "${name}" failed: ${err.message}` }], isError: true });
      }
    }

    // Declared-but-empty capabilities keep strict clients from erroring out.
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });

    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function createServer({ room, token, quiet = false }) {
  const seen = new Set();

  // Every address belonging to this box counts as one place, so the agent
  // running alongside the relay does not look like two machines.
  const localAddresses = new Set([
    '127.0.0.1',
    '::1',
    ...Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address),
  ]);
  const hostOf = (req) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    return localAddresses.has(ip) ? 'relay-host' : ip;
  };

  /** Visibility matters more than tidiness here: a partner who never arrives
   *  is invisible on the board, so log who actually reaches the relay. */
  const log = (req, agent, detail) => {
    if (quiet) return;
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    const stamp = new Date().toTimeString().slice(0, 8);
    const key = `${agent}@${ip}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`\x1b[32m  ${stamp}  NEW CONNECTION  ${agent || '\x1b[31m(no agent name!)\x1b[32m'}  from ${ip}\x1b[0m`);
      if (!agent) {
        console.log('\x1b[31m           ^ this client did not send ?agent=<name> — it cannot join the board\x1b[0m');
      }
    }
    if (detail) console.log(`\x1b[2m  ${stamp}  ${agent || '?'}  ${detail}\x1b[0m`);
  };

  const authorized = (url, req) => {
    if (!token) return true;
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return url.searchParams.get('token') === token || bearer === token || req.headers['x-bros-token'] === token;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const requestedAgent = url.searchParams.get('agent') || req.headers['x-bros-agent'] || null;
    const agent = requestedAgent ? room.resolveName(requestedAgent) : null;
    if (agent && agent !== requestedAgent && !seen.has(`alias:${requestedAgent}`)) {
      seen.add(`alias:${requestedAgent}`);
      if (!quiet) {
        console.log(`\x1b[33m  ${new Date().toTimeString().slice(0, 8)}  "${requestedAgent}" was renamed — forwarding to "${agent}"\x1b[0m`);
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      });
      return res.end();
    }

    if (url.pathname === '/healthz') return json(res, 200, { ok: true, room: room.name });

    if (!authorized(url, req)) {
      const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
      if (!quiet) console.log(`\x1b[31m  ${new Date().toTimeString().slice(0, 8)}  REJECTED (bad token)  from ${ip}\x1b[0m`);
      return json(res, 401, { error: 'Bad or missing token. Append ?token=... to the URL.' });
    }

    // ------------------------------------------------------------ MCP
    if (url.pathname === '/mcp') {
      if (req.method === 'GET' || req.method === 'DELETE') {
        // No server-initiated streams and no server-side sessions to tear down.
        return json(res, req.method === 'DELETE' ? 200 : 405, { ok: true });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, rpcError(null, -32700, `Parse error: ${err.message}`));
      }

      const batch = Array.isArray(payload);
      const messages = batch ? payload : [payload];
      const replies = [];
      for (const message of messages) {
        log(req, agent, message.method === 'tools/call' ? `tool: ${message.params?.name}` : message.method);
        const reply = await handleRpc(room, agent, message, hostOf(req));
        if (reply) replies.push(reply);
      }

      const clash = agent ? room.recordEndpoint(agent, hostOf(req)) : null;
      if (clash && !quiet) {
        console.log(`\x1b[41m\x1b[97m  NAME CLASH: "${agent}" is connecting from ${clash.join(' and ')}  \x1b[0m`);
        console.log('\x1b[31m  Two machines are sharing one identity — they will not see each other.');
        console.log('  One of them must re-run join with a different --as name.\x1b[0m');
      }

      if (!replies.length) {
        res.writeHead(202, { 'Content-Length': 0 });
        return res.end();
      }
      return json(res, 200, batch ? replies : replies[0], { 'Access-Control-Allow-Origin': '*' });
    }

    // ------------------------------------------------- REST (humans, hooks)
    if (url.pathname === '/api/board') return json(res, 200, room.board(agent));
    if (url.pathname === '/api/state') return json(res, 200, room.state);

    if (url.pathname === '/api/unread') {
      if (!agent) return json(res, 400, { error: 'agent required' });
      // Peek only — the agent itself must call the inbox tool to consume mail.
      const pending = room.unread(agent).map(({ readBy, ...m }) => m);
      const mine = room.state.tasks.filter((t) => t.owner === agent && t.status === 'claimed');
      return json(res, 200, { count: pending.length, messages: pending, claimedByYou: mine.length });
    }

    // Every tool over plain HTTP too. MCP tools only load at session start, so
    // an agent that joined mid-session has no other way to reach the board.
    if (url.pathname.startsWith('/api/tool/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/tool/'.length));
      if (!TOOL_DEFS.some((t) => t.name === name)) {
        return json(res, 404, { ok: false, error: `No tool "${name}".`, tools: TOOL_DEFS.map((t) => t.name) });
      }
      let args = {};
      if (req.method === 'POST') {
        try {
          const raw = await readBody(req);
          args = raw ? JSON.parse(raw) : {};
        } catch (err) {
          return json(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
        }
      } else {
        for (const [k, v] of url.searchParams) if (k !== 'agent' && k !== 'token') args[k] = v;
      }
      log(req, agent, `tool(rest): ${name}`);
      try {
        const result = await callTool(room, agent, name, args, hostOf(req));
        const out = result.content?.[0]?.text ?? '';
        if (url.searchParams.get('format') === 'json') {
          return json(res, result.isError ? 400 : 200, { ok: !result.isError, tool: name, text: out });
        }
        res.writeHead(result.isError ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(out);
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    if (url.pathname === '/api/tools') {
      return json(res, 200, TOOL_DEFS.map((t) => ({ name: t.name, title: t.title, params: Object.keys(t.inputSchema?.properties || {}) })));
    }

    // Catch-up after a relay blip: everything the client has not seen by seq.
    if (url.pathname === '/api/messages') {
      const since = Number(url.searchParams.get('since') || 0);
      const list = room.state.messages.filter((m) => (m.seq || 0) > since);
      return json(res, 200, { latestSeq: room.state.counters.seq || 0, count: list.length, messages: list });
    }

    if (url.pathname === '/api/rename' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const result = room.rename(body.from, body.to);
        if (!quiet && result.ok) {
          console.log(`\x1b[35m  ${new Date().toTimeString().slice(0, 8)}  RENAMED  ${result.from} -> ${result.to}\x1b[0m`);
        }
        return json(res, result.ok ? 200 : 400, result);
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (url.pathname === '/api/forget' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const result = room.forget(body.name, { force: body.force });
        if (!quiet && result.ok) {
          console.log(`\x1b[35m  ${new Date().toTimeString().slice(0, 8)}  FORGOT  ${result.name}\x1b[0m`);
        }
        return json(res, result.ok ? 200 : 400, result);
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (url.pathname === '/api/send' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.text) return json(res, 400, { error: 'text required' });
        const msg = room.send(body.from || agent || 'human', {
          to: body.to || 'all',
          text: body.text,
          urgent: body.urgent,
        });
        return json(res, 200, msg);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // Lets the other machine bootstrap without git: it downloads the relay's
    // own source, which is what `join` needs on disk to install the hooks.
    if (url.pathname === '/bundle.tgz') {
      const tar = spawn('tar', [
        '-czf', '-',
        '-C', PROJECT_ROOT,
        '--exclude=./data',
        '--exclude=./node_modules',
        '--exclude=./.git',
        // The relay owner's own guide. Shipping it caused a partner's agent to
        // follow it and join under the owner's name, so both shared one identity.
        '--exclude=./MY-SETUP.md',
        '.',
      ]);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="claude-bros.tgz"',
      });
      tar.stdout.pipe(res);
      tar.stderr.on('data', (d) => console.error('[bros] bundle:', d.toString().trim()));
      tar.on('error', (err) => {
        console.error('[bros] bundle failed:', err.message);
        res.destroy();
      });
      req.on('close', () => tar.kill());
      return;
    }

    if (url.pathname === '/help') {
      const html = helpHtml(room.name, TOOL_DEFS, token ? `?token=${encodeURIComponent(token)}` : '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = dashboardHtml(room.name, token ? `?token=${encodeURIComponent(token)}` : '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    return json(res, 404, { error: 'Not found' });
  });
}
