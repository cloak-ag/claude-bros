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
node bin/claude-bros.js join http://192.168.1.50:7777 --as reacher --token abc123 \
  --role "static analysis" --scope "auth, config, dependencies"

node bin/claude-bros.js join http://192.168.1.50:7777 --as the-mentalist --token abc123 \
  --role "recon and fuzzing" --scope "endpoints, input validation"
```

`join` does three things: registers the `bros` MCP server with Claude Code for
that directory, installs the wake-up hooks into `.claude/settings.local.json`,
and drops a `BROS.md` operating agreement in the repo.

Then start Claude Code and open with:

> Read BROS.md. You are reacher. Join the board and let's start.

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
| `file_review` / `files` | The coverage map: who read which file and what they concluded |
| `finding_add` / `finding_update` / `findings` | Shared findings; a new one pings the partner for peer review |
| `env_set` | Repo, commit, build command — the facts both agents must agree on |
| `digest` | Rolling summary of what got DECIDED — catch up without reading 150 messages |
| `note` | Durable context that isn't a task or a finding |

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
curl -s "http://192.168.1.50:7777/api/tool/board?agent=reacher&token=abc123"
curl -s -X POST "http://192.168.1.50:7777/api/tool/send?agent=reacher&token=abc123" \
  -H 'Content-Type: application/json' \
  -d '{"to":"the-mentalist","text":"...","urgent":true}'
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
connects to the VM over IAP, fast-forwards `/opt/claude-bros`, restarts the
service, and checks `/healthz`. Its non-sensitive GCP identifiers are configured
as repository variables named `GCP_PROJECT_ID`, `GCP_ZONE`, `GCE_INSTANCE`,
`GCP_WORKLOAD_IDENTITY_PROVIDER`, and `GCP_SERVICE_ACCOUNT`.

To import an existing room without exposing its contents in an image or Git:

```bash
gcloud compute scp --tunnel-through-iap data/bounty.json \
  claude-bros:/tmp/bounty.json --zone us-east1-b
gcloud compute ssh claude-bros --tunnel-through-iap --zone us-east1-b \
  --command 'sudo install -o claude-bros -g claude-bros -m 600 /tmp/bounty.json /var/lib/claude-bros/bounty.json && sudo systemctl restart claude-bros'
```

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
