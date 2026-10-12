# Strix

A voice-first web app for talking to AI personas, built around ElevenLabs voices. Four things, kept deliberately small:

- **Chat**: voice-only conversation with a persona. The orb sits at the bottom of the screen and the caption above it appears word by word *as it is spoken*. Supports a spoken "let me look that up" web-search tool, and a duplex mode (Scribe Realtime + a small decision model) where you can interrupt, back-channel ("mm-hm") or say "go on" and the persona knows exactly where it was cut off.
- **Text to Speech**: `eleven_v4_turbo`, audio tags (`[whispers]`, `[laughs]`...) highlighted in purple, one-click **auto-tag** that only inserts tags and never rewrites your words, and a **multi-speaker dialogue** mode (`Name: line` per speaker, one voice each, one merged MP3).
- **Voice Changer**: upload or record audio and convert it to another voice (speech-to-speech).
- **Voices**: your collection, plus the full public ElevenLabs Voice Library (~19k voices, search and filters), and **voice cloning** from your own samples.

Every voice and persona is a unique, procedurally generated orb. Personas can be made by hand or with AI help: it researches a character on the web and proposes a description, accent and an orb palette. There is also a guided 3D tour for new users.

> Status: personal project / preview. Real Google sign-in and on-device behaviour (phones, real keyboards, real microphones) have **not** been tested end to end; see [Known gaps](#known-gaps).

## Repository layout

| path | what |
|---|---|
| `server/` | Fastify + TypeScript API, SQLite via Node's built-in `node:sqlite`. |
| `web/` | Vite + TypeScript SPA (no UI framework). |
| `deploy/` | Caddyfile, systemd unit and [`deploy.md`](deploy/deploy.md) for a small VPS. |
| `server/CONTRACT-NOTES.md` | API contract and deviations (endpoints, SSE events, quotas, error shapes). |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Detailed dev notes: scripts, dev login, production build. |
| `SPEC.md`, `SPEC-LITE.md` | Original design specs (the Lite spec is what was built). |
| `_archive/` | Code removed when the scope was cut down (old Coffee agent screen, voice call, ...). Not built. |

## Quick start (development)

Requires Node.js 24 or newer.

```bash
npm install
npm --prefix web install
cp .env.example .env     # add OPENROUTER_API_KEY and ELEVENLABS_API_KEY; set DEV_FAKE_LOGIN=1 and ADMIN_EMAILS for local work

npm run dev:server       # http://localhost:3000
npm run dev:web          # http://localhost:5173 (proxies /api to :3000)
```

Sign in locally without Google (development only; the server refuses to start with this flag in production):

```
http://localhost:5173/api/auth/dev-login?email=admin@example.com&redirect=/
```

Production build: `npm run build && npm start` (serves the API and the built SPA on one port).

## Configuration

All configuration is environment variables; see [`.env.example`](.env.example). The important ones:

- `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`: server side only, never sent to the browser. The ElevenLabs key needs `voices_read`, `text_to_speech`, `speech_to_text`, `speech_to_speech`, and `voices_write` (for cloning and adding library voices).
- `OPENROUTER_MODEL` is the one chat model; `OPENROUTER_DECISION_MODEL` is a small fast model for interruption decisions. Clients cannot choose models.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`, `ADMIN_EMAILS`: sign-in and admins.
- `SHARED_VOICE_IDS`: voices every active user may use.
- `QUOTA_*`, `MAX_*`: per-user daily quotas (LLM requests, TTS characters, Voice Changer seconds, STT seconds, searches, clones, collection size).

## Access model

Sign in with Google, then redeem an **invite code**. Codes have 1 to 4 uses and an expiry; admins create, revoke and monitor them, suspend users and override quotas from the Admin screen. Until a code is redeemed, an account can only call `/api/me`, the redeem endpoint and logout. Per-user quotas reset daily (UTC) and there are IP rate limits on top.

## Deploying

[`deploy/deploy.md`](deploy/deploy.md) covers the Google OAuth setup (redirect URI), environment, Caddy (automatic HTTPS), the systemd unit, creating the first admin and invite, backing up `data/app.db`, and taking the preview down afterwards.

## Voices, cloning and consent

Cloning requires an explicit consent checkbox and is meant for **your own voice or voices you have permission to use**. Public Voice Library voices added to a collection occupy a slot on the ElevenLabs account that owns the API key (the server shares one slot between users and caps the total). ElevenLabs terms, notice periods and moderation apply to everything generated.

## Not included in this repository

- `.env` files, the SQLite database and logs.
- The narration clips of the in-app tour that were generated with a private voice clone (`web/public/intro/t_*.mp3`, `r_*.mp3`, `tts_*.mp3`, `vc_out.mp3`). Without them the tour has no narration; generate your own with a voice you are allowed to use and put the files at the same paths (`tour.json` lists names, durations and word timings). Running the tour without these files has not been tested.

## Known gaps

- Real Google OAuth has not been exercised against a live Google project (local testing used the dev login).
- Not tested on real iOS/Android devices or real on-screen keyboards; the layouts were checked in headless Edge with emulated viewports and touch.
- Full-duplex conversation is a simulation (Scribe Realtime + decision model + TTS), not a native speech-to-speech model. There is roughly a second of delay before the persona yields, and without headphones its own voice can leak back into the mic.
- ElevenLabs does not expose a hard limit for voice-library slots; the app counts conservatively and returns "slots full" when it thinks the cap is reached.

## License

[MIT](LICENSE). The license covers this code only: ElevenLabs and OpenRouter terms, and the rights to any voice you clone or use, are your own responsibility.

## Tech

TypeScript, Fastify, Zod, `node:sqlite`; Vite with no UI framework (vanilla modules); WebGL/Canvas for the orbs; OpenRouter for LLMs and web search; ElevenLabs for TTS, speech-to-speech, Scribe Realtime and voice cloning.
