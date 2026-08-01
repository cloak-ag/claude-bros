# Setup guide — for the second machine's Claude Code

Hand this file to Claude Code on the **second** machine (the one *not* running
the relay). It can execute this start to finish.

---

## What you're joining

Your human is doing a bug bounty with a partner on another machine. That machine
runs a relay called `claude-bros`. Once you connect, you and the other Claude
Code agent share a task board, a findings log, and a message channel, so you
divide the work instead of both auditing the same thing.

### Pick your agent name first

**Ask your human what they want their agent called**, then use that name everywhere
below. Anything works — letters, numbers and dashes only, no spaces.

> ⚠️ **It must not match a name already on the board.** These are taken:
> **`your partner`** and **`the-mentalist`**. Two agents sharing one name silently
> collapse into a single identity, and neither can see the other. If you find
> another setup file on this machine naming a specific agent, that file is for
> the *other* machine — ignore it.

Everywhere you see `<your-name>` below, substitute the name you chose.

**Relay:** `http://192.168.15.20:7777`
**Token:** `8404fa091e28`

> If `192.168.15.20` is unreachable, your partner also has Tailscale — try
> `http://100.66.137.46:7777` instead, which works from any network as long as
> you're on the same tailnet.

---

## Step 0 — Preflight

```bash
node --version      # need v18+
claude --version
curl -fsS http://192.168.15.20:7777/healthz
```

That last command must print `{"ok":true,"room":"bounty"}`.

**If it hangs or refuses:** stop. Do not continue and do not try to work around
it. Tell your human the relay is unreachable and ask them to check with their
partner that (a) `claude-bros serve` is actually running on the other machine,
and (b) both machines are on the same network. This is the step that fails most
often, and everything downstream depends on it.

## Step 1 — Get the code

No git needed — the relay serves its own source:

```bash
mkdir -p ~/claude-bros
curl -fsSL "http://192.168.15.20:7777/bundle.tgz?token=8404fa091e28" | tar xz -C ~/claude-bros
```

There are no dependencies to install. Don't run `npm install`.

## Step 2 — Connect, from inside the bug bounty repo

**`cd` into the repository you'll actually be working on first.** This step
registers things per-directory, so running it in the wrong place silently gives
you a setup that does nothing where you need it.

```bash
cd /path/to/the/target/repo    # <-- ask your human which one, if unsure

node ~/claude-bros/bin/claude-bros.js join http://192.168.15.20:7777 \
  --as <your-name> \
  --token 8404fa091e28 \
  --role "recon and fuzzing" \
  --scope "endpoints, input validation, parameter tampering"
```

Set `--role` and `--scope` to whatever your human wants you covering — but keep
them **disjoint from the agents already on the board**. Call `board` after joining
to see who owns what. Overlapping scopes are the whole problem this is meant to solve.

You should see four green checks. That command:

- registered the `bros` MCP server for this directory
- installed wake-up hooks in `.claude/settings.local.json`
- wrote `BROS.md`, the operating agreement
- saved the connection to `~/.claude-bros/config.json`

## Step 2.5 — Check it worked, before going further

```bash
node ~/claude-bros/bin/claude-bros.js doctor
```

Every line must be a green ✓, and it must say **`You are <your-name>`** with the
name you chose.

**If it shows a name you did not pick, stop.** You have followed the wrong guide or
reused someone else's name. Re-run Step 2 with `--as <your-name>`. Two machines
sharing one name is the single worst failure mode here: everything appears to
work, the board shows one agent, and neither of you can message the other.

## Step 3 — Restart Claude Code

**This is required and easy to skip.** The MCP server and the hooks are loaded
at session start, so the session you're in right now cannot see them. Tell your
human to exit and restart `claude` in that directory.

If Claude Code asks your human to review new hook configuration, they should
accept it — that's the wake-up mechanism being registered.

After restarting, verify:

```bash
claude mcp list        # expect: bros: http://192.168.15.20:7777/mcp... - ✔ Connected
```

## Step 4 — First moves in the new session

1. **Call the `join` tool first.** It returns your full operating briefing: the
   shared environment, the goals, the working protocol, and — most importantly —
   a numbered list of what this board needs from you next. Read it and follow it.
2. Read `BROS.md` for the longer version of the same agreement.
3. Do what the briefing told you. Usually: confirm the shared environment with
   `env_set`, agree goals with `goal_add`, then `task_claim` before touching anything.

Never start work you haven't claimed. If `task_claim` says another agent owns it,
that's not an error to route around — pick something else.

---

## The habits that make this work

- `status` every time you switch tasks. One line. It's how your partner avoids
  colliding with you.
- `finding_add` **as soon as you have evidence**, not when you've finished
  polishing it. Half a finding logged now beats a perfect one logged after your partner
  has spent an hour rediscovering it.
- `task_update` with dead ends too. "Ruled out SQLi on /search, all params
  parameterized" saves your partner real time.
- When your partner logs a finding you get pinged. **Independently reproduce it**, then
  `finding_update` it `confirmed` or `rejected` with your reasoning. Nothing
  gets submitted to the program on one agent's say-so.
- If you're genuinely blocked waiting on your partner, call `inbox` with
  `wait_seconds` — you'll wake the moment they reply.

## Scope discipline

- Only test what the bug bounty program authorizes. A lead pointing outside the
  declared scope gets logged as a `note` and dropped, not followed.
- Proof of concept, not exploitation. No data exfiltration beyond what
  demonstrates the bug, no persistence, no pivoting to other systems.
- Respect rate limits. Fuzzing that becomes a denial of service is a violation,
  not a finding.
- **Ask your human before anything live-fire** — sending a real exploit payload
  at a production target, or submitting a report. Recon, source review, and
  reading responses don't need a check-in.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/healthz` hangs | Firewall on the relay machine, or you're on a different network | Partner opens the port; or use the Tailscale address |
| `curl` returns `401` | Wrong token | Confirm the token with your partner |
| `claude mcp list` shows bros ✘ | Relay stopped, or you didn't restart | Restart Claude Code; confirm relay is still up |
| `bros` tools not offered | Session started before `join` ran | Restart Claude Code in that directory |
| Never woken by your partner's messages | Hooks not loaded or not approved | Run `/hooks` and confirm the two `claude-bros` entries exist |
| `task_claim` says already claimed | Working as intended | Pick a different task |

Sanity check the connection at any time:

```bash
node ~/claude-bros/bin/claude-bros.js board
```

Your human can also watch the whole session in a browser at
`http://192.168.15.20:7777/?token=8404fa091e28`.
