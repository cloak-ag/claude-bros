import http from 'node:http';
import { createMigrationProxy } from '../deploy/migration-proxy.js';

const oldToken = 'old-only-on-lan';
const newToken = 'new-never-leaves-proxy';
let upstreamRequest = null;
let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
  upstreamHits += 1;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    upstreamRequest = {
      method: req.method, path: url.pathname, token: url.searchParams.get('token'),
      agent: url.searchParams.get('agent'),
      auth: req.headers.authorization, legacyHeader: req.headers['x-bros-token'],
      cookie: req.headers.cookie, body: Buffer.concat(chunks).toString('utf8'),
    };
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // The real dashboard is HTML and embeds its own token in its links.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><body><a href="/?token=${newToken}">board</a></body></html>`);
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true,"room":"bounty"}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, renderedLink: `/?token=${newToken}` }));
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

const canonical = `http://127.0.0.1:${upstream.address().port}`;
const proxy = createMigrationProxy({
  canonicalUrl: canonical, oldToken, newToken, quiet: true, allowInsecureForTests: true,
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${proxy.address().port}`;

const check = (condition, message) => { if (!condition) throw new Error(message); };
const health = await fetch(`${base}/healthz`);
const healthBody = await health.json();
check(healthBody.ok && healthBody.migrated && healthBody.canonicalUrl === canonical, 'health migration metadata');
check(health.headers.get('x-claude-bros-migrated-to') === canonical, 'canonical response header');

const denied = await fetch(`${base}/api/state`);
check(denied.status === 401, 'old proxy still authenticates clients');
check(upstreamHits === 1, 'unauthorized traffic never reaches upstream');

const preflight = await fetch(`${base}/api/tool/board`, {
  method: 'OPTIONS', headers: { Origin: 'https://client.invalid', 'Access-Control-Request-Headers': 'authorization' },
});
check(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*',
  'CORS preflight remains credential-free and compatible');
check(upstreamHits === 1, 'CORS preflight is answered locally');

// The dashboard must actually work from the legacy address. A static notice
// here left the local board dead and its one link unusable, so browser routes
// are proxied like everything else.
const hitsBeforePage = upstreamHits;
const page = await fetch(`${base}/?token=${oldToken}`);
const pageBody = await page.text();
check(upstreamHits === hitsBeforePage + 1, 'browser route is proxied, not stubbed');
check(!pageBody.includes(newToken), 'canonical token never reaches the browser');
check(pageBody.includes(new URL(canonical).origin), 'proxied page names the canonical relay');
check(pageBody.includes(`token=${oldToken}`),
  'the dashboard\'s own links are rewritten to the legacy token, so they work through the bridge');

const payload = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const configuredAgent = 'existing-agent-name';
const forwarded = await fetch(`${base}/mcp?agent=${configuredAgent}&token=${oldToken}`, {
  method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${oldToken}`,
    'X-Bros-Token': 'attacker-controlled', Cookie: `token=${newToken}`,
  }, body: payload,
});
const forwardedBody = await forwarded.json();
check(upstreamRequest.method === 'POST' && upstreamRequest.path === '/mcp', 'method and path preserved');
check(upstreamRequest.agent === configuredAgent, 'configured agent identity preserved exactly');
check(upstreamRequest.token === null && upstreamRequest.auth === `Bearer ${newToken}`, 'credential translated outside URL');
check(!upstreamRequest.legacyHeader && !upstreamRequest.cookie, 'untrusted credential headers stripped');
check(upstreamRequest.body === payload, 'request body preserved');
// Redacting the upstream's own token broke every link it rendered. It is now
// swapped for the legacy credential the client already holds, which keeps those
// links working through the bridge while the canonical one still never appears.
check(!JSON.stringify(forwardedBody).includes(newToken), 'new credential never leaks downstream');
check(forwardedBody.renderedLink.includes(`token=${oldToken}`),
  'upstream-rendered links are rewritten to the legacy credential, not blanked');

await new Promise((resolve) => proxy.close(resolve));
await new Promise((resolve) => upstream.close(resolve));

// Either credential is accepted locally: the legacy one for agents that never
// changed, the canonical one for a machine already pointed at the new relay.
{
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sawAuth: req.headers.authorization === 'Bearer NEWTOKEN' }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = createMigrationProxy({
    canonicalUrl: target, oldToken: 'OLDTOKEN', newToken: 'NEWTOKEN',
    quiet: true, allowInsecureForTests: true,
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${bridge.address().port}`;

  const legacy = await fetch(`${base}/api/state?token=OLDTOKEN`);
  check(legacy.status === 200, 'legacy token is still accepted');
  const canonical = await fetch(`${base}/api/state?token=NEWTOKEN`);
  check(canonical.status === 200, 'canonical token is accepted too');
  check((await canonical.json()).sawAuth === true, 'the canonical token is what reaches upstream');
  const bearer = await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer NEWTOKEN' } });
  check(bearer.status === 200, 'canonical token works as a bearer header');
  const wrong = await fetch(`${base}/api/state?token=NEITHER`);
  check(wrong.status === 401, 'an unrelated token is still refused');

  const strict = createMigrationProxy({
    canonicalUrl: target, oldToken: 'OLDTOKEN', newToken: 'NEWTOKEN',
    quiet: true, allowInsecureForTests: true, acceptCanonicalToken: false,
  });
  await new Promise((r) => strict.listen(0, '127.0.0.1', r));
  const strictBase = `http://127.0.0.1:${strict.address().port}`;
  check((await fetch(`${strictBase}/api/state?token=NEWTOKEN`)).status === 401,
    'acceptCanonicalToken:false restores legacy-only auth');

  bridge.close(); strict.close(); upstream.close();
}
console.log('migration proxy: 23 checks passed');
