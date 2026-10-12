# Intro tour (ui/intro)

A guided 3D tour narrated by Strix, at the user's own pace. It shows what the app is, what it can do and how to use it, with real pieces of
the app's screens. `ui/intro.ts` is the lazy entry point: it runs on the first visit, and "Tur singkat" in the account
sheet replays it. Everything in this folder (JS and `tour.css`) ships in the lazy `intro-*.js/css` chunk.

| file | role |
|---|---|
| `tour.ts` | start (autoplay probe, else one "Take the tour" tap / Enter), steps, narration audio + captions, camera director, the four interactions, auto-advance, exit into Chat, test hook `window.__tour()` |
| `panels.ts` | the four panels: small copies of the real screens built from the app's own markup classes (`vx-*`, `tts-*`, `rec-*`, `mp`, `vp-btn`, `search-wrap`...) and tokens, isolated in `.tu-panel`; orbs are empty `.tu-slot`s |
| `cam.ts` | hand-made 3D camera: pinhole projection, a full `matrix3d` per panel, framing ("fit this rect"), flights (blend with a dolly-out / pedestal arc), point-in-quad for orb occlusion |
| `stage.ts` | orb canvas (WebGL, instanced dots, the real orb shader of `ui/orb.ts` patched for blur / alpha / colour wipe; Canvas 2D fallback; `probe()` roundness check). Two are used: background behind the panels, transparent orb layer in front |
| `kit.ts` | easing, spring, PRNG |
| `map.ts` | the Voices step: the voice map (data loading + mock, camera, input, HUD, previews, test hook `__tour().map()`) |

## Steps (at the user's pace: there is no timer)
1. **hello**: Strix, softly: "Oh— hey, I'm Strix. This is, umm... a place for voices. You can chat with me, turn
   writing into speech, swap your own voice, and, uh, collect new ones." Four feature orbs pop in on their words, with
   clean labels: Chat, Text to Speech, Voice Changer, Voices. Then she waits for Next.
2. **Chat**: the camera flies in (the Chat orb flies into the panel and turns into Strix's orb), pushes in while she
   explains, then frames the whole panel. Type, or tap "Hi Strix!" / "Tell me something weird" -> a real `/api/chat`
   reply (built-in persona `strix`), spoken with streaming `/api/tts` via the shared player, the app's own `Captions`
   (synced to the audio clock), the orb moving with the voice. On failure: the static "my voice is having a lie-down...
   but I did hear you" clip.
3. **Text to Speech**: the wand ("Make it expressive") -> real `/api/tts/autotag` (8 s timeout), tags painted purple;
   Play -> `/api/tts`. If either fails a static tagged sentence / clip is used.
4. **Voice Changer**: Before / After examples (static; the mic button only explains that recording is in the app).
5. **Voices**: a navigable VOICE MAP (`map.ts`) over the whole stage (the panel dissolves as the map dives in). 24
   distinct voices from `GET /api/voices/library/random?n=24&diverse=1` (one ball = one voice; ids and preview URLs are
   de-duplicated; on 404 a mock picks a diverse set from `/api/voices/library`, on any other failure the 10 static tour
   clips are used). Clusters by Language / Gender / Age / Accent (switchable; singles fold into "Other"). Real depth: a
   pinhole camera over the plane, balls at different depths (parallax while panning, dolly zoom, depth of field that
   racks to the focused ball, fog, dust specks). One finger / mouse drag = pan with inertia, pinch / ctrl+wheel / +/- =
   zoom, wheel = pan, arrows / + / - / Enter / A on the focused map, double tap = zoom to a ball, minimap (tap to fly).
   After a pan the nearest big ball glides to the middle; resting on it (0.45 s) focuses it and plays its preview (only
   after the user navigated, never over Strix). Tap = centre + hear; tap the focused ball again or "Add" = add to the local
   tour collection. One audio at a time; the speaking ball moves with the preview (analyser). Previews are warmed in the
   background (2 at a time, blob URLs) because the upstream proxy can take seconds. After Strix's line the camera glides
   through one voice of each of the 3 biggest clusters (cut at 2.8 s), then she invites the user.
6. **outro**: wide shot of the four panels (as the user left them) behind Strix: "And that's the tour, more or less...
   I'll be over in Chat." -> "Start talking". It waits; nothing enters the app by itself.

Every feature step has "Skip this" and "Next". There is no countdown, no progress ring and no auto-advance. After 25 s
without input Strix may say ONE gentle line per step ("No rush, by the way. Take your time." / "I'm not going
anywhere..." / "Whenever you're ready..."), with no visual indicator. Reactions come from small pools and never repeat in
one tour (after Next when the user did something: "Oh, that's... actually pretty good." / "Mm. See? Not so scary." /
"Okay, I'm a little bit impressed."; after Skip: "Fair enough. We'll leave that one." / "Yep, skipping. No judgement.";
plus one line each after tagging, after hearing both TTS versions, after Before + After, and after adding a voice).
Keys: Esc skip, Right arrow next, M sound.

## Strix's voice
The script follows the persona rules of `server/characters.ts`: warm, a bit awkward, dry, calm, understated; light
disfluency (umm, uh, "I mean—", trailing "..."), plain everyday Australian words used sparingly (heaps, reckon), no
stereotyped slang, few exclamation marks, every line opens differently. 1-2 audio tags per clip ([softly], [chuckles],
[hesitates], [exhales], [quietly], [dry]).
Voice settings were chosen by generating four variants of the same lines (stability 0.5 / 0.3, speed 1 / 0.95, with and
without an accent tag) and comparing the Scribe transcript (word error rate), speaking rate, pause share and pitch mean /
spread: the accent tag raised the pitch (brighter, "presenter" sound), so the clips use stability 0.3, similarity 0.75,
speed 0.95, no accent tag (calmest pitch, natural rate ~2.7 words/s, expressive spread, WER 0). Two lines that still came
out bright were rewritten and regenerated.

## Async rules (the Voices freeze)
Every scripted continuation is tied to a step token and every clip to a serial number. Before this, a narration
promise of the previous step (resolved when the user pressed Next) started the next step's flow (it compared the step
with itself), so channel surfing could start twice and overlap with the narration and a tapped voice; an AbortError of
an interrupted `play()` could also mark the NEW clip as silent. Now: a tap stops the surf (generation counter), the
tapped voice plays alone, then the invitation line once. The frame loop also catches and logs any error, so it can
never stop drawing. Regression test: start the surf, tap an orb in the middle, compare frames.

## Keyboard (phones)
When a tour input has focus and the visual viewport is >= 120 px shorter than the largest height seen at that width,
the tour switches to a compact layout: narration and top bar hidden, "Skip this" / "Next" small at the top, the chat panel
is resized to exactly the visible area (header folded, 64 px orb) and framed at scale ~1, so the input, the caption and
the orb stay readable above the keyboard. It returns to normal when the keyboard closes.

## Looks / rules
- Orbs are never DOM inside the tilted panels: each `.tu-slot` / crowd orb is projected and drawn on the front canvas, so
  every orb is a perfect circle (measured with `__tour().probe()`: second-moment elongation <= 0.5 %, bbox within 1 px).
- Panels move only with `transform` (matrix3d), `opacity`, `filter: blur()` (rack focus, 0.5 px steps) and `z-index`;
  at rest the camera stops, so text re-rasterises crisp. A push-in never lets a panel run below the panel area (it crops the top instead), so
  white panels never sit under the white caption. At most 3 panels are displayed (current + neighbours on desktop).
- Mobile keyboard: the stage shrinks to the visual viewport and hides narration / nav.
- Reduced motion: camera cuts instead of flights, still orbs, no word animation; interactions all work.

## Exit
Same match cut as before: Strix's orb flies into the Chat orb (`.vx-orb`, same spec / phase) while the stage
dissolves and the app rises in (`html.intro-reveal`, ~860 ms); 300 ms fade under reduced motion.
