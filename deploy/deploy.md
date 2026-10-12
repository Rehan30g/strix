# Deploy Strix on a small VPS (short-lived preview)

Target: Ubuntu/Debian VPS, Node >= 24 (built-in `node:sqlite`; tested with Node 26), Caddy for HTTPS.
One process, one SQLite file (`/opt/strix/data/app.db`).

## 1. Google OAuth client
1. https://console.cloud.google.com/ -> create/select a project.
2. **APIs & Services -> OAuth consent screen**: User type *External*, app name, support email.
   Scopes: `openid`, `email`, `profile` (non-sensitive). While the app is in *Testing* mode only
   listed **test users** can sign in — add the preview testers' Gmail addresses there (max 100),
   or publish the app (no verification needed for these basic scopes).
3. **Credentials -> Create credentials -> OAuth client ID -> Web application**.
   - Authorized JavaScript origins: `https://speak.example.com`
   - Authorized redirect URIs: `https://speak.example.com/api/auth/google/callback`
     (must equal `PUBLIC_URL` + `/api/auth/google/callback` exactly).
4. Copy the client ID and secret into the env file (below).

## 2. Server setup
```bash
# as root
apt-get update && apt-get install -y caddy   # see caddyserver.com/docs/install for the apt repo
# Node: install Node 24+ (e.g. NodeSource or nvm for the service user); check: node -v
useradd --system --home /opt/strix --shell /usr/sbin/nologin strix
mkdir -p /opt/strix /etc/strix
# copy this repository (without node_modules, dist, data, .env) to /opt/strix, e.g.
#   rsync -av --exclude node_modules --exclude dist --exclude data --exclude .env ./ root@vps:/opt/strix/
cd /opt/strix
npm ci && npm --prefix web ci          # or: npm run install:all
npm run build                          # builds web/dist and compiles server -> dist/server
mkdir -p data && chown -R strix:strix /opt/strix
```

## 3. Environment file `/etc/strix/strix.env`
Start from `.env.example`. Minimum for production:
```
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://speak.example.com
TRUST_PROXY=1
SESSION_SECRET=<openssl rand -base64 48>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ADMIN_EMAILS=you@gmail.com
OPENROUTER_API_KEY=...
ELEVENLABS_API_KEY=...
DEV_FAKE_LOGIN=0
```
`chmod 600 /etc/strix/strix.env; chown root:root` it (systemd reads it as root).
Note: the server refuses to start if `DEV_FAKE_LOGIN=1` with `NODE_ENV=production`, and if
`SESSION_SECRET` is missing/short in production. The ElevenLabs key needs `voices_write` permission
for voice cloning (otherwise clone uploads fail with `upstream` 401 -> HTTP 502).

## 4. systemd + Caddy
```bash
cp deploy/strix.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now strix
journalctl -u strix -f          # logs (JSON lines)
curl -s localhost:3000/healthz          # {"ok":true}

cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
systemctl reload caddy
```
Open ports 80/443 only (`ufw allow 80,443/tcp`); port 3000 stays on 127.0.0.1.

## 5. First admin and first invite
1. Put your Gmail in `ADMIN_EMAILS`, restart the service.
2. Visit `https://speak.example.com`, sign in with Google -> you are `active` + admin immediately
   (admins never need an invite).
3. Open the Admin page -> create an invite code (uses 1–4, expiry, note) -> copy it and send it to a tester.
   API equivalent from the browser console while signed in as admin:
   `fetch('/api/admin/invites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxUses:3,expiresInHours:72,note:'friends'})}).then(r=>r.json())`
4. Testers sign in with Google, land on the redeem screen, enter the code.

## 6. Backup of `data/app.db`
SQLite runs in WAL mode; use the online backup so a copy is consistent while running:
```bash
sqlite3 /opt/strix/data/app.db ".backup '/root/backup/app-$(date +%F).db'"
```
(or stop the service and copy `app.db`, `app.db-wal`, `app.db-shm` together). Example daily cron:
`0 3 * * * sqlite3 /opt/strix/data/app.db ".backup '/root/backup/app-$(date +\%F).db'"`.
No audio is stored server-side (only TTS text history), so backups are small.

## 7. Updating
```bash
cd /opt/strix && git pull   # or rsync again
npm ci && npm --prefix web ci && npm run build
systemctl restart strix
```

## 8. Taking the preview down
1. Admin page: suspend users / revoke codes (or just stop the service).
2. Delete testers' cloned voices: Admin -> user -> delete voices
   (`DELETE /api/admin/users/:id/voices`), so no clones stay in the ElevenLabs account.
3. `systemctl disable --now strix`; remove the site block from the Caddyfile, `systemctl reload caddy`.
4. Rotate/revoke secrets: delete the OAuth client in Google Cloud Console, rotate the OpenRouter and
   ElevenLabs keys, delete `/etc/strix/strix.env`.
5. Back up (if wanted) and delete `/opt/strix/data/app.db*` (contains emails and TTS text history).
6. Remove the DNS record.
