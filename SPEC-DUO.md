# Strix: duo call ("call over")

A call with BOTH built-in personas at once (Strix and Lena, exes who are enemies; backstory in `server/characters.ts`).
Not a phone UI: one shared room, two orbs side by side. Builds on the cross-conversation memory
(`persona_memory` and `shared_events`, see CONTRACT-NOTES "Memory") and on the duplex machinery of the Chat screen.

## Experience
- Entry: "Panggilan berdua" in the persona sheet (and `#/duo`). Starts with a short ring/connect beat, then both are "on the line".
- Screen: neutral stage, Strix's orb left and Lena's right, large, side by side; the speaking orb grows and nudges its neighbour; a small "you" indicator and mic.
  Captions above the orbs, coloured per speaker, revealed in sync with their speech (reuse `lib/captions.ts`). No phone frame, no chat bubbles.
  Controls: mic (hold / hands-free like Chat), text input, mute, "Tinggalkan panggilan". No scrub or technical UI.
- They talk to the user AND to each other. Left alone for a beat they bicker (the feud) and the user can step in, side with one, calm them down, or stir.
  Interrupt anytime (voice or typing); the cut speaker knows where they were cut off (existing `interrupted` context).
- Emotions are real: either can get angry, swear, and leave the call (their own end_call). If one leaves, the other stays and reacts; if both leave, the call ends.
  Outcomes follow how the user treats them: provocation can blow up; a genuinely gentle moment can make one soften or apologise first (never for flattery or pressure).
- Memory: both remember earlier solo chats and calls via the shared memory block; after the call each persona's memory and the shared events are updated (reason `duo`).

## Server (Fastify, SSE)
- `POST /api/duo/turn` (auth, active user, same-origin). Body (zod, strict limits):
  `{messages:[{role:'user'|'assistant', speaker?:'strix'|'lena', content, interrupted?:{spokenText,unspokenText}}] (last 40), present:['strix','lena'] (who is still on the call), opener?:boolean, resumeHint?}`.
- A small **director** (decision model, JSON, ~0.5 s, rules first, no LLM when obvious) picks the next speaker: `'strix' | 'lena' | 'user'`, with a one-line stage hint
  (who is addressed, who is provoked, whether to wait for the user). Constraints: never the same persona twice in a row unless the other left; at most 3 persona turns in a row
  before waiting for the user; waits for the user after a direct question to the user; if the user addressed one persona by name, that one answers first.
- Then it streams ONE persona's reply using that persona's own prompt (`characters.ts`) plus a DUO block: "you are on a three-way call with the user and <other>, here is the transcript with speaker names,
  talk to whoever you want, keep it short, you may react to what the other just said", plus the memory block. SSE events: `{speaker:'lena'}` first, then `{t}` deltas, `{end:{decision:'hangup',reason}}` (that persona leaves),
  and a final `{next:'strix'|'lena'|'user'}` so the client knows whether to request another turn or hand over to the user.
- Quotas: each persona reply counts as one LLM request; the director does not; a per-call cap (default 60 persona turns, env) and a no-user-input cap (4 chained turns) stop runaway loops.
  Web search is off in duo (keep it simple). TTS per speaker with its own voice via the existing `/api/tts` stream.
- Memory commit at the end (and on leave/idle): reuse `/api/memory/commit` per persona with the transcript filtered to what that persona heard; produce shared events.

## Client
- New screen `web/src/screens/duo/` reusing `player`, `captions`, `duplex`, `orb`, `stt`. A small state machine like Chat's: idle / user-speaking / persona-speaking(speaker) / thinking / ducked / interrupted.
- Sequential audio only (never two voices at once): sentence chunks queue per speaker; the next turn's generation overlaps with the current speech for low latency (start the next `/duo/turn` when the current reply finishes streaming, play when audio frees).
- Caption colours per speaker, `aria-live` transcript. Mobile first (390px: orbs stacked closer but still side by side, controls in thumb reach), desktop centred.
- Reduced motion and no-WebGL fallbacks like the rest of the app. Transitions: orbs fly in from the persona sheet; leaving flies the orbs back.

## Generalised (user decision, 2026-10-13): any personas, ringing, personas calling
- Participants are not hard-coded: built-ins or the user's own custom personas, max `DUO_MAX_PERSONAS` (3) besides the user. Strix <-> Lena keep
  their feud (backstory); every other pair only gets each other's short bio and starts as strangers ("you met before" after a remembered call).
- The user calls someone: from Chat ("Telepon…" in ⋮, "Telepon" in a persona's actions, "Panggilan berdua" in the persona sheet) and from the call
  ("Tambah orang"). From a solo chat with A, calling B turns it into A + B + user (A stays on the line, its recent solo lines are context).
- Ringing in the same room (not a phone UI): the callee's orb waits small at the side, pulsing / shaking, "memanggil…", a soft synthesized ring tone
  (WebAudio, muted with "Bisukan"), a "Batal" button. The callee reacts out loud BEFORE picking up (`POST /api/duo/ring`: one line in its voice and
  colour), then answers (its orb grows in and it greets in its mood), declines, or lets it ring. Weighted by relationship, remembered mood, who calls,
  retries and chance. Declined / unanswered calls are remembered by the callee; "Coba lagi" up to 3 times, then its phone is off for this call.
- Personas can ring someone themselves with the tool `call_persona` (chat and duo), rarely and in character, once per conversation; the call starts
  with that persona as the caller and the user stays on the line.
- Memory as above, plus missed calls and links (custom personas share news only with personas they have been on a call with).
  Contract: server/CONTRACT-NOTES.md "Duo / group calls".

## Verification
Real services; scripted multi-turn scenarios: (1) neutral user, they bicker and the user stays out for a beat, (2) user sides with one, (3) user provokes both, one hangs up and the other stays, (4) gentle path, (5) interruption mid-sentence and resume, (6) memory and shared events written and used in the next solo chat, (7) turn caps, (8) quota and abort. UI e2e in headless Edge at 390 and 1366 with fake mic audio, frames reviewed by eye.
