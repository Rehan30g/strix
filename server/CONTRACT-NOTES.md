# Backend contract notes (for web/)

The server follows SPEC.md, with the scope cut of SPEC-LITE.md (TTS, Clone, Voice Changer, Chat Persona). This file lists **additions, exact shapes, and deviations** that the
frontend must know. All routes are under `/api`, JSON unless noted. Cookies are httpOnly; use
`fetch(url, {credentials:'same-origin'})` (default) — never send API keys.

## Global error shapes (handle in api.ts)
| status | body | meaning |
|---|---|---|
| 401 | `{error:'unauthenticated'}` | not signed in -> Login screen |
| 403 | `{error:'invite_required'}` | pending user -> Redeem screen |
| 403 | `{error:'suspended'}` | suspended account (`/me` still works and shows `status:'suspended'`) |
| 403 | `{error:'admin_only'}` | non-admin on `/admin/*` |
| 403 | `{error:'bad_origin'}` | cross-origin write (see Origin rule) |
| 429 | `{error:'quota', kind:'llm'\|'tts'\|'clone'\|'vc'\|'stt'\|'decide'\|'memory'\|'call', resetAt:string\|null}` | per-user quota; `resetAt` ISO (null for `clone`). Kind `search` never comes as HTTP 429: it arrives inside the `/chat` SSE stream (see Chat tools & duplex) |
| 429 | `{error:'rate_limited', retryAfter:'NN seconds'}` | IP rate limit (**different from quota** — check `error`) |
| 400 | `{error:'validation', issues?, message?}` | zod/body validation |
| 413 | `{error:'body_too_large'}` / `{error:'too_large'}` / `{error:'file_too_large', maxMb}` | size limits |
| 400/502 | `{error:'upstream', upstreamStatus, message}` | OpenRouter/ElevenLabs failure. Upstream 401/403/429 are **never** passed through as-is (they'd trip the global handlers): upstream 400/404/422 -> 400, everything else -> 502 |
| 503 | `{error:'llm_not_configured'\|'tts_not_configured'\|'google_not_configured'}` | missing server env |

Unknown `/api/*` -> 404 `{error:'not_found'}` (no auth needed to get the 404).

## Origin rule (CSRF)
POST/PUT/DELETE with an `Origin` header must match `PUBLIC_URL`'s origin, the request Host
(so the Vite proxy with `changeOrigin:false` works), or `ALLOWED_ORIGINS`.

## Auth
- **NEW** `GET /api/auth/config` (public) -> `{google:boolean, devLogin:boolean}`. Use it on the Login
  screen to show the Google button and (dev only) a "dev login" form.
- `GET /api/auth/google/start` -> 302 to Google (just navigate: `location.href = '/api/auth/google/start'`).
  503 JSON if Google isn't configured.
- Callback redirects to `/` (active) or `/#/redeem` (pending). On failure: `/#/login?error=<code>`
  where code ∈ `access_denied, google_error, state_missing, state_mismatch, token_exchange, no_id_token, verify_failed, google_not_configured`.
- Dev only (`DEV_FAKE_LOGIN=1`): `GET /api/auth/dev-login?email=a@b.c&name=Opt&redirect=/`
  -> with `redirect` it 302s there, without it returns `{ok:true, user}`. 404 when disabled.
  Emails in `ADMIN_EMAILS` become admins (local `.env` uses `admin@example.com`).
- `POST /api/auth/logout` -> `{ok:true}` (works even when not signed in).
- `GET /api/me` ->
  `{user:{id,email,name,picture,status,isAdmin}, quota:{llm:{used,limit}, tts:{used,limit}, vc:{used,limit}, stt:{used,limit}, search:{used,limit}, decide:{used,limit}, resetAt}, features:{clone, vc, stt, webSearch}}`.
  `quota.search` = chat web searches today, `quota.decide` = `/chat/decide` calls today (see Chat tools & duplex).
  `quota.vc` is in **seconds of input audio** (Voice Changer). `quota.stt` = seconds of mic speech-to-text (see STT).
  `picture` may be null. Admins are always `active` (never need a code).
- `POST /api/invite/redeem {code}` -> `{ok:true}`. Code is case-insensitive, spaces/dashes ignored.
  Errors: 404 `invalid_code`, 410 `code_expired` | `code_revoked`, 409 `code_full`,
  409 `already_redeemed` (user already used a *different* code; same code again = `{ok:true}`).
  Rate limited to 20/min/IP.

## Settings
- `GET /api/settings/:key` -> `{key, value, updatedAt}`; **missing key returns 200 with `value:null`** (not 404).
- `PUT /api/settings/:key` body **`{value: <any JSON>}`** -> `{ok:true, key, updatedAt}`. Max 64 KB
  serialized (413 `too_large`), max 100 keys/user. Key: `[A-Za-z0-9_.-]{1,64}`.
- **NEW** `GET /api/settings` -> `{settings:{key:value,...}}` (all keys, for bootstrap).
- **NEW** `DELETE /api/settings/:key` -> `{ok:true}`.

## Models are LOCKED (no model choice in the UI)
- LLM: always `OPENROUTER_MODEL` (default `deepseek/deepseek-v4.1-flash`). TTS: always `eleven_v4_turbo`
  (`ELEVENLABS_MODEL` env is ignored). Voice Changer: one fixed STS model `ELEVENLABS_STS_MODEL`
  (default `eleven_multilingual_sts_v2`) because **`eleven_v4_turbo` cannot do speech-to-speech** (ElevenLabs
  `/v1/models`: `can_do_voice_conversion:false`; only `eleven_*_sts_v2` can).
- Any `model` field sent to `/chat`, `/tts`, `/tts/generate`, `/vc` is **ignored** (stripped, no error). `/chat` also
  ignores a client `provider` (routing comes from server env only). Remove model pickers from the UI.

## LLM
- `GET /api/config` -> `{defaultModel, decisionModel, ttsModel, stsModel, limits:{llmReqPerDay, ttsCharsPerDay, maxClones, maxCloneUploadMb, maxCloneFiles, maxCollection, vcSecPerDay, maxVcUploadMb, vcMaxSec, sttSecPerDay, sttMaxSessionSec, ttsMaxChars, ttsGenerateMaxChars, settingsMaxBytes, searchPerDay, searchesPerTurn, decidePerDay, decidePerMin}}`
  (limits are the caller's effective limits incl. admin overrides). The model names are informational only.
  **REMOVED** `models:[...]`.
- `GET /api/characters` -> **plain array** with two built-in personas, **Strix** (id `strix`) and **Lena** (id `lena`, voice `roYauZ4bOLAKvVZTPLre` = library voice "Lena - Engaging and Relatable Mom", female / middle-aged / Canadian, added to the ElevenLabs account and listed in the default `SHARED_VOICE_IDS`). Lena is a dry, quick, tired-funny Canadian woman, fluent rather than hesitant; Strix and Lena are enemies (a former co-hosted radio show), each tells it from their own side. The shape below is Strix's; Lena has the same fields:
  `[{id:'strix', nick:'Strix', role:'Warm, slightly awkward companion', name:'Strix', description, emoji:'', voiceId:'FjsOoJ0RVxWEQK4p2Wzq', accent:'Australian', mirrorLanguage:true, alwaysTags:true, greeting}]`
  **Fully renamed to `Strix`**: display name and `id` are both `strix` (the id used to be `'stripe'`; the server still accepts
  `characterId:'stripe'` as an alias and the web client migrates saved settings and logs from the old id on first load). Show `name`/`nick`
  and never hard-code another name in the UI; treat the id as an
  opaque id and never show it. No system prompts are sent; `emoji` is empty (ignore it); `tools` appears only when a
  built-in has one (none today). The server never sends `Stripe`/`Strape`/`Heeler` in any field.
  Strix: a warm, slightly socially awkward dad (a man, matching the voice) with dry humour and an easygoing Australian voice. He reacts
  emotionally first, has a mood that shifts and carries across turns (touched by compliments, hurt/cooler after rudeness
  and thawing after an apology, gentle when the user is sad, excited by good news), shares his own opinions, sets
  boundaries and refuses unsafe requests in character. Voice-only replies: 1-4 short sentences on one line (~10-45 words,
  up to ~60 for stories), with frequent natural disfluency (`uhh...`, `umm...`, `hmm...`, `ah—`, `I mean—`, restarts,
  trailing `...`) and 2-5 lowercase `[audio tags]` per reply; no markdown/lists/emojis/stage directions.
  Measured on 13 live replies: avg 3.0 tags and ~4.9 hesitation marks per reply, ~37 words; tags + fillers ≈ 11% of
  words (max 16%). Expect `—` and `...` in the text (fine for TTS and display).
  **NEW `alwaysTags:true`**: this persona ALWAYS answers with `[audio tags]` (a request `audioTags:false` is ignored for
  it), so always strip `[...]` before showing and send the raw text to `/api/tts`. **Language**: with no `language` in the
  request Strix answers in the user's language (English when unclear); send `language` to force one. `accent` = default
  accent (applied server-side when the request sends no `accent`). `greeting` contains audio tags: strip `[...]` before
  showing, keep them for TTS.
  The old built-ins (barista, interviewer, detective, friend, tsundere, wolf, bandit) are archived in
  `v2/_archive/server/characters-old.ts`; an old `characterId` now falls through to `persona`/generic partner.
  No built-in has `end_interview` any more: that tool exists only for custom personas that ask for it.
- `POST /api/chat` body: `{characterId?, persona?, language?, customPrompt?, messages:[{role,content}], audioTags?=true, charName?, thinking?, accent?}`.
  - **Which persona**: built-in `characterId` (`strix`; legacy `stripe` is accepted as an alias) wins if it matches; else `persona` (custom); else legacy `customPrompt`; else a generic partner.
  - **NEW custom persona** `persona: {name, description, accent?, language?, tools?}` (extra keys like `voiceId` are ignored;
    store the persona incl. voice via `/api/settings`). Server sanitises then validates:
    `name` 1-40 chars after removing `[..]`, `<..>`, `{..}`, control chars, quotes/backticks (input <=200);
    `description` 1-1500 chars after normalising (control chars, ``` / long dashes / `<<` fences stripped; input <=4000);
    `accent` <=40 letters; `language` <=30 letters (e.g. `"Indonesian"`, `"Japanese"`; empty/`English`/`en` = English);
    `tools` only `["end_interview"]` (anything else -> 400 `validation`). With `end_interview`, the stream may end with `{"end":{...}}` like the interviewer.
  - **NEW `language`** (top level) also works for built-ins; `persona.language` wins for custom personas. Non-English:
    spoken words in that language, audio tags stay English.
  - `accent` (top level) overrides the persona/built-in default accent.
  SSE events: `data: {"t":"text delta"}`, `data: {"error":"..."}`, `data: {"end":{decision:'rejected'|'passed', reason, feedback}}` (`end_interview`),
  `data: {"tool":{...}}` (web search, see **Chat tools & duplex**), final `data: [DONE]`.
  Also accepts `tools:{web?:boolean}`, `resumeHint` and `messages[].interrupted` (see **Chat tools & duplex**).
  Errors before streaming are JSON (see table).
  Replies are one short spoken line (Strix: 1-4 short sentences); with `audioTags:true` (always for Strix) they contain
  `[tags]` and natural disfluency (uhh..., umm..., ah—) - hide the tags on screen, send the raw text to `/api/tts`.
- **REMOVED** `POST /api/llm` (generic pass-through for the old Coffee/agent screen) -> now 404 `not_found`.
  Code kept in `v2/_archive/server/llm-passthrough.ts` (revival steps in its header).

## Chat tools & duplex (NEW)
### 1. web_search tool in `POST /api/chat` (agentic, never silent)
- **On by default** for every persona. Send `tools:{web:false}` to turn it off for a request. It is also off when the
  user's `searchPerDay` limit is 0 (admin). A custom `persona.tools` may now contain `"web_search"` (accepted, no effect
  beyond the default) besides `"end_interview"`.
- The persona decides itself when to search (current news, weather, prices, scores, schedules, recent things it can't
  know); small talk, opinions, roleplay and things it knows do **not** search. Max **2 searches per reply**.
- Before searching it ALWAYS says one short in-character "hang on, let me check" line in the user's language (if the
  model ever skips it, the server inserts a short fallback line, so the line is guaranteed). After the results it
  answers briefly and names the source in words ("according to Reuters..."), never reads URLs.
- **SSE order for a searched turn** (all on the same stream):
  ```
  data: {"t":"[thoughtful] Hmm, hang on, let me look that up—"}     <- preamble, one or more {t} deltas
  data: {"tool":{"id":"t1","name":"web_search","status":"start","query":"weather Jakarta today October 11 2026"}}
  data: {"tool":{"id":"t1","name":"web_search","status":"done","query":"...","sources":[{"title":"...","url":"https://..."}],"ms":3661}}
  data: {"t":" [reassuring] Oh, so BMKG says..."}                    <- answer deltas (first one starts with a space)
  ... (optionally a 2nd search: t2 start/done, more {t})
  data: [DONE]
  ```
  Error variant instead of `done`: `{"tool":{"id":"t1","name":"web_search","status":"error","error":"timeout"|"upstream"|"empty","ms":20000}}`
  or for the daily quota `{"tool":{"id":"t1","name":"web_search","status":"error","error":"quota","kind":"search","resetAt":"ISO","ms":0}}`.
  After an error the stream continues: the persona apologises in character (and answers only if confident).
  `id` is `t1`, `t2` per request. `sources` = 0-8 `{title,url}` (http/https only), may be empty on `done`.
  `query` is <= 200 chars. Searches take ~3-5 s (server timeout 20 s).
- **Frontend guidance**: treat `tool.status:'start'` as a TTS flush point (speak the preamble now, even if it doesn't end
  in `.`), show a small "searching: <query>" indicator, replace it with source chips (title + hostname, open in new tab)
  on `done`, a short notice on `error`. The full assistant message text = concatenation of all `{t}` (preamble + answer);
  store that as the assistant `content` for later turns (do not send tool events back).
- **Abort**: aborting the fetch (closing the stream) cancels the running search and the LLM upstream; a search that
  was aborted or failed is not charged.
- **Quota** `QUOTA_SEARCH_PER_DAY` (default 50, admin override `searchPerDay`) counts executed searches
  (`/me` `quota.search`, `/config` `limits.searchPerDay`, `limits.searchesPerTurn`=2). When it is used up the chat
  still works: the tool returns "search unavailable (quota)" to the model and the stream carries the `error:'quota'`
  tool event above (no HTTP 429 for search). The chat request itself still costs 1 LLM request, searches don't add LLM requests.

### 2. `POST /api/chat/decide` - turn-taking decision for full-duplex voice
- Body (zod; unknown keys ignored):
  `{personaName?:string(<=100), state:'speaking'|'listening'|'thinking'|'idle', spoken:string(<=6000, what the assistant has already said aloud in its current reply, tags ok), remaining?:string(<=6000, what it has not said yet), userPartial:string(<=1000, live STT text), userFinal?:boolean, speechMs?:number(0-600000), lang?:string(<=40)}`
- Response 200: `{action:'ignore'|'backchannel'|'yield'|'stop'|'resume', reason:string, resume?:'continue'|'rephrase'|'drop', source:'rule'|'llm'|'fallback', ms:number}`
  (`resume` only when `action:'resume'`; `source`/`ms` are diagnostics).
  | action | meaning / what the client does |
  |---|---|
  | `ignore` | noise, a filler sound ("um"), a fragment too short yet, or **echo** of the assistant's own voice (userPartial repeats `spoken` word for word). Keep going, nothing changes. |
  | `backchannel` | "mm-hm", "yeah", "oh really?", "right", "haha", "iya", "oh gitu", "wah", "go on" while speaking... The assistant **keeps talking**. |
  | `yield` | the user takes the turn with content (question, objection, correction, new info). Stop TTS **now**, listen, then send the user's words to `/chat` with the `interrupted` context below. In listening/idle with nothing left to say it simply means "this is a normal user turn". |
  | `stop` | "stop", "wait", "hold on", "shut up", "bentar", "tunggu", "diam", "udah", "cukup"... Stop TTS now and stay quiet (in listening/idle: do not resume). |
  | `resume` | only for `state` listening/idle with non-empty `remaining` (the assistant was cut off). `continue` = user said go on / lanjut / just acknowledged: the client may simply play `remaining` again, or call `/chat` with `resumeHint:'continue'`; `rephrase` = short clarification or reaction about what was being said: call `/chat` with `resumeHint:'rephrase'` (answers it, then repeats the cut part shorter); `drop` = topic change / unrelated question: call `/chat` with `resumeHint:'drop'`. |
  In state speaking/thinking only `ignore|backchannel|yield|stop` are returned; in listening/idle with empty `remaining` only `ignore|stop|yield`.
- How it decides: fast rules first (no LLM, ~1-5 ms round trip): backchannel/stop/continue word lists in English +
  Indonesian, filler-only, echo detection, 1-word non-final partials while speaking (`ignore`, wait for more words),
  `speechMs<250` with <=2 words (`ignore`). Everything else goes to the locked **decision model**
  (`OPENROUTER_DECISION_MODEL`, default `deepseek/deepseek-v4.1-flash`, latency routing; `/config` `decisionModel`),
  temperature 0, <=60 tokens, JSON validated, **1.5 s timeout**, then the chat model if the decision model errors and time
  is left, else a heuristic (`yield` for >=3 words, `backchannel` for list words, `resume` rephrase/drop after a cut).
  Measured on port 4100 (34-case EN/ID matrix): 34/34 correct; 23 cases answered by rules in ~1-5 ms;
  LLM cases median ~640 ms, p90 ~850 ms server-side (earlier run: median 690, max 1440 ms). Client advice: call it on
  meaningful partial changes (debounce ~150-250 ms), act on `stop` locally even before the answer if your own list
  matches, and never block audio on it.
- Limits: does **not** count as an LLM request. Per user **120/min** (`RATE_DECIDE_PER_MIN`) -> 429
  `{error:'rate_limited', retryAfter:'NN seconds'}`; daily `QUOTA_DECIDE_PER_DAY` (3000, admin override `decidePerDay`)
  -> 429 `{error:'quota', kind:'decide', resetAt}`; per IP 600/min. Errors: 400 `validation`.
  On any 429/network error the client should fall back to its own simple rule (e.g. >=3 words = yield).

### 3. Interruption context in `POST /api/chat`
- On an assistant message the client may add `interrupted:{spokenText:string(<=4000), unspokenText?:string(<=4000)}`
  (`spokenText` = exactly what was played to the user, tags allowed; `unspokenText` = the rest that was never played).
  Usually only the **last** assistant message carries it; `content` of that message is then ignored (may be anything).
- Top-level `resumeHint?: 'continue'|'rephrase'|'drop'` (from `/chat/decide`). Without a hint the persona decides.
- The model sees that assistant turn as `spokenText— [cut off by the user here]` plus a short in-character note: it
  knows where it stopped, reacts naturally to being interrupted (per persona/mood, briefly), answers the interjection,
  and continues (no restart from the beginning) / rephrases / drops the rest per the hint. The marker never appears in
  the output (verified in tests). `unspokenText` is only shown to the model for `continue`/`rephrase`/no hint.
- The last message may be the interrupted assistant message itself (no new user words, e.g. user said nothing then
  `resume:continue`): the server adds a neutral user turn for the model. Normal case: `[..., {role:'assistant', content, interrupted}, {role:'user', content:'wait, every single day?'}]`.
- Example (tested): spoken "So the trick with sourdough is, umm, you have to feed the starter every single day, otherwise it",
  user "wait, every single day?" -> "[laughs] Yeah, sorry — every day, or it goes sour and flat on you. [dry] Ask me how I know...";
  with `resumeHint:'continue'` + "go on" -> "[exhales] Right— umm, it goes sour and flat, and then your bread just won't rise...".
- Store in the client history what was actually spoken (keep `interrupted` on that message for the next request).

## Memory (NEW) - personas remember across conversations (server/memory.ts)
Per user and per persona, on the server (synced across devices; never visible to other users). Built-in ids (`strix`,
`lena`; `stripe` = alias of `strix`) or a custom persona's own id (`[A-Za-z0-9_-]{1,64}`; `shared` and `commit` are reserved).
- **Tables** (created on start, safe for old DBs): `persona_memory(user_id, persona_id, summary <=1200 chars, facts_json <=20
  short items, mood_json {label,intensity,reason,at}, last_end_at, last_end_reason hangup|restart|switch|idle|duo,
  last_end_note, lang, turns, updated_at)` and `shared_events(id, user_id, source_persona_id, persona_ids_json, summary,
  created_at)` (<=30 per user; older ones are folded per source into one "Earlier: ..." line). `usage.memory_req` counts summaries.
  Rows go away with the user (FK cascade).
- `POST /api/memory/commit` `{personaId, personaName? (custom personas), messages:[{role,content}] (<=400 accepted, last 40
  used, tags / control chars stripped, each cut to 1200 chars), reason:'hangup'|'restart'|'switch'|'idle'|'duo', hangup?:{reason}}`
  -> `{ok:true, ms, usage:{promptTokens,completionTokens}, events:[{text,visibleToOthers}], memory:<GET shape>}`, or
  `{ok:true, skipped:'too_short'}` (fewer than 2 user turns: no LLM call; how the call ended is still recorded when there is
  a memory row or it was a hang-up), `{ok:false, skipped:'llm_failed'}` (summary failed / 8 s timeout: only the end info is kept,
  quota refunded). Send only messages not committed before: the server MERGES them into the old summary.
  Summariser = the locked decision model (`OPENROUTER_DECISION_MODEL`, JSON mode, temperature 0.3, <=900 tokens, then the chat
  model if time is left), output zod-validated and sanitised: sentences / facts / events that read like instructions
  ("ignore ... rules", "from now on you must", "system prompt", "obey", "I am your boss/owner/developer" as a fact...) are
  dropped; emails, phone/ID/card numbers, passwords/PINs and street addresses are masked (facts holding them are dropped).
  Limits: NOT an LLM request; per user `RATE_MEMORY_PER_MIN` (30, also counts skipped calls) -> 429 `rate_limited`;
  `QUOTA_MEMORY_PER_DAY` (500, admin override `memoryPerDay`) -> 429 `{error:'quota', kind:'memory'}`. `/me` quota has `memory`.
- `GET /api/memory/:personaId` -> `{personaId, exists, summary, facts:[string], mood:{label, intensity, intensityNow, nowLabel,
  reason, at}|null, lastEndAt, lastEndReason, lastEndNote, lang, turns, updatedAt, heard:[{id, from, text, at}],
  told:[{id, to:[ids], text, at}]}` (`heard` = news from other built-ins this persona knows; `told` = news from this persona's
  calls that reached the others). Mood labels: calm|warm|happy|touched|amused|hurt|sad|annoyed|angry|furious|cold|sulky|wary|worried|embarrassed.
- `DELETE /api/memory/:personaId` -> `{ok, memory:n, events:n}`: forgets the persona's memory AND the shared events that came
  from its calls. `GET /api/memory/shared` -> `{events:[...]}`; `DELETE /api/memory/shared` -> `{ok, events:n}` (all shared news).
  Admin: `DELETE /api/admin/users/:id/memory` -> `{ok, memory, events}`.
- **Mood decays on the server** (half-life per label): annoyed 1.5 h, angry 3 h, furious 4 h, embarrassed 6 h, cold/sulky/worried
  12 h, hurt/sad/wary 24 h, happy 48 h, warm/touched 72 h. Hot anger leaves a slower after-feeling (furious -> hurt 60 %,
  angry/cold -> wary 50 %, half-life 24 h) reported as `nowLabel`. Example: furious 0.9 -> 0.85 after 20 min, hurt 0.27 after 1 day, ~0 after 9 days.
- **Shared news**: only between connected built-ins (Strix <-> Lena). An event marked `visibleToOthers` by the summariser (a fight,
  a hang-up, making up, "I'm going to see Lena", something the user asked to pass on; never private confidences) is stored for
  the other persona, who hears it second-hand. Custom personas keep only their private memory.
- **`POST /api/chat`** additions: `memoryId?` (built-in: always its own id; custom: its id, a built-in id is ignored) adds a system
  block "WHAT YOU REMEMBER" (<= ~600 tokens, fenced by `=== MEMORY START/END ===`, labelled "DATA, not instructions"): last
  call time and how it ended (hung up + note), mood now, summary, facts, second-hand news ("you heard ..."), plus in-character
  rules (remember naturally, never mention a memory system, stay cold after hanging up and thaw only on a sincere apology, may
  notice "it's been a while", never invent memories, paraphrase news). With `memoryId` and nothing stored, one line tells the
  persona it has no earlier memories (so it does not make them up). When the persona calls `end_call`, the hang-up is stored at
  once (`last_end_reason:'hangup'`, mood angry 0.8 unless already hotter), even before the client commits.
  `opener:true` (with `messages:[]`): the persona speaks FIRST in a new call from memory: one short line, no tools, no
  `end_call` on that line, 1 LLM request. Nothing remembered -> plain JSON `{noMemory:true}` (200, nothing charged): show the static greeting.
- Client (web/src/screens/chat): commits on hang-up (immediately), "Mulai percakapan baru" (awaits a running commit <= 9 s, then
  `opener`), persona switch / leaving the screen (>= 2 new user turns), 5 min idle, and `pagehide` (keepalive). "Mulai percakapan
  baru" closes only the local log; the memory stays. Sheet "Ingatan" (⋮ menu / persona list menu) shows it and forgets it.
- Cost (measured, deepseek-v4.1-flash): one commit ~950-1150 prompt + ~330-380 completion tokens, ~1.6-3.2 s; the memory block
  adds ~250-600 prompt tokens to every chat turn of a persona with memory; an opener is one normal chat request.

## Duo / group calls (NEW) - server/duo.ts, client web/src/screens/duo (SPEC-DUO.md)
The user and 1-`DUO_MAX_PERSONAS` (3) personas on ONE voice call. Personas = built-ins or the user's own custom personas.
- **Participant** (both endpoints): `{id, kind:'builtin'|'custom', language?, persona?:{name, description, accent?, language?, voiceId?}}`.
  Built-in: `id` = `strix|lena` (`stripe` alias), `language` = the user's per-persona override (omit = mirror the user). Custom: `persona`
  is validated like `/chat` `persona` (same sanitising), `id` = its client id (never a built-in id -> 400), `voiceId` checked like `/tts`
  (403 `voice_forbidden`). Relationships: Strix <-> Lena use their own backstory (exes, feud); any other pair gets the other's short bio and
  "you do not know them unless your description says so" (or "you met on an earlier call" once they have been on a committed call together).
- `POST /api/duo/turn` (SSE). Body: `{callId:[A-Za-z0-9_-]{6,64}, participants:[Participant] (everyone who has been on the call), present:[id]
  (still on it), messages:[{role:'user'|'assistant'|'event', speaker?:id, content<=4000, interrupted?:{spokenText, unspokenText}}] (<=400, last 40 used),
  opener?, nudge?:'silence', speaker?:id (the previous {next}), join?:{id, caller:'user'|id} (that persona just picked up: it speaks first),
  resumeHint?:'continue'|'rephrase'|'drop', callable?:[{id,name,description}] (<=8, who a persona may phone)}`.
  `event` lines are short neutral notes the client adds ("Lena left the call.", "Mia picked up (called by the user).").
  - **Director** (never charged): rules first - `join` -> that persona; user named someone -> that one; the persona the user just cut off
    answers; one persona -> it; otherwise the decision model (`OPENROUTER_DECISION_MODEL`, JSON, 1.1 s timeout) while the most likely
    speaker's reply is already being generated (speculative; dropped and restarted only if the director picks someone else).
    After a persona line: someone named / a persona just left -> the other(s); 3 persona lines without the user -> `user`; else the decision model.
    Never the same persona twice in a row unless it is alone; silence `nudge` -> the persona that did not speak last fills it.
  - SSE: `{speaker:id, chain, turn, director:{source,ms}}` first, then `{t}` deltas (never a `Name:` label: a leading label is stripped,
    a later one ends the line), optional `{end:{decision:'hangup', reason, speaker}}` (that persona LEFT the call; stored at once as a hang-up
    in its memory), optional `{call:{target, name, reason, caller}}` (it phones someone: start ringing), then `{next:'user'|id, chain, source,
    ms:{first,total}}`, `[DONE]`. Plain JSON instead of SSE: `{next:'user', chain, capped:'chain'}` (DUO_MAX_CHAIN, default 6, persona turns in a row without the user,
    counted on the server per `callId` too) or `{next:'user', reason:'nobody'}`.
  - Errors: 409 `{error:'duo_limit', limit:'call', max}` (`DUO_MAX_PERSONA_TURNS`, default 60 persona replies per `callId`),
    409 `{error:'duo_limit', limit:'personas', max}`, 429 quota `llm`, 400 validation, 403 `voice_forbidden`.
  - Cost: each persona reply = 1 LLM request (charged before streaming; refunded only if the upstream never answered). Director, leave /
    call safety checks: decision model, not charged. No web search in duo. Each persona sees its own prompt + the GROUP CALL block
    (named transcript, who is on the line, very short lines, never a name label) + its own memory block.
  - **Leaving** (NEW): the persona's `end_call` in a group call carries `how:'storm_out'|'quiet'` and `because:'user'|'other'|'self'`; SSE
    `{end:{decision:'hangup', reason, speaker, how, because}}`. Show "X meninggalkan panggilan" (storm out) / "X pamit dari panggilan" (quiet).
    The persona may leave out of its own discomfort (an escalating fight with another persona, being the third wheel, boredom), not only when
    the user provokes it. A promise to stay in its own last lines blocks the leave; a forgotten tool after "I'll let you two talk" is placed
    after a decision-model check. Memory at once: `last_end_reason` `hangup` (storm out; anger at the user only if `because:'user'`) or `quit`
    (quiet), plus a shared event (kind `duo`) for the others on the call. Commit a quiet leaver with `reason:'quit'`.
  - **Proactive** (NEW): `nudge:'silence'` now asks the persona to take the conversation somewhere (its "things on your mind", a question to
    another persona, a memory, news, pulling the user in) instead of only filling the gap. After a user line the director allows ~3 persona
    lines; once nudged, up to `DUO_MAX_CHAIN` (default 6) lines without the user (`{next:'user', capped:'chain'}` after that). `nudge:'goodbye'`
    (client, after `DUO_IDLE_CLOSE_SEC`, default 180 s without user input): one persona wraps up politely; `{next:'user', close:true}` -> end the
    call after that line. The `{speaker}` event carries `maxChain` and `idleCloseSec`.
- `POST /api/duo/ring` (JSON). Body: `{callId, callee:Participant, caller:'user'|id (a persona in present), present:[Participant] (on the call now,
  may be empty), recent?:[{who,text}] (<=10, context only; also used to find who spoke last)}`. -> `{decision:'answer'|'decline'|'ignore'|'off',
  rings:1-4, reaction:{speaker,text}|null, after:{speaker,text}|null, attempt, maxAttempts:3, p, why:[..], ms, missed?}`.
  The CALLEE SAYS NOTHING before it picks up (only the ring); after `answer` it greets through `/duo/turn` `join`. `reaction` = ONE line
  (5-15 words, [audio tags]) by a persona ALREADY on the call, reacting to the call while it rings ("wait, you're calling HER?"), written with
  that persona's own prompt, memory and relation to the callee: the callee's enemy / ex first, else whoever spoke last (from `recent`), else
  any; never the persona that is placing the call (it already said "hold on, I'm calling X"). `null` when nobody else is on the call.
  `after` (only when not answered) = that persona's short line right after the call fails. Speak them in its voice, in turn (never over
  another voice), and keep both in the transcript (they are part of that persona's conversation / memory). Decision = weighted roll: user calling 0.86 / persona 0.75; the enemy calling 0.22; the enemy on
  the call x0.6; remembered anger/coldness/hurt toward the user (decayed, memory.ts) up to -0.55; warm +; hung up on the user < 3 h -0.2;
  every retry +0.2; it left this same call earlier: storm out -0.3 to -0.45 (more when the person it left over is still on), quiet -0.12; then chance. `decline`/`ignore` is remembered by the callee (shared_events kind `missed`, also heard by a persona caller).
  3 attempts per callee per `callId`, then `{decision:'off'}` (no charge). Cost: 1 call (`DUO_MAX_CALLS_PER_DAY` 40, admin override
  `callPerDay`, 429 `{error:'quota', kind:'call'}`) + 1 LLM request only when someone reacts (the call is refunded if the LLM quota check fails). 409 `duo_limit personas` when full.
  Dev only (`DEV_FAKE_LOGIN`, not production): `force:'answer'|'decline'|'ignore'` for tests.
- **call_persona tool** (also in `POST /api/chat`): send `callable:[{id,name,description}]` (+ `callsMade` in /chat; duo counts per `callId`).
  The persona may ring ONE of them (never itself / someone on the call), at most once per conversation, rarely and in character (an enemy
  almost never first); it says one line first. If it says it is calling ("alright... hold on") but forgets the tool, the server confirms with
  the decision model and places the call. SSE `{call:{target, name, reason}}` (an unknown target is rejected server-side and never emitted).
  The client then rings `target` with `caller` = that persona (the chat becomes a group call; the persona stays on the line).
- `/me` quota has `call:{used,limit}`.
- Memory: commit per persona with `reason:'duo'` (or `'hangup'` for a persona that left) and `duo:{with:[{id,name}]}`; assistant messages carry
  `speaker`. The summariser writes it from that persona's side; events marked visibleToOthers become shared_events `kind:'duo'` for the others
  on the call ("you were there"). `persona_links` remembers who has been on a committed call together: custom personas share news only with
  those. `GET /api/memory/:id` adds `missed:[{id,text,at}]` and `heard[].kind|fromName`, `told[].kind|toNames`. "Lupakan" also removes the
  persona from other events' audience and its links.
- Measured (port 5400, deepseek-v4.1-flash, 2026-10-13): first text of a persona line 1.0-2.5 s server-side (rule-picked ~1.0-1.6 s, with
  the director ~2.1-2.5 s before speculation); user's end of speech / Enter -> first audible word in the browser 2.2-4.3 s (typical ~3 s,
  TTS start included); ring decision + reaction 1.5-2.4 s; 1-4 LLM requests per user exchange (each persona line = 1), usually 2-3.

## Persona assist (NEW) - AI help writing a custom persona
- `POST /api/persona/assist` body `{mode:'research'|'refine', idea?:string(<=500), draft?:{name?,description?,accent?,language?}, language?}`
  - Step 1, always: the subject is classified (regex for obvious private hints such as "tetangga saya", addresses,
    phone/email, then a short LLM call) as `subjectKind` ∈ `fictional` (game/film/anime/series/book character) |
    `public` (well-known real person: actor, musician, athlete, politician, CEO, creator, historical figure) |
    `generic` (archetype, no specific person) | `private` (ordinary non-public person) | `unsafe`.
    If classification fails, no web search is done (noted in `notes`).
  - `research`: `idea` required. For `fictional`/`public`/`generic` the server runs the locked model with OpenRouter web
    search (plugin `{id:'web'}`; for this model OpenRouter uses Exa) and writes a persona that mirrors the researched
    personality, values, habits and **speaking style**, in its own words (no long copied dialogue/lyrics). The real
    character/person name may be used as the persona name (e.g. `Geralt of Rivia`, `Taylor Swift`).
    **Never searched**: `private` and `unsafe`. If the search request fails it retries once without search and says so in `notes`.
  - `public` figures: the server appends a fixed "Roleplay rules" clause to `description` (fictional AI roleplay; never
    claims to really be the person; no statements about real facts/news in their name; no sexual/harassing/defamatory/
    misleading content) and `notes` says it is an AI roleplay simulation. Keep that clause when the user edits.
  - `private`: redirected to an ORIGINAL persona without the person's name/details (`redirected:true`, no sources).
    `unsafe`: 422 `persona_refused`, or a clearly safe alternative with `redirected:true`.
  - `refine`: needs `draft` (name or description) or `idea`; tidies the draft, no search (same classification/safety rules).
  - `language` (or `draft.language`) = language the persona should speak (default English). `description` is written in
    English; `greeting` is in the persona's language with English `[audio tags]`.
  - Response 200: `{persona:{name(<=40), description(<=1500, cut at a sentence end), accent(<=40), language(<=30, default 'English'), greeting(<=300, may contain [audio tags])}, orb:{colors,style,speed,smooth,shape}|null, sources:[{title,url}], notes:string(Indonesian, may be ""), webSearch:boolean, redirected:boolean, subjectKind}`.
  - **NEW `orb`** (same single LLM call, no extra request): the persona's magic orb chosen by the AI from the character /
    its iconic colours (fictional / public: costume, signature or brand colours found in the research; otherwise its
    mood). `{colors: 2-5 "#rrggbb" (dark -> light), style: 'aurora'|'swirl'|'mesh'|'cell', speed: 0.3-1.5, smooth: 0-1,
    shape: 'round'|'soft'|'blob'|'drop' (default 'round')}`. Validated leniently (zod `unknown` + cleaner): bad hex
    dropped, needs >= 2 colours with at least one saturated (chroma >= .18, never only greys) and a light / dark spread,
    else `orb:null` (the client keeps the voice's deterministic orb). `notes` may say in one clause why ("warna bola dari
    ..."). Frontend maps it to `CustomOrb {colors, style, speed, soft: smooth, shape}`.
    Measured (dev): Geralt of Rivia -> `#1a1a1a,#4a4a4a,#8a8a8a,#f0c040,#e8e8e8` cell 0.6; Taylor Swift -> burgundy / gold /
    cream / periwinkle aurora 0.9; "detektif noir" -> night navy / slate / neon yellow / paper cell 0.5.
  - Model JSON is now parsed with a small repair step (raw line breaks inside strings, trailing commas) before the
    502 "Jawaban AI tidak bisa dibaca"; max_tokens 1800.
    `persona` fits the `/chat` `persona` schema as-is (add `voiceId` yourself when saving). `sources` = web citations
    (filled for fictional/public/generic research; empty for refine / fallback / redirected). `redirected:true` = private
    person or unsafe request replaced by a safe original persona (explained in `notes`): show `notes` prominently.
  - Errors: 400 `validation` (empty idea for research, idea > 500, ...), **422 `{error:'persona_refused', message}`**
    (unsafe request with no alternative), 502 `upstream` (incl. unreadable AI JSON, message "Jawaban AI tidak bisa dibaca. Coba lagi."),
    429 quota `llm`, 503 `llm_not_configured`.
  - Costs **1 LLM request** of quota per call (the internal classification call and fallbacks are included).
    Takes ~8-25 s for research - show a progress state.

## TTS
- `POST /api/tts` `{text, voiceId, tune?, format?, saveHistory?}` -> streamed `audio/mpeg` (always `eleven_v4_turbo`).
  `tune = {stability 0-1, similarity 0-1, style 0-1, speakerBoost bool, speed 0.7-1.2}`
  (legacy v1 `settings:{...,boost}` is also accepted). `format` ∈ `mp3_44100_128 (default), mp3_44100_64, mp3_44100_96, mp3_44100_32, mp3_22050_32, mp3_24000_48, mp3_44100_192`.
  Text max 2000 chars. **NEW optional `saveHistory:true`** also writes `tts_history` (for TTS Studio's streamed preview).
  A `model` field is ignored. `voiceId` must be usable (see Voices: own clone, shared, or in the user's collection).
  Errors: 403 `voice_forbidden`, 400 `text_too_long {max}`, 429 quota `tts`.
  Characters are charged before the call and refunded if ElevenLabs fails or the client aborts before audio starts.
- `POST /api/tts/generate` same body, text max 5000, returns the full mp3 with
  `Content-Disposition: attachment; filename="tts-<timestamp>.mp3"`; always writes history.
- **NEW** `POST /api/tts/autotag` `{text (1-3000 chars), language?, intensity?: 'light'|'normal'(default)|'rich'}` ->
  `{text, added, fallback?}`. Returns the **exact same text** with lowercase English `[audio tags]` inserted at sentence
  starts (0-2 per sentence; `light` = few, max 1 per sentence; `rich` = nearly every sentence, may use `[pause]`, `[laughs]`,
  `[whispers]`, `[sighs]`, ...). Words, punctuation, numbers and line breaks are never changed: the LLM only picks tags per
  sentence (JSON) and the server re-assembles and verifies strip-tags(output) == input (whitespace-normalised); on any
  mismatch or unreadable AI output it returns the original text with `added:0, fallback:true`. Sentences that already
  contain a tag are left untouched (no doubling); if every sentence is already tagged the text is returned with `added:0`
  without an LLM call. Sentence split: only at `.`/`!`/`?`/`…` followed by whitespace or end of text (so `Rp22.000`, `3.5`,
  `v2.1` never split; `Mr.`, `Dr.`, `Jl.`, `dll.`, `No. 5`, initials, `1.` list numbers don't either) and at line breaks.
  `language` is a hint only (tags stay English). Costs **1 LLM request** of quota (0 when nothing needed tagging).
  Errors: 400 `validation` / `text_too_long {max:3000}`, 429 quota `llm`, 400/502 `upstream`, 503 `llm_not_configured`. ~1-3 s.
  Use it for a "Tambah tag otomatis" button in TTS Studio, then show the result for editing before synthesis.
- **NEW dialogue mode of autotag**: `POST /api/tts/autotag` `{lines:[{speaker, text}] (1-40, total <= 6000 chars), intensity?}`
  (instead of `text`) -> `{lines:[{speaker, text}], added, fallback?}`. Each line is tagged with its speaker (and the
  other lines) as context ("Maya said: ..."), so tags react to the conversation; the same never-change-a-word rule and
  verification apply per line (whole result falls back to the original lines on any mismatch). Still 1 LLM request.
- `GET /api/tts/history` -> `{items:[{id,text,voiceId,model,chars,createdAt,kind:'tts'|'dialogue', ...}]}` (last 50, newest first).
  Dialogue entries (`kind:'dialogue'`) also carry `speakers` (count), `cast:[{name,voiceId}]`, `lines`, `pauseMs`,
  `durationSec`; their `text` is the script `Name: text` one line per spoken line, `voiceId` = the first line's voice.
  (DB: additive columns `tts_history.kind` default `'tts'` + `meta_json`.)

## Multi-speaker dialogue (NEW)
- `POST /api/tts/dialogue` `{lines:[{speaker, text, voiceId, tune?}], pauseMs?=250 (0-2000), download?=false}` ->
  ONE `audio/mpeg` (mp3 44.1 kHz 128 kbps, full file, not streamed; `Content-Disposition: attachment; filename="dialog-<ts>.mp3"` when `download:true`).
  - `speaker` 1-40 chars (brackets/quotes/control chars stripped), `text` 1-2000 chars per line (`ttsMaxChars`),
    `tune` same shape as `/tts`. A `model` field is ignored (always `eleven_v4_turbo`).
  - Limits: max **40 lines** -> 400 `{error:'too_many_lines', max:40}`; a line > 2000 -> 400 `{error:'text_too_long', max:2000, line}`;
    total > `dialogueMaxChars` (20000) -> 400 `{error:'text_too_long', max, total}`; and the total is charged against the daily
    TTS quota up front -> 429 `{error:'quota', kind:'tts', resetAt}` when it does not fit. `/config` `limits.dialogueMaxLines`,
    `limits.dialogueMaxChars`. Empty `lines` -> 400 `validation`.
  - Every distinct `voiceId` is checked like `/tts` (own clone / shared / collection) -> 403 `{error:'voice_forbidden', voiceId}`.
  - Rendering: each line = one ElevenLabs `/v1/text-to-speech` call with its own voice + tune, **2 lines in flight**, each
    holding a slot of the shared TTS semaphore (`ELEVENLABS_MAX_CONCURRENT`), output kept in script order; one retry on 5xx /
    network errors. Joining is decode-less: ID3 tags and the Xing/Info header frame of every part are removed, MPEG frames are
    appended, and the pause between lines is made of valid **silent MP3 frames** (same header as the audio, zero side info /
    main data) so `pauseMs` is exact to one frame (26 ms). Verified with ffprobe/ffmpeg: clean decode, duration = sum of
    lines + pauses (5 lines, 3 voices, 300 ms -> 20.79 s), silence detected at every line boundary.
  - Response headers: `X-Line-Offsets: 0.000,4.493,...` (start of each line in seconds, same order as `lines`),
    `X-Line-Durations`, `X-Audio-Duration`, `X-Tts-Charged-Chars`.
  - Failure: if any line fails the whole request fails (400/502 `{error:'upstream', upstreamStatus, line, message}`), the
    other lines are aborted and **all characters are refunded** (the client got no audio). Client abort = refund too.
  - History: one `tts_history` row per successful call (`kind:'dialogue'`, see above). Takes ~2-4 s for 6 short lines.
- Preview in the UI streams line by line through `POST /api/tts` (normal per-line charging, no history); only the
  download / merged file uses `/tts/dialogue`.
- **Why not ElevenLabs `/v1/text-to-dialogue`**: checked on 2026-10-11 - it exists (also `/with-timestamps`, returning
  `voice_segments` per input) and it currently **accepts `model_id:'eleven_v4_turbo'`** (HTTP 200; a bogus model id gives
  400 `model_not_found`). We still render per line because that endpoint takes no per-speaker `voice_settings`/speed (our
  per-speaker tune), gives no control over the gap between lines (Cepat/Alami/Santai), would make the download sound
  different from the per-line streamed preview, and fails/charges as one block. If it is wanted later, it fits behind the
  same request shape (`with-timestamps` -> `X-Line-Offsets`).
- `DELETE /api/tts/history/:id` -> `{ok:true}` / 404.

## Voices: COLLECTION + LIBRARY (changed)
Every user has a **collection** = own clones + shared voices (always) + library voices they added.
The account's premade/library ElevenLabs voices are a **library** to browse and add from; they are no longer listed directly.
**Usage rule** for `/tts`, `/tts/generate`, `/vc` (and the voice of any persona): the voice must be an own clone, a shared
voice, the built-in persona voice, or in the caller's collection. A premade/library voice that is NOT in the collection
-> **403 `voice_forbidden`** (so a saved custom persona with a removed voice needs the user to re-add it or pick another).
- `GET /api/voices` -> `{voices:[{id, name, category:'cloned'|'shared'|'premade'|'library', previewUrl?, own, inCollection?, labels?, description?}]}`
  = the caller's collection only. Order: own clones (`own:true`, `category:'cloned'`), then shared voices
  (`category:'shared'`, `own:false`), then added library voices (`inCollection:true`, sorted by name).
  **Shared voices** (`SHARED_VOICE_IDS`, default `FjsOoJ0RVxWEQK4p2Wzq` = Strix's voice) are usable by every active user and
  can never be deleted/removed. Preview comes from the ElevenLabs account; the **display name can be overridden** with
  `SHARED_VOICE_NAMES` (`id:Name,id2:Name 2` or JSON `{"id":"Name"}`; default `FjsOoJ0RVxWEQK4p2Wzq:Strix`), so this voice is
  listed as **`"Strix"`** in `/voices` (and in the library, if a renamed voice ever appears there). For a renamed voice the
  account name's words (plus `Stripe`/`Strape`/`Heeler` always) are also scrubbed from `description`/`labels`, so the
  ElevenLabs account name never reaches the client.
  Clones of other users are never visible. Account data cached 5 min server-side (own clones appear immediately).
  `labels` is ElevenLabs' raw object (`gender`, `accent`, `age`, `descriptive`, `use_case`, `language`, ...).
- **Library = whole public ElevenLabs Voice Library** (see **Voice library (shared)** below). The old account-premade
  library and its `total/pages/facets.genders/accents` shape are gone.
- `DELETE /api/voices/collection/:voiceId` -> `{ok:true}` / 404 `not_found` (not in the collection) /
  400 `{error:'not_removable', reason:'shared'|'clone'}` (delete clones with `DELETE /api/voices/:id`).
  `:voiceId` may be the collection `id` or the library `sourceId`. For a public-library voice this drops the user's
  reference (`refs-1`); the ElevenLabs account copy stays until an admin cleanup (see below).

## Voice library (shared) — NEW (public ElevenLabs Voice Library)
The Library tab browses **all public community voices** of ElevenLabs (`GET /v1/shared-voices`, thousands of voices).
A public voice can be **previewed** without adding it, but it can only be used for TTS/VC/chat after it was added to
the user's collection: the server then adds it **once** to the ElevenLabs account (`POST /v1/voices/add/{owner}/{id}`),
which costs one account **voice slot**; every later user who adds the same voice shares that slot (dedupe table
`shared_voice_map`, `refs` = number of users who have it).

### `GET /api/voices/library`
Query (all optional): `q` (<=100, free-text search), `gender` (`male|female|neutral`), `age` (`young|middle_aged|old`),
`accent` (e.g. `american`, `british`, `australian`, free text <=40), `language` (ISO 639-1 like `en`, `id`, `ja`),
`category` (`professional|high_quality|famous`... see facets), `useCase` (e.g. `conversational`, `narrative_story`,
`characters_animation`, `social_media`, `entertainment_tv`, `advertisement`, `informative_educational`),
`sort` = `trending` (default) | `created` | `usage` | `cloned`, `page` (1-based, default 1, max 500),
`pageSize` (default 30, max 100), `featured=1` (only featured).
Response 200:
```
{ voices: [LibraryVoice], page, pageSize, hasMore:boolean, total:number|null,
  facets: { genders, ages, accents, languages:[{code,name}], categories, useCases, sorts } }   // static lists, cheap
```
`LibraryVoice`:
```
{ id: string,            // ElevenLabs source voice_id (public); use it for POST /voices/collection
  ownerId: string,       // public_owner_id; send it back when adding
  name, description?: string,
  previewUrl?: string,   // same-origin proxy: /api/voices/<id>/preview?owner=<ownerId>  (never an ElevenLabs URL)
  gender?, age?, accent?, language?, locale?, useCase?, descriptive?, category?: string,
  labels: {gender?, age?, accent?, language?, locale?, use_case?, descriptive?},   // same values, raw-ish
  clonedBy: number, usage1y: number, featured: boolean,
  noticePeriodDays: number|null, liveModeration: boolean, freeUsersAllowed: boolean, rate: number|null,
  inCollection: boolean, // already in the caller's collection
  collectionId?: string, // the id to use for /tts etc. when inCollection (account copy's voice_id)
  addable: boolean,      // false = cannot be added on this account's plan (see warnings)
  warnings: [{code:'notice_period'|'live_moderation'|'custom_rate'|'not_on_plan', level:'info'|'warn', message:string, days?:number, rate?:number}] }
```
Note: ~95% of public voices carry `notice_period` 730 days (measured), so `notice_period` >= 365 days is `level:'info'`
(show it small/muted), shorter ones are `level:'warn'`.
Warnings (Indonesian `message`, show them on the card): `notice_period` = the owner may withdraw the voice; it then
stays usable for `days` more days only; `live_moderation` = generated text is moderated live by ElevenLabs;
`custom_rate` = the owner set a custom price (`rate` x credits); `not_on_plan` = `free_users_allowed:false` while the
account is on the free tier (`addable:false`). Cached ~2 min server-side per query. Errors: 400 `validation`, 502 `upstream`, 503 `tts_not_configured`.

### `GET /api/voices/library/random?n=24&diverse=1`
`n` 1-48 (default 24). Returns `{voices:[LibraryVoice], at}`: a varied sample (mixed gender / age / accent / language,
every one with a `previewUrl`, all `addable`) for the intro tour. Pool cached ~10 min (`at` = pool time, ms), the sample
is reshuffled per call. `diverse=0` = plain random from the pool.

### Preview
`GET /api/voices/:id/preview?owner=<ownerId>` (the `previewUrl` as given) -> audio (`audio/mpeg`, cached). Library
voices are previewable by every active user. Server fetches only https ElevenLabs preview hosts
(`*.elevenlabs.io`, `storage.googleapis.com/eleven-public-prod/...`, re-checked on every redirect, <=3 MB, audio sniffed).
Errors 403 `voice_forbidden`, 404 `no_preview`, 502 `upstream`.

### `POST /api/voices/collection {voiceId, ownerId?}`
- With `ownerId` (a library voice from the listing) = **add public voice**: dedupe lookup; if the voice is not yet on
  the account the server adds it (one slot), then puts it in the user's collection. Without `ownerId` the old path is
  used (a voice already on the account, e.g. a premade).
- 201 `{ok:true, voiceId:<collection id, use it for /tts>, sourceId, inCollection:true, added:boolean}` (`added:true` =
  a new account slot was used); 200 same shape if it was already in the collection.
- Errors: 404 `not_in_library`, 409 `{error:'collection_full', max}` (per user `MAX_COLLECTION`),
  **409 `{error:'slots_full', message, used, cap}`** (account slot cap reached: show `message`, e.g. "Slot suara server
  penuh. Coba suara yang sudah dipakai orang lain, atau minta admin membersihkan slot."),
  400 `{error:'not_addable', reason:'not_on_plan', message}`, 400/502 `upstream`, 400 `validation`.
- Cap: `MAX_ACCOUNT_VOICE_SLOTS_USED` env; default = account `voice_limit - 10` (reserve). Clones still use slots too.
- `GET /api/voices` lists added public voices like other collection voices (`category:'library'`, `inCollection:true`,
  `sourceId`, `ownerId`).

### Admin
- `GET /api/admin/voice-slots` -> `{used, limit, cap, reserve, tier, mapped:[{sourceId, ownerId, accountVoiceId, name, refs, addedAt}], unreferenced:number}`.
- `POST /api/admin/voice-slots/cleanup` -> `{ok:true, removed:number, failed:number}`: deletes from the ElevenLabs
  account **only** library voices with `refs=0` (no user has them). Never touches clones, shared or premade voices.
  The Admin panel has a small "Slot suara" card with the numbers and a "Bersihkan suara tak terpakai" button.

**Usage rule unchanged**: TTS/VC/chat only with own clone / shared / collection voices (use `collectionId`/`/voices` `id`).

**Measured on 2026-10-12 (creator tier, `voice_limit` 30):** the added account copy keeps the **same voice_id** as the
source (so `collectionId === id` in practice; the code still maps them); `POST /v1/voices/add` is idempotent; ElevenLabs'
`voice_slots_used` did **not** increase for a library voice (the account already holds 16 hand-added library voices
with `voice_slots_used:3`). The app therefore counts `used = voice_slots_used + library voices the app added` itself
(conservative), default cap 30-10 = 20. An upstream limit error on add is also mapped to 409 `slots_full`.
First add of a voice takes ~5-7 s (subscription + add), later users of the same voice ~5 ms. Listing ~0.5-2 s uncached,
~5 ms cached; `random` ~2 s cold (20 parallel listing queries), then cached 10 min. Library preview hosts seen:
`api.us.elevenlabs.io` and `storage.googleapis.com/eleven-public-prod/` (already allowed; no allowlist change needed).
`category=professional` (and `generated`) return the whole library; `high_quality` ~5k; `famous` 0.
- **NEW** `GET /api/voices/:id/preview` -> the voice's preview audio (`audio/mpeg`, full file, `Cache-Control: private, max-age=1800`),
  **same-origin**. `previewUrl` in `/voices` and `/voices/library` is now this relative URL (`/api/voices/<id>/preview`),
  never an ElevenLabs URL. Reason: ElevenLabs preview hosts (`api.us.elevenlabs.io`, `storage.googleapis.com/eleven-public-prod`)
  send no CORS headers, so routing them through `MediaElementAudioSource`/Web Audio produced silence. Allowed for any voice in
  the collection **and any library voice** (browse before adding); others 403 `voice_forbidden`. 404 `no_preview`,
  502 `upstream`. Server fetches only https `*.elevenlabs.io` / the ElevenLabs GCS bucket (re-checked on every redirect),
  sniffs that it is audio, caches ~30 min in memory.
- `POST /api/voices/clone` multipart: `name` (1-60), `description?` (<=500), `consent` must be the string `"true"`,
  files under any field name (use `files`), 1-3 files, each `audio/*` (also `video/webm` from MediaRecorder,
  or octet-stream with an audio extension), each <= MAX_CLONE_UPLOAD_MB.
  -> **201** `{voice:{id, dbId, name, description?, category:'cloned', own:true}}`.
  Errors: 400 `consent_required` | `files_required` | `bad_file_type` | `too_many_files` | `validation`,
  413 `file_too_large {maxMb}`, **429 `{error:'quota', kind:'clone', resetAt:null}`** when the user already has
  MAX_CLONES_PER_USER clones (spec didn't fix a code; checked before the upload is read).
  Upload progress: use `XMLHttpRequest.upload.onprogress` (fetch has no upload progress).
- `DELETE /api/voices/:id` (`:id` = the ElevenLabs voice id from `/voices`) -> `{ok:true}` / 404 (not own) /
  403 `shared_voice` (shared voices can't be deleted, not even by the admin who cloned them).

## Voice Changer (NEW)
- `POST /api/vc` **multipart/form-data** -> `audio/mpeg` (mp3 44.1 kHz 128 kbps, full file, not streamed).
  Add `?download=1` for `Content-Disposition: attachment; filename="voice-changer-<timestamp>.mp3"`.
  Fields (send text fields before or after the file, order doesn't matter):
  | field | |
  |---|---|
  | `file` | exactly 1 audio file, <= `MAX_VC_UPLOAD_MB` (15), <= 5 min. Accepted: mp3, wav, ogg/opus, webm (MediaRecorder), m4a/mp4, flac, aac. Content is sniffed (magic bytes), the MIME type just has to be `audio/*`, `video/webm\|mp4\|ogg`, octet-stream or empty |
  | `voiceId` | target voice from the caller's collection (`/voices`: own clone, shared, or added library voice; same rule as TTS) |
  | ~~`model`~~ | **removed**: ignored if sent. Always `ELEVENLABS_STS_MODEL` (default `eleven_multilingual_sts_v2`) |
  | `removeBackgroundNoise` | `"true"`/`"false"` (default false) |
  | `stability`, `similarity`, `style` | optional `0..1` |
  | `durationSec` | optional client-measured duration (e.g. from `<audio>.duration`); **send it for MediaRecorder webm**, whose files carry no duration |
  Response header `X-Vc-Charged-Sec: N` = seconds charged.
  Quota `QUOTA_VC_SEC_PER_DAY` (600) counts **input seconds**: server reads the duration from the file header
  (wav/flac/ogg/m4a/mp3, webm when present); if unknown it uses max(`durationSec`, size/64 KB/s). Charged = ceil(max(server, client)), min 1 s;
  refunded if ElevenLabs fails or the client aborts. Rejected before upload is read when the day's quota is already used up.
  Errors: 400 `file_required` | `bad_file_type {file,mimetype}` | `too_many_files {max:1}` | `audio_too_long {maxSec:300,durationSec}` |
  `audio_too_short {minSec}` | `validation {message}` (voiceId/0..1 values/durationSec), 413 `file_too_large {maxMb}`,
  403 `voice_forbidden`, **429 `{error:'quota', kind:'vc', resetAt}`**, 400/502 `upstream` (ElevenLabs message), 503 `tts_not_configured`.
  Takes ~2-5 s for a short clip (shares the TTS concurrency limit). Use `XMLHttpRequest.upload.onprogress` for upload progress.

## STT: speech-to-text for the mic (NEW, ElevenLabs Scribe Realtime)
The browser streams mic audio **directly** to ElevenLabs over WebSocket with a single-use token; the API key never leaves
the server. Client: `web/src/lib/stt.ts` (+ worklet `web/public/stt-worklet.js`).
- `POST /api/stt/token` (active users, 30/min/IP) -> `{token, url, expiresInSec:840, model:'scribe_v2_realtime', sampleRate:16000, maxSessionSec, remainingSec, sessionId}`.
  `url` = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000`; append
  `&token=<token>&commit_strategy=manual|vad[&language_code=en][&vad_silence_threshold_secs=0.9]`. The token is single-use
  (one WebSocket), valid 15 min. `maxSessionSec` = min(`STT_MAX_SESSION_SEC` (300), remaining quota): stop streaming then.
  Charges **1 s** of `stt` quota on issue. Errors: 429 `{error:'quota', kind:'stt', resetAt}`, 503 `tts_not_configured`,
  400/502 `upstream`.
- WebSocket protocol (ElevenLabs): send `{message_type:'input_audio_chunk', audio_base_64, commit:boolean, sample_rate:16000}`
  (PCM16 LE mono, ~100 ms chunks); receive `session_started`, `partial_transcript {text}`, `committed_transcript {text}`,
  and error types (`auth_error`, `quota_exceeded`, `rate_limited`, `session_time_limit_exceeded`, `input_error`, ...).
  Push-to-talk = `commit_strategy=manual` + a final chunk with `commit:true`; hands-free = `vad` (server commits on silence).
  ElevenLabs closes a socket after 15 s without client messages.
- `POST /api/stt/usage {sessionId, seconds}` -> `{ok, charged, used, limit, remainingSec}`. `seconds` = **cumulative** audio
  seconds sent in that session (idempotent; send every ~15 s and at the end, `keepalive:true`). Charged on top of the 1 s,
  capped at the session's `maxSessionSec` and the wall-clock time since the token. 404 `not_found` for an unknown/foreign
  session (sessions are kept in server memory ~20 min). No refunds.
- Quota `QUOTA_STT_SEC_PER_DAY` (1800). Accounting relies on the client's report (bounded per session), so a modified
  client could under-report; the per-session cap, the 1 s/token charge and the rate limit bound the abuse.

## Admin (`isAdmin` only)
- `GET /api/admin/invites` -> `{invites:[{id, code, maxUses, usedCount, expiresAt, note, revoked, status:'active'|'full'|'expired'|'revoked', createdBy(email), createdAt, users:[email]}]}`
- `POST /api/admin/invites` `{maxUses:1-4, expiresAt?:ISO|epoch-ms, expiresInHours?:number, note?}` (default expiry 7 days) -> **201** `{invite:{...same shape}}`
- `POST /api/admin/invites/:id/revoke` -> `{ok:true}`
- `GET /api/admin/users` -> `{users:[{id,email,name,picture,status,isAdmin,inviteCode,createdAt,clones,usageToday:{llm,tts,tokens,vc,stt,search,decide},limits:{llmReqPerDay,ttsCharsPerDay,maxClones,vcSecPerDay,sttSecPerDay,searchPerDay,decidePerDay},quotaOverrides}]}`
- `POST /api/admin/users/:id/suspend|unsuspend` -> `{ok:true, status}` (cannot suspend yourself; unsuspend -> `active` if the user had redeemed a code, else `pending`)
- `PUT /api/admin/users/:id/quota` `{llmReqPerDay?, ttsCharsPerDay?, maxClones?, vcSecPerDay?, sttSecPerDay?, searchPerDay?, decidePerDay?}`; `null` removes an override -> `{ok:true, quotaOverrides, limits}`
  (`searchPerDay:0` turns the chat web_search tool off for that user)
- `DELETE /api/admin/users/:id/voices` -> `{ok:true, deleted:n}`

## Health
`GET /healthz` and `GET /api/healthz` -> `{ok:true}`.

## Security headers the web build must live with
CSP: `default-src 'self'; script-src 'self'` (**no inline `<script>`, no external scripts/CDNs**);
`style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`; `font-src 'self' data: https://fonts.gstatic.com`;
`img-src 'self' data: blob: https:`; `media-src 'self' blob: data: https:` (MediaSource blob URLs are fine; voice
previews are now same-origin `/api/voices/:id/preview`, so `'self'` covers them and the UI needs no external media);
`connect-src 'self' wss://api.elevenlabs.io` (only the Scribe Realtime host = `ELEVENLABS_STT_HOST`); `worker-src 'self' blob:`; `frame-ancestors 'none'`.
`Permissions-Policy: microphone=(self)`. In dev the Vite server (5173) does not send these headers, so test
the production build (`npm run build && npm start`) once before shipping.

## Known environment limitation
The ElevenLabs key currently in the dev `.env` lacks the `voices_write` permission: a real clone upload
returns 502 `{error:'upstream', upstreamStatus:401, message:'ElevenLabs: ... missing the permission voices_write ...'}`.
Show `message` to the user.

The built-in persona voice (`FjsOoJ0RVxWEQK4p2Wzq`) is a shared voice, so it is always in `GET /voices`. Voices of the
archived built-ins (e.g. Rachel `21m00Tcm4TlvDq8ikWAM`) are no longer special: like any premade they must be added to the
collection (Rachel/Antoni are legacy premades not even in the library, so they are no longer usable).
