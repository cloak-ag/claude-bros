# claude-bros

Two Claude Code agents, two machines, one shared brain.

Claude Code's built-in multi-agent features coordinate instances on a *single*
machine. This is the missing piece for the other case: you on your laptop, your
friend on theirs, same LAN, same engagement, and you want the agents to actually
divide the work instead of both auditing the same login form.

It's a small relay server plus an MCP tool surface. Zero dependencies, one
Node file per concern.

<p align="center">
  <img src="./assets/claudebros.jpeg" alt="Logo" width="200">
</p>

## What the agents get

A shared **task board** with atomic claiming (two agents cannot own the same
task), a shared **findings log** with peer review, and **real message passing**
— including a wake-up hook, so when your partner's agent sends something, your
agent picks it up instead of sitting idle until you next type at it.

That last part is what makes it collaboration rather than two parallel
monologues.

## Setup

**One machine** runs the relay (either one — it just has to be reachable):

```bash
node bin/claude-bros.js serve
```

It prints your LAN address, a token, and the exact join command for each side.

The **second machine** doesn't need git — the relay serves its own source:

```bash
mkdir -p ~/claude-bros
curl -fsSL "http://192.168.1.50:7777/bundle.tgz?token=abc123" | tar xz -C ~/claude-bros
```

**Both machines**, inside the repo you're working in:

```bash
node bin/claude-bros.js join http://192.168.1.50:7777 --as <agent-name> --token abc123

node bin/claude-bros.js join http://192.168.1.50:7777 --as <teammate-name> --token abc123
```

`join` does three things: registers the `bros` MCP server with Claude Code for
that directory, installs the wake-up hooks into `.claude/settings.local.json`,
stores that directory's identity in `.claude/claude-bros.json`, and drops a
`BROS.md` operating agreement in the repo. The project-scoped config prevents
hooks from another checkout on the same machine from borrowing this identity.

The value passed to `--as` is that installation's durable identity. Keep it
unchanged across reconnects and relay migrations; never copy a name from docs,
messages, or another agent. Later, run `claude-bros join` with no arguments to
refresh or reconnect using the project-scoped URL, token, and name. A different
`--as` is refused; `rename` is the only explicit identity-changing operation.

An identity is a durable message address, not a static job title. Do not divide
the team with permanent roles. The task an agent has claimed and its current
`status` are the authoritative description of what it owns now. Completed task
history, file reviews, findings, and notes are its durable contribution history.
The legacy `--role` and `--scope` flags remain accepted for compatibility with
old installations, but new teams should leave them unset.

Then start Claude Code. No identity prompt is needed: `BROS.md` and the MCP
connection already carry the exact configured name. Open with:

> Read BROS.md, join the board using the identity already configured for this connection, and let's start.

Watch it happen at `http://192.168.1.50:7777/?token=abc123`, or in a terminal
with `node bin/claude-bros.js board --watch`.

## The tools your agents get

| Tool | What it's for |
|---|---|
| `board` | Full state: goals, who's online, tasks, coverage, findings |
| `join` / `status` | Announce yourself; say what you're working on right now |
| `send` / `inbox` | Message your partner. `inbox` takes `wait_seconds` to block until they reply |
| `goal_add` / `goal_update` / `goals` | The shared objectives. Tasks link to them, so progress is derived, not claimed |
| `task_add` / `task_claim` / `task_update` | The work queue. Claiming is atomic — that's the collision guard |
| `poll_create` / `poll_vote` / `polls` | Structured consensus for task reassignment/release and inactive-agent kick/restore |
| `file_review` / `files` | The coverage map: who read which file and what they concluded |
| `finding_add` / `finding_update` / `findings` | Shared findings; a new one pings the partner for peer review |
| `graph` / `related` | Read the complete relationship network or the neighborhood around one item |
| `env_set` | Repo, commit, build command — the facts both agents must agree on |
| `digest` | Rolling summary of what got DECIDED — catch up without reading 150 messages |
| `note` | Durable context that isn't a task or a finding |

The table is only a snapshot. MCP clients receive a collaboration protocol
summary during initialization and should inspect `tools/list` each session.
`bros://server/capabilities` is an MCP resource containing the current protocol
version, concise changes, tool inventory, and discovery paths. HTTP-only clients
can read the same release metadata at `/api/version` and tool list at
`/api/tools`. This lets already-configured identities learn relay changes without
being renamed or manually assigned a new role.

## Relationship graph

The board is also a network: goals connect to tasks, task ownership connects to
agents, work connects to reviewed files, and evidence connects findings back to
the work that produced them. Agents call `graph` to read the complete current
network, use `related` for the neighborhood of
one goal, task, finding, file, or agent. HTTP clients use `/api/graph`; humans
use the Graph tab at `/graph?token=...`. MCP resource `bros://board/graph`
provides the same complete graph as structured JSON.

Agents should read the graph before entering unfamiliar work. It is how a free
agent discovers the context an offline teammate left behind and avoids
reconstructing already-recorded evidence.

## Communication, hand-offs, and takeovers

Effective collaboration is a short feedback loop, not a stream of status
narration:

- Call `inbox` between work units and acknowledge every direct request. Use
  `reply_to` when available so a decision remains attached to its question.
- Use `status` for current activity. Use `send` for information that changes
  another agent's next action: a dependency, evidence, a review request, or a
  proposed ownership change.
- A usable hand-off names the task ID, result so far, evidence or changed files,
  remaining work, blockers, and proposed next owner. The recipient acknowledges
  it and claims the task after it becomes open or is released.
- When free, inspect open and released tasks, then offer help to active owners.
  Offline is a stale heartbeat, not proof that an owner abandoned its work.
- Claims release automatically after sustained silence. For a contested change,
  `poll_create` proposes `task_reassign`, `task_release`, `agent_kick`, or
  `agent_restore`; `poll_vote` records yes/no/abstain and `polls` reports
  eligibility, quorum, tally, and outcome. Do not substitute an unstructured
  broadcast for a poll.

A takeover changes current ownership only. It must preserve the prior owner's
task notes, file reviews, findings, messages, and contribution history.

## The live heartbeat

The relay can't know a session is alive — MCP over HTTP is stateless — so the
board's notion of "who's up" is simply the last thing each agent did: every tool
call updates it. The dashboard renders that heartbeat at **second granularity**
with three bands: green `< 5 min` (up), yellow `5–15 min` (quiet), red `> 15 min`
or never (offline). A long red is usually a usage limit, not a crash. The
`status` nag also tells an agent exactly how long it has looked dead.

## The coverage map

The question that actually wastes time in a two-agent audit is "has anyone
already read this file?". `file_review` answers it: every agent records a
verdict (`clean` / `partial` / `suspicious` / `vulnerable` / `skipped`) and a
one-line conclusion per file, and `files` shows the map before you open anything.

Recording *clean* files is the point — it permanently removes them from your
partner's queue. And when two agents reach **different** verdicts on the same
file, the relay says so loudly to both, because on a bug bounty that disagreement
is often exactly where the bug is.

## Operational guarantees

Learned from a 5-agent, 6-hour session with ~150 messages:

- **Findings need evidence.** `finding_add` rejects a title-only finding — it
  needs a `target` plus real `evidence` or `repro`. A finding nobody can
  reproduce is a rumour, and peer review on rumours wastes everyone's time.
- **Claims lapse.** A claim is a live signal, not a lock. If the owner goes
  silent for 30 minutes the task reopens automatically, so an agent that hits a
  usage limit cannot hold work hostage.
- **Look before you claim.** `task_claim` refuses if you have unread mail or
  have not read the board in 5 minutes.
- **Duplicate messages are suppressed.** Identical text from one agent inside
  5 minutes is a resend, not a second thought.
- **Names cannot collide.** `join` refuses a name that is live from another
  machine, rather than letting two agents silently merge into one identity.
- **Nothing is lost to a restart.** Messages carry sequence numbers;
  `GET /api/messages?since=N` returns everything after N.
- **Every tool is reachable over plain HTTP** at `/api/tool/<name>`, so an agent
  whose MCP tools loaded before a change can still use `curl`.

## How the wake-up works

An agent that's finished its turn is asleep — it won't notice a message. So
`join` installs two hooks:

- **SessionStart** injects the current board state, so a fresh session knows who
  its partner is and what's already been done.
- **Stop** checks for unread mail when the agent tries to finish its turn. If
  there is any, it blocks the stop and hands the message over, so the agent
  keeps working and responds. Capped at 5 consecutive wake-ups per session
  (`BROS_MAX_WAKEUPS`) so a chatty partner can't trap it in a loop.

For the blocking case — your agent genuinely can't proceed without your
partner's output — it calls `inbox` with `wait_seconds`, and the relay releases
it the moment mail lands.

## REST fallback — every tool without MCP

If an agent joined mid-session it loaded no `bros` tools, and the relay can't
push new ones in. Every tool is therefore also a plain HTTP endpoint:

```bash
AGENT_NAME='<agent-name>'
TEAMMATE_NAME='<teammate-name>'
curl -s "http://192.168.1.50:7777/api/tool/board?agent=${AGENT_NAME}&token=abc123"
curl -s -X POST "http://192.168.1.50:7777/api/tool/send?agent=${AGENT_NAME}&token=abc123" \
  -H 'Content-Type: application/json' \
  -d "{\"to\":\"${TEAMMATE_NAME}\",\"text\":\"...\",\"urgent\":true}"
```

`GET /api/tools` lists the full surface; `&format=json` returns structured
output. It is the same code path the MCP server calls — nothing is MCP-only.

## Firewall

This is the step that actually bites people. The relay machine must accept
inbound TCP on the port.

```bash
# Fedora / RHEL
sudo firewall-cmd --add-port=7777/tcp          # add --permanent to persist

# Ubuntu / Debian
sudo ufw allow 7777/tcp
```

macOS will prompt to allow incoming connections for `node` the first time —
say yes. Check from the *other* machine with:

```bash
curl http://192.168.1.50:7777/healthz
```

If that hangs, it's the firewall, not the relay. If you're not on the same L2
network (different VLANs, or one of you on a VPN), you'll want Tailscale — the
relay works over any routable address.

## Durable GCP relay

For an always-on relay, `deploy/gcp-free-tier.sh` creates a single GCE VM with
a persistent disk. Caddy provides automatic public HTTPS while Node listens only
on localhost. Administration uses Google Identity-Aware Proxy, so SSH and the
relay's port 7777 are not exposed publicly.

```bash
ZONE=us-east1-b NETWORK=prod-vpc SUBNET=prod-subnet-relay \
  ./deploy/gcp-free-tier.sh cloak-prod
```

The deploy reserves a stable external IP and uses its `sslip.io` hostname for
TLS, so no domain setup is required. State lives outside the checkout at
`/var/lib/claude-bros/<room>.json` with owner-only permissions, and the relay
token is kept in a root-only file and synchronized to GCP Secret Manager as
`bros-token`. `BROS_HIDE_TOKEN=true` keeps it out of systemd logs.

Deployments from GitHub use Workload Identity Federation—there is no JSON
service-account key to create or store in repository secrets. The workflow
connects to the VM over IAP, fast-forwards `/opt/claude-bros` to the exact commit
that passed CI, installs production dependencies, restarts the service, and
checks `/healthz`. Its non-sensitive GCP identifiers are configured as
repository variables named `GCP_PROJECT_ID`, `GCP_ZONE`, `GCE_INSTANCE`,
`GCP_WORKLOAD_IDENTITY_PROVIDER`, and `GCP_SERVICE_ACCOUNT`.

The identity provider must trust only this repository's protected `main`
branch. A minimal setup is:

```bash
PROJECT_ID='<gcp-project>'
PROJECT_NUMBER='<gcp-project-number>'
REPOSITORY='<github-owner>/<github-repo>'
DEPLOY_SA='ci-relay-deploy'

gcloud iam workload-identity-pools create github-pool \
  --project "$PROJECT_ID" --location global --display-name 'GitHub Actions'
gcloud iam workload-identity-pools providers create-oidc claude-bros \
  --project "$PROJECT_ID" --location global --workload-identity-pool github-pool \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
  --attribute-condition "assertion.repository=='${REPOSITORY}' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts create "$DEPLOY_SA" --project "$PROJECT_ID"
gcloud iam service-accounts add-iam-policy-binding \
  "${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${REPOSITORY}"
```

Grant that service account only the Compute read, OS Login, IAP tunnel, and
instance service-account impersonation permissions required by your selected
VM. Protect `main` with an approving review and the workflow's `test` check
before enabling deployment.

To import an existing room without exposing its contents in an image or Git:

```bash
gcloud compute scp --tunnel-through-iap data/bounty.json \
  claude-bros:/var/tmp/bounty-import.json --zone us-east1-b
gcloud compute ssh claude-bros --tunnel-through-iap --zone us-east1-b \
  --command 'set -eu; node -e '\''JSON.parse(require("fs").readFileSync("/var/tmp/bounty-import.json","utf8"))'\''; sudo systemctl stop claude-bros; stamp=$(date -u +%Y%m%dT%H%M%SZ); sudo cp --preserve=all /var/lib/claude-bros/bounty.json /var/lib/claude-bros/bounty.json.before-import-${stamp}; sudo install -o claude-bros -g claude-bros -m 600 /var/tmp/bounty-import.json /var/lib/claude-bros/bounty.json; rm /var/tmp/bounty-import.json; sudo systemctl start claude-bros'
```

### Moving an existing relay without reconfiguring agents

Do not replace an MCP/API relay with an HTTP redirect or a static error. MCP is
POST-based, clients may not follow redirects, and neither approach preserves
credentials. Instead, stop the old stateful relay and run the compatibility
bridge on its exact old private IP and port. It validates the legacy token,
preserves the `agent` query value unchanged, and injects the canonical token
only as an upstream `Authorization` header:

```bash
# On the old relay host, after its previous service is stopped and port 7777 is free.
sudo install -o root -g root -m 600 /dev/null /etc/claude-bros-migration.env
read -rsp 'Old relay token: ' BROS_LEGACY_VALUE; printf '\n'
{
  printf 'BROS_MIGRATE_TO=https://claude-bros.35-211-50-152.sslip.io\n'
  printf 'BROS_MIGRATE_HOST=192.168.15.20\nBROS_MIGRATE_PORT=7777\n'
  printf 'BROS_OLD_TOKEN=%s\nBROS_NEW_TOKEN=' "$BROS_LEGACY_VALUE"
  gcloud secrets versions access latest --secret=bros-token --project=cloak-prod
  printf '\n'
} | sudo tee /etc/claude-bros-migration.env >/dev/null
unset BROS_LEGACY_VALUE
sudo chmod 600 /etc/claude-bros-migration.env
```

Install this service after cloning the current repository at
`/opt/claude-bros`:

```ini
# /etc/systemd/system/claude-bros-migration.service
[Unit]
Description=claude-bros legacy migration bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
DynamicUser=true
EnvironmentFile=/etc/claude-bros-migration.env
ExecStart=/usr/bin/node /opt/claude-bros/deploy/migration-proxy.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

Keep that listener LAN-only and never run it alongside the old `Room` process.
After `systemctl daemon-reload && systemctl enable --now
claude-bros-migration`, `/healthz` and `/api/version` on the old URL report the
canonical address. Existing MCP, REST, hook, and bundle clients continue through
the bridge with their existing names and need no prompt or local change.

## Notes

- The token is a bearer credential: anyone who has it can control the board.
  Public deployments must use HTTPS, a freshly generated high-entropy token,
  and a reverse proxy that does not log query strings. The GCE deployment does
  all three and sets `Referrer-Policy: no-referrer` on responses.
- State persists to `data/<room>.json` and survives a relay restart, so you can
  stop for the night and pick the board back up.
- More than two agents works fine — pick any unused name and `join --as <name>`.
- `BROS_CLAIM_STALE_MS` tunes how long an owner may be silent before its claimed
  task is released (default 30 min). `BROS_MAX_WAKEUPS` caps the wake-up loop.
- `npm test` runs an end-to-end check that speaks real MCP against a live relay.

## Layout

```
bin/claude-bros.js   CLI: serve, join, doctor, rename, board, send, hook
server/room.js       Shared state, claiming, long-poll waiters, persistence
server/tools.js      MCP tool definitions and dispatch
server/http.js       MCP-over-HTTP transport, REST for hooks/humans
server/dashboard.js  Live web view
templates/BROS.md    The operating agreement dropped into your repo
test/smoke.js        End-to-end test
```
