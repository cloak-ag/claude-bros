#!/usr/bin/env bash
#
# Runs ON the VM. Installs Node and Tailscale, fetches the relay, generates a
# fresh token, and starts it under systemd so it survives reboots.
#
# Expects TS_KEY (optional) and ROOM in the environment.
#
set -euo pipefail

ROOM="${ROOM:-bounty}"
REPO="${REPO:-https://github.com/vict0rcarvalh0/claude-bros}"
APP="$HOME/claude-bros"

say() { printf '\n\033[36m--\033[0m %s\n' "$1"; }

say "Installing Node.js 22 and git"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
fi
sudo apt-get install -y git >/dev/null
node --version

say "Installing Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
fi
if tailscale status >/dev/null 2>&1; then
  echo "   already on the tailnet"
elif [ -n "${TS_KEY:-}" ]; then
  sudo tailscale up --authkey="$TS_KEY" --hostname=claude-bros --ssh
else
  echo "   no auth key supplied — authorise this machine at the URL below:"
  sudo tailscale up --hostname=claude-bros --ssh
fi

say "Fetching the relay"
if [ -d "$APP/.git" ]; then
  git -C "$APP" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP"
fi
mkdir -p "$APP/data"

say "Generating a fresh token"
# The old LAN token is recoverable from public git history — never reuse it.
TOKEN_FILE="$HOME/.claude-bros-token"
[ -f "$TOKEN_FILE" ] || openssl rand -hex 16 > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
TOKEN="$(cat "$TOKEN_FILE")"

say "Installing the systemd unit"
sudo tee /etc/systemd/system/claude-bros.service >/dev/null <<EOF
[Unit]
Description=claude-bros relay
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP
Environment=BROS_TOKEN=$TOKEN
Environment=BROS_ROOM=$ROOM
ExecStart=/usr/bin/node $APP/bin/claude-bros.js serve --room $ROOM
Restart=always
RestartSec=3
# The relay holds the whole board in memory; 1 GB e2-micro has ample headroom,
# but cap it so a runaway can never take the box down with it.
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-bros >/dev/null
sudo systemctl restart claude-bros
sleep 3

say "Health"
systemctl is-active claude-bros
curl -fsS "http://127.0.0.1:7777/healthz" && echo

printf '\n\033[1m  TOKEN: %s\033[0m\n' "$TOKEN"
printf '  dashboard: http://%s:7777/?token=%s\n' "$(tailscale ip -4 2>/dev/null | head -1)" "$TOKEN"
