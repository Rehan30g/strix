# UI translations

Indonesian is the source language and the default. English (US) lives in `en.json`
as a flat map `{ "<Indonesian text>": "<English text>" }`. The guided tour (`ui/intro/*`) is written
in English directly and is not part of this.

## Adding or changing a string

1. Wrap it in `t()` with the Indonesian text as the key:
   ```ts
   import { t } from '../i18n';
   h('button', null, t('Mulai percakapan baru'));
   toast(t('Kuota {kind} habis. Direset {when}.', { kind, when }));
   ```
   The first argument must be **one plain literal** (`'..'`, `".."`, or `` `..` `` without `${}`).
   No concatenation, no variables, no `${}`. Use `{name}` placeholders and pass values as the second argument.
   For a map of messages, call `t()` on each value (`{ code: t('...') }`). `t()` at module scope is fine,
   because the English table loads before any module that imports `i18n.ts` runs.
2. `node scripts/i18n.mjs todo` writes `todo.json` with every key that has no English yet.
3. Fill in the English values in `todo.json`.
4. `node scripts/i18n.mjs merge` moves the filled entries into `en.json` (sorted, placeholders checked).
5. `node scripts/i18n.mjs check --strict` must pass (no missing keys, no placeholder mismatches,
   no empty values, no dynamic `t()` calls). It also lists unused keys you can delete.

If you change the Indonesian text, the key changes too: run `todo` again and translate the new key.
A missing English entry falls back to Indonesian (and logs `i18n missing` once in dev).

## Rules

- **Placeholders**: `{name}`, the same set in the key and the value (the order can change).
- **Plurals**: Indonesian has none. When English needs one, write two keys and pick in code:
  `n === 1 ? t('1 jam lalu') : t('{n} jam lalu', { n })`.
- **Numbers and dates**: never hard-code `'id-ID'`. Use `locale()` from `i18n.ts`
  (or `fmtNum` / `fmtDate` / `relTime` in `ui/dom.ts`).
- Names stay as they are: Strix, ElevenLabs, Voice Library, Google, GitHub, OpenRouter.
- Tone: short, friendly, plain US English (it's a closed test of a voice app). Sentence case for buttons and titles.
- Language switching reloads the page (`setLang`), so nothing has to re-render live.

## Glossary

| Indonesian | English |
| --- | --- |
| Pesan | Messages |
| Kuota | Quota |
| Persona | Persona |
| Panggilan | Call |
| Suara | Voice |
| Ingatan | Memories |
| Voice Changer | Voice Changer |
| Voice Library | Voice Library |
| Clone suara | Voice clone |
| Undangan / kode undangan | Invite / invite code |
| Pengundang / orang yang mengundangmu | Host / whoever invited you |
| Tur | Tour |
| Teks ke Suara | Text to Speech |
| Uji coba (tertutup) | (Closed) test |
| Koleksi | Collection |
| Masuk / Keluar | Sign in / Sign out |
