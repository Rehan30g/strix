/* While the first-run notice and tour are showing, the app behind them stays hidden and quiet: no persona opener, no
   voice. Released when the tour is over (or when it turns out nobody needs it). */
let held = false;
let waiters: Array<() => void> = [];
export const isHeld = (): boolean => held;
export function hold(): void { held = true; document.documentElement.classList.add('intro-hold'); }
export function release(): void {
  held = false; document.documentElement.classList.remove('intro-hold');
  const w = waiters; waiters = []; w.forEach((f) => f());
}
export const whenReleased = (): Promise<void> => (held ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve());
