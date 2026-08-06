/**
 * One-off seed for advisories + fences (Part A/B of the advisory-outcome-
 * tracking feature). Writes through the normal Room write path — the same
 * upsertAdvisory/addFence methods the advisory_upsert/fence_add MCP tools
 * call — into the default "bounty" room file (data/bounty.json), so the
 * dashboard/API see real, persisted data on first load.
 *
 * Run: node test/seed-advisories-fences.js
 * Safe to re-run: advisories upsert by ghsa_id; fences are matched by `ref`
 * before adding, so this script is idempotent too.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from '../server/room.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataFile = path.join(ROOT, 'data', 'bounty.json');

const SEED_AGENT = 'seed-script';

const advisories = [
  {
    ghsaId: 'GHSA-5w47-2m67-5mm7',
    findingId: 'F15',
    title: 'VotePool memory growth from unverified future-slot votes',
    url: 'https://github.com/anza-xyz/alpenglow/security/advisories/GHSA-5w47-2m67-5mm7',
    state: 'closed',
    outcome: 'rejected',
    anzaSeverity: 'low',
    ourSeverity: 'medium',
    product: 'bls-sigverify',
    affectedVersions: 'v4.3.0-alpha.3',
    patchedVersions: 'None',
    closedBy: 'cfkelly18',
    outcomeReason:
      'This is intentional / by design see the discussion around SIMD-326. By doing this you forfeit block rewards which generally make up most of a validator\'s income.',
    creditState: 'pending',
    burnTx: 'A6JQEtLLtsaeMgLGP8Uzr4qwsHcj9HWN4Kf8gJwp458hHcrs4PPsickEvKZvKWeU4roVLKZAo3tE87X1H98v9vm',
    burnSol: 0.5,
    submittedAt: '2026-08-05T18:12:31Z',
  },
  {
    ghsaId: 'GHSA-gq59-gmfv-rg36',
    findingId: 'F18',
    title: 'Vote recorded in history before it is sent, preventing retry',
    url: 'https://github.com/anza-xyz/alpenglow/security/advisories/GHSA-gq59-gmfv-rg36',
    state: 'draft',
    outcome: 'pending',
    anzaSeverity: 'low',
    ourSeverity: 'medium',
    product: 'votor',
    affectedVersions: '>= v4.3.0-alpha.2',
    patchedVersions: 'None',
    creditState: 'pending',
    burnTx: 'tcpXo31XeZgjdRoii5rcyv2PgBHmppX8jaAcw5x48GcmD2aafPfSJrdqhznixxBV9R12Soeg3nQH27m87rKqRBb',
    burnSol: 0.5,
    submittedAt: '2026-08-05T21:11:00Z',
  },
];

const fences = [
  {
    kind: 'section8_issue',
    ref: 'agave#14335',
    url: 'https://github.com/anza-xyz/agave/issues/14335',
    title: 'Reduce the bound of vote ingest in BLS sigverify',
    quote:
      'we admit votes from root_slot - 8 to root_slot + 30k. This could lead to a large amount of memory being used for the vote tracking.',
    publishedAt: '2026-08-05T12:47:35Z',
    appliesTo: ['F15'],
    paths: ['bls-sigverify/src/bls_sigverifier.rs', 'bls-sigverify/src/vote_pool.rs'],
    note: 'Published 5h25m BEFORE F15 was filed. This is why F15 was excluded under RULES §8.',
  },
  {
    kind: 'accepted_report',
    ref: 'agave#14358',
    url: 'https://github.com/anza-xyz/agave/pull/14358',
    title: 'votor: fix bug where we can vote skip on the genesis block',
    quote: 'A bug bounty report pointed out that we could vote skip on the genesis block',
    publishedAt: '2026-08-06T03:41:16Z',
    paths: ['votor/src/event_handler.rs', 'votor/src/vote_history.rs'],
    note: 'Competitor report ACCEPTED — do not rework this class.',
  },
  {
    kind: 'accepted_report',
    ref: 'agave#14359',
    url: 'https://github.com/anza-xyz/agave/pull/14359',
    title: 'block id repair: enforce strict proof size check for FecSetRoot',
    quote:
      'A bug bounty report showed that we\'re not checking the exact proof size, so the responder could provide an internal node in the merkle tree as the fec set root and the shortened proof would pass',
    publishedAt: '2026-08-06T04:00:29Z',
    paths: ['core/src/repair/serve_repair.rs', 'core/src/repair/block_id_repair_service.rs'],
    note: 'Competitor report ACCEPTED — do not rework.',
  },
  {
    kind: 'accepted_report',
    ref: 'agave#14360',
    url: 'https://github.com/anza-xyz/agave/pull/14360',
    title: 'block id repair: only compare the first 20 bytes of fec set roots',
    quote:
      'only the first 20 bytes of the merkle root are used in the construction of the DMR. We are comparing the full 32 bytes which is incorrect',
    publishedAt: '2026-08-06T04:15:43Z',
    paths: ['core/src/repair/serve_repair.rs', 'core/src/repair/block_id_repair_service.rs'],
    note: 'Competitor report ACCEPTED — partial-commitment/authentication-boundary class.',
  },
];

async function main() {
  const room = await new Room({ name: 'bounty', file: dataFile }).init();

  for (const patch of advisories) {
    const result = room.upsertAdvisory(SEED_AGENT, patch);
    if (!result.ok) throw new Error(`advisory seed failed for ${patch.ghsaId}: ${result.error}`);
    console.log(`  ${result.created ? 'created' : 'updated'} advisory ${result.advisory.ghsaId} (${result.advisory.findingId || 'no finding'})`);
  }

  const existingRefs = new Set(room.fences().map((f) => f.ref));
  for (const patch of fences) {
    if (existingRefs.has(patch.ref)) {
      console.log(`  skipped fence ${patch.ref} (already present)`);
      continue;
    }
    const fence = room.addFence(SEED_AGENT, patch);
    console.log(`  created fence ${fence.id} ${fence.ref}`);
  }

  // Room.flush() only forces an immediate write through the PostgreSQL
  // persistence layer; the plain-file path (used here, no DATABASE_URL) is
  // always debounced 250ms and its timer is deliberately unref()'d so it
  // never keeps a server process alive. A short real wait here lets that
  // debounced write actually land before this short-lived script exits.
  await room.flush();
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log(`\nSeed complete. ${room.advisories().length} advisories, ${room.fences().length} fences in ${dataFile}`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
