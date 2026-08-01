# claude-bros

Two Claude Code agents, two machines, one shared brain.

Claude Code's built-in multi-agent features coordinate instances on a *single*
machine. This is the missing piece for the other case: you on your laptop, your
friend on theirs, same LAN, same engagement, and you want the agents to actually
divide the work instead of both auditing the same login form.

It's a small relay server plus an MCP tool surface. Zero dependencies, one
Node file per concern.

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
| `note` | Durable context that isn't a task or a finding |

## The coverage map

The question that actually wastes time in a two-agent audit is "has anyone
already read this file?". `file_review` answers it: every agent records a
verdict (`clean` / `partial` / `suspicious` / `vulnerable` / `skipped`) and a
one-line conclusion per file, and `files` shows the map before you open anything.

Recording *clean* files is the point — it permanently removes them from your
partner's queue. And when two agents reach **different** verdicts on the same
file, the relay says so loudly to both, because on a bug bounty that disagreement
is often exactly where the bug is.

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

## Notes

- The token is a shared secret in the URL, adequate for a trusted LAN. It is
  **not** transport encryption. Don't expose this to the internet; if you need
  it across networks, put it behind Tailscale or an SSH tunnel rather than port
  forwarding.
- State persists to `data/<room>.json` and survives a relay restart, so you can
  stop for the night and pick the board back up.
- More than two agents works fine — pick any unused name and `join --as <name>`.
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
