#!/usr/bin/env bash
#
# Runs ON the VM. Installs Node and Caddy, fetches the relay, generates a fresh
# token, and starts it under systemd so it survives reboots.
#
# Expects PUBLIC_HOST and ROOM in the environment.
#
set -euo pipefail

ROOM="${ROOM:-bounty}"
PUBLIC_HOST="${PUBLIC_HOST:?PUBLIC_HOST is required}"
REPO="${REPO:-https://github.com/cloak-ag/claude-bros}"
APP="/opt/claude-bros"
STATE_DIR="/var/lib/claude-bros"
CONFIG_DIR="/etc/claude-bros"

[[ "$ROOM" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid room name" >&2; exit 1; }
[[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid public hostname" >&2; exit 1; }

say() { printf '\n\033[36m--\033[0m %s\n' "$1"; }

say "Installing Node.js 22 and git"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
fi
sudo apt-get install -y git caddy >/dev/null
node --version

sudo systemctl disable --now tailscaled >/dev/null 2>&1 || true

say "Fetching the relay"
sudo useradd --system --create-home --home-dir /var/lib/claude-bros \
  --shell /usr/sbin/nologin claude-bros 2>/dev/null || true
sudo mkdir -p "$STATE_DIR" "$CONFIG_DIR"
sudo chown claude-bros:claude-bros "$STATE_DIR"
sudo chmod 700 "$STATE_DIR" "$CONFIG_DIR"
if [ -d "$APP/.git" ]; then
  sudo chown -R claude-bros:claude-bros "$APP"
  sudo -u claude-bros git -C "$APP" pull --ff-only
else
  sudo git clone --depth 1 "$REPO" "$APP"
  sudo chown -R claude-bros:claude-bros "$APP"
fi

say "Generating a fresh token"
# Generate the credential on the VM and never place it in source control.
TOKEN_FILE="$CONFIG_DIR/token"
HUMAN_TOKEN_FILE="$CONFIG_DIR/human-token"
if ! sudo test -f "$TOKEN_FILE"; then
  openssl rand -hex 16 | sudo tee "$TOKEN_FILE" >/dev/null
fi
if ! sudo test -f "$HUMAN_TOKEN_FILE"; then
  openssl rand -hex 32 | sudo tee "$HUMAN_TOKEN_FILE" >/dev/null
fi
sudo chown root:root "$TOKEN_FILE" "$HUMAN_TOKEN_FILE"
sudo chmod 600 "$TOKEN_FILE" "$HUMAN_TOKEN_FILE"
TOKEN="$(sudo cat "$TOKEN_FILE")"
HUMAN_TOKEN="$(sudo cat "$HUMAN_TOKEN_FILE")"
sudo sh -c "printf '%s\\n' 'BROS_TOKEN=$TOKEN' 'BROS_HUMAN_TOKEN=$HUMAN_TOKEN' > '$CONFIG_DIR/env'"
sudo chmod 600 "$CONFIG_DIR/env"

say "Installing the systemd unit"
sudo tee /etc/systemd/system/claude-bros.service >/dev/null <<EOF
[Unit]
Description=claude-bros relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=claude-bros
Group=claude-bros
WorkingDirectory=$APP
EnvironmentFile=$CONFIG_DIR/env
Environment=BROS_ROOM=$ROOM
Environment=BROS_HIDE_TOKEN=true
ExecStart=/usr/bin/node $APP/bin/claude-bros.js serve --host 127.0.0.1 --room $ROOM --data $STATE_DIR/$ROOM.json
Restart=always
RestartSec=3
# The relay holds the whole board in memory; 1 GB e2-micro has ample headroom,
# but cap it so a runaway can never take the box down with it.
MemoryMax=512M
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-bros >/dev/null
sudo systemctl restart claude-bros
sleep 3

say "Configuring public HTTPS"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$PUBLIC_HOST {
  encode zstd gzip
  reverse_proxy 127.0.0.1:7777
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    Referrer-Policy "no-referrer"
    X-Content-Type-Options "nosniff"
    -Server
  }
}
EOF
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy

say "Health"
systemctl is-active claude-bros
curl -fsS "http://127.0.0.1:7777/healthz" && echo

say "Public HTTPS"
for attempt in $(seq 1 30); do
  if curl -fsS "https://$PUBLIC_HOST/healthz"; then echo; break; fi
  if [ "$attempt" -eq 30 ]; then
    sudo journalctl -u caddy --no-pager -n 30
    exit 1
  fi
  sleep 2
done

printf '\n  relay: https://%s\n' "$PUBLIC_HOST"
printf '  token: stored in %s and synced to GCP Secret Manager\n' "$TOKEN_FILE"
printf '  human moderation token: stored in %s and synced separately\n' "$HUMAN_TOKEN_FILE"
