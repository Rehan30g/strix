# web/ — notes for the Coffee agent port

The Coffee simulation (old `public/coffee.html`, `coffee-voice.js`, `coffee-phone.js/.css`, `coffee-settings.js`,
`coffee-icons.js`) goes into **`web/src/screens/coffee/`** only. Everything else in `web/` is shared infrastructure;
do not edit it from the Coffee port (if you need something, add it inside the coffee folder or note it here).

## Mount contract

```ts
// web/src/screens/coffee/index.ts  (route: #/coffee, default route, lazy-loaded)
import type { ScreenCtx } from '../../ctx';
export function mount(root: HTMLElement, ctx: ScreenCtx): () => void
```

- `root` is an empty `<div class="screen">` that fills the view (flex column, `min-height:0`). Put your own layout
  inside; for a scrolling page use `<div class="page"><div class="page-inner">…`.
- Return a cleanup function: abort LLM requests, `ctx.player.stop()`, stop mic, remove `window`/`document`
  listeners (e.g. the Esc handler of Preview mode), clear timers / rAF. The shell also calls `player.stop()` on
  every route change.
- Query params: `#/coffee?scenario=scam` → `ctx.route.params.get('scenario')`.
- CSS: import a stylesheet from the coffee folder (`import './coffee.css'`); Vite bundles it. Prefix every class
  (e.g. `.cf-…`) — global class names already in use include `.page`, `.stack`, `.row`, `.card`, `.btn`, `.field`,
  `.badge`, `.chip`, `.seg`, `.menu`, `.dlg`, `.drawer`, `.msg`, `.avatar`, `.brand`, `.empty`, `.tag`, `.dot`, `.meter`.
  Use the design tokens (`var(--surface)`, `--fg`, `--muted`, `--accent`, `--border`, `--ok`, `--bad`, `--warn`,
  `--tag`, `--coffee`, `--r-md`, `--shadow-2` …, see `src/styles/tokens.css`); dark mode is `:root[data-theme="dark"]`.
- No inline `<script>`, no CDNs (CSP `script-src 'self'`). No emoji in the UI: use `ctx.icons`.

## ctx (exact interface, see `src/ctx.ts`)

```ts
interface ScreenCtx {
  api: Api;            // src/api.ts
  player: Player;      // src/player.ts  (single shared <audio>)
  store: Store;        // src/store.ts   (app state: me, config, voices, characters, theme, route)
  icons: Icons;        // src/icons.ts
  settings: Settings;  // src/settings.ts (server-synced settings + per-user localStorage)
  data: { voices(force?): Promise<Voice[]>; config(): Promise<Config>; characters(): Promise<Character[]>; refreshMe(delayMs?): void };
  ui: { h, btn, renderTagged, avatar, toast, confirm, modal, drawer, popover, menuItem };
  speech: { hasSpeech(): boolean; listen(opts): Listening | null };   // Web Speech wrapper
  text: { chunker(onChunk, min=160, first=min); splitChunks(text, max=420): string[] };
  route: { name: string; path: string; params: URLSearchParams };
  navigate(path: string): void;                 // e.g. ctx.navigate('voices?clone=1')
  shell: { setTitle(t: string): void; setActions(nodes: Node[]): void; setChrome(visible: boolean): void };
}
```

### ctx.api
- `api.llm(body, signal?)` → POST `/api/llm` non-stream, returns OpenRouter JSON (`choices[0].message…`).
- `api.llmStream(body, onChunk, signal?)` → POST `/api/llm` with `stream:true`; `onChunk(json)` gets each parsed
  OpenRouter SSE chunk (`choices[0].delta.content`, `delta.tool_calls[]`, last chunk has `usage`). A mid-stream
  failure arrives as a chunk `{error:{message}}` — check for it. `[DONE]` ends the promise.
- Whitelisted body fields: `model, messages, tools, tool_choice, temperature, max_tokens(<=4000), reasoning, provider, stream`.
  Message keys kept: `role, content, name, tool_calls, tool_call_id, reasoning, reasoning_details`.
- Errors throw `ApiError {status, code, message, data}`; `code === 'aborted'` when you aborted. 401/403/429 are
  already handled globally (login / redeem / suspended screens, quota toast) — just stop your loop and show a line.
- Also: `api.get/post/put/del(path, body?)`, `api.raw(path, init)` (Response), `api.sse(path, body, {signal,onEvent})`,
  `api.tts(body, signal)` (raw audio Response — normally use the player instead).
- The default model is `(await ctx.data.config()).defaultModel`; user's override is `ctx.settings.prefs().model` ('' = default).

### ctx.player (replaces the old `P` / `window.CV` audio parts)
| old coffee-voice.js | new |
|---|---|
| `speakChunk(text, voiceId, fx, who, call, meta)` | `player.speak(text, { voiceId, fx, who, call, meta, model?, tune?, onStart?, onEnd?(completed) })` → Promise (never rejects) |
| `stopAudio()` | `player.stop()` (aborts in-flight TTS fetches, bumps `player.generation`) |
| `P.pending` | `player.pending` (`player.busy` also counts preview URLs) |
| `P.who`, `P.call` | `player.speaker`, `player.inCall` |
| `P.err` | `player.err` + `player.on('error', fn)` |
| `waitSpeech(maxMs)` | `player.waitIdle(maxMs)` |
| `speechNow()` | `player.speechNow()` → `{sid, kind, who, a, b, p}` (same semantics) |
| `level()` | `player.level()` → `{who, call, amp, freq}` |
| `warm()`, `initFx()`, `setFx(on)` | `player.warm()`, `player.initFx()`, `player.setFx(on)` (speak() calls these itself) |
| `st.fxLevel` | `player.fxLevel = 'light' \| 'medium' \| 'strong'` |
| `st.player` (`stream/full/simple`) | `player.mode = 'stream' \| 'full' \| 'simple'` |
| `REV.off[sid] = meta.b` after a chunk | do it in `onEnd(completed)` of that chunk |
| `paint()` on every state change | `player.on('change', fn)` (returns unsubscribe) |
| `lineNoise()`, `fxLog`, `_ctx()` | `player.lineNoise()`, `player.fxLog`, `player.ctxState()` |
| play an URL/Blob | `player.playUrl(urlOrBlob)` |

Tune defaults come from `settings.tune()` (shared with the rest of the app; shape
`{stability, similarity, style, speed, speakerBoost}` — note `speakerBoost`, not v1's `boost`). The model comes from
`settings.prefs().ttsModel` ('' = server default) if you pass it as `model`. TTS text max 2000 chars per request.
Voice ids: the user may only use premade/library voices from `/api/voices`, their own clones, or the built-in
character voices; anything else → 403 `voice_forbidden`. The old PRESETS (Adam/Rachel/Antoni/Bella) are premade.

### ctx.settings (replaces localStorage `cv.settings`, `cf.settings`, `sm2.settings`)
- `settings.register('coffee.cv', DEFAULTS)` once, then `settings.get('coffee.cv')` (sync, merged over defaults),
  `settings.set(key, value)` / `settings.patch(key, partial)` → localStorage now + debounced `PUT /api/settings/:key`.
  Keys: `[A-Za-z0-9_.-]{1,64}`, value ≤ 64 KB, ≤ 100 keys/user — use a few namespaced keys, e.g. `coffee.cv`
  (voice layer) and `coffee.form` (the old settings dialog, store only values that differ from defaults).
- `settings.subscribe(key, fn)` → unsubscribe. Keys other than `prefs`/`tune` are pulled from the server on login
  (bulk `GET /api/settings`), so `get()` is ready when the screen mounts.
- `settings.local.get(key, fallback)` / `.set` / `.remove` — per-user localStorage only (never synced), for bulky
  data like run history.
- Shared: `settings.prefs()` → `{theme, model, thinking, ttsModel, accent, lang:'en'|'id', sttLang, voiceId,
  audioTags, autoSpeak, handsFree, showTags, names}`; `settings.tune()`.

### ctx.icons
`icons.svg(name, cls?)` → `<svg class="ic">` string; `icons.el(name)` → element; `icons.apply(root)` fills
`[data-ic]`; **`icons.IC` is a drop-in for the old `window.IC`** (all names from coffee-icons.js exist:
mic, speaker, speakerOff, phone, cup, wallet, card, list, send, alert, receipt, help, bank, gear, flame, headset,
smartphone, eye, plus, x, flag, sparkle) plus ~60 more (`icons.names`), e.g. phoneOff, play, pause, stop, user,
users, chat, sliders, clock, refresh, check, copy, trash, arrowUp, chevronDown, moreV, bolt, shield.

### ctx.ui
`h(tag, attrs, ...children)` (on* attrs become listeners, `html`/`text`/`class`/`style`/`dataset`), `btn({label, icon,
cls:'primary|soft|ghost|danger|sm|icon', onClick})`, `toast(msg, {kind:'info'|'ok'|'warn'|'bad'})`,
`confirm({title, message, danger}) → Promise<boolean>` (replaces `confirm()`), `modal({title, body, actions})`,
`drawer({title, body})` (right-side panel, good for the settings dialog), `popover(anchor, content)`, `menuItem(...)`,
`renderTagged(el, text, {hideTags})` (shows `[tags]` styled or hides them), `avatar(name, picture)`.

### ctx.speech
`speech.listen({lang:'en-US'|'id-ID', onText(t, isFinal), onEnd(finalText), onError(code, msg)})` → `{stop, abort}`
or null. Replaces the `SR` code in coffee-voice.js (`micLang()` = `settings.prefs().lang === 'id' ? 'id-ID' : 'en-US'`).

### ctx.shell
`setTitle('Coffee Agent')`, `setActions([...buttons])` for top-bar controls (e.g. Free / Super / Jadi Coffee pills,
settings button), `setChrome(false)` hides rail/top bar/bottom bar for **Preview mode**; call `setChrome(true)` on
Esc and in cleanup.

## Dev
```
cd v2/web && npm install && npm run dev        # Vite on :5173, proxies /api to API_ORIGIN (default http://localhost:3000)
cd v2 && npm run dev:server                    # Fastify on :3000 (DEV_FAKE_LOGIN=1 in v2/.env)
# sign in: http://localhost:5173/api/auth/dev-login?email=admin@example.com&redirect=/
npm run typecheck   # (in web/)    npm run build -> web/dist (served by Fastify in prod)
```
In dev builds `window.__sm = {api, store, settings, player}` exists for debugging/tests.
