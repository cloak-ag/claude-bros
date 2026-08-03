#!/usr/bin/env bash
#
# Deploy the claude-bros relay to a GCP Always Free e2-micro. Caddy terminates
# public HTTPS, Node listens only on localhost, and administration uses IAP.
# Running cost is the external IPv4 and a little egress; the VM and its 30 GB
# disk are free tier.
#
#   ./deploy/gcp-free-tier.sh <PROJECT_ID>
#
set -euo pipefail

PROJECT="${1:?usage: $0 <PROJECT_ID>}"

# These three are the only regions the Always Free e2-micro is offered in.
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-claude-bros}"
ROOM="${ROOM:-bounty}"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-}"
REGION="${ZONE%-*}"
ADDRESS_NAME="${ADDRESS_NAME:-claude-bros-ip}"

[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo "invalid GCP project id" >&2; exit 1; }
[[ "$ZONE" =~ ^[a-z0-9-]+$ ]] || { echo "invalid GCP zone" >&2; exit 1; }
[[ "$NAME" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || { echo "invalid instance name" >&2; exit 1; }
[[ "$ROOM" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid room name" >&2; exit 1; }
[[ "$NETWORK" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || { echo "invalid network name" >&2; exit 1; }
if [ -n "$SUBNET" ]; then
  [[ "$SUBNET" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || { echo "invalid subnet name" >&2; exit 1; }
fi
[[ "$ADDRESS_NAME" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || { echo "invalid address name" >&2; exit 1; }

say() { printf '\n\033[35m==>\033[0m \033[1m%s\033[0m\n' "$1"; }

say "Project $PROJECT, zone $ZONE"
gcloud config set project "$PROJECT" >/dev/null
gcloud services enable compute.googleapis.com --quiet
gcloud services enable iap.googleapis.com secretmanager.googleapis.com --quiet

say "Creating the free-tier VM (e2-micro, 30 GB standard PD, STANDARD network tier)"
if gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  echo "    already exists — reusing it"
else
  NETWORK_ARGS=(--network="$NETWORK")
  if [ -n "$SUBNET" ]; then NETWORK_ARGS=(--subnet="$SUBNET"); fi
  gcloud compute instances create "$NAME" \
    --zone="$ZONE" \
    --machine-type=e2-micro \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --network-tier=STANDARD \
    "${NETWORK_ARGS[@]}" \
    --tags=claude-bros \
    --metadata=enable-oslogin=TRUE
fi

# Promote the VM's ephemeral address in place so the automatic TLS hostname is
# stable across reboots and upgrades.
say "Reserving the relay's public IP"
INSTANCE_IP="$(gcloud compute instances describe "$NAME" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
if gcloud compute addresses describe "$ADDRESS_NAME" --region="$REGION" >/dev/null 2>&1; then
  PUBLIC_IP="$(gcloud compute addresses describe "$ADDRESS_NAME" --region="$REGION" --format='value(address)')"
  if [ "$PUBLIC_IP" != "$INSTANCE_IP" ]; then
    echo "reserved address $PUBLIC_IP is not attached to $NAME ($INSTANCE_IP)" >&2
    exit 1
  fi
else
  gcloud compute addresses create "$ADDRESS_NAME" --region="$REGION" \
    --addresses="$INSTANCE_IP" --network-tier=STANDARD
  PUBLIC_IP="$INSTANCE_IP"
fi
PUBLIC_HOST="${PUBLIC_HOST:-claude-bros.${PUBLIC_IP//./-}.sslip.io}"
[[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid public hostname" >&2; exit 1; }

# Administration travels through Identity-Aware Proxy. Public traffic reaches
# Caddy on 80/443; the relay's port 7777 remains blocked by the deny-all rule.
say "Allowing public HTTPS and IAP SSH, then denying every other inbound connection"
gcloud compute firewall-rules describe claude-bros-allow-web >/dev/null 2>&1 || \
  gcloud compute firewall-rules create claude-bros-allow-web \
    --direction=INGRESS --action=ALLOW --rules=tcp:80,tcp:443 \
    --source-ranges=0.0.0.0/0 \
    --network="$NETWORK" \
    --target-tags=claude-bros --priority=800 \
    --description="Public HTTPS for claude-bros via Caddy"
gcloud compute firewall-rules describe claude-bros-allow-iap-ssh >/dev/null 2>&1 || \
  gcloud compute firewall-rules create claude-bros-allow-iap-ssh \
    --direction=INGRESS --action=ALLOW --rules=tcp:22 \
    --source-ranges=35.235.240.0/20 \
    --network="$NETWORK" \
    --target-tags=claude-bros --priority=900 \
    --description="IAP-only administration for claude-bros"
gcloud compute firewall-rules describe claude-bros-deny-in >/dev/null 2>&1 || \
  gcloud compute firewall-rules create claude-bros-deny-in \
    --direction=INGRESS --action=DENY --rules=all \
    --network="$NETWORK" \
    --target-tags=claude-bros --priority=1000 \
    --description="Deny relay port and all non-HTTPS, non-IAP ingress"

say "Waiting for SSH"
until gcloud compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap --command 'true' >/dev/null 2>&1; do
  printf '.'; sleep 5
done; echo

say "Bootstrapping the VM"
gcloud compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap \
  --command "PUBLIC_HOST='${PUBLIC_HOST}' ROOM='${ROOM}' bash -s" -- -T < "$(dirname "$0")/vm-bootstrap.sh"

# Keep the relay credential recoverable without placing it in GitHub. This
# streams it directly from the root-only VM file into Secret Manager.
say "Synchronising the relay token to Secret Manager"
if gcloud secrets describe bros-token >/dev/null 2>&1; then
  gcloud compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap \
    --command 'sudo cat /etc/claude-bros/token' -- -T \
    | gcloud secrets versions add bros-token --data-file=- >/dev/null
else
  gcloud compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap \
    --command 'sudo cat /etc/claude-bros/token' -- -T \
    | gcloud secrets create bros-token --data-file=- >/dev/null
fi

if gcloud secrets describe bros-human-token >/dev/null 2>&1; then
  gcloud compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap \
    --command 'sudo cat /etc/claude-bros/human-token' -- -T \
    | gcloud secrets versions add bros-human-token --data-file=- >/dev/null
else
  gcloud compute ssh "$NAME" --zone "$ZONE" --tunnel-through-iap \
    --command 'sudo cat /etc/claude-bros/human-token' -- -T \
    | gcloud secrets create bros-human-token --data-file=- >/dev/null
fi

cat <<'EOF'

  Next:
    1. Read the token when needed:
         gcloud secrets versions access latest --secret=bros-token
       Read the separate human moderation token only when editing/deleting messages:
         gcloud secrets versions access latest --secret=bros-human-token
    2. Generate configuration for each persistent identity:
         node bin/claude-bros.js connect <relay-url> --as <name>
    3. Add it to Claude, Codex, Grok, or another MCP host and restart that client.

  To move an existing board across:
       gcloud compute scp --tunnel-through-iap data/<room>.json claude-bros:/tmp/<room>.json --zone ZONE
       gcloud compute ssh claude-bros --tunnel-through-iap --zone ZONE --command \
         'sudo install -o claude-bros -g claude-bros -m 600 /tmp/<room>.json /var/lib/claude-bros/<room>.json && sudo systemctl restart claude-bros'
EOF

printf '\n  Relay URL: https://%s\n' "$PUBLIC_HOST"
