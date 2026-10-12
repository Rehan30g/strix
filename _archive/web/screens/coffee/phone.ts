/* Phone mode + Preview mode (port of coffee-phone.js).
   - Phone mode: a phone call screen (contact name, clock, call timer, waveform of the other party, orb of the agent).
     The phone is drawn on a 390x844 canvas (+11px bezel) and scaled to fit, so proportions are always exact.
   - Preview mode: only a big minimal input; the phone slides in from off-screen while the agent is on a call and leaves
     when the agent hangs up (end_call). Shell chrome hidden (ctx.shell.setChrome(false)); Esc exits.
   - Agent text is typed in sync with its voice (words appear one by one, blue blur-in). */
import type { ScreenCtx } from '../../ctx';
import type { Rev } from './voice';
import { mmss } from './util';

export interface PhoneCfg { on: boolean; wp: number; preview: boolean }
export interface CallView { live: boolean; connected: boolean; ringing: boolean; t0?: number; sessionId: number | null; name: string; number: string; icon: string }

export function createPhone(o: {
  ctx: ScreenCtx; app: HTMLElement; thread: HTMLElement; chat: HTMLElement; rev: Rev;
  cfg: () => PhoneCfg; saveCfg: (p: Partial<PhoneCfg>) => void;
  follow: () => boolean; voiceOn: () => boolean; sessionKey: () => string; sessionMsgs: () => number;
  onMic: () => void; onVoice: () => void; onEnd: () => void; onApply: () => void;
}) {
  const { ctx, app, thread } = o;
  const IC = ctx.icons.IC, player = ctx.player;
  const el = document.createElement('aside');
  el.className = 'cf-phone';
  el.setAttribute('aria-label', 'Layar telepon (simulasi)');
  el.innerHTML = `
    <div class="cf-phone-fit">
      <div class="cf-device" data-wp="0">
        <div class="cf-wall"></div>
        <div class="cf-screen">
          <button class="cf-island" title="Ganti wallpaper" aria-label="Ganti wallpaper"></button>
          <div class="cf-statusbar">
            <span class="cf-clock">9:41</span>
            <span class="cf-stat-r">
              <svg viewBox="0 0 18 11" aria-hidden="true"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="6" rx="1"/><rect x="10" y="2.5" width="3" height="8.5" rx="1"/><rect x="15" y="0" width="3" height="11" rx="1"/></svg>
              <svg viewBox="0 0 27 12" aria-hidden="true"><rect x=".5" y=".5" width="22" height="11" rx="3.2" fill="none" stroke="#fff" stroke-opacity=".6"/><rect x="2" y="2" width="17" height="8" rx="2"/><rect x="24" y="4" width="2.2" height="4" rx="1" fill-opacity=".6"/></svg>
            </span>
          </div>
          <div class="cf-avatar2">${IC.cup}</div>
          <div class="cf-callname"></div>
          <div class="cf-callnum"></div>
          <div class="cf-calltimer">00:00</div>
          <div class="cf-simtag">SIMULASI · bukan panggilan sungguhan</div>
          <div class="cf-wavebox"><canvas class="cf-wave"></canvas></div>
          <div class="cf-grow"></div>
          <div class="cf-orbwrap"><div class="cf-orb"></div></div>
          <div class="cf-callbtns">
            <button class="cf-cb" data-act="mic" title="Bicara" aria-label="Bicara">${IC.mic}</button>
            <button class="cf-cb" data-act="voice" title="Suara nyala/mati" aria-label="Suara nyala/mati">${IC.speaker}</button>
            <button class="cf-cb cf-cb-end" data-act="end" title="Tutup telepon (stop)" aria-label="Tutup telepon">${IC.phone}</button>
          </div>
        </div>
      </div>
    </div>`;
  const fitEl = el.querySelector<HTMLElement>('.cf-phone-fit')!;
  const device = el.querySelector<HTMLElement>('.cf-device')!;
  const nameEl = el.querySelector<HTMLElement>('.cf-callname')!, numEl = el.querySelector<HTMLElement>('.cf-callnum')!;
  const timerEl = el.querySelector<HTMLElement>('.cf-calltimer')!, clockEl = el.querySelector<HTMLElement>('.cf-clock')!;
  const avatarEl = el.querySelector<HTMLElement>('.cf-avatar2')!;
  const canvas = el.querySelector<HTMLCanvasElement>('canvas')!, g = canvas.getContext('2d')!;
  const orb = el.querySelector<HTMLElement>('.cf-orb')!;
  const voiceBtn = el.querySelector<HTMLElement>('[data-act="voice"]')!;
  /* compact call bar for narrow screens (the phone itself is hidden there) */
  const callbar = document.createElement('div');
  callbar.className = 'cf-callbar';
  callbar.setAttribute('role', 'status');
  callbar.innerHTML = `<span class="cf-cbar-ic">${IC.cup}</span><span class="cf-cbar-meta"><b></b><small></small></span><span class="cf-cbar-sim">simulasi</span><span class="cf-cbar-t">00:00</span><button class="cf-cbar-end" type="button" title="Tutup telepon (stop)" aria-label="Tutup telepon">${IC.phone}</button>`;
  callbar.querySelector<HTMLElement>('.cf-cbar-end')!.onclick = () => o.onEnd();
  const cbName = callbar.querySelector<HTMLElement>('b')!, cbNum = callbar.querySelector<HTMLElement>('small')!;
  const cbTime = callbar.querySelector<HTMLElement>('.cf-cbar-t')!, cbIc = callbar.querySelector<HTMLElement>('.cf-cbar-ic')!;

  /* ---------- size: 390x844 canvas (+11px bezel) scaled to fit ---------- */
  const BW = 412, BH = 866;
  function fitPhone() {
    let k: number;
    if (o.cfg().preview) k = (window.innerHeight - 40) / BH;
    else { const r = el.getBoundingClientRect(); k = Math.min((r.height - 24) / BH, (r.width - 24) / BW); }
    if (!Number.isFinite(k) || k <= 0) k = 1;
    k = Math.max(0.3, Math.min(1, k));
    fitEl.style.setProperty('--k', k.toFixed(4));
    app.style.setProperty('--pw', (BW * k).toFixed(1) + 'px');
    fitCanvas();
  }
  function fitCanvas() {
    const d = window.devicePixelRatio || 1, k = parseFloat(fitEl.style.getPropertyValue('--k')) || 1;
    const w = canvas.offsetWidth, h = canvas.offsetHeight;
    if (w) { canvas.width = Math.max(64, Math.round(w * k * d)); canvas.height = Math.max(16, Math.round(h * k * d)); }
  }
  const ro = new ResizeObserver(fitPhone); ro.observe(el);
  addEventListener('resize', fitPhone);

  /* ---------- status bar clock + call timer ---------- */
  let callStart: number | null = null, lastDur: number | null = null, callSid: number | null = null;
  function tickClock() {
    const d = new Date();
    clockEl.textContent = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    if (callStart) { timerEl.textContent = mmss(Date.now() - callStart); timerEl.className = 'cf-calltimer cf-live'; }
    else if (lastDur != null) { timerEl.textContent = mmss(lastDur); timerEl.className = 'cf-calltimer cf-ended'; }
    else { timerEl.textContent = '00:00'; timerEl.className = 'cf-calltimer'; }
    cbTime.textContent = app.classList.contains('cf-ringing') ? 'berdering…' : timerEl.textContent;
  }
  const clockT = setInterval(tickClock, 250); tickClock();

  /** Called at the end of every render(). The phone stays visible while the call is live (also during ask_user);
      it leaves when the agent hangs up, the run is stopped, or the session ends. */
  let lastIcon = 'cup';
  function sync(v: CallView | null) {
    app.classList.toggle('cf-has-session', !!v);
    if ((v?.sessionId ?? null) !== callSid) { callSid = v?.sessionId ?? null; callStart = null; lastDur = null; }
    const live = !!v?.live;
    app.classList.toggle('cf-call-on', live);
    app.classList.toggle('cf-ringing', !!v?.ringing);
    if (v) {
      if (nameEl.textContent !== v.name) nameEl.textContent = v.name;
      numEl.textContent = v.number;
      if (v.icon !== lastIcon) { lastIcon = v.icon; avatarEl.innerHTML = IC[v.icon] || IC.user; cbIc.innerHTML = IC[v.icon] || IC.user; }
      cbName.textContent = v.name; cbNum.textContent = v.number;
    }
    if (live && v!.connected && !callStart) { callStart = v!.t0 || Date.now(); lastDur = null; }   // timer starts after pick-up
    if (!live && callStart) { lastDur = Date.now() - callStart; callStart = null; }
  }
  function setIdleName(name: string) { if (!app.classList.contains('cf-call-on')) { nameEl.textContent = name; numEl.textContent = ''; } }

  /* ---------- ring tone (Web Audio, ~2.9 s) then "picked up" ---------- */
  let rctx: AudioContext | null = null;
  function ringTone() {
    try {
      const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      rctx = rctx || new AC();
      if (rctx.state !== 'running') rctx.resume();
      const t0 = rctx.currentTime, gn = rctx.createGain();
      gn.gain.value = 0; gn.connect(rctx.destination);
      const o1 = rctx.createOscillator(), o2 = rctx.createOscillator();
      o1.frequency.value = 440; o2.frequency.value = 480; o1.connect(gn); o2.connect(gn); o1.start(t0); o2.start(t0);
      const burst = (a: number, b: number) => { gn.gain.setValueAtTime(0, t0 + a); gn.gain.linearRampToValueAtTime(0.07, t0 + a + 0.03); gn.gain.setValueAtTime(0.07, t0 + b - 0.03); gn.gain.linearRampToValueAtTime(0, t0 + b); };
      burst(0.1, 1.2); burst(1.7, 2.8);
      o1.stop(t0 + 2.9); o2.stop(t0 + 2.9);
      const c = rctx.createOscillator(), cg = rctx.createGain();        // "pick-up" click
      c.frequency.value = 1300; cg.gain.setValueAtTime(0.05, t0 + 2.86); cg.gain.linearRampToValueAtTime(0, t0 + 2.9);
      c.connect(cg); cg.connect(rctx.destination); c.start(t0 + 2.86); c.stop(t0 + 2.9);
    } catch { /* no audio */ }
  }
  /** Test hook: speed factor for the ring wait (window.__coffeeRingMs). */
  async function ring() { player.initFx(); player.warm(); ringTone(); await new Promise((r) => setTimeout(r, (window as any).__coffeeRingMs ?? 2900)); }

  /* ---------- Phone / Preview mode ---------- */
  function apply() {
    const c = o.cfg();
    app.classList.toggle('cf-preview', c.preview);
    app.classList.toggle('cf-phone-mode', c.on || c.preview);
    ctx.shell.setChrome(!c.preview);
    device.dataset.wp = String(c.wp);
    fitPhone();
    o.onApply();
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (document.querySelector('.dlg-scrim, .drawer')) return;      // a dialog handles its own Esc
      if (o.cfg().preview) { o.saveCfg({ preview: false }); apply(); }
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'p') {
      e.preventDefault(); o.saveCfg({ preview: !o.cfg().preview }); apply();
    }
  };
  document.addEventListener('keydown', onKey);
  el.querySelector<HTMLElement>('.cf-island')!.onclick = () => { o.saveCfg({ wp: (o.cfg().wp + 1) % 4 }); apply(); };
  el.querySelector<HTMLElement>('[data-act="mic"]')!.onclick = () => o.onMic();
  voiceBtn.onclick = () => o.onVoice();
  el.querySelector<HTMLElement>('[data-act="end"]')!.onclick = () => o.onEnd();

  /* ---------- enter animations, count-up, auto-scroll ---------- */
  const seen = new Set<string>();
  const SEL = '.cf-row-user,.cf-row-ai,.cf-cmsg,.cf-tool,.cf-endcard,.cf-inv-chip,.cf-struk,.cf-tx,.cf-humanturn';
  let lastKey = '__none__', prime = false;
  const fmtRp = (n: number) => (n < 0 ? '-' : '') + 'Rp' + Math.abs(Math.round(n)).toLocaleString('id-ID');
  function countUp(x: HTMLElement) {
    const to = +(x.dataset.to || 0), t0 = performance.now(), dur = 1100;
    const step = (n: number) => {
      const p = Math.min(1, (n - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      x.textContent = fmtRp(to * e);
      if (p < 1 && x.isConnected) requestAnimationFrame(step); else x.textContent = fmtRp(to);
    };
    step(t0);
  }
  function autoScroll(list: HTMLElement, animate: boolean) {
    if (!animate) { list.scrollTop = list.scrollHeight; return; }
    list.scrollTop = 0;
    const delay = 300 + Math.min(list.children.length, 8) * 90;
    setTimeout(() => {
      const to = list.scrollHeight - list.clientHeight;
      if (to <= 0 || !list.isConnected) return;
      const t0 = performance.now(), dur = Math.min(1700, 500 + to * 5);
      const st = (n: number) => {
        const p = Math.min(1, (n - t0) / dur);
        list.scrollTop = to * (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
        if (p < 1 && list.isConnected) requestAnimationFrame(st);
      };
      requestAnimationFrame(st);
    }, delay);
  }
  function mark() {
    const key = o.sessionKey();
    if (key !== lastKey) { seen.clear(); lastKey = key; prime = o.sessionMsgs() > 2; }   // opening an old session: no animation
    const counts: Record<string, number> = {};
    for (const x of thread.querySelectorAll<HTMLElement>(SEL)) {
      const k0 = [...x.classList].find((c) => c !== 'cf-enter') || x.tagName;
      counts[k0] = (counts[k0] || 0) + 1;
      // text typed progressively keeps changing: the key only uses text that is certain to exist
      const k = k0 + '#' + counts[k0] + ':' + (x.textContent || '').replace(/\s+/g, ' ').trim().slice(0, k0 === 'cf-row-ai' ? 0 : 70);
      const fresh = !seen.has(k);
      seen.add(k);
      if (fresh && !prime && !x.parentElement?.closest('.cf-enter')) x.classList.add('cf-enter');
    }
    prime = false;
    thread.querySelectorAll<HTMLElement>('.cf-count[data-to]').forEach((x) => { if (x.closest('.cf-enter')) countUp(x); });
    thread.querySelectorAll<HTMLElement>('.cf-txlist[data-autoscroll]').forEach((l) => autoScroll(l, !!l.closest('.cf-enter')));
  }
  const mo = new MutationObserver(mark); mo.observe(thread, { childList: true });

  /* ---------- waveform of the other party + orb of the agent + synced typing ---------- */
  const N = 40, bars = new Float32Array(N);
  let amp = 0, ampA = 0, raf = 0, voiceOff: boolean | null = null;
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const L = player.level();
    const t = now / 1000;
    // reveal words whose position was passed by the voice (blur-in)
    const sp = player.speechNow();
    if (sp && sp.kind !== 'chat' && sp.sid) {
      const target = sp.a + sp.p * (sp.b - sp.a);
      o.rev.off[sp.sid] = Math.max(o.rev.off[sp.sid] || 0, target);
    }
    let revealed = 0;
    thread.querySelectorAll<HTMLElement>('.cf-w:not(.cf-on):not(.cf-done)').forEach((w) => {
      const sid = w.closest<HTMLElement>('[data-sid]')?.dataset.sid;
      if (sid && (o.rev.done.has(sid) || +(w.dataset.o || 0) < (o.rev.off[sid] || 0))) { w.classList.add('cf-on'); revealed++; }
    });
    if (revealed && o.follow()) o.chat.scrollTop = o.chat.scrollHeight;
    // small AI icon in the chat = mini orb (moves only while the agent speaks to the user, not on the phone)
    ampA += ((L.who === 'agent' && !L.call ? L.amp : 0) - ampA) * 0.3;
    const avs = thread.querySelectorAll<HTMLElement>('.cf-row-ai > .cf-av');
    if (avs.length) {
      const av = avs[avs.length - 1];
      av.style.transform = `scale(${(1 + ampA * 0.5 + 0.045 * Math.sin(t * 2)).toFixed(3)})`;
      av.style.setProperty('--g', ampA.toFixed(3));
    }
    const off = !o.voiceOn();
    if (off !== voiceOff) { voiceOff = off; voiceBtn.innerHTML = off ? IC.speakerOff : IC.speaker; voiceBtn.classList.toggle('cf-off', off); }
    if (!app.classList.contains('cf-phone-mode') || !el.offsetWidth) return;
    const w = canvas.width, h = canvas.height;
    if (!w || w <= 64) { fitCanvas(); if (!canvas.width) return; }
    g.clearRect(0, 0, w, h);
    const slot = w / N, bw = Math.max(2, slot * 0.55);
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,.95)'); grad.addColorStop(1, 'rgba(255,255,255,.55)');
    g.fillStyle = grad;
    for (let i = 0; i < N; i++) {
      let target: number;
      if (L.who && L.who !== 'agent' && L.freq) {
        const v = L.freq[1 + Math.floor(i * 1.5)] / 255;                     // low-mid bins = human voice
        target = Math.min(1, Math.pow(v, 1.25) * (0.75 + 0.5 * Math.sin(i * 0.5 + t * 6) * 0.2 + 0.25));
      } else target = 0.05 + 0.035 * Math.sin(t * 2.2 + i * 0.55);          // silent: thin wavy line
      bars[i] += (target - bars[i]) * 0.38;
      const bh = Math.max(h * 0.03, bars[i] * h * 0.88), x = i * slot + (slot - bw) / 2, y = (h - bh) / 2;
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, bw, bh, bw / 2); else g.rect(x, y, bw, bh);
      g.fill();
    }
    // big orb: moves only while the agent talks inside the call
    amp += ((L.who === 'agent' && L.call ? L.amp : 0) - amp) * 0.3;
    orb.style.transform = `scale(${(1 + amp * 0.75 + 0.022 * Math.sin(t * 1.6)).toFixed(3)})`;
    orb.style.setProperty('--g', amp.toFixed(3));
  }
  raf = requestAnimationFrame(frame);

  return {
    el, callbar, sync, ring, apply, setIdleName, mark,
    destroy() {
      cancelAnimationFrame(raf); clearInterval(clockT); ro.disconnect(); mo.disconnect();
      removeEventListener('resize', fitPhone); document.removeEventListener('keydown', onKey);
      try { rctx?.close(); } catch { /* ignore */ }
    },
  };
}
export type Phone = ReturnType<typeof createPhone>;
