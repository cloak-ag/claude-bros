# Your setup — do this in order

You need **2 terminals**. Terminal 1 stays open forever. Terminal 2 is where you work.

Everything below is copy-paste. The only thing you type yourself is your repo path in Step 2.

---

## ☐ Step 1 — Start the relay (Terminal 1)

```bash
cd /home/victorcarvalho/Documents/Github/claude-bros && node bin/claude-bros.js serve --token 8404fa091e28
```

**You should see:** a purple `claude-bros relay up — room bounty` block.

**Now leave this terminal alone.** Don't close it. Don't Ctrl-C it. It has to stay
running the whole time you're working. Minimize it.

---

## ☐ Step 2 — Connect yourself (Terminal 2)

Open a **new** terminal. Go to your bug bounty repo — **not** the claude-bros folder:

```bash
cd /path/to/your/bounty/repo
```

☝️ **Replace that path with your real one.** This is the one step you have to think
about. If you run the next command in the wrong folder, everything "works" but does
nothing where you need it.

Confirm you're in the right place before continuing:

```bash
pwd && ls
```

Now connect:

```bash
node /home/victorcarvalho/Documents/Github/claude-bros/bin/claude-bros.js join \
  http://192.168.15.20:7777 --as reacher --token 8404fa091e28 \
  --role "static analysis" --scope "source review, auth logic, config, dependencies"
```

**You should see 4 green ✓ checks.** If you see a red ✗ on the first one, go back to
Step 1 — the relay isn't running.

---

## ☐ Step 3 — Restart Claude Code

**Do not skip this.** Claude only loads the new tools when it starts up. Your current
session literally cannot see them.

- Exit Claude Code (`/exit` or Ctrl-C twice)
- Start it again in that same repo folder: `claude`
- If it asks you to review new hooks → **accept**

---

## ☐ Step 4 — Send your friend their guide

Send him **`PARTNER-SETUP.md`** (Discord, Slack, email — whatever). His Claude reads
it and does the rest.

⚠️ **Send that file, not this one.** This file uses *your* agent name. The partner
guide tells his Claude to pick its own name and lists the ones already taken. If he
follows this file instead, you both become the same agent, the board collapses to a
single identity, and you can't message each other. Terminal 1 shows a red NAME CLASH
banner if that happens.

Their side needs nothing from you except that file and Terminal 1 staying up.

---

## ☐ Step 5 — Kick it off

Paste this into Claude Code:

```
Read BROS.md. You are reacher. Join the board and let's start.
```

**Done.** ✅

---

# Is it actually working?

**The one command that checks everything.** Run it in Terminal 2, inside your repo:

```bash
node /home/victorcarvalho/Documents/Github/claude-bros/bin/claude-bros.js doctor
```

It checks all six things that can be wrong and tells you which one it is. It also
lists who's actually on the board — you want a green ● next to every agent you
expect to be running.

**If it says "Nobody else has joined yet"**, your friend isn't connected. Nothing
on your side will fix that — send him `PARTNER-SETUP.md` and have him run
`doctor` on his machine.

**If you see a red NAME CLASH banner** (in Terminal 1 or on the dashboard), you and
your friend joined under the same name. You're sharing one identity and can't see
each other. He re-runs join with a different `--as` name.

Or open this in your browser and just leave it up — it refreshes itself every 3s:

```
http://192.168.15.20:7777/?token=8404fa091e28
```

---

# Next time (this is the short version)

Once it's set up, starting a new session is just:

1. Terminal 1: `cd /home/victorcarvalho/Documents/Github/claude-bros && node bin/claude-bros.js serve --token 8404fa091e28`
2. Terminal 2: `cd` to your repo, run `claude`

**That's it.** Steps 2–4 above were one-time. The board remembers everything — tasks,
findings, all of it — even after you stop the relay.

---

# If something breaks

| What you see | What to do |
|---|---|
| Friend can't connect | Terminal 1 closed. Restart it (Step 1). |
| Claude has no `bros` tools | You didn't restart Claude Code. Do Step 3. |
| Red ✗ "cannot reach the relay" | Terminal 1 isn't running. |
| `EADDRINUSE` in Terminal 1 | A relay is already running. That's fine — you're done, use it. |
| Agents never message each other | Run `/hooks` in Claude Code, check two `claude-bros` entries exist. |
| Friend's IP fails | Tell them to use `http://100.66.137.46:7777` instead (your Tailscale). |

**Reset everything and start clean** (this wipes tasks and findings):

```bash
rm -rf /home/victorcarvalho/Documents/Github/claude-bros/data
```

---

# Your details, in one place

| | |
|---|---|
| Relay address | `http://192.168.15.20:7777` |
| Tailscale backup | `http://100.66.137.46:7777` |
| Token | `8404fa091e28` |
| You are | `reacher` — static analysis, source review, auth, config |
| Also on the board | `the-mentalist` — cert paths, reward certs |
| Dashboard | `http://192.168.15.20:7777/?token=8404fa091e28` |
