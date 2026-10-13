/* TTS: text with audio tags -> streamed preview through the shared player, or a downloadable mp3.
   Voice + (advanced) model and tuning, short history. */
import type { ScreenCtx } from '../../ctx';
import type { TtsBody } from '../../api';
import { h, relTime, fmtNum, onDisconnect } from '../../ui/dom';
import { field, tuneControls } from '../../ui/controls';
import { voicePicker, shortName } from '../../ui/voicepicker';
import { miniPlayer } from '../../ui/audio';
import { voiceOrb } from '../../ui/orb';
import { swipeRow } from '../../ui/gesture';
import { autoTag, INTENSITY, type Intensity } from '../../lib/autotag';
import { seg } from '../../ui/controls';
import { orb, personaOrb } from '../../ui/orb';
import { dialogue } from './dialogue';

interface TtsPrefs { voiceId: string; autotag?: Intensity; mode?: 'single' | 'dialog' }
interface HistoryItem { id: number; text: string; voiceId: string; model: string; chars: number; createdAt: string; kind?: 'tts' | 'dialogue'; speakers?: number; cast?: Array<{ name: string; voiceId: string }>; lines?: number | null; durationSec?: number | null }

const TAGS = ['laughs', 'chuckling', 'sighing', 'whispering', 'excited', 'warmly', 'sarcastic', 'curious', 'nervous', 'pause', 'long pause', 'clears throat', 'gasping', 'shouting', 'slowly', 'crying'];
const SAMPLE = "[warmly] Hey, welcome back! [pause] So, um... I tried that recipe you sent me. [chuckling] Let's just say the smoke alarm loved it more than I did.";

export function mount(root: HTMLElement, ctx: ScreenCtx): () => void {
  const { settings, player, ui, icons, api } = ctx;
  const S = icons.svg;
  settings.register<TtsPrefs>('studio', { voiceId: '' });
  let sp = settings.get<TtsPrefs>('studio');
  let maxChars = 5000, streamMax = 2000;
  let dlCtrl: AbortController | null = null;
  let histAll: HistoryItem[] = [];
  let showAll = false;

  /* ---------- editor: a transparent textarea over a backdrop that paints [tags] purple ---------- */
  const ta = h('textarea', { class: 'tts-text', spellcheck: true, placeholder: 'Tulis teks yang ingin diucapkan...', 'aria-label': 'Teks' }) as HTMLTextAreaElement;
  ta.value = settings.local.get('studio.draft', SAMPLE);
  const backIn = h('div', { class: 'tts-back-in' });
  const back = h('div', { class: 'tts-back', 'aria-hidden': 'true' }, backIn);
  const fieldBox = h('div', { class: 'tts-field' }, back, ta);
  function paintBack() {
    const nodes: Node[] = [];
    for (const p of ta.value.split(/(\[[^\]\n]*\]?)/)) {
      if (!p) continue;
      nodes.push(p.startsWith('[') ? h('mark', { class: 'tg' }, p) : document.createTextNode(p));
    }
    nodes.push(document.createTextNode('\n​'));        // keeps the last (empty) line's height
    backIn.replaceChildren(...nodes);
    syncBack();
  }
  function syncBack() {
    back.style.width = ta.clientWidth + 'px';
    back.style.height = ta.clientHeight + 'px';
    backIn.style.transform = `translate3d(${-ta.scrollLeft}px,${-ta.scrollTop}px,0)`;
  }
  ta.addEventListener('scroll', syncBack, { passive: true });
  const ro = new ResizeObserver(syncBack); ro.observe(ta);
  const counter = h('span', { class: 'tts-count', 'aria-live': 'polite' });
  const clearBtn = h('button', { type: 'button', class: 'btn ghost icon sm', title: 'Kosongkan', 'aria-label': 'Kosongkan teks', html: S('x') });
  clearBtn.onclick = () => { setText(''); ta.focus(); };
  /** Replace the whole text, keeping the browser's own undo (Ctrl+Z) where possible. */
  function setText(next: string) {
    const fine = matchMedia('(pointer: fine)').matches;
    let done = false;
    if (fine) {
      try { ta.focus({ preventScroll: true }); ta.select(); done = document.execCommand('insertText', false, next) && ta.value === next; } catch { done = false; }
    }
    if (!done) ta.value = next;
    onText();
  }

  /* ---------- auto tag ---------- */
  let tagCtrl: AbortController | null = null;
  let undoText: string | null = null;
  const autoBtn = h('button', { type: 'button', class: 'btn sm soft tts-auto', 'aria-haspopup': 'menu', html: S('wand') }, h('span', null, 'Auto tag'), h('span', { class: 'tts-auto-c', html: S('chevronDown') }));
  const undoBtn = h('button', { type: 'button', class: 'btn sm ghost', hidden: true, 'aria-label': 'Urungkan auto tag', title: 'Urungkan auto tag', html: S('refresh') }, h('span', null, 'Urungkan'));
  autoBtn.title = 'Sisipkan audio tag otomatis (teks tidak diubah)';
  autoBtn.onclick = () => {
    if (tagCtrl) { tagCtrl.abort(); return; }
    const last = settings.get<TtsPrefs>('studio').autotag || 'normal';
    ui.popover(autoBtn, h('div', { class: 'auto-menu' }, h('div', { class: 'menu-h' }, 'Intensitas tag'),
      ...INTENSITY.map(([k, label, hint]) => {
        const b = ui.menuItem(label, k === last ? 'check' : 'tag', () => runAutoTag(k));
        b.append(h('small', null, hint));
        return b;
      })), { align: 'start' });
  };
  async function runAutoTag(k: Intensity) {
    const before = ta.value;
    if (!before.trim()) { ui.toast('Tulis teksnya dulu.', { kind: 'warn' }); return; }
    sp = settings.patch<TtsPrefs>('studio', { autotag: k });
    tagCtrl = new AbortController();
    autoBtn.classList.add('busy'); autoBtn.querySelector('span')!.textContent = 'Menandai...';
    try {
      const r = await autoTag(before, k, tagCtrl.signal);
      if (ta.value !== before) { ui.toast('Teks berubah saat menunggu, hasil auto tag tidak dipakai.', { kind: 'warn' }); return; }
      if (r.text === before) { ui.toast(r.fallback ? 'AI belum bisa menambahkan tag kali ini. Coba lagi.' : 'Tidak ada tag baru yang perlu ditambahkan.', { kind: r.fallback ? 'warn' : 'info', timeout: 2600 }); return; }
      undoText = before; undoBtn.hidden = false;
      setText(r.text);
      ui.toast(r.mock ? 'Tag disisipkan (mode contoh: server belum punya auto tag).' : 'Tag disisipkan. Teksmu tidak diubah.', { kind: 'ok', timeout: 2600 });
    } catch (e: any) {
      if (e?.code !== 'aborted') ui.toast(e?.message || 'Auto tag gagal.', { kind: 'bad', title: 'Auto tag gagal' });
    } finally {
      tagCtrl = null; autoBtn.classList.remove('busy'); autoBtn.querySelector('span')!.textContent = 'Auto tag';
    }
  }
  undoBtn.onclick = () => { if (undoText == null) return; setText(undoText); undoText = null; undoBtn.hidden = true; };
  const insertTag = (tag: string) => {
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    const before = ta.value.slice(0, s), after = ta.value.slice(e);
    const ins = `${before && !/\s$/.test(before) ? ' ' : ''}[${tag}] `;
    const rest = after.replace(/^\s+/, '');
    ta.focus();
    ta.setSelectionRange(s, e + (after.length - rest.length));
    let ok = false;
    try { ok = document.execCommand('insertText', false, ins); } catch { ok = false; }   // keeps native undo
    if (!ok) { ta.value = before + ins + rest; }
    const pos = (before + ins).length;
    ta.setSelectionRange(pos, pos);
    onText();
  };
  const chips = h('div', { class: 'tag-row', role: 'group', 'aria-label': 'Sisipkan audio tag' },
    ...TAGS.map((t) => h('button', { type: 'button', class: 'chip tag-chip', onclick: () => insertTag(t) }, `[${t}]`)));
  const editor = h('section', { class: 'tts-editor' },
    fieldBox,
    h('div', { class: 'tts-editor-f' }, h('span', { class: 'tag-label', html: S('tag') }, 'Tag'), chips),
    h('div', { class: 'tts-editor-meta' }, h('div', { class: 'tts-meta-l' }, autoBtn, undoBtn), h('div', { class: 'tts-meta-r' }, counter, clearBtn)));

  /* ---------- voice + actions ---------- */
  const vp = voicePicker({ value: sp.voiceId, onChange: (v) => { sp = settings.patch<TtsPrefs>('studio', { voiceId: v }); paint(); }, liveWhenBusy: () => player.pending > 0 });
  const playBtn = h('button', { type: 'button', class: 'btn primary lg tts-play' });
  const dlBtn = h('button', { type: 'button', class: 'btn lg tts-dl', html: S('download') }, h('span', null, 'Unduh MP3'));
  const result = h('div', { class: 'tts-result', 'aria-live': 'polite' });

  /* ---------- advanced ---------- */
  const adv = h('details', { class: 'disclosure' },
    h('summary', null, h('span', null, 'Tuning suara'), h('small', null, 'Kestabilan, kemiripan, gaya, kecepatan')),
    h('div', { class: 'disc-b stack' }, tuneControls({ compact: true })));

  /* ---------- history ---------- */
  const histList = h('div', { class: 'hist', role: 'list' });
  const histMore = h('button', { type: 'button', class: 'btn ghost sm', hidden: true });
  histMore.onclick = () => { showAll = !showAll; paintHistory(); };
  const histSec = h('section', { class: 'stack', style: 'gap:10px' },
    h('div', { class: 'sec-head' }, h('h2', null, 'Riwayat'), h('span', { class: 'hint' }, 'Teks & dialog dari MP3 yang diunduh')), histList, histMore);

  /* ---------- mode: one voice | dialogue (multi-speaker) ---------- */
  const single = h('div', { class: 'stack tts-single' }, editor, field('Suara', vp), h('div', { class: 'tts-actions' }, playBtn, dlBtn), result);
  const dlg = dialogue(ctx, { onHistory: () => loadHistory() });
  const modeSeg = seg<'single' | 'dialog'>([['single', 'Satu suara', 'user'], ['dialog', 'Dialog', 'users']], sp.mode === 'dialog' ? 'dialog' : 'single', (m) => setMode(m), 'Mode TTS', true);
  modeSeg.classList.add('tts-mode');
  function setMode(m: 'single' | 'dialog') {
    if ((sp.mode || 'single') !== m) player.stop();
    sp = settings.patch<TtsPrefs>('studio', { mode: m });
    modeSeg.setValue(m);
    single.hidden = m !== 'single';
    dlg.el.hidden = m !== 'dialog';
    adv.querySelector('small')!.textContent = m === 'dialog' ? 'Berlaku untuk semua pembicara (kecuali tuning khusus)' : 'Kestabilan, kemiripan, gaya, kecepatan';
  }

  root.append(h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    modeSeg,
    single,
    dlg.el,
    adv,
    histSec)));
  setMode(sp.mode === 'dialog' ? 'dialog' : 'single');

  /* ---------- behaviour ---------- */
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.max(150, Math.min(ta.scrollHeight, 420)) + 'px'; syncBack(); }
  function onText() {
    settings.local.set('studio.draft', ta.value);
    if (undoText != null && !undoBtn.hidden && ta.value === undoText) { undoText = null; undoBtn.hidden = true; }
    paintBack();
    const n = ta.value.trim().length;
    counter.textContent = `${fmtNum(n)} / ${fmtNum(maxChars)}`;
    counter.classList.toggle('over', n > maxChars);
    autosize(); paint();
  }
  ta.addEventListener('input', onText);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); playBtn.click(); } });

  const body = (): TtsBody => ({ text: ta.value.trim(), voiceId: vp.value, tune: settings.tune() });
  function paint() {
    const n = ta.value.trim().length;
    const ok = n > 0 && n <= maxChars && !!vp.value;
    const playing = player.pending > 0;
    playBtn.disabled = !ok && !playing;
    playBtn.innerHTML = S(playing ? 'stop' : 'play') + `<span>${playing ? 'Stop' : 'Putar'}</span>`;
    dlBtn.disabled = !ok || !!dlCtrl;
    dlBtn.innerHTML = dlCtrl ? '<span class="spinner"></span><span>Membuat...</span>' : S('download') + '<span>Unduh MP3</span>';
  }
  playBtn.onclick = () => {
    if (player.pending > 0) { player.stop(); return; }
    const b = body(); if (!b.text || !b.voiceId) return;
    player.stop();
    const parts = b.text.length > streamMax ? ctx.text.splitChunks(b.text, Math.min(1800, streamMax)) : [b.text];
    for (const p of parts) player.speak(p, { voiceId: b.voiceId, tune: b.tune, who: 'studio' });
  };
  dlBtn.onclick = async () => {
    const b = body(); if (!b.text || !b.voiceId) return;
    dlCtrl = new AbortController(); paint();
    result.replaceChildren();
    try {
      const r = await api.raw('/tts/generate', { method: 'POST', json: b, signal: dlCtrl.signal });
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const name = /filename="?([^";]+)"?/i.exec(cd)?.[1] || `tts-${Date.now()}.mp3`;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      result.replaceChildren(miniPlayer(blob, { label: 'MP3 siap', sub: `${name} · ${(blob.size / 1024).toFixed(0)} KB`, orb: voiceOrb(b.voiceId), accent: true }));
      api.usageChanged(); loadHistory();
    } catch (e: any) {
      if (e?.code !== 'aborted') ui.toast(e.message, { kind: 'bad', title: 'Gagal membuat MP3' });
    } finally { dlCtrl = null; paint(); }
  };

  function paintHistory() {
    const voices = ctx.store.get().voices || [];
    if (!histAll.length) { histList.replaceChildren(h('div', { class: 'hist-empty' }, 'Belum ada riwayat. Teks dari MP3 yang kamu unduh muncul di sini.')); histMore.hidden = true; return; }
    const items = showAll ? histAll : histAll.slice(0, 4);
    histMore.hidden = histAll.length <= 4;
    histMore.textContent = showAll ? 'Tampilkan lebih sedikit' : `Tampilkan semua (${histAll.length})`;
    histList.replaceChildren(...items.map((it) => {
      const v = voices.find((x) => x.id === it.voiceId);
      const isDlg = it.kind === 'dialogue';
      const txt = h('div', { class: 'hist-text' });
      ui.renderTagged(txt, it.text);
      const n = it.speakers || it.cast?.length || 0;
      const meta = isDlg
        ? [`Dialog · ${n} pembicara`, it.lines ? `${it.lines} baris` : '', `${fmtNum(it.chars)} karakter`, relTime(it.createdAt)].filter(Boolean)
        : [v ? shortName(v) : 'Suara lain', `${fmtNum(it.chars)} karakter`, relTime(it.createdAt)];
      const cast = isDlg ? h('span', { class: 'hist-cast', 'aria-hidden': 'true' }, ...(it.cast || []).slice(0, 6).map((c) => orb(personaOrb(c.voiceId, c.name), { size: 18 }))) : null;
      const use = h('button', { type: 'button', class: 'hist-main' + (isDlg ? ' mspk-hist' : '') },
        txt,
        h('div', { class: 'hist-meta' }, cast, h('span', null, meta.join(' · '))));
      use.title = isDlg ? 'Pakai naskah dialog dan suara pembicaranya' : 'Pakai teks dan suara ini';
      use.onclick = () => {
        if (isDlg) {
          setMode('dialog');
          const ok = new Set(voices.map((x) => x.id));
          dlg.load(it.text, (it.cast || []).filter((c) => ok.has(c.voiceId)));
        } else {
          setMode('single');
          setText(it.text);
          if (it.voiceId && v) { vp.setValue(it.voiceId); sp = settings.patch<TtsPrefs>('studio', { voiceId: it.voiceId }); }
        }
        document.getElementById('view')?.scrollTo({ top: 0, behavior: 'smooth' });
      };
      const del = h('button', { type: 'button', class: 'btn ghost icon hist-del', 'aria-label': 'Hapus dari riwayat', title: 'Hapus', html: S('trash') });
      const remove = async () => {
        if (!(await ui.confirm({ title: 'Hapus dari riwayat?', message: 'Teks ini dihapus dari riwayat TTS.', confirm: 'Hapus', danger: true }))) return;
        try { await api.del(`/tts/history/${it.id}`); histAll = histAll.filter((x) => x.id !== it.id); paintHistory(); ui.toast('Dihapus dari riwayat.', { kind: 'ok', timeout: 1800 }); }
        catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
      };
      del.onclick = remove;
      const item = h('div', { class: 'hist-item' }, use, del);
      const host = swipeRow(item, [{ label: 'Pakai', icon: 'studio', run: () => use.click() }, { label: 'Hapus', icon: 'trash', cls: 'danger', run: remove }], S);
      host.setAttribute('role', 'listitem');
      return host;
    }));
  }
  async function loadHistory() {
    if (!histAll.length) histList.replaceChildren(...[0, 1].map(() => h('div', { class: 'skel', style: 'height:62px' })));
    try {
      const r = await api.get<{ items: HistoryItem[] }>('/tts/history');
      histAll = Array.isArray(r) ? r as HistoryItem[] : r.items || [];
      paintHistory();
    } catch (e: any) {
      histList.replaceChildren(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, e.message)));
    }
  }

  onDisconnect(ta, player.on('change', paint));
  onDisconnect(ta, player.on('error', (e: any) => ui.toast(e?.message || 'TTS gagal', { kind: 'bad' })));
  ctx.data.config().then((c) => {
    maxChars = c.limits?.ttsGenerateMaxChars || maxChars; streamMax = c.limits?.ttsMaxChars || streamMax;
    onText();
  }).catch(() => {});
  ctx.data.voices().then((l) => {
    if (!vp.value || !l.some((v) => v.id === vp.value)) {
      const first = l.find((v) => !v.own) || l[0];
      if (first) { vp.setValue(first.id); sp = settings.patch<TtsPrefs>('studio', { voiceId: first.id }); }
    }
    paint(); paintHistory();
  }).catch(() => {});
  const pre = ctx.route.params.get('voice');
  if (pre) { vp.setValue(pre); sp = settings.patch<TtsPrefs>('studio', { voiceId: pre }); }
  loadHistory();
  onText();
  requestAnimationFrame(autosize);

  return () => { player.stop(); dlCtrl?.abort(); tagCtrl?.abort(); ro.disconnect(); dlg.cleanup(); };
}
