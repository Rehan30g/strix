/* Custom voice orbs: settings key "orbs" = { [voiceId]: CustomOrb } (synced per user via /api/settings).
   Persona orbs live on the persona itself (CustomPersona.orb / built-in override .orb, see lib/persona.ts).
   Without a custom orb everything stays deterministic (ui/orb.ts). */
import { settings } from '../settings';
import { setVoiceOrbs, cleanOrb, type CustomOrb } from '../ui/orb';

settings.register<Record<string, CustomOrb>>('orbs', {});

/** Re-read the setting (call after login / user switch). */
export function refreshOrbs(): void { setVoiceOrbs(settings.get<Record<string, CustomOrb>>('orbs')); }

/** Save (or with null: remove) the custom orb of a voice. */
export function setVoiceOrb(voiceId: string, o: CustomOrb | null): void {
  const all = { ...(settings.get<Record<string, CustomOrb>>('orbs') || {}) };
  const c = o ? cleanOrb(o) : null;
  if (c) all[voiceId] = c; else delete all[voiceId];
  settings.set('orbs', all);
}

settings.subscribe('orbs', (v) => setVoiceOrbs(v));
refreshOrbs();
