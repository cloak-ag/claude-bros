#!/usr/bin/env bash
#
# Deploy the claude-bros relay to a GCP Always Free e2-micro, reachable only
# over Tailscale. Running cost is the external IPv4 (~$3.65/month) and a little
# egress; the VM and its 30 GB disk are free tier.
#
#   ./deploy/gcp-free-tier.sh <PROJECT_ID> [TAILSCALE_AUTH_KEY]
#
# The auth key is optional — without it the script pauses and prints a URL for
# you to authorise the machine interactively.
#
set -euo pipefail

PROJECT="${1:?usage: $0 <PROJECT_ID> [TAILSCALE_AUTH_KEY]}"
TS_KEY="${2:-}"

# These three are the only regions the Always Free e2-micro is offered in.
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-claude-bros}"
ROOM="${ROOM:-bounty}"

say() { printf '\n\033[35m==>\033[0m \033[1m%s\033[0m\n' "$1"; }

say "Project $PROJECT, zone $ZONE"
gcloud config set project "$PROJECT" >/dev/null
gcloud services enable compute.googleapis.com --quiet

say "Creating the free-tier VM (e2-micro, 30 GB standard PD, STANDARD network tier)"
if gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  echo "    already exists — reusing it"
else
  gcloud compute instances create "$NAME" \
    --zone="$ZONE" \
    --machine-type=e2-micro \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --network-tier=STANDARD \
    --tags=claude-bros \
    --metadata=enable-oslogin=TRUE
fi

# Tailscale needs no open ports — it makes an outbound connection. So refuse
# everything inbound; the relay is unreachable from the public internet.
say "Firewalling all inbound shut (Tailscale dials out, nothing dials in)"
gcloud compute firewall-rules describe claude-bros-deny-in >/dev/null 2>&1 || \
  gcloud compute firewall-rules create claude-bros-deny-in \
    --direction=INGRESS --action=DENY --rules=all \
    --target-tags=claude-bros --priority=1000 \
    --description="claude-bros is reached over Tailscale only"

say "Waiting for SSH"
until gcloud compute ssh "$NAME" --zone "$ZONE" --command 'true' >/dev/null 2>&1; do
  printf '.'; sleep 5
done; echo

say "Bootstrapping the VM"
gcloud compute ssh "$NAME" --zone "$ZONE" --command "TS_KEY='${TS_KEY}' ROOM='${ROOM}' bash -s" -- -T < "$(dirname "$0")/vm-bootstrap.sh"

say "Tailscale address of the relay"
gcloud compute ssh "$NAME" --zone "$ZONE" --command 'tailscale ip -4' 2>/dev/null | tail -1

cat <<'EOF'

  Next:
    1. Copy the token printed above.
    2. Invite your partner to the tailnet (or share just this node):
         https://login.tailscale.com/admin/machines  ->  Share
    3. On every machine, inside the repo you work in:
         node bin/claude-bros.js join http://<tailscale-ip>:7777 --as <name> --token <token>
    4. Restart Claude Code in that directory.

  To move an existing board across:
       gcloud compute scp data/<room>.json claude-bros:~/claude-bros/data/ --zone ZONE
       gcloud compute ssh claude-bros --zone ZONE --command 'sudo systemctl restart claude-bros'
EOF
