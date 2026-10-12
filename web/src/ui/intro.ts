/* Intro / onboarding = the guided 3D tour narrated by Strix (ui/intro/tour.ts, see ui/intro/README.md): real mini panels
   of Chat / TTS / Voice Changer / Voices with one small, real action each; static narration MP3s + word timings from
   public/intro. This module stays the lazy entry point (main.ts on first visit, "Tur singkat" in the account sheet);
   the whole tour (code + CSS) is in this lazily loaded chunk.
   Finishing or skipping sets the `onboarded` setting (synced) and a localStorage flag. */
import { settings } from '../settings';
import { openTour } from './intro/tour';

export function markOnboarded(): void {
  settings.set('onboarded', true);
  try { localStorage.setItem('sm2.onboarded', '1'); } catch { /* private mode */ }
}
export const isOnboarded = (): boolean => settings.get<boolean>('onboarded', false) === true;

export function openIntro(opts: { onDone?: () => void } = {}): void {
  openTour({ onDone: () => { markOnboarded(); opts.onDone?.(); } });
}
