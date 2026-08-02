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
      auth: req.headers.authorization, legacyHeader: req.headers['x-bros-token'],
      cookie: req.headers.cookie, body: Buffer.concat(chunks).toString('utf8'),
    };
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

const page = await fetch(`${base}/?token=${oldToken}`);
const pageBody = await page.text();
check(pageBody.includes('forwarded automatically') && !pageBody.includes(newToken), 'browser route is a safe local notice');
check(upstreamHits === 1, 'browser route cannot leak upstream HTML');

const payload = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const forwarded = await fetch(`${base}/mcp?agent=reacher&token=${oldToken}`, {
  method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${oldToken}`,
    'X-Bros-Token': 'attacker-controlled', Cookie: `token=${newToken}`,
  }, body: payload,
});
const forwardedBody = await forwarded.json();
check(upstreamRequest.method === 'POST' && upstreamRequest.path === '/mcp', 'method and path preserved');
check(upstreamRequest.token === null && upstreamRequest.auth === `Bearer ${newToken}`, 'credential translated outside URL');
check(!upstreamRequest.legacyHeader && !upstreamRequest.cookie, 'untrusted credential headers stripped');
check(upstreamRequest.body === payload, 'request body preserved');
check(forwardedBody.renderedLink.includes('[redacted]') && !JSON.stringify(forwardedBody).includes(newToken),
  'new credential never leaks downstream');

await new Promise((resolve) => proxy.close(resolve));
await new Promise((resolve) => upstream.close(resolve));
console.log('migration proxy: 13 checks passed');
