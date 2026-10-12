/* Settings: theme, model, TTS voice/model/tune, accent, languages — synced to /api/settings/:key (cached locally). */
import type { ScreenCtx } from '../../ctx';
import { h } from '../../ui/dom';
import { field, switchRow, seg, voiceSelect, previewButton, modelInput, accentInput, tuneControls, sttSelect } from '../../ui/controls';
import { setTheme } from '../../theme';
import type { Prefs } from '../../settings';

const TTS_MODELS: Array<[string, string]> = [
  ['eleven_v4_turbo', 'Eleven v4 Turbo'], ['eleven_v3', 'Eleven v3'], ['eleven_multilingual_v2', 'Multilingual v2'], ['eleven_flash_v2_5', 'Flash v2.5'], ['eleven_turbo_v2_5', 'Turbo v2.5'],
];

export function mount(root: HTMLElement, ctx: ScreenCtx): () => void {
  const { settings, ui, icons, player } = ctx;
  const S = icons.svg;
  const p = settings.prefs();
  const set = (patch: Partial<Prefs>) => { settings.setPrefs(patch); saved(); };
  const savedEl = h('span', { class: 'badge ok', hidden: true, html: S('check') }, 'Tersimpan');
  let savedT: ReturnType<typeof setTimeout> | null = null;
  function saved() { savedEl.hidden = false; if (savedT) clearTimeout(savedT); savedT = setTimeout(() => { savedEl.hidden = true; }, 1600); }
  const unTune = settings.subscribe('tune', saved);

  const section = (icon: string, title: string, sub: string, ...body: Node[]) =>
    h('section', { class: 'card set-sec' },
      h('div', { class: 'card-h' }, h('span', { class: 'avatar', html: S(icon) }), h('div', null, h('h2', null, title), h('div', { class: 'sub' }, sub))),
      h('div', { class: 'card-b stack', style: 'gap:16px' }, ...body));

  const ttsModel = h('select', { class: 'select' }) as HTMLSelectElement;
  const fillTts = (def: string) => { ttsModel.replaceChildren(new Option(`Bawaan server (${def})`, ''), ...TTS_MODELS.map(([v, l]) => new Option(l, v))); ttsModel.value = settings.prefs().ttsModel; };
  fillTts('eleven_v4_turbo');
  ttsModel.onchange = () => set({ ttsModel: ttsModel.value });
  ctx.data.config().then((c) => fillTts(c.ttsModel || 'eleven_v4_turbo')).catch(() => {});

  const vs = voiceSelect({ value: p.voiceId, onChange: (v) => set({ voiceId: v }), emptyLabel: 'Bawaan karakter' });
  const testBtn = ui.btn({ label: 'Tes suara', icon: 'speaker', cls: 'soft sm', onClick: () => {
    const id = vs.value || '21m00Tcm4TlvDq8ikWAM';
    const acc = settings.prefs().accent;
    player.stop();
    player.speak(`${acc && settings.prefs().audioTags ? `[strong ${acc} accent] ` : ''}[warmly] Hey there! [pause] This is how I sound with your current settings.`, { voiceId: id, model: settings.prefs().ttsModel || undefined, who: 'test' });
  } });

  const page = h('div', { class: 'page' }, h('div', { class: 'page-inner narrow' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Pengaturan'), h('p', null, 'Tersimpan di akunmu dan tersinkron antar perangkat.')), savedEl),
    h('div', { class: 'stack', style: 'gap:20px' },
      section('palette', 'Tampilan', 'Tema dan tampilan teks',
        field('Tema', seg<'system' | 'light' | 'dark'>([['system', 'Sistem', 'monitor'], ['light', 'Terang', 'sun'], ['dark', 'Gelap', 'moon']], p.theme, (v) => { setTheme(v); set({ theme: v }); }, 'Tema')),
        switchRow('Tampilkan audio tag di layar', p.showTags, (v) => set({ showTags: v }), 'Tag seperti [laughs] tetap diucapkan walau disembunyikan.')),
      section('cpu', 'Model AI', 'OpenRouter, dipakai roleplay dan panggilan suara',
        field('Model chat', modelInput({ value: p.model, onChange: (v) => set({ model: v }) }), 'Kosong = model bawaan server. Format vendor/model-id.'),
        switchRow('Thinking / reasoning', p.thinking, (v) => set({ thinking: v }), 'Jawaban lebih matang tapi lebih lambat.')),
      section('speaker', 'Suara (TTS)', 'ElevenLabs: suara, model, dan tuning',
        field('Suara default', h('div', { class: 'row' }, h('div', { class: 'grow' }, vs), previewButton(() => vs.value)), 'Dipakai roleplay dan panggilan; kosong = suara bawaan tiap karakter.'),
        field('Model TTS', ttsModel),
        field('Aksen', accentInput({ value: p.accent, onChange: (v) => set({ accent: v }) }), 'Ditambahkan sebagai tag [strong X accent]. Eksperimental, hasil berbeda per suara.'),
        h('div', { class: 'section-title' }, 'Tuning'),
        tuneControls(),
        h('div', null, testBtn)),
      section('languages', 'Bahasa', 'Bahasa bicara AI dan mikrofon',
        field('Bahasa bicara AI (Coffee Agent)', seg<'en' | 'id'>([['en', 'English'], ['id', 'Indonesia']], p.lang, (v) => set({ lang: v }), 'Bahasa AI')),
        field('Bahasa yang kamu ucapkan (mic)', sttSelect(p.sttLang, (v) => set({ sttLang: v })), ctx.speech.hasSpeech() ? 'Pengenalan suara memakai Web Speech API browser.' : 'Browser ini tidak mendukung pengenalan suara; pakai Chrome atau Edge.')),
      section('chat', 'Roleplay', 'Perilaku chat dan panggilan',
        switchRow('Audio tags', p.audioTags, (v) => set({ audioTags: v }), 'AI menulis [sighing], [whispering] … untuk suara yang ekspresif.'),
        switchRow('Suara otomatis', p.autoSpeak, (v) => set({ autoSpeak: v }), 'Bacakan balasan begitu muncul.'),
        switchRow('Mode ngobrol (panggilan)', p.handsFree, (v) => set({ handsFree: v }), 'Mic terbuka otomatis setelah karakter selesai bicara.')),
      section('lock', 'Data di perangkat ini', 'Riwayat sesi panggilan hanya disimpan di browser ini',
        h('div', { class: 'row', style: 'flex-wrap:wrap' },
          ui.btn({ label: 'Hapus riwayat panggilan', icon: 'trash', cls: 'danger-soft sm', onClick: async () => {
            if (await ui.confirm({ title: 'Hapus riwayat panggilan?', message: 'Semua sesi panggilan suara di perangkat ini akan dihapus.', confirm: 'Hapus', danger: true })) { settings.local.remove('call.sessions'); ui.toast('Riwayat dihapus.', { kind: 'ok' }); }
          } }),
          ui.btn({ label: 'Kembalikan pengaturan bawaan', icon: 'refresh', cls: 'sm', onClick: async () => {
            if (!(await ui.confirm({ title: 'Kembalikan bawaan?', message: 'Model, suara, tuning, aksen, dan bahasa dikembalikan ke bawaan.', confirm: 'Kembalikan' }))) return;
            settings.set('prefs', { ...settings.PREFS_DEFAULT, names: settings.prefs().names }); settings.set('tune', { ...settings.TUNE_DEFAULT });
            setTheme('system'); ctx.navigate('settings?r=' + Date.now());
          } }))))));
  root.append(page);
  return () => { unTune(); player.stop(); };
}
