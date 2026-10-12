# Strix: development notes
One app: Fastify + TypeScript backend (`server/`) and a Vite + TypeScript SPA (`web/`), SQLite via
built-in `node:sqlite` (`data/app.db`). Google sign-in + invite codes, per-user quotas, OpenRouter LLM,
ElevenLabs TTS / voice cloning / Voice Changer (speech-to-speech). Scope: [SPEC-LITE.md](SPEC-LITE.md)
(4 features: TTS, Clone Voice, Voice Changer, Chat Persona) on top of [SPEC.md](SPEC.md). API details and deviations for the frontend:
[server/CONTRACT-NOTES.md](server/CONTRACT-NOTES.md). Deploy: [deploy/deploy.md](deploy/deploy.md).

Requires Node >= 24 (developed on Node 26).

## Setup
```bash
npm install                 # server deps (root package)
npm --prefix web install    # web deps        (or: npm run install:all)
cp .env.example .env        # fill in keys; for local work set DEV_FAKE_LOGIN=1 and ADMIN_EMAILS
```

## Development (two terminals)
```bash
npm run dev:server          # Fastify on http://localhost:3000 (tsx watch, reads .env)
npm run dev:web             # Vite on http://localhost:5173, proxies /api and /healthz -> :3000
```
Open http://localhost:5173. The Vite proxy must keep `changeOrigin: false` (the server's same-origin
check compares `Origin` with `Host`), and `ALLOWED_ORIGINS=http://localhost:5173` is set in `.env.example`.
Point Vite to another backend port with `API_ORIGIN=http://localhost:3100 npm run dev:web`.

### Signing in without Google (dev only)
With `DEV_FAKE_LOGIN=1` (refused when `NODE_ENV=production`):
```
http://localhost:5173/api/auth/dev-login?email=admin@example.com&redirect=/     # admin if listed in ADMIN_EMAILS
http://localhost:5173/api/auth/dev-login?email=tester@example.com&redirect=/    # pending -> needs an invite code
```
Without `redirect` it returns JSON (handy for curl: `curl -c jar -b jar 'localhost:3000/api/auth/dev-login?email=a@b.c'`).
Defaults for a bare `/api/auth/dev-login`: `DEV_FAKE_EMAIL`, `DEV_FAKE_NAME`.

Real Google login locally: create an OAuth client with redirect URI
`http://localhost:5173/api/auth/google/callback` and set `PUBLIC_URL=http://localhost:5173`
(or use `:3000` with the built web app).

## Production build
```bash
npm run build               # = npm run build:web (web/dist) && npm run build:server (tsc -> dist/server)
npm start                   # node dist/server/index.js — serves /api + web/dist with SPA fallback
```
`npm run typecheck` type-checks the server only (the web package has its own scripts).

## Scripts (root)
| script | what |
|---|---|
| `dev:server` | `tsx watch server/index.ts` |
| `dev:web` | `npm --prefix web run dev` |
| `build:server` | `tsc -p tsconfig.json` -> `dist/server/*.js` |
| `build:web` | `npm --prefix web run build` -> `web/dist` |
| `build` | web then server |
| `start` | `node dist/server/index.js` |
| `typecheck` | server `tsc --noEmit` |

## Layout
```
server/   index.ts (bootstrap) app.ts (plugins, static, errors) config.ts db.ts quota.ts
          auth.ts (Google OAuth+PKCE, sessions, dev login, access hook) invites.ts admin.ts
          llm.ts (/config /characters /chat) characters.ts (built-in personas + prompt rules)
          tts.ts voices.ts eleven.ts settings.ts vc.ts (/vc Voice Changer) audio.ts (audio sniff/duration)
          stt.ts (/stt/token + /stt/usage: Scribe Realtime single-use tokens)
web/      Vite SPA (built to web/dist)
deploy/   Caddyfile, strix.service, deploy.md
data/     app.db (created on first start, gitignored)
_archive/ code removed by SPEC-LITE (e.g. server/llm-passthrough.ts = old generic /api/llm); not built
```

## Access model
Google login -> account `pending` -> redeem invite code -> `active`. Pending users can only call
`/api/me`, `/api/invite/redeem`, `/api/auth/logout` (everything else `403 invite_required`).
Admins (`ADMIN_EMAILS`) are active immediately. Quotas reset daily at 00:00 UTC.

## Quotas (env defaults, per user per UTC day; admins can override per user)
| env | default | counts |
|---|---|---|
| `QUOTA_LLM_REQ_PER_DAY` | 300 | `/api/chat` requests |
| `QUOTA_TTS_CHARS_PER_DAY` | 30000 | TTS characters |
| `QUOTA_VC_SEC_PER_DAY` | 600 | Voice Changer input seconds (`/api/vc`) |
| `QUOTA_STT_SEC_PER_DAY` | 1800 | mic speech-to-text seconds (Chat mic, ElevenLabs Scribe Realtime): 1 s per token + client-reported audio seconds, capped per session |
| `STT_MAX_SESSION_SEC` | 300 | max length of one STT session (one single-use token) |
| `ELEVENLABS_STT_HOST` | `api.elevenlabs.io` | Scribe Realtime host (regional e.g. `api.us.elevenlabs.io`); also the only extra CSP `connect-src` (`wss://<host>`) |
| `MAX_CLONES_PER_USER` | 2 | cloned voices (total) |
| `MAX_CLONE_UPLOAD_MB` / `MAX_VC_UPLOAD_MB` | 10 / 15 | per-file upload size |

Existing databases are migrated automatically on start (additive only: `usage.vc_sec`, `usage.stt_sec` columns).

Speech input (Chat mic) uses ElevenLabs Scribe Realtime (`scribe_v2_realtime`): `server/stt.ts` mints a single-use token
(`POST /v1/single-use-token/realtime_scribe`) with the server key; the browser streams PCM16 16 kHz to
`wss://api.elevenlabs.io/v1/speech-to-text/realtime` itself (`web/src/lib/stt.ts`, worklet `web/public/stt-worklet.js`).
The API key needs the speech-to-text permission. Web Speech (Chrome/Edge) is only a marked fallback when no token can be had.
