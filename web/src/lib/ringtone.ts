/* A soft synthesized ringing tone for the group call (no audio asset): two mixed sines (440 + 480 Hz, the classic
   ring-back), 1.0 s on / 1.4 s off, low volume with gentle attack and release. Its own small AudioContext (so it never
   touches the TTS player graph). duck() lowers it while a voice speaks; muted() silences it; stop() ends it. */
const RING_ON = 1.0, RING_CYCLE = 2.4;
export const RING_MS = RING_CYCLE * 1000;

export interface Ringtone { stop(): void; duck(on: boolean): void; setMuted(on: boolean): void; readonly rings: () => number }

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  const AC: typeof AudioContext | undefined = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  try { ctx ??= new AC(); if (ctx.state !== 'running') void ctx.resume().catch(() => {}); return ctx; } catch { return null; }
}

/** Start ringing now. `level` 0..1 (default .06). */
export function startRing(o: { muted?: boolean; level?: number } = {}): Ringtone {
  const a = audio();
  const t0 = performance.now();
  let muted = !!o.muted, ducked = false, stopped = false;
  const level = o.level ?? 0.06;
  if (!a) return { stop() {}, duck() {}, setMuted() {}, rings: () => Math.floor((performance.now() - t0) / RING_MS) };
  const out = a.createGain(); out.gain.value = muted ? 0 : 1; out.connect(a.destination);
  const env = a.createGain(); env.gain.value = 0; env.connect(out);
  const oscs = [440, 480].map((f) => { const o2 = a.createOscillator(); o2.type = 'sine'; o2.frequency.value = f; o2.connect(env); o2.start(); return o2; });
  // schedule ring bursts a few cycles ahead, re-scheduled on a timer
  let next = a.currentTime + 0.05;
  const plan = () => {
    if (stopped) return;
    while (next < a.currentTime + 6) {
      const g = env.gain;
      g.setValueAtTime(0, next);
      g.linearRampToValueAtTime(level, next + 0.04);
      g.setValueAtTime(level, next + RING_ON - 0.08);
      g.linearRampToValueAtTime(0, next + RING_ON);
      next += RING_CYCLE;
    }
  };
  plan();
  const timer = setInterval(plan, 2000);
  const apply = () => { const t = a.currentTime; out.gain.cancelScheduledValues(t); out.gain.setTargetAtTime(muted ? 0 : ducked ? 0.3 : 1, t, 0.05); };
  return {
    stop() {
      if (stopped) return; stopped = true; clearInterval(timer);
      const t = a.currentTime;
      out.gain.cancelScheduledValues(t); out.gain.setTargetAtTime(0, t, 0.03);
      setTimeout(() => { oscs.forEach((x) => { try { x.stop(); x.disconnect(); } catch { /* gone */ } }); env.disconnect(); out.disconnect(); }, 200);
    },
    duck(on) { ducked = on; apply(); },
    setMuted(on) { muted = on; apply(); },
    rings: () => Math.floor((performance.now() - t0) / RING_MS),
  };
}
