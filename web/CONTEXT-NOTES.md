# web/ — notes (Lite app)

Scope follows `../SPEC-LITE.md`: 4 tabs (Chat Persona, TTS, Voice Changer, Voices/Clone) + login/redeem + minimal Admin
+ a small account sheet. The old Coffee / Voice call / Roleplay / Settings screens were moved (not deleted) to
`../_archive/web/` (outside `src/`, so outside the Vite build and `tsc`). The previous version of this file
(the Coffee-port contract) is `../_archive/web/CONTEXT-NOTES.coffee.md`.

## Layout
- `src/shell.ts` — sidebar (>= 900px) / bottom tab bar (mobile), top bar with avatar, hash router.
  A screen's `mount(root, ctx)` may return a cleanup function or `{ cleanup, onRoute }`; with `onRoute` the
  screen handles sub-paths itself (`#/chat/<id>`, `#/voices/clone`) without being re-mounted.
  `ctx.shell`: `setTitle, setActions, setBack, setTopbar, setTabbar, setChrome, accountButton()`.
- `src/ui/account.ts` — account sheet (quota incl. Voice Changer, theme, "Tuning suara", admin link, logout).
  **No model selection anywhere** (server locks LLM / TTS / STS models; no `model` is sent).
- `src/ui/voicepicker.ts` — voice picker (orb + name) + sheet listing the COLLECTION only (Milikmu / Bersama /
  Dari Library) with previews and a "Cari di Library" link. `previewVoice()` plays `previewUrl` (same-origin proxy
  `/api/voices/:id/preview`) with `who='preview:<id>'`.
- `src/ui/orb.ts` — "bola magis": deterministic spec from an id (`voiceOrb(id)`, `personaOrb(voiceId, name)`),
  flat 2D look. One shared WebGL canvas renders all orbs (copied into 2D canvases); stills cached as data: URLs per
  pixel bucket; live orbs (`orb(spec,{live, level})` / `setLive`) pause off screen / hidden tab, static under
  prefers-reduced-motion; Canvas 2D fallback without WebGL.
- `src/ui/transition.ts` — ONE transition vocabulary: `enter` / `leave` (dissolve + small slide, 140-260 ms, WAAPI, fade only
  under reduced motion), `swap` (View Transitions when available), orb match-cut `handOff(el)` / `receiveOrb(target)`
  (uniform scale: stays round). Used by the shell router (tabs slide by direction, sub-pages such as Library <-> Koleksi
  dissolve), the persona forge exit (its orb flies onto "Persona siap").
- `src/ui/overlay.ts` is spam-safe: one modal per key (cls / title), one drawer per title, popovers toggle on their
  anchor and close any other, identical toasts are merged. `.btn:active` uses `scale` (not `transform`), so buttons that
  are positioned with a transform never jump when pressed (that was the `.ps-more` jump).
- `src/styles/mobile.css` — phones (<= 640 px): touch targets >= 44-48 px, inputs 16 px, popover menus become a bottom
  action sheet (ui/overlay.ts `.menu.sheet` + scrim).
- `src/ui/glprog.ts` — `buildProgram()`: WebGL programs without main-thread freezes (KHR_parallel_shader_compile +
  polling; without the extension the blocking status check is deferred to idle). Used by ui/orb.ts (2D orbs: 2D painter
  until ready, then repaint; the GL context is created in its own task), the persona forge (forgegl.ts: ONE shared
  context + program per page, prewarmed at idle by the Chat screen via `prewarmForge()`; a real DOM orb stands in until
  ready; morph = two passes of one program) and the tour stage (ui/intro/stage.ts; draws nothing until ready).
- `src/ui/gesture.ts` — `drag()` (axis-locked Pointer Events), `swipeRow()` (actions behind a row), `pullToRefresh()`
  (Touch Events), `haptic()`, `rubber()`. Used by: modal bottom sheets (drag handle/header down to close), tab swipe
  in `shell.ts` (phones, not inside `[data-hswipe]`/inputs/range/players), Chat edge-swipe back to the list, persona /
  TTS-history / voice / library rows, pull-to-refresh in Voices. Every gesture has a button alternative.
- `src/ui/audio.ts` — mini audio player for local blobs; with `orb` the play button is the voice orb animated by an
  analyser on the blob audio (never cross-origin).
- `src/player.ts` — `playUrl(src, who)`: same-origin/blob audio through the shared element (level() works); a
  cross-origin URL would go to a separate plain `<audio>` that never touches Web Audio.
- `src/lib/collection.ts` — add/remove library voices (`POST/DELETE /api/voices/collection`), toasts.
  `addVoiceResult(v)` (no toast, returns `{ok, voiceId}` / `{ok:false, code:'slots_full'|'collection_full'|'not_addable'|..., message}`)
  sends `ownerId` for public-library voices; `inCollection(id)` also matches a collection voice's `sourceId`.
- `src/lib/persona.ts` — personas (built-in `stripe` from `/api/characters`, `mirrorLanguage` -> lang `auto` = no
  `language` sent; own ones in setting `chat.personas`, per-persona overrides + "Bacakan" in `chat.prefs`),
  `/api/chat` streaming, tag stripping. Logs are per device (`settings.local`, key `chat.log.<id>`).
- `src/screens/chat/creator.ts` — persona creator. `personaForm()` = the ONE form model (fields, "Bantu AI" =
  `POST /api/persona/assist` research with sources + notes, "Rapikan dengan AI" = refine with undo, Roleplay clause,
  voice / Studio Bola, validation). Views: `forge.ts` (+ `forgegl.ts`, `forge.css`) = the immersive editor (glass sphere
  with a lat/long grid; ingredients dragged / tapped in make ripples and fill it with ink in the voice's colours; the
  camera dives through the surface; inside, the form is a ring of glass panels on the concave wall, CSS 3D from the same
  camera yaw; Strix researches from inside (scan band, results fly to their panels); Simpan = back out, then the offer).
  WebGL shader, Canvas 2D fallback; phone keyboard lays the edited panel flat in the visible area. Under
  prefers-reduced-motion the classic modal (`openClassicEditor`) is used. Test hook `window.__forge()`.
  Look: neutral dark stage, hairline panels, one accent from the persona's orb; panels are nearly full screen on phones.
  The forge sphere IS the persona's orb: forgegl.ts compiles ui/orb.ts ORB_FS into `orbA()` / `orbB()` (B = morph from the
  previous look) and draws it flat at rest (pixel-identical to a 2D orb of the same size: test lite-ident, mean diff < 1%),
  wrapped on the sphere + glass grid only once the camera moves; on save it turns back to the front view and flattens,
  then a real orb element with the same clock takes over (no jump). A DOM orb's disc is .88 of its box.
  Shared-element flights (ui/transition.ts orbGhost / flyOrb / receiveOrb / takeHandOff / morphOrb): chat orb <-> persona
  list row, list row -> chat orb on pick, "Buat persona" -> forge, forge -> "Persona siap" -> chat orb, library card <->
  detail sheet, cross-morph of the chat orb on persona change. A new flight ends the previous one (no ghosts left).
  Dragging the sphere turns it like a ball in the hand. `/api/persona/assist` also returns `orb` (iconic colours / style /
  shape) which is applied as the persona's CustomOrb (`shape` round|soft|blob|drop is supported by ui/orb.ts).
- `src/screens/voices` — `#/voices` Koleksiku, `#/voices/library` Library = the WHOLE public ElevenLabs Voice Library
  (~19.6k community voices, `GET /api/voices/library`, server-side search/filters/sort, 30 per page), `#/voices/clone`.
  Library grid is windowed: fixed 96 px cards (+8 gap) absolutely positioned in `.lib-virt`, only ~1 screen above/below
  the `#view` scroller is in the DOM (about 20-50 cards even after hundreds loaded); next page loads near the end.
  Filters (gender/usia/aksen/bahasa/kategori/kegunaan) sit in a collapsible panel behind "Filter" (count badge) + sort
  select; value lists are static `FACET` (same as server `facets`). Card: orb preview button (one preview at a time via
  `player`), name, meta, chips (warning chips first, HQ, use case, usage), add button with states Tambah / Menambahkan...
  / Terpasang (tap = remove) / Slot penuh / Tidak tersedia (icon-only <=420px). Tapping the card opens a detail sheet
  with description, all warnings (notice period, live moderation, custom rate) and attributes.
- `src/screens/admin` — Pengguna tab also has a "Slot suara" card (`GET /api/admin/voice-slots`, button
  "Bersihkan suara tak terpakai" = `POST /api/admin/voice-slots/cleanup`).
- `api.libraryRandom(n, diverse)` -> `LibraryVoice[]` (`GET /api/voices/library/random`) for the intro tour.
- `src/lib/stt.ts` — speech input = ElevenLabs Scribe Realtime: `startStt({lang, mode:'ptt'|'vad', onPartial, onFinal,
  onLevel, onError, onState, onEnd, onFallback}) -> {stop(), abort(), backend}`. Token from `POST /api/stt/token`
  (`prewarmStt()` fetches one ahead), mic -> AudioWorklet `public/stt-worklet.js` (plain JS because CSP forbids blob:
  worklets; ScriptProcessor fallback) -> PCM16 16 kHz 100 ms chunks -> WebSocket; audio is buffered while connecting,
  reconnects twice with a fresh token, reports cumulative seconds to `/api/stt/usage`. Web Speech (`lib/speech.ts`) is
  only a fallback when no token can be had (UI shows "(mode browser)"). Chat: hold/tap mic = push-to-talk (manual commit
  on release -> send); menu "Mode bebas tangan" (prefs.handsFree) = VAD, mic re-opens after each spoken reply, pauses after
  30 s without speech or on error (tap mic to resume).
- `src/lib/vc.ts` — `POST /api/vc` (XHR, upload progress). `src/lib/recorder.ts` — MediaRecorder + level meter.
- Modals render as bottom sheets below 640px; modals and popovers close on route change.
- **Chat is voice-only** (src/screens/chat/index.ts): no bubbles; big persona orb above a compact bar (type / hold-to-talk
  mic / send); every reply is spoken (LLM SSE -> sentence chunks -> player.speak with meta.sid). Captions:
  src/lib/captions.ts reveals words by the real audio clock (player.speechNow() now returns 	/dur/final/buffered/lat/playing)
  using a weight map per chunk (letters + punctuation / pause / sound-tag pauses), a slow duration estimate until the stream
  is complete, and phrase starts gated on audible voice. Failed audio -> static caption + toast. Transcript and persona list
  are sheets (tap orb when idle / swipe up on orb / left edge swipe). Tap orb while talking = stop + listen.
  Test hooks: window.__caps.log (reveals) and window.__chatClock().
- **Custom orbs** (ui/orb.ts CustomOrb {colors 2-5, style aurora|swirl|mesh|cell|marble, speed, soft}; Studio in
  ui/orbstudio.ts): persona -> CustomPersona.orb / built-in override chat.prefs.over[id].orb; voice -> settings
  orbs {voiceId: CustomOrb} (lib/orbs.ts). Persona orb > voice custom orb > deterministic (unchanged).
- Persona flow: createPersonaFlow() (creator.ts) = editor -> save -> offer (talk / Studio Bola); after a clone Voices offers
  'Buat persona dengan suara ini' + Studio Bola. The server's public-figure 'Roleplay rules:' clause is kept apart in the
  editor (splitClause/joinClause) and always re-appended on save.
- TTS: [tags] are drawn purple by a backdrop behind a transparent-text textarea (no innerHTML); 'Auto tag' =
  lib/autotag.ts (POST /api/tts/autotag, result accepted only if the words are unchanged; local MOCK only on 404).
- TTS **Dialog** mode (screens/tts/dialogue.ts, CSS prefix `mspk-` because `.dlg*` is the modal): seg "Satu suara | Dialog"
  (setting studio.mode). Script syntax `Nama: kalimat` (case-insensitive names, `[tags]` purple, names coloured per
  speaker), a line without a name continues the previous speaker (before any name = "Narator"). Panel "Pembicara" (max 6):
  orb = personaOrb(voice, name), voicePicker, per-speaker tune modal ("Ikuti tuning global" or own stability/similarity/
  speed), rename/delete/add rewrite the script (native undo kept). Prefs in setting `studio.dialog` {cast:{key:{voiceId,tune}},
  pace}, draft in local `studio.dialog.draft`. Play = player.speak per line (who `dlg:<i>`, 2 lines prefetched) +
  `player.gap(ms)` (NEW in player.ts) with Cepat/Alami/Santai = 150/250/350 ms; active speaker orb live, others dimmed,
  stage caption, per-line progress, click a line = play from it. Unduh = POST /api/tts/dialogue (one mp3); the result
  player follows X-Line-Offsets. Auto tag = lib/autotag.ts autoTagLines (dialogue mode of /tts/autotag).
- Intro = guided 3D tour narrated by Strix (ui/intro.ts -> ui/intro/, see its README): hello (what this is, four labelled
  feature orbs) -> Chat / Text to Speech / Voice Changer / Voices as real mini panels (app markup + tokens, isolated in
  .tu-panel) flown through by a hand-made 3D camera (matrix3d per panel, rack-focus blur, parallax). One small real action
  each: /api/chat reply spoken with streaming TTS + Captions; /api/tts/autotag + /api/tts; before/after clips; voice sea
  a navigable voice map (ui/intro/map.ts: 24 distinct library voices, clusters, pan / pinch / zoom with parallax and depth of
  field, the centred ball speaks), add to a local tour-only collection.
  Quota/network failures -> static in-character clips. Skip this / Next per step; NO timer / auto-advance (one gentle
  "take your time" line per step after 25 s idle); outro "Start talking" -> the orb flies into the Chat orb
  (html.intro-reveal). Phone keyboard: compact layout, chat panel fitted to
  the visible area. Orbs are drawn on canvases at
  projected .tu-slot positions (always round). Static MP3s + tour.json in public/intro. Shown when setting onboarded !=
  true; replay from the account sheet ("Tur singkat"). Test hooks window.__tour(), window.__trailerOut.
- Jelly orbs (ui/orb.ts `jelly(el, {target, onTap, onDrag, onRelease})`, `splash()`, `ghostPull()`, test hook
  `jellyState()`): soft-body ring (24 radial springs + tension + area kept) + body centre spring + lagging content (slosh);
  finger angular velocity stirs, finger speed adds turbulence; the shape goes to the shader as 8 Fourier harmonics; the
  canvas is 1.9x the orb (`.orb.jelly`). Physics sleeps (exact rest state) when energy ~0; none under reduced motion.
  Used by the Chat orb (a light drag swallows the click; tap still works) and the Studio Bola preview.
- Brand: the built-in persona / voice name is ONE constant, `BRAND` in src/lib/brand.ts (now 'Strix'); persona.ts
  brandName() maps upstream names (stripe / strape / heeler) to it. The internal id stays 'stripe'.

## Chat full duplex + tools (server contract: ../server/CONTRACT-NOTES.md, server/decide.ts, llm.ts)
- `src/lib/duplex.ts` (pure, no DOM; unit tests were run with `node --test` from a scratch file): `DuplexMachine` = the ONE
  turn-taking state machine (idle / listening / thinking / speaking / ducked / interrupted). Events: mic, think, audible,
  quiet, voice (mic level >= 250 ms), partial / final (Scribe), decision, hush, typing, submit, stop, timeout. Effects:
  duck, unduck, decide, cut, cancel, send, heard, drop. Utterance ids reject stale async answers; a yield/stop for an older
  prefix still counts ("wait, wait, can..." -> yield). `isEcho()` (partial = the persona's own words near the audio
  position), `splitAtWord()` (cut point inside a tagged chunk), `fastDecide()` (stop words: no round trip),
  `localDecide()` (fallback). `src/lib/decide.ts` = `POST /api/chat/decide` (plain fetch, 2.5 s timeout, local fallback
  on 404 / error / quota).
- Chat (`screens/chat/index.ts`): menu toggle **Mode Percakapan** (`chat.prefs.convo`): one Scribe session stays open
  (`startStt({mode:'vad', continuous:true})` renews the socket with a fresh token at `maxSessionSec`), echo cancellation;
  pauses after 60 s of silence / tab hidden / STT quota (status line says why; tap the mic pill to resume). Partials
  without recent mic energy are ignored (transcriber hallucinations). Headphone hint banner (dismiss = `hpHint`).
  `player.duck()/unduck()/fadeStop(110)` (master GainNode). Cut point = caption reveal state (`caps.cut()` freezes the
  line; the unspoken rest fades); the assistant message gets `interrupted:{spokenText, unspokenText}` (content = spoken
  part). After a cut, the next turn asks /decide (state listening) for `resumeHint`; "Lanjutkan" button = resumeHint
  `continue` (continuation is appended to the interrupted message). Speech while still thinking cancels the reply and
  merges the words into the last user message. Text duplex: typing while it talks ducks, Enter interrupts, clear/blur
  restores. Push-to-talk (Mode off) still works; pressing the mic while it talks = stop with the cut point saved.
- Tools: SSE `{tool:{id,name,status,query?,sources?,ms?}}` -> `screens/chat/tools.ts` (generic by `name`; `TOOLS` table).
  Chip near the orb while running (orb gets a scanning arc, `data-tool`), "Dicari di web · N sumber" chip -> popover of
  links (`target=_blank rel=noopener noreferrer`), error/quota chip + toast, transcript lines + "Dicari di web" /
  "terpotong" tags. The intro sentence is flushed to TTS when the tool starts. Toggle "Cari di web" sends
  `tools:{web:false}`; hidden when `/me features.webSearch === false`. Account sheet shows quota `search`.
- Test hooks: `window.__duplex()` (state, trace, decisions, gain, cuts, sends, echo).

## Persona memory (server contract: ../server/CONTRACT-NOTES.md "Memory")
- `src/lib/memory.ts`: `commitMemory()` (plain fetch, never throws, `keepalive` for page hide), `getMemory / forgetMemory /
  forgetShared`, Indonesian wording (`moodText`, `agoText`). `streamChat` sends `memoryId: persona.id` on every call (the intro
  tour passes `memory:false`) and supports `opener:true` (-> `{noMemory}` = static greeting).
- Chat (`screens/chat/index.ts`): `ChatLog.mem` = messages already committed; `commitNow(reason)` sends only the rest (>= 2 user
  turns, or a hang-up). Triggers: hang-up verdict (at once), "Mulai percakapan baru" / "Mulai ulang" (commit, wait <= 9 s, then the
  persona opens with `opener`), persona switch and leaving the screen, 5 min idle, `pagehide`. An empty log opens with the opener
  (no user gesture yet: fetched silently and shown as a caption). "Mulai percakapan baru" no longer forgets anything: it only
  closes the local log. After a hang-up the end bar shows "X masih ingat percakapan tadi. Lihat".
- Sheet "Ingatan" (menu ⋮ and the persona row menu): last call + how it ended, mood now, summary, facts, news heard / passed on,
  privacy line, "Lupakan semuanya" (confirm) and "Lupakan kabar bersama". Deleting a custom persona also deletes its memory.
  Test hook `window.__memory()` (commit log, pending commits, `mem`).

## Group calls (server contract: ../server/CONTRACT-NOTES.md "Duo / group calls", ../SPEC-DUO.md)
- `#/duo` (`src/screens/duo/index.ts`, `duo.css`, `picker.ts`; route not a tab, tab bar hidden). Query: `call=strix,lena` (ring them in order),
  `with=<id>` (already on the line, from a solo Chat: its last 8 solo lines are context), `caller=<id>` (a persona placed the call).
- One room: orbs side by side (`.duo-slot`, created at `--big` px and scaled by `--k` per count; the speaking one scales up and pushes its
  neighbours with `--dx`), captions per reply block coloured by the speaker's orb (`--spk`, name in `data-who`), event lines ("X meninggalkan
  panggilan", "Memanggil X…"). Same DuplexMachine / decide / Captions / player / STT as Chat (Mode Percakapan, push-to-talk, text duplex, cut point
  `interrupted`). Audio strictly sequential (player queue); the next persona's turn is requested as soon as the current line has streamed.
- Silence: after ~7 s (12 s after a question to the user) the personas fill it (`nudge:'silence'`, max 2 in a row; server caps 4 persona turns).
- Ringing: `lib/duo.ts duoRing` + `lib/ringtone.ts` (WebAudio, 440+480 Hz, ducked while a voice speaks); the reaction plays with who `ring:<id>`.
- Leaving: a persona's `{end}` -> it is off the call at once (next turns), its orb fades away after its last line is heard; both gone -> end box.
  "Tinggalkan panggilan" commits every persona (reason `duo`, or `hangup` for one that left, `duo.with`) and flies the Chat persona's orb back.
- Orb hand-offs are keyed (`ui/transition.ts handOff(el, ttl, key)` / `receiveOrb(target, ms, key)`; `''` = the old single slot, `duo:<id>`).
- `player.setMuted()` (NEW): silence the output without stopping it (captions keep their clock).
- Chat: `streamChat({callable, callsMade, onCall})`; a `{call}` -> after the line is heard, `#/duo?with=<cur>&call=<target>&caller=<cur>`
  (`ChatLog.calls` counts it). Memory sheet shows missed calls and "dari panggilan bersama" news.
- Test hook `window.__duo()` (state, present, slots, log, stats: lat / turns / audio intervals / rings, `force(decision)`).

## Dev
```
cd v2 && PORT=3300 npx tsx --env-file=.env server/index.ts              # API (DEV_FAKE_LOGIN=1 in .env)
cd v2/web && API_ORIGIN=http://localhost:3300 npx vite --port 5300      # UI, proxies /api
# sign in: http://localhost:5300/api/auth/dev-login?email=admin@example.com&redirect=/
npm run typecheck   # (in web/)      npm run build -> web/dist (served by Fastify)
```
