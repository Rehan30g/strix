# Strix — spec (backend + unified UI)

Goal: rewrite everything as ONE app in `D:\2026\SpeakingModel\v2\` (old code in `..\` stays untouched and is the REFERENCE for behaviour:
`..\server.js`, `..\characters.js`, `..\public\*`). Deploy target: a small VPS, short-lived preview for a few invited people.
Language of UI copy: Indonesian (user is Indonesian); AI roleplay default language English.

## Layout
```
v2/
  SPEC.md  README.md  .env.example  package.json  tsconfig.json
  server/   Fastify + TypeScript (run with `tsx` in dev, compiled `dist/` in prod)
  web/      Vite + TypeScript, NO UI framework (vanilla modules), builds to web/dist, served by Fastify
  deploy/   Caddyfile, systemd unit, deploy.md
```
Node 26 is installed: use built-in `node:sqlite` (no native deps). One process, one SQLite file `data/app.db`.

## Auth and access (hard requirement)
1. Visitor must sign in with **Google** (OAuth2 authorization-code flow, `openid email profile`; env `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`; callback `/api/auth/google/callback`; state + PKCE; verify id_token). No password login.
2. After login the account is `pending` until it **redeems an invite code**. Pending users can only call `/api/me`, `/api/invite/redeem`, `/api/auth/logout`. Everything else → `403 {error:'invite_required'}`.
3. Invite code: random 10-char (no ambiguous chars), `max_uses` 1–4 (set by admin), `expires_at`, optional `note`, `revoked`. One user can redeem only one code; one code redeemed by the same user twice is a no-op. Code full → `409 code_full`; expired/revoked → `410`.
4. Admin = emails in `ADMIN_EMAILS` (comma list). Admin API + page: create/list/revoke codes, list users (email, code, usage), suspend/unsuspend user, set per-user quota overrides, delete a user's cloned voices.
5. Sessions: signed httpOnly, SameSite=Lax, Secure in prod cookie; 7-day expiry; server-side session table.
6. Per-user quotas (defaults via env, daily reset UTC): `QUOTA_LLM_REQ_PER_DAY=300`, `QUOTA_TTS_CHARS_PER_DAY=30000`, `MAX_CLONES_PER_USER=2`, `MAX_CLONE_UPLOAD_MB=10`. Over quota → `429 {error:'quota', kind, resetAt}`. Also IP-based `@fastify/rate-limit` (global 120/min, auth 20/min).
7. Secrets (`OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`) only server-side; never sent to the browser. Helmet-style headers, same-origin only (no open CORS), body limits, input validation with zod.

## Database tables (node:sqlite)
users(id, google_sub UNIQUE, email, name, picture, status 'pending'|'active'|'suspended', is_admin, invite_id, created_at, quota_json)
sessions(id, user_id, expires_at, created_at)
invites(id, code UNIQUE, max_uses, used_count, expires_at, note, revoked, created_by, created_at)
usage(user_id, day, llm_req, tts_chars, llm_tokens)  -- PK(user_id, day)
voices(id, user_id, eleven_voice_id, name, description, created_at)  -- user's cloned voices
tts_history(id, user_id, text, voice_id, model, chars, created_at)   -- text + metadata only, no audio stored
user_settings(user_id, key, value_json)                               -- server-side sync of settings (tune, presets, persona, etc.)

## API contract (all JSON unless noted, prefix `/api`)
Auth/account
- `GET  /auth/google/start` → 302 to Google;  `GET /auth/google/callback`;  `POST /auth/logout`
- `GET  /me` → `{user:{id,email,name,picture,status,isAdmin}, quota:{llm:{used,limit},tts:{used,limit}, resetAt}, features:{clone:boolean}}`  (401 if not signed in)
- `POST /invite/redeem {code}` → `{ok:true}` or errors above
- `GET/PUT /settings/:key` (value_json, ≤64 KB) – synced UI settings (replaces localStorage-only persistence; UI still caches in localStorage)
Admin (isAdmin only): `GET/POST /admin/invites`, `POST /admin/invites/:id/revoke`, `GET /admin/users`, `POST /admin/users/:id/{suspend,unsuspend}`, `PUT /admin/users/:id/quota`, `DELETE /admin/users/:id/voices`
LLM (OpenRouter, default model `deepseek/deepseek-v4.1-flash`; keep provider routing + `withCache` logic from old server.js)
- `GET  /config` → `{defaultModel, ttsModel, models:[...suggested], limits}`
- `POST /chat` (SSE) – classic roleplay with character system prompts + tool `end_interview` (port from old `/api/chat` and `characters.js`; character prompts live server-side)
- `GET  /characters`
- `POST /llm` – generic pass-through used by the Coffee/agent simulation: whitelisted `model,messages,tools,tool_choice,temperature,max_tokens,reasoning,provider,stream`; `stream:true` → SSE passthrough. Counts one LLM request against quota.
TTS (ElevenLabs, default `eleven_v4_turbo`)
- `POST /tts` `{text, voiceId, model?, tune?:{stability,similarity,style,speakerBoost,speed}, format?:'mp3_44100_128'}` → streamed audio/mpeg (pipe upstream `/stream`), semaphore MAX_TTS=3 + retry on 429, abort upstream on client disconnect. voiceId must be a premade/library voice from `/voices` OR one of the caller's own clones, else 403. Counts characters.
- `POST /tts/generate` same body but non-streamed full file with `Content-Disposition` for download (TTS Studio); writes `tts_history`.
- `GET  /tts/history` (last 50 for the caller), `DELETE /tts/history/:id`
Voices
- `GET  /voices` → `{voices:[{id,name,category:'premade'|'cloned'|'library', previewUrl?, own:boolean, labels?}]}` (account voices from ElevenLabs filtered: premade + the caller's own clones only; cache 5 min)
- `POST /voices/clone` multipart (`name`, `description?`, `consent=true` required, 1–3 files `audio/*`, ≤MAX_CLONE_UPLOAD_MB each) → ElevenLabs Instant Voice Clone `POST /v1/voices/add`; store in `voices`; enforce MAX_CLONES_PER_USER
- `DELETE /voices/:id` → delete at ElevenLabs + DB (own only)
Health: `GET /healthz`.

## Frontend (web/) — ONE app, hash-routed, mobile first, light/dark, no emoji icons (use inline SVG icon set)
Shell: left rail / bottom bar on mobile, top-right account menu (avatar, quota meter, logout), admin link if admin.
Screens (port ALL existing behaviour from the old pages — read them):
1. **Login** (Google button) → **Redeem code** screen for pending users → app.
2. **Roleplay chat** (old `index.html`/`app.js`): characters, rename nick, model selector, accent input, audio tags toggle, auto-speak, voice picker.
3. **Voice call** (old `voice.html`/`voice.js`): push-to-talk/auto mic (Web Speech), streaming reply + streamed TTS, tune sliders.
4. **Coffee agent simulation** (old `coffee.html` + `coffee-voice.js` + `coffee-phone.js/css` + `coffee-settings.js` + `coffee-icons.js`): the main screen. Keep: agent loop + tools, Coffee seller AI, personas (sam, bandit, stripe, wolf, tsundere, barista), Phone mode, Preview mode (+ Esc to exit), voice sync (speech finishes before actions), live typed text tied to speech, cheap-mic FX, free/super modes, tsundere, scam scenario, interjection inbox, "Jadi Coffee" human cashier mode (tags-only voicer: TTS only ADDS audio tags to the typed text, never rewrites), settings persistence. NEW: tool `call_number` — agent can phone other simulated parties (unknown number/scam-ish caller, friend, courier, bank CS; all fictional; presets + free-form), reusing the phone UI with the contact name on screen, per-contact voice/persona, `end_call`; agent is cautious by default with unknown numbers.
5. **TTS Studio**: text box with audio-tag palette/inserter, voice + model + tune, Generate (streamed preview) and Download mp3, history list.
6. **Voices**: list (premade + own), preview, **upload voice clone** (drag-drop, record from mic, consent checkbox, progress), delete.
7. **Settings**: model, tune, accent, language, theme; synced to `/settings/:key`.
8. **Admin** (admin only): invite code creation (uses 1–4, expiry, note) with copy button, users table, suspend, quota override.
Code quality: modules per screen under `web/src/`, shared `api.ts` (fetch wrapper that handles 401/403/429 globally), `player.ts` (single `<audio>` + MediaSource streaming, port the logic from `coffee-voice.js`), `store.ts`. No giant inline scripts. Must work with the dev proxy (Vite → Fastify) and in prod (Fastify static + SPA fallback).

## Deploy
`deploy/Caddyfile` (auto-HTTPS reverse proxy to :3000), `deploy/speakingmodel.service` (systemd, `EnvironmentFile`), `deploy/deploy.md` (Google OAuth console steps incl. authorized redirect URI, env vars, first admin, creating the first invite, backup of `data/app.db`, `npm run build`, how to take it down after the preview). `npm run build` builds web and compiles server; `npm start` runs `node dist/server/index.js`.

## Working agreements
- Never touch files outside `v2/` except reading the old code. Never print or commit secret values from `..\.env`; dev `.env` for v2 may copy the keys locally (gitignored).
- Verify what you build: typecheck, run the server, hit endpoints with curl, and for UI drive it with puppeteer-core + Edge headless (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`). Test auth with a dev-only bypass `DEV_FAKE_LOGIN=1` (disabled and refusing to start when `NODE_ENV=production`).
- Report faithfully what works, what was not verified (e.g. real Google OAuth cannot be tested locally without credentials), and the exact commands to run.
