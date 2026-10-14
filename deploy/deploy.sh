#!/usr/bin/env bash
# Strix: pull the latest code, build and restart. Run as the deploy user (e.g. ubuntu) on the VPS, after bootstrap.sh.
#   bash /opt/strix/deploy/deploy.sh        # or:  cd /opt/strix && bash deploy/deploy.sh
# Needs no root except the one whitelisted command `sudo systemctl restart strix` (installed by bootstrap.sh).
set -euo pipefail

APP=/opt/strix
REPO="${REPO:-https://github.com/Rehan30g/strix.git}"
cd "$APP"

if [[ ! -d .git ]]; then
  echo "== first deploy: fetching $REPO"
  git init -q -b main
  git remote add origin "$REPO"
fi
git fetch --depth 1 origin main
git checkout -q -f -B main FETCH_HEAD     # ignored files (data/, web/public/intro/*.mp3) are left alone
echo "== now at $(git log --oneline -1)"

echo "== install and build"
npm ci --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
npm run build

# the tour narration clips are not in the repo: warn if they are missing
if ! ls web/public/intro/t_hello.mp3 >/dev/null 2>&1; then
  echo "!! web/public/intro/t_*.mp3 missing: the first-time tour will have no narration (copy them with rsync, then rebuild)"
fi

echo "== restart"
sudo systemctl restart strix
sleep 4
if curl -fsS --max-time 8 http://127.0.0.1:3000/api/healthz >/dev/null; then echo "OK: healthy"; else echo "NOT healthy: sudo journalctl -u strix -n 50"; exit 1; fi
