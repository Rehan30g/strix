#!/usr/bin/env bash
# Strix: one-time server setup for a fresh Ubuntu 22.04/24.04 VPS. Safe to run again (idempotent).
#
#   curl -fsSLO https://raw.githubusercontent.com/Rehan30g/strix/main/deploy/bootstrap.sh
#   less bootstrap.sh                                   # read it first
#   sudo bash bootstrap.sh <domain> <deploy-user>       # e.g.  sudo bash bootstrap.sh huzky.xyz ubuntu
#
# What it does:
#   - installs Node.js (same major as the one the app was tested on), Caddy (automatic HTTPS), ufw, fail2ban, git, rsync
#   - creates the system user `strix`, /opt/strix (code, owned by the deploy user) and /opt/strix/data (SQLite, owned by strix)
#   - writes /etc/strix/strix.env with a fresh SESSION_SECRET and EMPTY placeholders for your keys (never committed anywhere)
#   - installs the systemd unit and the Caddy site for <domain>
#   - firewall: only 22, 80, 443 are open to the internet
#   - lets the deploy user restart ONLY the strix service, reload Caddy and read its logs without a password
# What it does NOT do: change SSH settings (see --harden-ssh), start the app (nothing is built yet), or touch any key.
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-26}"
MODE=install
if [[ "${1:-}" == "--harden-ssh" ]]; then MODE=harden; DEPLOY_USER="${2:-${SUDO_USER:-ubuntu}}"; DOMAIN=""; else DOMAIN="${1:-}"; DEPLOY_USER="${2:-}"; fi

[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

say() { printf '\n== %s\n' "$*"; }
APT="apt-get -o DPkg::Lock::Timeout=600 -yq"

harden_ssh() {
  say "SSH hardening (key login only, no root login)"
  local user="${DEPLOY_USER:-${SUDO_USER:-ubuntu}}"
  local keys="/home/$user/.ssh/authorized_keys"
  [[ -s "$keys" ]] || { echo "refusing: $keys is empty, you would lock yourself out"; exit 1; }
  cat > /etc/ssh/sshd_config.d/00-strix-hardening.conf <<'EOF'
# written by Strix bootstrap.sh --harden-ssh (00- so it wins over 50-cloud-init.conf)
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  sshd -t
  systemctl reload ssh || systemctl reload sshd
  echo "done. KEEP THIS SESSION OPEN and test a NEW ssh login with your key before closing it."
}

if [[ $MODE == harden ]]; then harden_ssh; exit 0; fi

[[ -n "$DOMAIN" && -n "$DEPLOY_USER" ]] || { echo "usage: sudo bash bootstrap.sh <domain> <deploy-user> [--harden-ssh]"; exit 1; }
id "$DEPLOY_USER" >/dev/null 2>&1 || { echo "no such user: $DEPLOY_USER"; exit 1; }

say "package mirror check"
# Some providers point apt at a regional mirror (for example id.archive.ubuntu.com) that can be unreachable from the VPS.
# If the configured mirror does not answer, fall back to the main Ubuntu mirror.
. /etc/os-release
SRC_FILES=$(ls /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true)
MIRROR="$(grep -ohE 'https?://[a-z0-9.-]+\.archive\.ubuntu\.com' $SRC_FILES 2>/dev/null | head -1 || true)"
if [[ -n "$MIRROR" ]]; then
  if curl -4 -fsI --connect-timeout 8 --max-time 12 "$MIRROR/ubuntu/dists/${VERSION_CODENAME}/Release" >/dev/null 2>&1; then
    echo "mirror ok: $MIRROR"
  else
    echo "mirror $MIRROR is unreachable from this server, switching to http://archive.ubuntu.com"
    # shellcheck disable=SC2086
    sed -i -E 's#https?://[a-z0-9.-]+\.archive\.ubuntu\.com#http://archive.ubuntu.com#g' $SRC_FILES
  fi
fi

say "base packages"
export DEBIAN_FRONTEND=noninteractive
$APT update
PKGS="ca-certificates curl gnupg ufw fail2ban git rsync sqlite3 debian-keyring debian-archive-keyring apt-transport-https"
# shellcheck disable=SC2086
$APT install $PKGS || { echo "retrying with --fix-missing"; $APT update; $APT install --fix-missing $PKGS; }

say "Node.js $NODE_MAJOR"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  $APT install nodejs
fi
node -v

say "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  $APT update
  $APT install caddy
fi

say "users and folders"
id strix >/dev/null 2>&1 || useradd --system --home /opt/strix --shell /usr/sbin/nologin strix
mkdir -p /opt/strix /opt/strix/data /etc/strix /var/log/caddy
chown "$DEPLOY_USER":strix /opt/strix && chmod 750 /opt/strix
chown strix:strix /opt/strix/data && chmod 750 /opt/strix/data
chown caddy:caddy /var/log/caddy 2>/dev/null || true

say "environment file (secrets stay on this server)"
if [[ ! -f /etc/strix/strix.env ]]; then
  SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | head -c 64)"
  cat > /etc/strix/strix.env <<EOF
# Strix production environment. Readable by root and $DEPLOY_USER only. NEVER commit this file.
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
PUBLIC_URL=https://$DOMAIN
TRUST_PROXY=1
SESSION_SECRET=$SECRET
ALLOWED_ORIGINS=https://$DOMAIN

# Google sign-in (create an OAuth client; redirect URI: https://$DOMAIN/api/auth/google/callback)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# comma list of admin emails (they skip the invite step)
ADMIN_EMAILS=

# providers (server side only)
OPENROUTER_API_KEY=
ELEVENLABS_API_KEY=
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash

# per-user daily limits for testers (raise or lower to taste)
QUOTA_LLM_REQ_PER_DAY=150
QUOTA_TTS_CHARS_PER_DAY=15000
QUOTA_VC_SEC_PER_DAY=300
QUOTA_STT_SEC_PER_DAY=900
QUOTA_SEARCH_PER_DAY=20
DUO_MAX_CALLS_PER_DAY=15
EOF
  echo "created /etc/strix/strix.env with a new SESSION_SECRET"
else
  echo "/etc/strix/strix.env already exists, left untouched"
fi
chown root:"$DEPLOY_USER" /etc/strix/strix.env && chmod 640 /etc/strix/strix.env

say "systemd unit"
cat > /etc/systemd/system/strix.service <<'EOF'
[Unit]
Description=Strix (Fastify)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=strix
Group=strix
WorkingDirectory=/opt/strix
EnvironmentFile=/etc/strix/strix.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/strix/data
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable strix >/dev/null 2>&1 || true

say "Caddy site for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	# SSE (/api/chat, /api/duo/turn) and streamed TTS audio must not be buffered
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
	request_body {
		max_size 40MB
	}
	log {
		output file /var/log/caddy/strix.log
		format console
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# validate ran as root and may have created the log file as root: the caddy service user must own it
chown -R caddy:caddy /var/log/caddy
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy

say "firewall (22, 80, 443 only)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable
systemctl enable --now fail2ban >/dev/null 2>&1 || true

say "limited sudo for $DEPLOY_USER (restart strix, reload caddy, read logs: nothing else)"
SUDOERS=/etc/sudoers.d/strix-deploy
cat > "$SUDOERS.tmp" <<EOF
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart strix, /usr/bin/systemctl start strix, /usr/bin/systemctl stop strix, /usr/bin/systemctl status strix, /usr/bin/systemctl reload caddy, /usr/bin/systemctl restart caddy, /usr/bin/systemctl start caddy, /usr/bin/systemctl status caddy, /usr/bin/journalctl -u strix *, /usr/bin/journalctl -u caddy *
EOF
chmod 440 "$SUDOERS.tmp"
visudo -cf "$SUDOERS.tmp" >/dev/null && mv "$SUDOERS.tmp" "$SUDOERS" || { rm -f "$SUDOERS.tmp"; echo "sudoers check failed, not installed"; exit 1; }

say "done"
echo "domain:     https://$DOMAIN  (Caddy gets the certificate on the first request; the app is not running yet)"
echo "code dir:   /opt/strix (owner $DEPLOY_USER)    env file: /etc/strix/strix.env (fill in the empty keys)"
echo "next:       clone the repo into /opt/strix, copy the tour clips, build, then 'sudo systemctl start strix'"
echo "optional:   sudo bash bootstrap.sh --harden-ssh $DEPLOY_USER   (after you tested key login from every device you use)"
