import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const tracked = execFileSync(
  'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const forbiddenPaths = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)\.codex\//,
  /(^|\/)\.claude\//,
  /(^|\/)data\/[^/]+\.json(?:\.tmp)?$/,
  /(?:^|\/)[^/]*(?:service-account|credentials?)[^/]*\.json$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

const contentRules = [
  ['private IPv4 address', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ['personal filesystem path', /(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\]+\\)/g],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['GitHub token', /\b(?:gh[opsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['credential in URL', /\bhttps?:\/\/[^\s/:]+:[^\s/@]+@/g],
  ['long literal query token', /[?&]token=[A-Fa-f0-9]{24,}\b/g],
];

// Keep deployment-specific identifiers out of examples and defaults. Split the
// values so the regression test does not contain what it is designed to catch.
const retiredIdentifiers = [
  'cloak-' + 'prod',
  '35-211-' + '50-152.sslip.io',
];

const failures = [];
for (const file of tracked) {
  for (const rule of forbiddenPaths) {
    const isEnvironmentTemplate = /(^|\/)\.env\.example$/.test(file);
    if (rule.test(file) && !isEnvironmentTemplate) {
      failures.push(`${file}: sensitive path is tracked`);
    }
  }

  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  const content = buffer.toString('utf8');

  for (const [label, rule] of contentRules) {
    rule.lastIndex = 0;
    for (const match of content.matchAll(rule)) {
      const line = content.slice(0, match.index).split('\n').length;
      failures.push(`${file}:${line}: ${label}`);
    }
  }

  for (const identifier of retiredIdentifiers) {
    if (!content.includes(identifier)) continue;
    const line = content.slice(0, content.indexOf(identifier)).split('\n').length;
    failures.push(`${file}:${line}: retired deployment identifier`);
  }
}

if (failures.length) {
  console.error('Repository hygiene check failed:\n' + failures.map((x) => `  - ${x}`).join('\n'));
  process.exit(1);
}

console.log(`repository hygiene: ${tracked.length} tracked files checked`);
