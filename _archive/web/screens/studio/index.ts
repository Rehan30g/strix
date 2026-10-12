/* TTS Studio: text editor with audio-tag palette, voice + model + tune, streamed preview, mp3 download, history. */
import type { ScreenCtx } from '../../ctx';
import type { TtsBody } from '../../api';
import { h, relTime, fmtNum, onDisconnect } from '../../ui/dom';
import { field, voiceSelect, previewButton, tuneControls, voiceLabel } from '../../ui/controls';

interface StudioPrefs { voiceId: string; model: string }
interface HistoryItem { id: number; text: string; voiceId: string; model: string; chars: number; createdAt: string }

const TAG_GROUPS: Array<[string, string[]]> = [
  ['Emosi', ['warmly', 'excited', 'curious', 'sarcastic', 'nervous', 'tired', 'angry', 'deadpan', 'flustered', 'disbelief', 'playful', 'cold']],
  ['Suara tubuh', ['laughs', 'chuckling', 'sighing', 'sharp exhale', 'inhales deeply', 'clears throat', 'scoffing', 'gasping', 'gulps', 'yawning', 'sniffling']],
  ['Penyampaian', ['whispering', 'shouting', 'slowly', 'rushed', 'pause', 'short pause', 'long pause', 'trailing off', 'stammering', 'voice breaking', 'singing']],
  ['Efek', ['phone ringing', 'knocking on door', 'keyboard typing', 'applause', 'rain falling', 'heartbeat']],
];
const MODELS: Array<[string, string]> = [
  ['eleven_v4_turbo', 'Eleven v4 Turbo (ekspresif, audio tags)'],
  ['eleven_v3', 'Eleven v3 (ekspresif)'],
  ['eleven_multilingual_v2', 'Multilingual v2 (stabil)'],
  ['eleven_flash_v2_5', 'Flash v2.5 (cepat, murah)'],
  ['eleven_turbo_v2_5', 'Turbo v2.5'],
];
const SAMPLE = '[warmly] Hey, welcome back! [pause] So, um... I tried that recipe you sent me. [chuckling] Let\'s just say the smoke alarm loved it more than I did.';

export function mount(root: HTMLElement, ctx: ScreenCtx): () => void {
  const { settings, player, ui, icons, api } = ctx;
  const S = icons.svg;
  settings.register<StudioPrefs>('studio', { voiceId: '', model: '' });
  let sp = settings.get<StudioPrefs>('studio');
  let maxChars = 5000, streamMax = 2000;
  let dlCtrl: AbortController | null = null;

  /* ---------- editor ---------- */
  const ta = h('textarea', { class: 'textarea studio-text', rows: 9, spellcheck: true, placeholder: 'Tulis teks yang ingin diucapkan. Sisipkan audio tag seperti [laughs] atau [whispering] untuk ekspresi.', value: settings.local.get('studio.draft', SAMPLE), 'aria-label': 'Teks' }) as HTMLTextAreaElement;
  const counter = h('span', { class: 'studio-count', 'aria-live': 'polite' });
  const insertTag = (tag: string) => {
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    const before = ta.value.slice(0, s), after = ta.value.slice(e);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const ins = `${pad}[${tag}] `;
    ta.value = before + ins + after.replace(/^\s+/, '');
    const pos = (before + ins).length;
    ta.focus(); ta.setSelectionRange(pos, pos);
    onText();
  };
  let group = 0;
  const chips = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Audio tag' });
  const groupSeg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Kelompok tag' });
  const paintChips = () => {
    groupSeg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-selected', String(i === group)));
    chips.replaceChildren(...TAG_GROUPS[group][1].map((t) => h('button', { type: 'button', class: 'chip tagchip', title: `Sisipkan [${t}]`, onclick: () => insertTag(t) }, `[${t}]`)));
  };
  TAG_GROUPS.forEach(([name], i) => groupSeg.append(h('button', { type: 'button', role: 'tab', onclick: () => { group = i; paintChips(); } }, name)));
  paintChips();

  const btnGen = ui.btn({ label: 'Putar (streaming)', icon: 'play', cls: 'primary' });
  const btnDl = ui.btn({ label: 'Unduh MP3', icon: 'download' });
  const btnStop = ui.btn({ label: 'Stop', icon: 'stop', cls: 'ghost' });
  const btnClear = ui.btn({ icon: 'trash', cls: 'ghost icon', title: 'Kosongkan teks', onClick: () => { ta.value = ''; onText(); ta.focus(); } });
  const status = h('div', { class: 'studio-status', role: 'status' });

  const editor = h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', null, 'Teks'), h('div', { style: 'margin-left:auto' }, btnClear)),
    h('div', { class: 'card-b stack', style: 'gap:12px' },
      h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap' }, h('span', { class: 'label' }, 'Sisipkan audio tag'), groupSeg), chips),
      ta,
      h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap;gap:10px' }, counter, h('div', { class: 'row', style: 'flex-wrap:wrap' }, btnStop, btnDl, btnGen)),
      status));

  /* ---------- voice / model ---------- */
  const vs = voiceSelect({ value: sp.voiceId, onChange: (v) => { sp = settings.patch<StudioPrefs>('studio', { voiceId: v }); } });
  const modelSel = h('select', { class: 'select' }) as HTMLSelectElement;
  const fillModels = (def: string) => {
    modelSel.replaceChildren(new Option(`Bawaan server (${def})`, ''), ...MODELS.map(([v, l]) => new Option(l, v)));
    modelSel.value = sp.model;
  };
  fillModels('eleven_v4_turbo');
  modelSel.onchange = () => { sp = settings.patch<StudioPrefs>('studio', { model: modelSel.value }); };
  const voiceCard = h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', null, 'Suara')),
    h('div', { class: 'card-b stack', style: 'gap:16px' },
      field('Suara', h('div', { class: 'row' }, h('div', { class: 'grow' }, vs), previewButton(() => vs.value))),
      field('Model', modelSel, 'Audio tag paling bekerja di model v3 / v4.'),
      h('details', { class: 'disclosure' }, h('summary', null, 'Tuning (stability, speed ...)'), h('div', { style: 'padding-top:12px' }, tuneControls({ compact: true })))));

  /* ---------- history ---------- */
  const histList = h('div', { class: 'hist', role: 'list' });
  const histCard = h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', null, 'Riwayat'), h('span', { class: 'sub' }, 'Teks yang pernah diunduh (audio tidak disimpan)'),
      h('div', { style: 'margin-left:auto' }, ui.btn({ icon: 'refresh', cls: 'ghost icon sm', title: 'Muat ulang riwayat', onClick: () => loadHistory() }))),
    histList);

  root.append(h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'studio' }, h('div', { class: 'stack' }, editor, histCard), h('div', { class: 'stack studio-side' }, voiceCard)))));

  /* ---------- behaviour ---------- */
  function onText() {
    settings.local.set('studio.draft', ta.value);
    const n = ta.value.trim().length;
    counter.textContent = `${fmtNum(n)} / ${fmtNum(maxChars)} karakter`;
    counter.classList.toggle('over', n > maxChars);
    paint();
  }
  ta.addEventListener('input', onText);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); btnGen.click(); } });

  const body = (): TtsBody => ({ text: ta.value.trim(), voiceId: vs.value, ...(sp.model ? { model: sp.model } : {}), tune: settings.tune() });
  function paint() {
    const n = ta.value.trim().length;
    const ok = n > 0 && n <= maxChars && !!vs.value;
    btnGen.disabled = !ok; btnDl.disabled = !ok || !!dlCtrl;
    btnStop.hidden = !player.busy && !dlCtrl;
    btnGen.innerHTML = S(player.pending ? 'refresh' : 'play') + `<span>${player.pending ? 'Putar ulang' : 'Putar (streaming)'}</span>`;
  }
  btnGen.onclick = () => {
    const b = body(); if (!b.text || !b.voiceId) return;
    player.stop();
    const parts = b.text.length > streamMax ? ctx.text.splitChunks(b.text, Math.min(1800, streamMax)) : [b.text];
    for (const p of parts) player.speak(p, { voiceId: b.voiceId, model: b.model, tune: b.tune, who: 'studio' });
    status.textContent = '';
  };
  btnStop.onclick = () => { player.stop(); dlCtrl?.abort(); };
  btnDl.onclick = async () => {
    const b = body(); if (!b.text || !b.voiceId) return;
    dlCtrl = new AbortController(); paint();
    status.replaceChildren(h('span', { class: 'spinner' }), h('span', null, 'Membuat MP3...'));
    try {
      const r = await api.raw('/tts/generate', { method: 'POST', json: b, signal: dlCtrl.signal });
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const name = /filename="?([^";]+)"?/i.exec(cd)?.[1] || `tts-${Date.now()}.mp3`;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status.replaceChildren(h('span', { html: S('checkCircle'), style: 'display:contents;color:var(--ok)' }), h('span', null, `${name} siap (${(blob.size / 1024).toFixed(0)} KB)`),
        ui.btn({ label: 'Putar file', icon: 'play', cls: 'sm ghost', onClick: () => player.playUrl(blob).catch(() => {}) }));
      api.usageChanged(); loadHistory();
    } catch (e: any) {
      status.replaceChildren();
      if (e?.code !== 'aborted') ui.toast(e.message, { kind: 'bad', title: 'Gagal membuat MP3' });
    } finally { dlCtrl = null; paint(); }
  };

  async function loadHistory() {
    histList.replaceChildren(...[0, 1, 2].map(() => h('div', { class: 'hist-item' }, h('div', { class: 'skel', style: 'height:38px;flex:1' }))));
    try {
      const r = await api.get<{ items: HistoryItem[] }>('/tts/history');
      const items = Array.isArray(r) ? r as HistoryItem[] : r.items || [];
      const voices = ctx.store.get().voices || [];
      if (!items.length) { histList.replaceChildren(h('div', { class: 'empty', style: 'padding:28px 16px' }, h('div', { class: 'empty-ic', html: S('history') }), h('p', null, 'Belum ada riwayat. Unduh MP3 untuk menyimpan teksnya di sini.'))); return; }
      histList.replaceChildren(...items.map((it) => {
        const v = voices.find((x) => x.id === it.voiceId);
        const use = ui.btn({ label: 'Pakai', icon: 'edit', cls: 'sm ghost', onClick: () => {
          ta.value = it.text; onText();
          if (it.voiceId) { vs.value = it.voiceId; if (vs.value === it.voiceId) sp = settings.patch<StudioPrefs>('studio', { voiceId: it.voiceId }); }
          ta.focus(); ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } });
        const del = ui.btn({ icon: 'trash', cls: 'sm ghost icon', title: 'Hapus dari riwayat', onClick: async () => {
          try { await api.del(`/tts/history/${it.id}`); row.remove(); if (!histList.children.length) loadHistory(); } catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
        } });
        const row = h('div', { class: 'hist-item', role: 'listitem' },
          h('div', { class: 'hist-main' }, h('div', { class: 'hist-text' }, it.text),
            h('div', { class: 'hist-meta' }, h('span', null, v ? voiceLabel(v).split(' · ')[0] : it.voiceId), h('span', null, it.model), h('span', null, `${fmtNum(it.chars)} karakter`), h('span', null, relTime(it.createdAt)))),
          h('div', { class: 'hist-act' }, use, del));
        return row;
      }));
    } catch (e: any) {
      histList.replaceChildren(h('div', { class: 'notice bad', style: 'margin:16px', html: S('alert') }, h('span', null, e.message)));
    }
  }

  onDisconnect(ta, player.on('change', paint));
  onDisconnect(ta, player.on('error', (e: any) => ui.toast(e?.message || 'TTS gagal', { kind: 'bad' })));
  ctx.data.config().then((c) => {
    maxChars = c.limits?.ttsGenerateMaxChars || maxChars; streamMax = c.limits?.ttsMaxChars || streamMax;
    fillModels(c.ttsModel || 'eleven_v4_turbo'); onText();
  }).catch(() => {});
  ctx.data.voices().then((l) => { if (!vs.value && l[0]) { vs.value = l.find((v) => !v.own)?.id || l[0].id; sp = settings.patch<StudioPrefs>('studio', { voiceId: vs.value }); } paint(); loadHistory(); }).catch(() => loadHistory());
  onText();

  return () => { player.stop(); dlCtrl?.abort(); };
}
