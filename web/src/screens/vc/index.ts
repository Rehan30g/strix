/* Voice Changer: upload or record audio -> POST /api/vc (ElevenLabs speech-to-speech) -> compare original vs result,
   download the mp3. One step per block: source, target voice, (advanced), convert, result. */
import type { ScreenCtx } from '../../ctx';
import { h, onDisconnect } from '../../ui/dom';
import { seg, slider, switchRow } from '../../ui/controls';
import { voicePicker } from '../../ui/voicepicker';
import { miniPlayer, pauseAllMini } from '../../ui/audio';
import { startRecording, canRecord, probeDuration, fmtDur, type Recorder } from '../../lib/recorder';
import { convertVoice, type VcResult } from '../../lib/vc';
import { voiceOrb } from '../../ui/orb';

interface VcPrefs { voiceId: string; removeBackgroundNoise: boolean; stability: number; similarity: number; style: number }
interface Source { file: File; duration: number | null; origin: 'file' | 'mic' }

const MAX_MB = 15, MAX_SEC = 300;
const fmtLeft = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} mnt ${Math.round(s % 60)} dtk` : `${Math.max(0, Math.round(s))} dtk`);

export function mount(root: HTMLElement, ctx: ScreenCtx): () => void {
  const { settings, ui, icons, store, player } = ctx;
  const S = icons.svg;
  settings.register<VcPrefs>('vc', { voiceId: '', removeBackgroundNoise: false, stability: 0.5, similarity: 0.75, style: 0 });
  let pr = settings.get<VcPrefs>('vc');
  const setPr = (p: Partial<VcPrefs>) => { pr = settings.patch<VcPrefs>('vc', p); };
  let mode: 'upload' | 'record' = 'upload';
  let src: Source | null = null;
  let rec: Recorder | null = null, recRaf = 0;
  let ctrl: AbortController | null = null;
  let res: VcResult | null = null;

  /* ---------- 1. source ---------- */
  const modeSeg = seg<'upload' | 'record'>([['upload', 'Unggah file', 'upload'], ['record', 'Rekam', 'mic']], mode, (v) => { mode = v; paintSource(); }, 'Sumber audio', true);
  const fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac,.aac', hidden: true }) as HTMLInputElement;
  const drop = h('button', { type: 'button', class: 'dropzone' },
    h('span', { class: 'dz-ic', html: S('upload') }),
    h('b', null, 'Pilih file audio'),
    h('span', { class: 'hint' }, `MP3, WAV, M4A, WEBM · maks ${MAX_MB} MB · sekitar 5 menit`));
  const recBtn = h('button', { type: 'button', class: 'rec-btn', 'aria-label': 'Mulai merekam', html: S('mic') });
  const recTime = h('div', { class: 'rec-time' }, 'Ketuk untuk merekam');
  const recHint = h('div', { class: 'hint' }, 'Bicara jelas dekat mikrofon. Maksimal 5 menit.');
  const recPanel = h('div', { class: 'rec-panel' }, recBtn, recTime, recHint);
  const sourceBox = h('div', { class: 'vc-source' });
  const srcSec = h('section', { class: 'step' },
    h('div', { class: 'step-h' }, h('span', { class: 'step-n' }, '1'), h('h2', null, 'Audio asli')),
    sourceBox, fileInput);

  function paintSource() {
    if (src) {
      const change = ui.btn({ label: 'Ganti', icon: 'refresh', cls: 'sm ghost', onClick: () => { src = null; res = null; paintSource(); paintResult(); paint(); } });
      sourceBox.replaceChildren(h('div', { class: 'src-card' },
        miniPlayer(src.file, { label: src.origin === 'mic' ? 'Rekaman' : src.file.name, sub: [src.duration ? fmtDur(src.duration) : '', `${(src.file.size / 1024 / 1024).toFixed(1)} MB`].filter(Boolean).join(' · '), knownDuration: src.duration }),
        change));
      return;
    }
    modeSeg.setValue(mode);
    sourceBox.replaceChildren(modeSeg, mode === 'upload' ? drop : recPanel);
    if (mode === 'record' && !canRecord()) recPanel.replaceChildren(h('div', { class: 'notice warn', html: S('alert') }, h('span', null, 'Browser ini tidak mendukung perekaman. Unggah file saja.')));
  }

  async function setSource(file: File, origin: Source['origin'], known?: number) {
    if (!(file.type.startsWith('audio/') || file.type === 'video/webm' || /\.(mp3|wav|m4a|ogg|oga|webm|flac|aac|opus)$/i.test(file.name))) { ui.toast('File ini bukan audio.', { kind: 'warn' }); return; }
    if (file.size > MAX_MB * 1024 * 1024) { ui.toast(`File lebih dari ${MAX_MB} MB.`, { kind: 'warn' }); return; }
    const duration = known ?? await probeDuration(file);
    if (duration && duration > MAX_SEC + 5) { ui.toast(`Audio ${fmtDur(duration)} terlalu panjang. Maksimal sekitar 5 menit.`, { kind: 'warn' }); return; }
    src = { file, duration: duration ?? null, origin };
    res = null;
    paintSource(); paintResult(); paint();
  }
  drop.onclick = () => fileInput.click();
  fileInput.onchange = () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f) setSource(f, 'file'); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) setSource(f, 'file'); };

  async function toggleRec() {
    if (rec) {
      const r = rec; rec = null; cancelAnimationFrame(recRaf); paintRec();
      const out = await r.stop();
      if (!out) { ui.toast('Rekaman terlalu pendek.', { kind: 'warn' }); return; }
      setSource(out.file, 'mic', out.duration);
      return;
    }
    player.stop(); pauseAllMini();
    try {
      rec = await startRecording({ maxSec: MAX_SEC, name: 'rekaman', onAutoStop: (r) => { rec = null; cancelAnimationFrame(recRaf); paintRec(); if (r) setSource(r.file, 'mic', r.duration); } });
    } catch (e: any) { ui.toast(e.message, { kind: 'warn' }); return; }
    paintRec();
    const tick = () => {
      if (!rec) return;
      recTime.textContent = `${fmtDur(rec.elapsed())} / 5:00`;
      recBtn.style.setProperty('--lvl', rec.level().toFixed(3));
      recRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  function paintRec() {
    recBtn.classList.toggle('on', !!rec);
    recBtn.innerHTML = S(rec ? 'stop' : 'mic');
    recBtn.setAttribute('aria-label', rec ? 'Selesai merekam' : 'Mulai merekam');
    if (!rec) { recTime.textContent = 'Ketuk untuk merekam'; recBtn.style.setProperty('--lvl', '0'); }
    recHint.textContent = rec ? 'Ketuk lagi untuk selesai.' : 'Bicara jelas dekat mikrofon. Maksimal 5 menit.';
  }
  recBtn.onclick = toggleRec;

  /* ---------- 2. target voice ---------- */
  const vp = voicePicker({ value: pr.voiceId, onChange: (v) => { setPr({ voiceId: v }); paint(); } });
  const voiceSec = h('section', { class: 'step' },
    h('div', { class: 'step-h' }, h('span', { class: 'step-n' }, '2'), h('h2', null, 'Suara target')), vp);

  /* ---------- advanced ---------- */
  const adv = h('details', { class: 'disclosure' },
    h('summary', null, h('span', null, 'Lanjutan'), h('small', null, 'Hapus noise, tuning suara')),
    h('div', { class: 'disc-b stack' },
      switchRow('Hapus noise latar', pr.removeBackgroundNoise, (v) => setPr({ removeBackgroundNoise: v }), 'Untuk rekaman di tempat ramai.'),
      slider({ label: 'Stability', min: 0, max: 1, step: 0.05, value: pr.stability, onInput: (v) => setPr({ stability: v }) }),
      slider({ label: 'Similarity', min: 0, max: 1, step: 0.05, value: pr.similarity, onInput: (v) => setPr({ similarity: v }) }),
      slider({ label: 'Style', min: 0, max: 1, step: 0.05, value: pr.style, onInput: (v) => setPr({ style: v }) })));

  /* ---------- convert ---------- */
  const goBtn = h('button', { type: 'button', class: 'btn primary lg block' });
  const progress = h('div', { class: 'progress' }, h('i'));
  const progText = h('span');
  const cancelBtn = ui.btn({ label: 'Batal', cls: 'sm ghost', onClick: () => ctrl?.abort() });
  const working = h('div', { class: 'vc-working', hidden: true }, h('div', { class: 'row', style: 'justify-content:space-between' }, progText, cancelBtn), progress);
  const quotaLine = h('div', { class: 'hint vc-quota' });
  const offNote = h('div', { class: 'notice warn', hidden: true, html: S('info') }, h('span', null, 'Voice Changer tidak tersedia untuk akunmu atau belum dikonfigurasi di server.'));
  const resultBox = h('section', { class: 'step vc-result', hidden: true, 'aria-live': 'polite' });

  root.append(h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('p', { class: 'page-lead' }, 'Ubah suara di rekaman jadi suara lain, intonasi tetap sama.'),
    srcSec, voiceSec, adv,
    h('div', { class: 'stack', style: 'gap:10px' }, offNote, goBtn, working, quotaLine),
    resultBox)));

  function paint() {
    const busy = !!ctrl;
    const off = store.get().me?.features?.vc === false;
    offNote.hidden = !off;
    goBtn.disabled = busy || off || !src || !vp.value;
    goBtn.innerHTML = S('changer') + `<span>${busy ? 'Sedang mengubah...' : 'Ubah suara'}</span>`;
    working.hidden = !busy;
    const q = store.get().me?.quota?.vc;
    quotaLine.textContent = q ? `Sisa kuota hari ini: ${fmtLeft(Math.max(0, q.limit - q.used))} audio` : '';
    quotaLine.hidden = !q;
  }

  goBtn.onclick = async () => {
    if (!src || !vp.value || ctrl) return;
    player.stop(); pauseAllMini();
    ctrl = new AbortController();
    const bar = progress.firstElementChild as HTMLElement;
    progress.classList.remove('indet'); bar.style.width = '0%'; progText.textContent = 'Mengunggah...';
    paint();
    try {
      res = await convertVoice({ file: src.file, voiceId: vp.value, removeBackgroundNoise: pr.removeBackgroundNoise, stability: pr.stability, similarity: pr.similarity, style: pr.style, durationSec: src.duration }, {
        signal: ctrl.signal,
        onProgress: (phase, p) => {
          if (phase === 'upload') { bar.style.width = Math.round(p * 100) + '%'; progText.textContent = `Mengunggah ${Math.round(p * 100)}%`; }
          else { progress.classList.add('indet'); progText.textContent = 'Memproses suara...'; }
        },
      });
      paintResult();
      ctx.data.refreshMe(300);
      requestAnimationFrame(() => resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (e: any) {
      if (e?.code !== 'aborted' && !(e?.status === 429 && e?.code === 'quota')) ui.toast(e.message || 'Gagal mengubah suara.', { kind: 'bad', title: 'Voice Changer gagal' });
    } finally { ctrl = null; paint(); }
  };

  function paintResult() {
    if (!res || !src) { resultBox.hidden = true; resultBox.replaceChildren(); return; }
    const r = res;
    const dl = h('a', { class: 'btn lg block', href: '#', html: S('download') }, h('span', null, 'Unduh MP3'));
    dl.onclick = (e) => {
      e.preventDefault();
      const url = URL.createObjectURL(r.blob);
      const a = h('a', { href: url, download: r.name }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
    const v = (store.get().voices || []).find((x) => x.id === vp.value);
    resultBox.hidden = false;
    resultBox.replaceChildren(
      h('div', { class: 'step-h' }, h('span', { class: 'step-n ok', html: S('check') }), h('h2', null, 'Hasil')),
      h('div', { class: 'ab' },
        miniPlayer(src.file, { label: 'Asli', sub: src.origin === 'mic' ? 'Rekamanmu' : src.file.name, knownDuration: src.duration }),
        miniPlayer(r.blob, { label: 'Hasil', sub: v ? v.name.split(' - ')[0] : 'Suara baru', accent: true, orb: voiceOrb(vp.value), level: 'vc:' + vp.value })),
      dl);
  }

  onDisconnect(goBtn, store.select((s) => s.me?.quota, paint));
  ctx.data.voices().then((l) => {
    if (!vp.value || !l.some((v) => v.id === vp.value)) { const f = l[0]; if (f) { vp.setValue(f.id); setPr({ voiceId: f.id }); } }
    paint();
  }).catch(() => {});
  const pre = ctx.route.params.get('voice');
  if (pre) { vp.setValue(pre); setPr({ voiceId: pre }); }
  paintSource(); paint();
  ctx.data.refreshMe(0);

  return () => {
    ctrl?.abort(); cancelAnimationFrame(recRaf); rec?.cancel(); rec = null; pauseAllMini();
  };
}
