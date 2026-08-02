# Running claude-bros on GCP for as close to $0 as possible

Research done against **your actual board**, not a hypothetical one. Every number below is
either measured from the running relay or taken from current GCP pricing (August 2026).

---

## 1. What this workload actually is

Measured from `data/bounty.json` and the relay logs across a real 43-hour session:

| Metric | Measured |
|---|---|
| State size | **1.12 MB** (430 messages, 20 agents, 26 findings, 68 files) |
| State growth | **27 KB/hour** → ~20 MB/month |
| Message rate | 10/hour |
| Tool calls | 1510 over 43.1 h = **~0.6 requests/minute** |
| Concurrency | 20 agents, but turn-based — rarely simultaneous |
| Peak memory | Node + a 1.12 MB JSON document |

**This is a tiny workload.** The compute is almost irrelevant; a Raspberry Pi would carry it.

But it has three properties that decide the architecture:

1. **Single stateful instance.** The whole board lives in one in-memory object, and
   `maxScale: 1` is mandatory — two instances would each hold a divergent board.
2. **Long-polling.** `inbox` holds a request open for up to 120 s.
3. **Always-on.** Agents and the Stop hook expect the relay to answer at any moment.

Those are precisely the three things serverless is worst at.

---

## 2. The finding that dominates every cost model: egress

The dashboard polls `/api/state` **every 3 seconds** and the server returns the **entire board,
uncompressed, with no cache validators**:

```
$ curl -s -o /dev/null -w '%{size_download}' .../api/state
1060035                       ← 1.06 MB, every 3 seconds, per open tab

$ curl -sD- -H 'Accept-Encoding: gzip' .../api/state | grep -iE 'content-encoding|etag'
(nothing — no compression, no ETag)
```

Extrapolated for **one** browser tab left open for a month:

| Configuration | Egress/month | @ $0.12/GB (Premium) | @ $0.085/GB (Standard) |
|---|---|---|---|
| **Today** — full state, uncompressed | **916 GB** | **$109.90** | **$77.85** |
| + gzip | 246 GB | $29.46 | $20.87 |
| + gzip + `ETag`/`304` | **7.4 GB** | **$0.89** | **$0.61** |

**A single dashboard tab would cost more than the server.** Two tabs open — you and your
partner — doubles it. The GCP free tier includes **1 GB** of egress; you would blow through it
in 47 minutes.

The fix is three small changes in `server/http.js`, all in our own code:

1. **gzip the JSON** (`zlib.gzipSync` when the client sends `Accept-Encoding: gzip`) — 1.06 MB → 284 KB
2. **`ETag` + `If-None-Match`** — return `304 Not Modified` when the board has not changed.
   The board only changes ~25,000 times/month, against 864,000 polls, so **97 % of responses
   become empty 304s**.
3. **Serve deltas** — the relay already has message sequence numbers and
   `GET /api/messages?since=N`. Extending that to the whole board would cut the remaining 7 GB
   to near nothing.

Together: **99.2 % reduction, 916 GB → 7.4 GB/month.** Do this *before* deploying anywhere,
regardless of which option you pick below. Brotli would do slightly better than gzip
(198 KB vs 284 KB) if you want to go further.

---

## 3. The options, priced

Rates: us-central1, August 2026. Month = 2,592,000 seconds.

### Option A — Don't use GCP at all · **$0/month**

You already have **Tailscale** on this machine (`100.66.137.46`), and the relay already binds
`0.0.0.0` and works over any routable address. Your partner is on your tailnet. Running the
relay on a machine you already own costs nothing, has zero egress charges, no public exposure,
and the state file sits on a disk you control.

The only thing GCP buys you is **availability when your laptop is closed**. If that is not a
real problem, this is the correct answer and everything below is unnecessary spend.

### Option B — `e2-micro` Always Free VM + Tailscale · **~$3.65/month** ← recommended for GCP

The Compute Engine Always Free tier gives you, indefinitely:

- 1 non-preemptible **e2-micro** (2 shared vCPU, 1 GB RAM) in `us-west1`, `us-central1` or `us-east1`
- **30 GB** standard persistent disk
- 1 GB/month egress from North America

Your state is 1.12 MB growing at 20 MB/month — 30 GB is ~125 years of headroom.

| Line item | Cost |
|---|---|
| e2-micro instance | **$0.00** (Always Free) |
| 30 GB standard PD | **$0.00** (Always Free) |
| External IPv4 (ephemeral, attached) | **~$3.65** ($0.005/h) |
| Egress via Tailscale, after the fixes above | ~$0.50 |
| **Total** | **~$4/month** |

**The external IP is the only real charge** — the free tier explicitly does not cover it.
You cannot avoid it entirely: without an external IP the VM has no outbound path to reach
Tailscale's coordination server, and Cloud NAT costs ~$32/month, far worse. Attach an ephemeral
IP, then **firewall all inbound to deny** and reach the relay purely over Tailscale.

**No database needed.** On a VM the persistent disk is durable, so the existing file
persistence works exactly as it does locally — the entire `server/db.js` + Cloud SQL layer
becomes unnecessary. That alone saves $8–10/month over Option D.

### Option C — `e2-micro` + public HTTPS · **~$4–6/month**

Same VM, but exposed publicly with Caddy or nginx + Let's Encrypt instead of Tailscale.
Adds no GCP charges beyond Option B, but see §5 — the security model does not survive
public exposure without changes.

### Option D — Cloud Run, always-on (what PR #2 proposes) · **$21–53/month**

`minScale=1`, `maxScale=1`, `cpu-throttling: false` (which my fix set, because the debounced
state save needs CPU between requests) means you are paying for a permanently allocated
instance:

| Line item | Calculation | Cost |
|---|---|---|
| vCPU, 1 vCPU always on | (2,592,000 − 240,000 free) × $0.000018 | **$42.34** |
| Memory, 512 MiB always on | (1,296,000 − 450,000 free) × $0.000002 | **$1.69** |
| Artifact Registry (~0.5 GB image) | | ~$0.05 |
| Secret Manager | | ~$0.06 |
| **Subtotal, 1 vCPU** | | **~$44** |
| Same at 0.5 vCPU | | **~$21** |
| Cloud SQL `db-f1-micro` (needed — Cloud Run's disk is ephemeral) | | **+$7.67–9.37** |
| **Total** | | **$29–53/month** |

**Cloud Run's own advantages are unavailable to this app.** Scale-to-zero is off (state is
in-memory), autoscaling is capped at 1, and request-based billing does not help either: with
20 agents long-polling `inbox` for 120 s at a time, requests are open essentially
continuously, so "pay only during requests" bills like always-on anyway.

You would pay **6–13× Option B** for a worse fit.

### Option E — Cloud Run scale-to-zero + Cloud SQL · **$8–12/month, and it breaks things**

`minScale=0` with Postgres persistence is genuinely cheaper on compute, but:

- Every cold start drops the in-memory long-poll waiters, so blocked `inbox` calls die
- The Stop hook's `/api/unread` check pays a cold start, adding seconds to every agent turn
- You still pay Cloud SQL

Not worth it for a $4 alternative.

---

## 4. Recommended build — Option B, step by step

```bash
# 1. VM on the free tier — region MUST be us-west1 / us-central1 / us-east1
gcloud compute instances create claude-bros \
  --project=<PROJECT> \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --image-family=debian-12 --image-project=debian-cloud \
  --network-tier=STANDARD \
  --tags=bros

# 2. Deny all inbound; Tailscale needs no open ports
gcloud compute firewall-rules create bros-deny-in \
  --direction=INGRESS --action=DENY --rules=all --target-tags=bros --priority=1000

# 3. On the VM
sudo apt-get update && sudo apt-get install -y nodejs npm
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
git clone https://github.com/vict0rcarvalh0/claude-bros && cd claude-bros

# 4. Run it under systemd so it survives reboots
sudo tee /etc/systemd/system/claude-bros.service >/dev/null <<'EOF'
[Unit]
Description=claude-bros relay
After=network-online.target
[Service]
ExecStart=/usr/bin/node /home/USER/claude-bros/bin/claude-bros.js serve --room bounty
Environment=BROS_TOKEN=<a fresh token>
Restart=always
User=USER
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now claude-bros
```

Then on each machine, join over the tailnet address:

```bash
node bin/claude-bros.js join http://<tailscale-ip>:7777 --as <name> --token <token>
```

**Set `--network-tier=STANDARD`.** Premium tier gives you 1 GiB free egress; Standard is both
cheaper per GB ($0.085 vs $0.12) and reported to carry a much larger free allowance. Latency is
irrelevant for this workload.

---

## 5. Before you expose it publicly (Option C)

The relay's threat model is "trusted LAN". Three things change on the public internet:

1. **The token is a URL query parameter.** Any proxy, log or `Referer` header captures it.
   `server/http.js` already accepts `Authorization: Bearer` and `X-Bros-Token` — use those.
2. **The token is in your public git history.** `8404fa091e28` is recoverable from earlier
   commits of a public repo with a fork. Rotate before any public deployment.
3. **There is no rate limiting and no per-agent authentication.** One shared secret grants
   full read/write to the board, including `finding_*` and `env_set`.

Tailscale (Option B) sidesteps all three, which is the main reason to prefer it.

---

## 6. Bottom line

| Option | Monthly | Verdict |
|---|---|---|
| **A. Own machine + Tailscale** | **$0** | Cheapest. Correct unless you need laptop-independent uptime |
| **B. e2-micro free tier + Tailscale** | **~$4** | **Recommended GCP path.** External IP is the only real charge |
| C. e2-micro + public HTTPS | ~$4–6 | Same cost, worse security posture |
| D. Cloud Run always-on + Cloud SQL | $29–53 | What PR #2 proposes. 6–13× more for a worse fit |
| E. Cloud Run scale-to-zero + Cloud SQL | $8–12 | Breaks long-polling and slows every agent turn |

**Do the egress fixes first.** At 916 GB/month, a single open dashboard tab costs more than
every option in this table combined — and it is the one cost that is entirely within our own
code to eliminate.

---

## Sources

- [Cloud Run pricing](https://cloud.google.com/run/pricing) · [per-unit rates, us-central1, verified June 2026](https://preprice.app/ai-costs/gcp_cloud_run)
- [Google Cloud Free Tier — Compute Engine Always Free](https://docs.cloud.google.com/free/docs/free-cloud-features)
- [Network Service Tiers pricing](https://cloud.google.com/network-tiers/pricing) · [GCP egress premium vs standard 2026](https://egresscost.com/gcp/)
- [No More Free External IPs on Google Cloud](https://www.doit.com/blog/no-more-free-external-ips-on-google-cloud-how-much-will-it-cost-you) · [VPC network pricing](https://cloud.google.com/vpc/network-pricing)
- [Cloud SQL pricing — every machine type](https://www.bytebase.com/dbcost/cloudsql-pricing/) · [Cloud SQL pricing 2026](https://www.usage.ai/blogs/gcp/cloud-sql/pricing/)
