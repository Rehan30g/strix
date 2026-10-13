/* Compact audio player (play/pause, seek bar, time) for local blobs: recorded / uploaded audio and results.
   Only one plays at a time; starting one stops the shared TTS player. With `orb`, the play button is the voice's
   magic orb, animated by the real loudness of what plays (analyser on the blob audio, same-origin only).
   With `level` (a leveler key, e.g. the Voice Changer result 'vc:<voice id>') the audio is auto-leveled like the TTS
   player (lib/leveler.ts, "Samakan volume suara"); downloads / recordings / uploads play as they are. */
import { h, onDisconnect } from './dom';
import { svg } from '../icons';
import { player } from '../player';
import { fmtDur } from '../lib/recorder';
import { orb as makeOrb, type OrbSpec } from './orb';
import { Leveler, makeLimiter, onLevelingChange } from '../lib/leveler';

const all = new Set<HTMLAudioElement>();
export function pauseAllMini(): void { all.forEach((a) => a.pause()); }

/* one shared AudioContext for local playback levels */
let actx: AudioContext | null = null;
const analysers = new WeakMap<HTMLAudioElement, { an: AnalyserNode; buf: Uint8Array<ArrayBuffer>; lev: Leveler | null }>();
let lim: { input: GainNode; output: GainNode } | null = null;
const leveled = new Set<{ an: AnalyserNode; lev: Leveler }>();
onLevelingChange((on) => {
  for (const x of leveled) {
    x.lev.setEnabled(on);
    try { x.an.disconnect(); } catch { /* */ }
    x.an.connect(on && lim ? lim.input : actx!.destination);
  }
});
function analyse(a: HTMLAudioElement, level?: string): void {
  if (analysers.has(a) || !(a.src.startsWith('blob:') || a.src.startsWith(location.origin))) return;   // never cross-origin
  try {
    const AC: typeof AudioContext | undefined = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    actx ??= new AC();
    if (actx.state !== 'running') actx.resume().catch(() => {});
    const src = actx.createMediaElementSource(a);
    const an = actx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.5;
    let lev: Leveler | null = null;
    if (level) {
      lev = new Leveler(actx, src); lev.gain.connect(an);
      if (!lim) { lim = makeLimiter(actx); lim.output.connect(actx.destination); }
      an.connect(lev.enabled ? lim.input : actx.destination);
      leveled.add({ an, lev });
    } else { src.connect(an); an.connect(actx.destination); }
    analysers.set(a, { an, buf: new Uint8Array(512), lev });
  } catch { /* level stays 0 */ }
}
function levelOf(a: HTMLAudioElement): number {
  const x = analysers.get(a); if (!x || a.paused) return 0;
  x.an.getByteTimeDomainData(x.buf);
  let s = 0; for (let i = 0; i < x.buf.length; i++) { const v = (x.buf[i] - 128) / 128; s += v * v; }
  return Math.min(1, Math.sqrt(s / x.buf.length) * 3.4);
}

export interface MiniPlayer extends HTMLElement { audio: HTMLAudioElement; dispose(): void }

export function miniPlayer(src: Blob | string, opts: { label?: string; sub?: string; accent?: boolean; knownDuration?: number | null; orb?: OrbSpec; level?: string } = {}): MiniPlayer {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  const a = new Audio(); a.preload = 'metadata'; a.src = url;
  all.add(a);
  const ob = opts.orb ? makeOrb(opts.orb, { size: 48 }) : null;
  const icon = h('span', { class: 'mp-ic', html: svg('play') });
  const btn = h('button', { type: 'button', class: 'mp-btn' + (ob ? ' has-orb' : ''), 'aria-label': `Putar ${opts.label || 'audio'}` }, ob, icon);
  const range = h('input', { type: 'range', class: 'mp-range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Posisi' }) as HTMLInputElement;
  const time = h('span', { class: 'mp-time' }, '0:00');
  const head = opts.label ? h('div', { class: 'mp-head' }, h('b', null, opts.label), opts.sub ? h('span', null, opts.sub) : null) : null;
  const el = h('div', { class: 'mp' + (opts.accent ? ' accent' : '') + (ob ? ' with-orb' : '') }, btn, h('div', { class: 'mp-main' }, head, h('div', { class: 'mp-bar' }, range, time))) as unknown as MiniPlayer;
  el.audio = a;
  let dur = opts.knownDuration && Number.isFinite(opts.knownDuration) ? opts.knownDuration : 0;
  let seeking = false;
  const paint = () => {
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : dur;
    if (d) dur = d;
    if (!seeking) range.value = String(dur ? Math.round((a.currentTime / dur) * 1000) : 0);
    range.style.setProperty('--p', (Number(range.value) / 10) + '%');
    time.textContent = a.paused && a.currentTime === 0 ? fmtDur(dur) || '0:00' : `${fmtDur(a.currentTime)} / ${fmtDur(dur)}`;
    icon.innerHTML = svg(a.paused ? 'play' : 'pause');
    btn.setAttribute('aria-label', `${a.paused ? 'Putar' : 'Jeda'} ${opts.label || 'audio'}`);
    el.classList.toggle('playing', !a.paused);
    ob?.setLive(!a.paused, () => levelOf(a));
  };
  btn.onclick = () => {
    if (a.paused) {
      player.stop(); all.forEach((x) => { if (x !== a) x.pause(); });
      if (ob || opts.level) analyse(a, opts.level);
      const lv = analysers.get(a)?.lev;
      if (lv && a.currentTime < 0.05) lv.begin(opts.level!);   // a new listen from the start (a resume keeps its clip)
      a.play().catch(() => {});
    } else a.pause();
  };
  range.oninput = () => { seeking = true; range.style.setProperty('--p', (Number(range.value) / 10) + '%'); };
  range.onchange = () => { if (dur) a.currentTime = (Number(range.value) / 1000) * dur; seeking = false; paint(); };
  for (const ev of ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'durationchange']) a.addEventListener(ev, paint);
  a.addEventListener('ended', () => { analysers.get(a)?.lev?.end(); a.currentTime = 0; paint(); });
  const unP = player.on('change', () => { if (player.busy && !a.paused) a.pause(); });
  el.dispose = () => { a.pause(); analysers.get(a)?.lev?.end(); all.delete(a); unP(); ob?.setLive(false); if (typeof src !== 'string') URL.revokeObjectURL(url); };
  onDisconnect(el, () => el.dispose());
  paint();
  return el;
}
