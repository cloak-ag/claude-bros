#!/usr/bin/env node
/**
 * Compatibility proxy for a relay move. Existing agents keep their old URL
 * and token; this process authenticates them locally and forwards every request
 * to the canonical HTTPS relay with its new token.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const textual = (type = '') => /^(text\/)|json|javascript|xml|svg/i.test(type);
const sameSecret = (candidate, expected) => {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const hopByHop = [
  'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'cookie', 'authorization', 'x-bros-token', 'host',
];
const responseHopByHop = [
  'connection', 'proxy-authenticate', 'proxy-authorization', 'keep-alive',
  'transfer-encoding', 'upgrade', 'te', 'trailer',
];

export function createMigrationProxy({ canonicalUrl, oldToken, newToken, quiet = false, allowInsecureForTests = false }) {
  if (!canonicalUrl || !oldToken || !newToken) throw new Error('canonicalUrl, oldToken, and newToken are required');
  const canonical = new URL(canonicalUrl);
  if (canonical.protocol !== 'https:' && !allowInsecureForTests) throw new Error('canonicalUrl must use HTTPS');
  const transport = canonical.protocol === 'https:' ? https : http;

  const isAuthorized = (url, req) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return sameSecret(url.searchParams.get('token'), oldToken)
      || sameSecret(bearer, oldToken)
      || sameSecret(req.headers['x-bros-token'], oldToken);
  };

  const migrationPage = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>claude-bros migrated</title><style>body{font:16px system-ui;max-width:760px;margin:12vh auto;padding:24px;line-height:1.5}code{background:#eee;padding:2px 5px}</style><h1>This relay migrated</h1><p>Existing MCP, REST, and hook clients are forwarded automatically. No prompt or configuration change is required.</p><p>Canonical relay: <a href="${canonical.origin}">${canonical.origin}</a></p><p>New installations should join the canonical HTTPS URL with the current relay token.</p>`;

  return http.createServer((req, res) => {
    const incoming = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const publicRoute = incoming.pathname === '/healthz' || incoming.pathname === '/api/version';
    const browserRoute = req.method === 'GET' && ['/', '/help', '/graph'].includes(incoming.pathname);
    if (!publicRoute && !isAuthorized(incoming, req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        error: 'Bad or missing token.', migrated: true, canonicalUrl: canonical.origin,
      }));
    }

    if (browserRoute) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(migrationPage),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        Link: `<${canonical.origin}>; rel="canonical"`,
        'X-Claude-Bros-Migrated-To': canonical.origin,
      });
      return res.end(migrationPage);
    }

    incoming.searchParams.delete('token');
    const target = new URL(incoming.pathname + incoming.search, canonical);
    const headers = { ...req.headers };
    for (const name of hopByHop) delete headers[name];
    headers.host = canonical.host;
    headers.authorization = `Bearer ${newToken}`;
    headers['accept-encoding'] = 'identity';

    const upstream = transport.request(target, {
      method: req.method,
      headers,
    }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      for (const name of responseHopByHop) delete responseHeaders[name];
      responseHeaders['x-claude-bros-migrated-to'] = canonical.origin;
      responseHeaders.link = `<${canonical.origin}>; rel="canonical"`;
      responseHeaders['cache-control'] = 'no-store';
      delete responseHeaders['content-encoding'];

      if (!textual(responseHeaders['content-type'])) {
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        return upstreamRes.pipe(res);
      }

      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8').split(newToken).join('[redacted]');
        if (incoming.pathname === '/healthz' || incoming.pathname === '/api/version') {
          try {
            const parsed = JSON.parse(body);
            body = JSON.stringify({ ...parsed, migrated: true, canonicalUrl: canonical.origin });
          } catch {}
        }
        responseHeaders['content-length'] = Buffer.byteLength(body);
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        res.end(body);
      });
    });

    upstream.on('error', (err) => {
      if (!quiet) console.error('[migration-proxy] upstream:', err.message);
      if (res.headersSent) return res.destroy(err);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        error: 'Canonical relay unavailable.', migrated: true, canonicalUrl: canonical.origin,
      }));
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const canonicalUrl = process.env.BROS_MIGRATE_TO;
  const oldToken = process.env.BROS_OLD_TOKEN;
  const newToken = process.env.BROS_NEW_TOKEN;
  const host = process.env.BROS_MIGRATE_HOST || '192.168.15.20';
  const port = Number(process.env.BROS_MIGRATE_PORT || 7777);
  const server = createMigrationProxy({ canonicalUrl, oldToken, newToken });
  server.listen(port, host, () => {
    console.log(`[migration-proxy] ${host}:${port} -> ${new URL(canonicalUrl).origin}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
