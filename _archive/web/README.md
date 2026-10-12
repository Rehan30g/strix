# Archived web screens (not built)

Moved out of `web/src/` for the Lite scope (`../../SPEC-LITE.md`): `screens/coffee`, `screens/call`, `screens/chat`
(old roleplay), `screens/settings`, plus `lib/roleplay.ts` and copies of the old `routes.ts`, `shell.ts`, `api.ts`,
`styles/screens.css` (as `*.old.*`) and the Coffee-port notes.

To revive a screen: copy its folder back to `web/src/screens/`, add a route in `web/src/routes.ts`, and restore what it
uses from the `*.old.*` files (Coffee needs `api.llm` / `api.llmStream` from `api.old.ts` and the server's
`/api/llm`, see `../server/`; call/chat need `lib/roleplay.ts`; their CSS lives in `styles/screens.old.css`).
