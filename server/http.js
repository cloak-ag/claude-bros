import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS, callTool } from './tools.js';
import { dashboardHtml } from './dashboard.js';
import { helpHtml } from './help.js';
import { graphHtml } from './graphpage.js';
import { buildGraph } from './graph.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'claude-bros', title: 'Claude Bros', version: '0.2.0' };
const COLLABORATION_PROTOCOL = {
  version: '2026-08-02',
  changes: [
    'The relay is client-agnostic: Claude, Codex, Grok, and other Streamable HTTP MCP clients receive the same identity and operating contract.',
    'The relationship graph is available through the graph tool, bros://board/graph MCP resource, and related neighborhood queries.',
    'Static roles are deprecated; current claimed tasks and status describe present work, while task/file/finding history records contributions.',
    'Agents should check inbox between work units, acknowledge direct requests, and explicitly hand off work before a takeover.',
    'poll_create, poll_vote, and polls coordinate contested task takeovers and membership decisions.',
  ],
};

const connectionDocument = () => ({
  transport: 'streamable-http',
  protocolVersions: SUPPORTED_PROTOCOLS,
  endpoint: '/mcp?agent=<persistent-agent-name>',
  authentication: {
    type: 'bearer',
    header: 'Authorization: Bearer <token>',
    queryParameter: 'token (legacy compatibility only)',
  },
  identity: 'Choose one persistent agent name per installation. Keep it across reconnects and relay migrations.',
  lifecycle: ['initialize', 'notifications/initialized', 'tools/list or resources/list', 'tools/call or resources/read'],
  clients: {
    claudeCode: 'Remote HTTP MCP server; project .mcp.json or `claude mcp add --transport http`.',
    codex: 'Remote HTTP MCP server in .codex/config.toml or ~/.codex/config.toml.',
    grok: 'Public Custom MCP connector at grok.com/connectors.',
    other: 'Any MCP client supporting stateless Streamable HTTP and bearer headers.',
  },
  documentation: '/help',
});

const capabilityDocument = () => {
  const toolNames = TOOL_DEFS.map((tool) => tool.name).sort();
  const capabilityHash = crypto.createHash('sha256')
    .update(JSON.stringify({ protocol: COLLABORATION_PROTOCOL, tools: TOOL_DEFS }))
    .digest('hex').slice(0, 12);
  return {
    server: SERVER_INFO,
    capabilityHash,
    collaborationProtocol: COLLABORATION_PROTOCOL,
    tools: toolNames,
    discovery: {
      tools: 'MCP tools/list (or GET /api/tools)',
      graph: 'MCP resources/read bros://board/graph (or GET /api/graph)',
      reference: '/help',
      version: '/api/version',
      connecting: 'MCP resources/read bros://server/connecting (or GET /api/connect)',
    },
  };
};

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

/**
 * The dashboard polls the whole board every 3 seconds. Sent raw that is ~1 MB a
 * poll — roughly 900 GB/month per open tab, which on any metered link costs far
 * more than the server. So: gzip it, and give it an ETag keyed to the room's
 * mutation counter. The board changes ~25k times a month against ~860k polls,
 * so the overwhelming majority of responses become empty 304s.
 */
const cached = new Map();
const cachedJson = (req, res, body, version, key) => {
  const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const etag = `W/"${key}-${version}"`;

  // Revalidation: nothing changed since the client last asked.
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  let entry = cached.get(key);
  if (!entry || entry.version !== version) {
    const raw = Buffer.from(JSON.stringify(body));
    entry = { version, raw, gzip: zlib.gzipSync(raw, { level: 6 }) };
    cached.set(key, entry);
  }

  const payload = accepts ? entry.gzip : entry.raw;
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
    // no-cache, not no-store: the client must revalidate, which is what lets
    // the 304 path work at all. no-store would forbid caching entirely.
    'Cache-Control': 'no-cache',
    ETag: etag,
    Vary: 'Accept-Encoding',
    ...(accepts ? { 'Content-Encoding': 'gzip' } : {}),
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
  const isNotification = id === undefined;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      room.recordClient(agent, params?.clientInfo, negotiated);
      return ok({
        protocolVersion: negotiated,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          experimental: { collaborationProtocol: COLLABORATION_PROTOCOL },
        },
        serverInfo: SERVER_INFO,
        instructions:
          'You are collaborating with Claude, Codex, Grok, and other MCP agents through this relay. They are ' +
          'real colleagues working the same engagement; anything you learn is invisible to them unless you ' +
          'put it on this board.\n\n' +
          (agent
            ? `IDENTITY: this MCP connection is configured as "${agent}". That exact name is the sole source ` +
              'of truth. Keep it across reconnects and relay migrations; never copy a name from examples, ' +
              'messages, the roster, or prompts.\n\n'
            : 'IDENTITY ERROR: this MCP connection has no configured agent name. Do not guess or copy one; ' +
              'fix the connection URL before doing work.\n\n') +
          'FIRST ACTION, ALWAYS: call `join`. It returns your full operating briefing and tells you exactly ' +
          'what this board needs next — do not start work before reading it.\n\n' +
          `CAPABILITY BRIEF ${COLLABORATION_PROTOCOL.version}: inspect tools/list at session start; the relay may ` +
          'gain tools without changing your identity. Read MCP resource `bros://server/capabilities` for the ' +
          'current discovery map and changelog. Call `graph`, read `bros://board/graph`, or call `related` to understand ' +
          'goal → task → agent → file → finding relationships before duplicating work.\n\n' +
          'IDENTITY IS NOT A STATIC ROLE: describe current work with a claimed task and `status`. Past tasks, ' +
          'file reviews, and findings are your contribution history. Do not treat legacy role/scope labels as ' +
          'permanent ownership. Free agents should offer help, review hand-offs, and take released work.\n\n' +
          'The protocol in one line each:\n' +
          '- env_set: agree repo/commit/build before anything, or you may be auditing different code.\n' +
          '- goal_add / goals: agree what the engagement is for.\n' +
          '- task_add(goal) → task_claim → task_update: never start work you have not claimed.\n' +
          '- files / file_review: check coverage before opening a file; record every file you finish, clean ones included.\n' +
          '- finding_add: log evidence immediately; your partner reproduces and confirms it.\n' +
          '- status / send / inbox: say what you are doing, hand off leads, block on your partner when you must.\n\n' +
          'COORDINATE CHANGES: acknowledge direct asks; include task/finding/file IDs in replies; send a concise ' +
          'handoff with result, evidence, remaining work, and next owner. For a contested takeover or membership ' +
          'decision, use `poll_create`, `poll_vote`, and `polls`; never improvise a vote in status text.\n\n' +
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

    case 'resources/list':
      return ok({ resources: [
        {
          uri: 'bros://board/graph',
          name: 'Current board relationship graph',
          description: 'Goals, tasks, agents, files, and findings with their recorded and inferred relationships.',
          mimeType: 'application/json',
        },
        {
          uri: 'bros://server/connecting',
          name: 'Client-neutral connection contract',
          description: 'Transport, authentication, identity, lifecycle, and supported client setup paths.',
          mimeType: 'application/json',
        },
        {
          uri: 'bros://server/capabilities',
          name: 'Current relay capabilities and collaboration protocol',
          description: 'Machine-readable discovery paths, tool inventory, protocol version, and concise changes.',
          mimeType: 'application/json',
        },
      ] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'resources/read': {
      const uri = params?.uri;
      if (uri === 'bros://board/graph') {
        room.touch(agent);
        return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(buildGraph(room.state)) }] });
      }
      if (uri === 'bros://server/capabilities') {
        room.touch(agent);
        return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(capabilityDocument()) }] });
      }
      if (uri === 'bros://server/connecting') {
        room.touch(agent);
        return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(connectionDocument()) }] });
      }
      return isNotification ? null : rpcError(id, -32002, `Resource not found: ${uri || '(missing uri)'}`);
    }
    // Declared-but-empty prompt capability keeps strict clients from erroring out.
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

    // Version endpoint — public, so agents can poll for updates without auth
    if (url.pathname === '/api/version') {
      const toolNames = TOOL_DEFS.map((t) => t.name).sort();
      const toolHash = crypto.createHash('sha256').update(toolNames.join(',')).digest('hex').slice(0, 12);
      const capabilityHash = crypto.createHash('sha256')
        .update(JSON.stringify({ protocol: COLLABORATION_PROTOCOL, tools: TOOL_DEFS }))
        .digest('hex').slice(0, 12);
      return json(res, 200, {
        version: SERVER_INFO.version,
        name: SERVER_INFO.name,
        collaborationProtocol: COLLABORATION_PROTOCOL,
        toolCount: toolNames.length,
        tools: toolNames,
        toolHash,
        capabilityHash,
        resources: ['bros://board/graph', 'bros://server/capabilities', 'bros://server/connecting'],
        graph: { ui: '/graph', api: '/api/graph', mcp: 'bros://board/graph' },
      });
    }

    if (url.pathname === '/api/connect') return json(res, 200, connectionDocument());

    if (!authorized(url, req)) {
      const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
      if (!quiet) console.log(`\x1b[31m  ${new Date().toTimeString().slice(0, 8)}  REJECTED (bad token)  from ${ip}\x1b[0m`);
      return json(res, 401, { error: 'Bad or missing token. Send Authorization: Bearer <token>.' }, {
        'WWW-Authenticate': 'Bearer realm="claude-bros"',
      });
    }

    // Lapsed claims should read as lapsed wherever people glance — the dashboard
    // state read is the most common glance and it never calls the board tool.
    // Release on every authenticated request (cheap, idempotent, O(tasks)).
    room.releaseStaleClaims();

    // ------------------------------------------------------------ MCP
    if (url.pathname === '/mcp') {
      // Browser-based MCP clients send Origin. Accept same-origin traffic and
      // explicit operator allowlisting, but reject arbitrary web pages to
      // prevent DNS-rebinding attacks against a relay on a private network.
      const origin = req.headers.origin;
      if (origin) {
        const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        const allowed = new Set(String(process.env.BROS_ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean));
        let sameOrigin = false;
        try { sameOrigin = new URL(origin).host === forwardedHost; } catch {}
        if (!sameOrigin && !allowed.has(origin)) {
          return json(res, 403, rpcError(null, -32000,
            'Origin is not allowed. Add it to BROS_ALLOWED_ORIGINS on the relay if this is an intentional browser client.'));
        }
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        // No server-initiated streams and no server-side sessions to tear down.
        return json(res, 405, { error: 'This stateless server does not provide an SSE stream or session deletion.' }, { Allow: 'POST' });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });

      const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        return json(res, 415, rpcError(null, -32600, 'MCP Streamable HTTP requests require Content-Type: application/json.'));
      }
      const protocolHeader = req.headers['mcp-protocol-version'];
      if (protocolHeader && !SUPPORTED_PROTOCOLS.includes(String(protocolHeader))) {
        return json(res, 400, rpcError(null, -32600,
          `Unsupported MCP-Protocol-Version: ${protocolHeader}. Supported: ${SUPPORTED_PROTOCOLS.join(', ')}.`));
      }

      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, rpcError(null, -32700, `Parse error: ${err.message}`));
      }
      if (!agent) {
        const id = Array.isArray(payload) ? null : (payload?.id ?? null);
        return json(res, 400, rpcError(id, -32600,
          'Missing agent identity. Configure this MCP endpoint with ?agent=<persistent-agent-name>. Do not guess or copy another agent name.'));
      }

      const batch = Array.isArray(payload);
      if (batch && payload.length === 0) {
        return json(res, 400, rpcError(null, -32600, 'Invalid Request: an empty JSON-RPC batch is not allowed.'));
      }
      const messages = batch ? payload : [payload];
      const replies = [];
      for (const message of messages) {
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
          replies.push(rpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 request.'));
          continue;
        }
        log(req, agent, message.method === 'tools/call' ? `tool: ${message.params?.name}` : message.method);
        const reply = await handleRpc(room, agent, message, hostOf(req));
        if (reply) replies.push(reply);
      }

      const clash = agent ? room.recordEndpoint(agent, hostOf(req)) : null;
      if (clash && !quiet) {
        console.log(`\x1b[41m\x1b[97m  NAME CLASH: "${agent}" is connecting from ${clash.join(' and ')}  \x1b[0m`);
        console.log('\x1b[31m  Two machines are sharing one identity — they will not see each other.');
        console.log('  Reconfigure one endpoint with a different persistent agent name.\x1b[0m');
      }

      if (!replies.length) {
        res.writeHead(202, { 'Content-Length': 0 });
        return res.end();
      }
      return json(res, 200, batch ? replies : replies[0], { 'Access-Control-Allow-Origin': '*' });
    }

    // ------------------------------------------------- REST (humans, hooks)
    if (url.pathname === '/api/graph') return cachedJson(req, res, buildGraph(room.state), room.version, 'graph');
    if (url.pathname === '/api/board') return cachedJson(req, res, room.board(agent), room.version, `board-${agent || '-'}`);
    if (url.pathname === '/api/state') return cachedJson(req, res, room.state, room.version, 'state');

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

    // Search endpoint — search messages, findings, files
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      if (!q) return json(res, 400, { error: 'q parameter required' });
      const results = [];
      // Search messages
      for (const m of room.state.messages) {
        const hay = `${m.from} ${m.to} ${m.text}`.toLowerCase();
        if (hay.includes(q)) {
          results.push({ type: 'message', id: m.id, from: m.from, to: m.to, ts: m.ts, text: m.text.slice(0, 200) });
          if (results.length >= limit) break;
        }
      }
      // Search findings
      if (results.length < limit) {
        for (const f of room.state.findings) {
          const hay = `${f.title} ${f.target || ''} ${f.evidence || ''}`.toLowerCase();
          if (hay.includes(q)) {
            results.push({ type: 'finding', id: f.id, title: f.title, target: f.target, severity: f.severity, status: f.status });
            if (results.length >= limit) break;
          }
        }
      }
      // Search files
      if (results.length < limit) {
        for (const f of Object.values(room.state.files || {})) {
          const hay = `${f.path} ${(f.reviews || []).map((r) => r.note).join(' ')}`.toLowerCase();
          if (hay.includes(q)) {
            results.push({ type: 'file', path: f.path, reviews: f.reviews.length });
            if (results.length >= limit) break;
          }
        }
      }
      return json(res, 200, { query: q, count: results.length, results });
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

    if (url.pathname === '/graph') {
      const html = graphHtml(room.name, token ? `?token=${encodeURIComponent(token)}` : '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
      return res.end(html);
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
