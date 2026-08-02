#!/usr/bin/env node
/**
 * Compatibility proxy for a relay move. Existing agents keep their old URL
 * and token; this process authenticates them locally and forwards every request
 * to the canonical HTTPS relay with its new token. Paths, bodies, and the
 * existing `agent` query value pass through unchanged, preserving identity.
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

export function createMigrationProxy({ canonicalUrl, oldToken, newToken, quiet = false, allowInsecureForTests = false, acceptCanonicalToken = true }) {
  if (!canonicalUrl || !oldToken || !newToken) throw new Error('canonicalUrl, oldToken, and newToken are required');
  const canonical = new URL(canonicalUrl);
  if (canonical.protocol !== 'https:' && !allowInsecureForTests) throw new Error('canonicalUrl must use HTTPS');
  const transport = canonical.protocol === 'https:' ? https : http;

  // Clients presenting the canonical token are accepted too, so a machine
  // already reconfigured for the new relay keeps working against the legacy
  // address. Note this lets the canonical credential travel over plain HTTP on
  // the LAN, where previously only the legacy one did — acceptable only on a
  // trusted network, and a reason to rotate if that assumption ever breaks.
  const accepted = acceptCanonicalToken ? [oldToken, newToken] : [oldToken];
  const presents = (candidate) => accepted.some((secret) => sameSecret(candidate, secret));
  const isAuthorized = (url, req) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return presents(url.searchParams.get('token'))
      || presents(bearer)
      || presents(req.headers['x-bros-token']);
  };

  // A banner is injected into proxied HTML so it is obvious the board is served
  // from the canonical relay, without replacing the working dashboard with a
  // dead end. The canonical link carries no token by design.
  const banner = `<div style="font:13px/1.5 system-ui;background:#1c2b3a;color:#cfe3ff;border-bottom:1px solid #2c4a68;padding:7px 14px">`
    + `Served from the migrated relay · <a style="color:#8ab8ff" href="${canonical.origin}">${canonical.origin}</a>`
    + `<span style="opacity:.65"> — this legacy address keeps working; new installs should join the canonical URL.</span></div>`;

  return http.createServer((req, res) => {
    const incoming = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Cache-Control': 'no-store',
        'X-Claude-Bros-Migrated-To': canonical.origin,
      });
      return res.end();
    }
    const publicRoute = incoming.pathname === '/healthz' || incoming.pathname === '/api/version';
    const browserRoute = req.method === 'GET' && ['/', '/index.html', '/help', '/graph'].includes(incoming.pathname);
    if (!publicRoute && !isAuthorized(incoming, req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        error: 'Bad or missing token.', migrated: true, canonicalUrl: canonical.origin,
      }));
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
        // The upstream dashboard embeds its own token in nav links and fetches.
        // Redacting it would break every link; swapping it for the legacy token
        // keeps them working through this bridge and still means the canonical
        // credential never appears in a response. The client already sent the
        // legacy token to get here, so this reveals nothing new to it.
        let body = Buffer.concat(chunks).toString('utf8').split(newToken).join(oldToken);
        if (/text\/html/i.test(responseHeaders['content-type'] || '')) {
          body = body.replace(/<body[^>]*>/i, (tag) => tag + banner);
        }
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
