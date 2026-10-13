/* Voices: two segments
   - Koleksiku (#/voices): the user's collection = own clones + shared + voices added from the Library
     (preview, use in TTS / Changer, remove / delete). Pull to refresh on phones.
   - Library (#/voices/library): the whole public ElevenLabs Voice Library (thousands of community voices): search,
     filters (gender, age, accent, language, category, use case), sort, windowed infinite grid, preview, detail sheet with
     licence notes, add (the server installs the voice once on the account, shared slot) / remove.
   - Instant Voice Clone on its own step (#/voices/clone): name, samples (upload or record), consent, upload progress. */
import type { RouteInfo, ScreenCtx } from '../../ctx';
import type { Voice, LibraryPage, LibraryQuery, LibraryVoice, LibraryWarning } from '../../api';
import { h, onDisconnect } from '../../ui/dom';
import { field, seg } from '../../ui/controls';
import { voiceMeta, shortName, voiceOrbButton } from '../../ui/voicepicker';
import { flyOrb } from '../../ui/transition';
import { miniPlayer, pauseAllMini } from '../../ui/audio';
import { swipeRow, pullToRefresh, haptic } from '../../ui/gesture';
import { addVoiceResult, removeVoice, categoryLabel } from '../../lib/collection';
import { startRecording, canRecord, probeDuration, fmtDur, type Recorder } from '../../lib/recorder';
import { orb, voiceOrb, defaultVoiceOrb, voiceCustomOrb, onOrbsChange } from '../../ui/orb';
import { openOrbStudio } from '../../ui/orbstudio';
import { setVoiceOrb } from '../../lib/orbs';
import { createPersonaFlow } from '../chat/creator';

interface Sample { file: File; source: 'file' | 'mic'; duration: number | null }

// Library filter values (same lists as the server's `facets`, kept here so the filters render instantly)
const FACET = {
  genders: ['female', 'male', 'neutral'],
  ages: ['young', 'middle_aged', 'old'],
  accents: ['american', 'british', 'australian', 'standard', 'indian', 'irish', 'scottish', 'canadian', 'african', 'south african',
    'new zealand', 'latin american', 'peninsular', 'mexican', 'brazilian', 'european', 'parisian', 'quebec', 'jakarta', 'malaysian', 'singaporean', 'filipino'],
  languages: [['en', 'English'], ['id', 'Indonesia'], ['ms', 'Melayu'], ['ja', 'Jepang'], ['ko', 'Korea'], ['zh', 'Mandarin'], ['hi', 'Hindi'],
    ['ar', 'Arab'], ['es', 'Spanyol'], ['pt', 'Portugis'], ['fr', 'Prancis'], ['de', 'Jerman'], ['it', 'Italia'], ['nl', 'Belanda'],
    ['ru', 'Rusia'], ['pl', 'Polandia'], ['tr', 'Turki'], ['sv', 'Swedia'], ['vi', 'Vietnam'], ['th', 'Thai'], ['fil', 'Filipino'],
    ['ta', 'Tamil'], ['uk', 'Ukraina'], ['cs', 'Ceko'], ['el', 'Yunani'], ['ro', 'Rumania'], ['da', 'Denmark'], ['fi', 'Finlandia'], ['no', 'Norwegia'], ['hu', 'Hungaria']]
    .map(([code, name]) => ({ code, name })),
  categories: ['high_quality', 'professional'],
  useCases: ['conversational', 'narrative_story', 'characters_animation', 'social_media', 'entertainment_tv', 'advertisement', 'informative_educational'],
};
const cap = (s: string) => s.replace(/[_-]+/g, ' ').replace(/(^|\s)(\p{L})/gu, (_m, a: string, c: string) => a + c.toUpperCase());
const G_LABEL: Record<string, string> = { female: 'Perempuan', male: 'Laki-laki', neutral: 'Netral' };
const AGE_LABEL: Record<string, string> = { young: 'Muda', middle_aged: 'Dewasa', old: 'Tua' };
const CAT_LABEL: Record<string, string> = { high_quality: 'Kualitas tinggi', professional: 'Profesional', generated: 'Buatan AI', famous: 'Terkenal' };
const UC_LABEL: Record<string, string> = {
  conversational: 'Percakapan', narrative_story: 'Narasi & cerita', characters_animation: 'Karakter & animasi', social_media: 'Media sosial',
  entertainment_tv: 'Hiburan & TV', advertisement: 'Iklan', informative_educational: 'Edukasi',
};
const F_LABEL = { gender: 'Gender', age: 'Usia', accent: 'Aksen', language: 'Bahasa', category: 'Kategori', useCase: 'Kegunaan' };

export function mount(root: HTMLElement, ctx: ScreenCtx) {
  const { api, player, ui, icons, store } = ctx;
  const S = icons.svg;
  let voices: Voice[] = [];
  let loaded = false, loadErr = '';
  let query = '';
  let maxClones = 2, maxMb = 10, maxFiles = 3;
  let view: 'list' | 'library' | 'clone' = 'list';
  const canClone = () => !!store.get().me?.features?.clone;

  const page = h('div', { class: 'page' });
  root.append(page);

  const segEl = seg<'list' | 'library'>([['list', 'Koleksiku', 'voices'], ['library', 'Library', 'search']], 'list', (v) => ctx.navigate(v === 'list' ? 'voices' : 'voices/library'), 'Bagian', true);
  const segWrap = h('div', { class: 'voices-seg' }, segEl);

  /* ================= collection ================= */
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Cari di koleksimu...', 'aria-label': 'Cari suara', autocomplete: 'off' }) as HTMLInputElement;
  search.oninput = () => { query = search.value.trim().toLowerCase(); paintList(); };
  const listBox = h('div', { class: 'stack', style: 'gap:22px' });
  const cloneBtn = ui.btn({ label: 'Clone', icon: 'plus', cls: 'primary', onClick: () => ctx.navigate('voices/clone') });
  const listView = h('div', { class: 'page-inner' },
    segWrap,
    h('div', { class: 'voices-top' }, h('div', { class: 'search-wrap', html: S('search') }, search), cloneBtn),
    listBox);

  function useMenu(v: Voice, more: HTMLElement) {
    const box = h('div', null,
      ui.menuItem('Pakai di TTS', 'studio', () => ctx.navigate(`tts?voice=${encodeURIComponent(v.id)}`)),
      ui.menuItem('Pakai di Voice Changer', 'changer', () => ctx.navigate(`vc?voice=${encodeURIComponent(v.id)}`)),
      ui.menuItem('Buat persona dengan suara ini', 'sparkle', () => createPersonaFlow(ctx, { voiceId: v.id })),
      ui.menuItem('Studio Bola', 'palette', () => voiceStudio(v)),
      v.own || v.category !== 'shared' ? h('div', { class: 'menu-sep' }) : null,
      v.own ? ui.menuItem('Hapus suara', 'trash', () => deleteClone(v), 'danger')
        : v.category !== 'shared' ? ui.menuItem('Hapus dari koleksi', 'trash', () => removeVoice(v).then(syncFromStore), 'danger') : null);
    ui.popover(more, box, { align: 'end' });
  }
  function voiceStudio(v: Voice, after?: () => void) {
    openOrbStudio({
      title: 'Studio Bola', subtitle: `Bola suara ${shortName(v)}`, initial: voiceCustomOrb(v.id), base: defaultVoiceOrb(v.id), seedKey: 'v:' + v.id,
      resetLabel: 'Pakai bola bawaan',
      onSave: (o) => { setVoiceOrb(v.id, o); ui.toast(o ? 'Bola suara tersimpan. Persona dengan suara ini ikut memakainya.' : 'Bola suara kembali ke bawaan.', { kind: 'ok', timeout: 2600 }); after?.(); },
    });
  }
  function voiceRow(v: Voice) {
    const more = h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': `Aksi untuk ${v.name}`, 'aria-haspopup': 'menu', html: S('moreV') });
    more.onclick = () => useMenu(v, more);
    const meta = voiceMeta(v);
    const row = h('div', { class: 'v-row' }, voiceOrbButton(v, 48),
      h('div', { class: 'v-t' }, h('b', { title: v.name }, shortName(v)), h('span', null, meta || categoryLabel(v))),
      more);
    const actions = v.own
      ? [{ label: 'Hapus', icon: 'trash', cls: 'danger', run: () => deleteClone(v) }]
      : v.category === 'shared' ? [{ label: 'TTS', icon: 'studio', run: () => ctx.navigate(`tts?voice=${encodeURIComponent(v.id)}`) }]
        : [{ label: 'TTS', icon: 'studio', run: () => ctx.navigate(`tts?voice=${encodeURIComponent(v.id)}`) }, { label: 'Hapus', icon: 'trash', cls: 'danger', run: () => removeVoice(v).then(syncFromStore) }];
    const host = swipeRow(row, [{ label: 'Bola', icon: 'palette', run: () => voiceStudio(v) }, ...actions], S);
    host.setAttribute('role', 'listitem');
    return host;
  }
  function paintList() {
    if (!loaded) { listBox.replaceChildren(h('div', { class: 'v-list' }, ...Array.from({ length: 5 }, () => h('div', { class: 'v-row' }, h('span', { class: 'skel', style: 'width:48px;height:48px;border-radius:50%' }), h('div', { class: 'v-t' }, h('span', { class: 'skel', style: 'height:14px;width:40%' }), h('span', { class: 'skel', style: 'height:12px;width:60%;margin-top:6px' })))))); return; }
    if (loadErr) { listBox.replaceChildren(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, `Gagal memuat suara: ${loadErr}`))); return; }
    const match = (v: Voice) => !query || `${v.name} ${Object.values(v.labels || {}).join(' ')} ${v.description || ''}`.toLowerCase().includes(query);
    const own = voices.filter((v) => v.own && match(v));
    const shared = voices.filter((v) => !v.own && v.category === 'shared' && match(v));
    const added = voices.filter((v) => !v.own && v.category !== 'shared' && match(v));
    const ownAll = voices.filter((v) => v.own).length;
    const sec = (title: string, list: Voice[], side: Node | null, empty?: Node) => h('section', null,
      h('div', { class: 'sec-head' }, h('h2', null, title), side), list.length ? h('div', { class: 'v-list', role: 'list' }, ...list.map(voiceRow)) : empty || null);
    const out: Node[] = [];
    out.push(sec('Milikmu', own, h('span', { class: 'badge' + (ownAll >= maxClones ? ' warn' : '') }, `${ownAll} / ${maxClones}`),
      h('div', { class: 'v-empty' }, h('span', { class: 'empty-ic', html: S('mic') }),
        h('div', null, h('b', null, query ? 'Tidak ada yang cocok' : 'Belum ada suara clone'), h('p', null, query ? 'Coba kata kunci lain.' : canClone() ? 'Buat suara dari rekamanmu sendiri.' : 'Clone suara tidak tersedia untuk akunmu.')))));
    if (shared.length) out.push(sec('Bersama', shared, h('span', { class: 'hint' }, 'Dibagikan untuk semua penguji')));
    if (added.length || !query) out.push(sec('Dari Library', added, h('span', { class: 'hint' }, `${added.length} suara`),
      h('div', { class: 'v-empty lib-cta' }, h('span', { class: 'empty-ic', html: S('search') }),
        h('div', null, h('b', null, 'Koleksimu masih sepi'), h('p', null, 'Jelajahi Library dan tambahkan suara yang kamu suka. Suara di koleksi muncul di TTS, Changer, dan persona.')),
        ui.btn({ label: 'Jelajahi Library', icon: 'search', cls: 'soft', onClick: () => ctx.navigate('voices/library') }))));
    listBox.replaceChildren(...out);
    cloneBtn.hidden = !canClone();
  }
  async function deleteClone(v: Voice) {
    const ok = await ui.confirm({ title: `Hapus "${shortName(v)}"?`, message: 'Suara clone ini dihapus permanen dan tidak bisa dipakai lagi.', confirm: 'Hapus', danger: true });
    if (!ok) return;
    try { await api.del(`/voices/${encodeURIComponent(v.id)}`); ui.toast('Suara dihapus.', { kind: 'ok' }); await reload(); }
    catch (e: any) { ui.toast(e.message, { kind: 'bad', title: 'Gagal menghapus' }); }
  }
  async function reload() {
    try { voices = await ctx.data.voices(true); loadErr = ''; } catch (e: any) { loadErr = e.message; }
    loaded = true; paintList(); paintLib();
  }
  function syncFromStore() { voices = store.get().voices || voices; paintList(); paintLib(); }

  /* ================= library (public ElevenLabs Voice Library) ================= */
  // Thousands of voices: server-side search / filter / paging, and a windowed grid (only the cards near the viewport
  // exist in the DOM; fixed row pitch, absolutely positioned).
  let lib: LibraryVoice[] = [];
  let libPage = 0, libMore = true, libBusy = false, libErr = '', libCtrl: AbortController | null = null, libSeq = 0, libTotal: number | null = null;
  const lq: Required<Pick<LibraryQuery, 'q' | 'gender' | 'age' | 'accent' | 'language' | 'category' | 'useCase' | 'sort'>> =
    { q: '', gender: '', age: '', accent: '', language: '', category: '', useCase: '', sort: 'trending' };
  type AddState = 'adding' | 'full' | 'blocked';
  const addState = new Map<string, AddState>();
  const libSearch = h('input', { class: 'input', type: 'search', placeholder: 'Cari nama, gaya, aksen...', 'aria-label': 'Cari di Library', autocomplete: 'off' }) as HTMLInputElement;
  const sel = (label: string, opts: Array<[string, string]>) => h('select', { class: 'select', 'aria-label': label }, ...opts.map(([v, l]) => new Option(l, v))) as HTMLSelectElement;
  const sortSel = sel('Urutkan', [['trending', 'Sedang populer'], ['usage', 'Paling dipakai'], ['cloned', 'Paling banyak ditambah'], ['created', 'Terbaru']]);
  const filterBtn = h('button', { type: 'button', class: 'btn soft lib-fbtn', 'aria-expanded': 'false', html: S('sliders') }, h('span', null, 'Filter'), h('span', { class: 'lib-fcount', hidden: true }));
  const fSel = {
    gender: sel('Gender', [['', 'Semua gender'], ...FACET.genders.map((g): [string, string] => [g, G_LABEL[g] || cap(g)])]),
    age: sel('Usia', [['', 'Semua usia'], ...FACET.ages.map((a): [string, string] => [a, AGE_LABEL[a] || cap(a)])]),
    accent: sel('Aksen', [['', 'Semua aksen'], ...FACET.accents.map((a): [string, string] => [a, cap(a)])]),
    language: sel('Bahasa', [['', 'Semua bahasa'], ...FACET.languages.map((l): [string, string] => [l.code, l.name])]),
    category: sel('Kategori', [['', 'Semua kategori'], ...FACET.categories.map((c): [string, string] => [c, CAT_LABEL[c] || cap(c)])]),
    useCase: sel('Kegunaan', [['', 'Semua kegunaan'], ...FACET.useCases.map((u): [string, string] => [u, UC_LABEL[u] || cap(u)])]),
  };
  const resetBtn = ui.btn({ label: 'Reset filter', cls: 'ghost sm', onClick: () => { for (const k of Object.keys(fSel) as Array<keyof typeof fSel>) { fSel[k].value = ''; lq[k] = ''; } syncFilterCount(); loadLib(true); } });
  const fPanel = h('div', { class: 'lib-fpanel', hidden: true },
    ...(Object.entries(fSel) as Array<[keyof typeof fSel, HTMLSelectElement]>).map(([k, s]) => h('label', { class: 'lib-f' }, h('span', null, F_LABEL[k]), s)),
    h('div', { class: 'lib-freset' }, resetBtn));
  filterBtn.onclick = () => { fPanel.hidden = !fPanel.hidden; filterBtn.setAttribute('aria-expanded', String(!fPanel.hidden)); };
  const libInfo = h('div', { class: 'lib-info', 'aria-live': 'polite' });
  const virt = h('div', { class: 'lib-virt', role: 'list', 'aria-label': 'Library suara' });
  const libFoot = h('div', { class: 'lib-foot' });
  const sentinel = h('div', { class: 'lib-sentinel', 'aria-hidden': 'true' });
  const libView = h('div', { class: 'page-inner' },
    segWrap.cloneNode(false),
    h('div', { class: 'lib-filters' }, h('div', { class: 'search-wrap', html: S('search') }, libSearch), h('div', { class: 'lib-tools' }, filterBtn, sortSel)),
    fPanel, libInfo, virt, libFoot, sentinel);
  let qT: ReturnType<typeof setTimeout> | null = null;
  libSearch.oninput = () => { if (qT) clearTimeout(qT); qT = setTimeout(() => { lq.q = libSearch.value.trim(); loadLib(true); }, 350); };
  sortSel.onchange = () => { lq.sort = sortSel.value as typeof lq.sort; loadLib(true); };
  for (const [k, s] of Object.entries(fSel) as Array<[keyof typeof fSel, HTMLSelectElement]>) s.onchange = () => { lq[k] = s.value; syncFilterCount(); loadLib(true); };
  function syncFilterCount() {
    const n = (Object.keys(fSel) as Array<keyof typeof fSel>).filter((k) => lq[k]).length;
    const c = filterBtn.querySelector('.lib-fcount') as HTMLElement;
    c.hidden = !n; c.textContent = String(n);
    resetBtn.disabled = !n;
  }

  const inCol = (v: LibraryVoice) => voices.some((x) => x.id === v.id || x.sourceId === v.id || (v.collectionId && x.id === v.collectionId)) || (!!v.inCollection && !store.get().voices);
  const fmtNum = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.0', '')} jt` : n >= 1000 ? `${(n / 1000).toFixed(1).replace('.0', '')} rb` : String(n);
  const langName = (c?: string) => (c ? FACET.languages.find((l) => l.code === c)?.name || c.toUpperCase() : '');
  const libMeta = (v: LibraryVoice) => [v.gender && (G_LABEL[v.gender] || cap(v.gender)), v.age && (AGE_LABEL[v.age] || cap(v.age)), v.accent && cap(v.accent), langName(v.language)].filter(Boolean).join(' · ');
  const warnOf = (v: LibraryVoice) => v.warnings.filter((w) => w.level === 'warn');
  const WARN_SHORT: Record<string, (w: LibraryWarning) => string> = {
    notice_period: (w) => `Notice ${w.days} hr`, live_moderation: () => 'Dimoderasi', custom_rate: (w) => `Tarif ${w.rate}x`, not_on_plan: () => 'Tidak di paket',
  };

  function addBtnFor(v: LibraryVoice) {
    const added = inCol(v), st = addState.get(v.id);
    const blocked = !v.addable || st === 'blocked';
    const [label, icon, cls] = st === 'adding' ? ['Menambahkan...', '', 'soft'] : added ? ['Terpasang', 'check', 'on'] : st === 'full' ? ['Slot penuh', 'alert', 'warnb'] : blocked ? ['Tidak tersedia', 'ban', 'ghost'] : ['Tambah', 'plus', 'soft'];
    const btn = h('button', { type: 'button', class: `btn sm lib-add ${cls}`, 'aria-pressed': String(added), 'aria-label': `${label}: ${shortName(v)}`, disabled: st === 'adding' || (!added && blocked) },
      st === 'adding' ? h('span', { class: 'spinner' }) : h('span', { class: 'ic-w', html: S(icon) }), h('span', null, label));
    btn.title = added ? 'Ketuk untuk menghapus dari koleksi' : st === 'full' ? 'Slot suara server penuh. Ketuk untuk mencoba lagi.' : blocked ? 'Tidak bisa dipakai pada paket akun server' : 'Tambahkan ke koleksimu';
    btn.onclick = (e) => { e.stopPropagation(); toggleLib(v); };
    return btn;
  }
  async function toggleLib(v: LibraryVoice) {
    if (addState.get(v.id) === 'adding') return;
    if (inCol(v)) {
      addState.set(v.id, 'adding'); refreshCard(v.id);
      const ok = await removeVoice({ ...v, id: v.collectionId || v.id });
      addState.delete(v.id);
      if (ok) { v.inCollection = false; syncFromStore(); } else refreshCard(v.id);
      return;
    }
    player.stop();
    addState.set(v.id, 'adding'); refreshCard(v.id);
    const r = await addVoiceResult(v);
    if (r.ok) {
      addState.delete(v.id); v.inCollection = true; v.collectionId = r.voiceId;
      haptic(); ui.toast(`"${shortName(v)}" ditambahkan ke koleksimu.`, { kind: 'ok', timeout: 2600 });
      syncFromStore();
      return;
    }
    if (r.code === 'slots_full') addState.set(v.id, 'full');
    else if (r.code === 'not_addable' || r.code === 'not_in_library') addState.set(v.id, 'blocked');
    else addState.delete(v.id);
    ui.toast(r.message, { kind: r.code === 'slots_full' || r.code === 'collection_full' ? 'warn' : 'bad', title: r.code === 'slots_full' ? 'Slot suara penuh' : 'Belum bisa ditambahkan' });
    refreshCard(v.id);
  }
  function libCard(v: LibraryVoice) {
    const added = inCol(v);
    const warns = warnOf(v);
    const chips: Node[] = [];
    // warnings first so they are never clipped on narrow cards
    for (const w of warns.slice(0, 2)) chips.push(h('span', { class: 'lib-chip warn', title: w.message }, (WARN_SHORT[w.code] || (() => cap(w.code)))(w)));
    if (v.category === 'high_quality') chips.push(h('span', { class: 'lib-chip hq' }, 'HQ'));
    if (v.useCase) chips.push(h('span', { class: 'lib-chip' }, UC_LABEL[v.useCase] || cap(v.useCase)));
    if (!warns.length && v.clonedBy > 0) chips.push(h('span', { class: 'lib-chip muted' }, `${fmtNum(v.clonedBy)} pakai`));
    const body = h('button', { type: 'button', class: 'lib-body', 'aria-label': `Detail ${v.name}` },
      h('b', { title: v.name }, shortName(v)),
      h('span', { class: 'lib-meta' }, libMeta(v) || v.description || 'Library'),
      h('span', { class: 'lib-chips' }, ...chips));
    body.onclick = () => libDetail(v);
    const card = h('div', { class: 'lib-card' + (added ? ' added' : ''), role: 'listitem', 'data-id': v.id }, voiceOrbButton(v, 52), body, addBtnFor(v));
    return card;
  }
  function libDetail(v: LibraryVoice) {
    const rows: Array<[string, string]> = [
      ['Gender', v.gender ? G_LABEL[v.gender] || cap(v.gender) : '-'], ['Usia', v.age ? AGE_LABEL[v.age] || cap(v.age) : '-'],
      ['Aksen', v.accent ? cap(v.accent) : '-'], ['Bahasa', [langName(v.language), v.locale].filter(Boolean).join(' · ') || '-'],
      ['Kegunaan', v.useCase ? UC_LABEL[v.useCase] || cap(v.useCase) : '-'], ['Gaya', v.descriptive ? cap(v.descriptive) : '-'],
      ['Kategori', v.category ? CAT_LABEL[v.category] || cap(v.category) : '-'], ['Dipakai', `${fmtNum(v.clonedBy)} pengguna`],
      ['Masa pemberitahuan', v.noticePeriodDays ? `${v.noticePeriodDays} hari` : 'Tidak ada'],
    ];
    const addSlot = h('div', null, addBtnFor(v));
    const sync = () => addSlot.replaceChildren(addBtnFor(v));
    const unsub = store.select((s) => s.voices, sync);
    const watch = setInterval(sync, 400); // add state changes (adding -> done) while the sheet is open
    // shared element: the card's orb grows into the sheet's orb (and back when it closes)
    const cardOrb = document.querySelector<HTMLElement>(`.lib-card[data-id="${CSS.escape(v.id)}"] .orb`);
    const headBtn = voiceOrbButton(v, 72);
    const m = ui.modal({
      title: shortName(v), cls: 'lib-dlg', onClose: () => { unsub(); clearInterval(watch); if (cardOrb?.isConnected) void flyOrb(headBtn.querySelector('.orb'), cardOrb, 360); },
      body: h('div', { class: 'lib-detail' },
        h('div', { class: 'lib-dhead' }, headBtn, h('div', null, h('b', null, v.name), h('span', null, libMeta(v)))),
        v.description ? h('p', { class: 'lib-ddesc' }, v.description) : null,
        ...v.warnings.map((w) => h('div', { class: `notice ${w.level === 'warn' ? 'warn' : 'info'}`, html: S(w.level === 'warn' ? 'alert' : 'info') }, h('span', null, w.message))),
        h('dl', { class: 'lib-dl' }, ...rows.flatMap(([k, val]) => [h('dt', null, k), h('dd', null, val)])),
        h('p', { class: 'hint' }, 'Suara komunitas dari Voice Library ElevenLabs. Menambahkannya memasang suara ini di akun server (satu slot, dipakai bersama semua pengguna).'),
        addSlot),
    });
    void m;
    void flyOrb(cardOrb, headBtn.querySelector('.orb'));
  }

  /* ---- windowed grid ---- */
  const GAP = 8;
  const ROW_H = 96; // card height (fixed: 3 text lines max)
  const PITCH = ROW_H + GAP;
  const mounted = new Map<number, HTMLElement>();
  let cols = 1, raf = 0;
  const scroller = document.getElementById('view')!;
  function layoutLib() {
    cols = virt.clientWidth >= 640 ? 2 : 1;
    const rows = Math.ceil(lib.length / cols);
    virt.style.height = rows ? `${rows * PITCH - GAP}px` : '0px';
    for (const el of mounted.values()) el.remove();
    mounted.clear();
    windowLib();
  }
  function placeCard(i: number, el: HTMLElement) {
    const r = Math.floor(i / cols), c = i % cols;
    el.style.top = `${r * PITCH}px`;
    el.style.left = cols === 1 ? '0' : `calc(${c} * (100% + ${GAP}px) / ${cols})`;
    el.style.width = cols === 1 ? '100%' : `calc((100% - ${GAP * (cols - 1)}px) / ${cols})`;
  }
  function windowLib() {
    raf = 0;
    if (view !== 'library' || !virt.isConnected) return;
    const vr = virt.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    const buf = sr.height; // one screen above and below
    const y0 = sr.top - vr.top - buf, y1 = sr.bottom - vr.top + buf;
    const r0 = Math.max(0, Math.floor(y0 / PITCH)), r1 = Math.max(-1, Math.ceil(y1 / PITCH));
    const i0 = r0 * cols, i1 = Math.min(lib.length - 1, (r1 + 1) * cols - 1);
    for (const [i, el] of mounted) if (i < i0 || i > i1) { el.remove(); mounted.delete(i); }
    for (let i = i0; i <= i1; i++) {
      if (mounted.has(i)) continue;
      const el = libCard(lib[i]);
      placeCard(i, el);
      virt.append(el);
      mounted.set(i, el);
    }
    // near the end: fetch the next page (the sentinel observer covers the rest)
    if (i1 >= lib.length - cols * 4 && libMore && !libBusy && !libErr && lib.length) loadLib(false);
  }
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(windowLib); };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(() => { if (view === 'library') { const c = virt.clientWidth >= 640 ? 2 : 1; if (c !== cols) layoutLib(); else onScroll(); } });
  ro.observe(virt);
  function refreshCard(id: string) {
    for (const [i, el] of mounted) if (lib[i]?.id === id) { const n = libCard(lib[i]); placeCard(i, n); el.replaceWith(n); mounted.set(i, n); }
  }
  function refreshAllCards() { for (const [i, el] of mounted) { const n = libCard(lib[i]); placeCard(i, n); el.replaceWith(n); mounted.set(i, n); } }

  function paintLib(mode: 'full' | 'cards' | 'foot' = 'cards') {
    if (view !== 'library') return;
    if (mode === 'full') layoutLib(); else if (mode === 'cards') refreshAllCards();
    libInfo.textContent = libErr || (!lib.length && libBusy) ? '' : libTotal != null ? `${libTotal.toLocaleString('id-ID')} suara di Voice Library ElevenLabs` : lib.length ? `${lib.length.toLocaleString('id-ID')} suara dimuat` : '';
    const foot: Node[] = [];
    if (!lib.length && libBusy) foot.push(h('div', { class: 'lib-skel' }, ...Array.from({ length: 6 }, () => h('div', { class: 'lib-card' }, h('span', { class: 'skel', style: 'width:52px;height:52px;border-radius:50%' }), h('div', { class: 'v-t' }, h('span', { class: 'skel', style: 'height:14px;width:50%' }), h('span', { class: 'skel', style: 'height:12px;width:70%;margin-top:6px' }))))));
    else if (libErr) foot.push(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, libErr), ui.btn({ label: 'Coba lagi', cls: 'sm ghost', onClick: () => loadLib(!lib.length) })));
    else if (!lib.length && !libBusy) foot.push(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: S('search') }), h('h3', null, 'Tidak ada suara'), h('p', null, 'Coba kata kunci atau filter lain.')));
    else if (libBusy) foot.push(h('span', { class: 'spinner' }));
    else if (libMore) foot.push(ui.btn({ label: 'Muat lagi', cls: 'ghost', onClick: () => loadLib(false) }));
    else foot.push(h('span', { class: 'hint' }, 'Sudah semua.'));
    libFoot.replaceChildren(...foot);
  }
  async function loadLib(reset: boolean) {
    if (reset) { libCtrl?.abort(); lib = []; libPage = 0; libMore = true; libErr = ''; libTotal = null; scroller.scrollTo({ top: 0 }); }
    else if (libBusy || !libMore) return;
    const seq = ++libSeq;
    libBusy = true; paintLib(reset ? 'full' : 'foot');
    libCtrl = new AbortController();
    try {
      const r: LibraryPage = await api.library({ ...lq, page: libPage + 1, pageSize: 30 }, libCtrl.signal);
      if (seq !== libSeq) return;
      const seen = new Set(lib.map((v) => v.id));
      lib.push(...r.voices.filter((v) => !seen.has(v.id)));
      libPage = r.page; libMore = r.hasMore && r.voices.length > 0;
      if (typeof r.total === 'number') libTotal = r.total;
    } catch (e: any) {
      if (seq !== libSeq || e?.code === 'aborted') return;
      libErr = e?.status === 404 ? 'Library belum tersedia di server.' : e.message || 'Gagal memuat Library.';
    } finally {
      if (seq === libSeq) {
        libBusy = false;
        const rows = Math.ceil(lib.length / cols);
        virt.style.height = rows ? `${rows * PITCH - GAP}px` : '0px';
        paintLib('foot');
        windowLib();
      }
    }
  }
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && view === 'library' && lib.length && libMore && !libBusy && !libErr) loadLib(false); }, { rootMargin: '600px 0px' });
  io.observe(sentinel);

  /* ================= clone ================= */
  const samples: Sample[] = [];
  let rec: Recorder | null = null, recRaf = 0;
  let uploadCtrl: AbortController | null = null;
  const name = h('input', { class: 'input', maxLength: 60, placeholder: 'mis. Suaraku', autocomplete: 'off' }) as HTMLInputElement;
  const desc = h('textarea', { class: 'textarea', rows: 2, maxLength: 500, placeholder: 'Opsional: ciri suara, aksen, catatan' }) as HTMLTextAreaElement;
  const fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac', multiple: true, hidden: true }) as HTMLInputElement;
  const addFileBtn = h('button', { type: 'button', class: 'add-tile', html: S('upload') }, h('b', null, 'Unggah file'), h('span', null, 'MP3, WAV, M4A'));
  const recTile = h('button', { type: 'button', class: 'add-tile', html: S('mic') }, h('b', null, 'Rekam'), h('span', null, 'dari mikrofon'));
  const sampleList = h('div', { class: 'samples' });
  const consent = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const progress = h('div', { class: 'progress', hidden: true }, h('i'));
  const submit = h('button', { type: 'submit', class: 'btn primary lg block' }, 'Buat clone suara');
  const cloneMsg = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'stack', style: 'gap:20px', novalidate: true },
    field('Nama suara', name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Sampel audio'),
      h('div', { class: 'hint' }, `1–${maxFiles} sampel, total 1–3 menit, satu pembicara, tanpa musik atau gema.`),
      h('div', { class: 'add-tiles' }, addFileBtn, recTile), sampleList, fileInput),
    h('details', { class: 'disclosure' }, h('summary', null, h('span', null, 'Lanjutan'), h('small', null, 'Deskripsi')), h('div', { class: 'disc-b' }, field('Deskripsi', desc))),
    h('label', { class: 'check consent' }, consent,
      h('span', null, 'Ini suaraku sendiri, atau aku punya izin dari pemiliknya. Aku tidak akan memakainya untuk menipu atau meniru orang lain.',
        h('small', null, 'Wajib. Clone bisa dihapus kapan saja.'))),
    cloneMsg, progress, submit);
  const cloneView = h('div', { class: 'page-inner' }, form);

  const clearWarn = () => { if (cloneMsg.querySelector('.notice.warn')) cloneMsg.replaceChildren(); };
  name.addEventListener('input', clearWarn); consent.addEventListener('change', clearWarn);
  function paintSamples() {
    clearWarn();
    sampleList.replaceChildren(...samples.map((s, i) => {
      const rm = h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': 'Hapus sampel', title: 'Hapus', html: S('x') });
      rm.onclick = () => { samples.splice(i, 1); paintSamples(); };
      return h('div', { class: 'sample' }, miniPlayer(s.file, { label: s.source === 'mic' ? `Rekaman ${i + 1}` : s.file.name, sub: [fmtDur(s.duration), `${(s.file.size / 1024 / 1024).toFixed(1)} MB`].filter(Boolean).join(' · '), knownDuration: s.duration }), rm);
    }));
    const full = samples.length >= maxFiles;
    addFileBtn.disabled = full; recTile.disabled = full && !rec;
  }
  async function addFiles(files: Iterable<File>) {
    for (const f of files) {
      if (samples.length >= maxFiles) { ui.toast(`Maksimal ${maxFiles} sampel.`, { kind: 'warn' }); break; }
      const okType = f.type.startsWith('audio/') || f.type === 'video/webm' || /\.(mp3|wav|m4a|ogg|oga|webm|flac|aac|opus)$/i.test(f.name);
      if (!okType) { ui.toast(`${f.name}: bukan file audio.`, { kind: 'warn' }); continue; }
      if (f.size > maxMb * 1024 * 1024) { ui.toast(`${f.name}: lebih dari ${maxMb} MB.`, { kind: 'warn' }); continue; }
      samples.push({ file: f, source: 'file', duration: await probeDuration(f) });
    }
    paintSamples();
  }
  addFileBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => { addFiles([...(fileInput.files || [])]); fileInput.value = ''; };
  const recLabel = () => recTile.querySelector('b')!;
  recTile.onclick = async () => {
    if (rec) {
      const r = rec; rec = null; cancelAnimationFrame(recRaf); recTile.classList.remove('on'); recTile.style.removeProperty('--lvl');
      recLabel().textContent = 'Rekam'; (recTile.querySelector('span') as HTMLElement).textContent = 'dari mikrofon';
      const out = await r.stop();
      if (!out) { ui.toast('Rekaman terlalu pendek.', { kind: 'warn' }); paintSamples(); return; }
      samples.push({ file: out.file, source: 'mic', duration: out.duration }); paintSamples();
      return;
    }
    if (!canRecord()) { ui.toast('Browser ini tidak mendukung perekaman.', { kind: 'warn' }); return; }
    player.stop(); pauseAllMini();
    try { rec = await startRecording({ maxSec: 300, name: `rekaman-${samples.length + 1}` }); } catch (e: any) { ui.toast(e.message, { kind: 'warn' }); return; }
    recTile.classList.add('on');
    const tick = () => { if (!rec) return; recLabel().textContent = `Stop · ${fmtDur(rec.elapsed())}`; (recTile.querySelector('span') as HTMLElement).textContent = 'ketuk untuk selesai'; recTile.style.setProperty('--lvl', rec.level().toFixed(3)); recRaf = requestAnimationFrame(tick); };
    tick();
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const problems: string[] = [];
    if (!name.value.trim()) problems.push('Isi nama suara.');
    if (!samples.length) problems.push('Tambahkan minimal satu sampel.');
    if (!consent.checked) problems.push('Centang pernyataan persetujuan.');
    if (problems.length) { cloneMsg.replaceChildren(h('div', { class: 'notice warn', html: S('alert') }, h('span', null, problems.join(' ')))); return; }
    const fd = new FormData();
    fd.append('name', name.value.trim());
    if (desc.value.trim()) fd.append('description', desc.value.trim());
    fd.append('consent', 'true');
    for (const s of samples) fd.append('files', s.file, s.file.name);
    uploadCtrl = new AbortController();
    submit.disabled = true; progress.hidden = false; progress.classList.remove('indet');
    cloneMsg.replaceChildren(h('div', { class: 'hint' }, 'Mengunggah sampel...'));
    const bar = progress.firstElementChild as HTMLElement; bar.style.width = '0%';
    try {
      const r = await api.upload<{ voice: Voice }>('/voices/clone', fd, { signal: uploadCtrl.signal, onProgress: (p) => {
        bar.style.width = Math.round(p * 100) + '%';
        if (p >= 1) { progress.classList.add('indet'); cloneMsg.replaceChildren(h('div', { class: 'hint' }, 'Memproses suara...')); }
      } });
      const made: Voice = r?.voice?.id ? r.voice : { id: '', name: name.value.trim(), category: 'cloned', own: true };
      name.value = ''; desc.value = ''; consent.checked = false; samples.splice(0); paintSamples(); cloneMsg.replaceChildren();
      await reload();
      ctx.navigate('voices');
      // after the route change (modals close on hashchange)
      if (made.id) setTimeout(() => offerAfterClone(voices.find((x) => x.id === made.id) || made), 150);
      else ui.toast(`Suara "${made.name}" siap dipakai.`, { kind: 'ok', title: 'Clone berhasil' });
    } catch (err: any) {
      cloneMsg.replaceChildren(err?.code === 'aborted' ? '' : h('div', { class: 'notice bad', html: S('xCircle') }, h('span', null, err.message)));
    } finally { uploadCtrl = null; progress.hidden = true; submit.disabled = false; }
  };

  /** After a clone: try it, make a persona with it, or shape its orb. */
  function offerAfterClone(v: Voice) {
    const big = orb(voiceOrb(v.id), { size: 132, cls: 'offer-orb', live: true, label: `Bola suara ${shortName(v)}` });
    const persona = h('button', { type: 'button', class: 'btn primary lg block', html: S('sparkle') }, h('span', null, 'Buat persona dengan suara ini'));
    const shape = h('button', { type: 'button', class: 'btn soft lg block', html: S('palette') }, h('span', null, 'Bentuk bola suaranya'));
    const tts = h('button', { type: 'button', class: 'btn ghost block', html: S('studio') }, h('span', null, 'Coba di TTS'));
    const m = ui.modal({ title: 'Clone berhasil', cls: 'offer-dlg', body: h('div', { class: 'offer' }, big,
      h('h3', null, shortName(v)), h('p', null, 'Suaramu siap. Jadikan suara sebuah persona untuk diajak ngobrol, atau beri dia bola sendiri.'), persona, shape, tts) });
    persona.onclick = () => { m.close(); createPersonaFlow(ctx, { voiceId: v.id }); };
    shape.onclick = () => voiceStudio(v, () => big.setSpec(voiceOrb(v.id)));
    tts.onclick = () => { m.close(); ctx.navigate(`tts?voice=${encodeURIComponent(v.id)}`); };
  }

  /* ================= views ================= */
  // the library view gets its own copy of the segmented control (a node can only live in one place)
  const libSeg = seg<'list' | 'library'>([['list', 'Koleksiku', 'voices'], ['library', 'Library', 'search']], 'library', (v) => ctx.navigate(v === 'list' ? 'voices' : 'voices/library'), 'Bagian', true);
  libView.firstElementChild!.replaceWith(h('div', { class: 'voices-seg' }, libSeg));
  const refreshBtn = h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Muat ulang', title: 'Muat ulang', html: S('refresh') });
  refreshBtn.onclick = () => (view === 'library' ? loadLib(true) : reload());

  function show(r: RouteInfo) {
    const sub = r.path.split('/')[1] || '';
    let next: typeof view = sub === 'clone' ? 'clone' : sub === 'library' ? 'library' : 'list';
    if (next === 'clone' && !canClone()) { history.replaceState(null, '', '#/voices'); next = 'list'; }
    player.stop(); pauseAllMini();
    if (next !== 'clone' && rec) { rec.cancel(); rec = null; cancelAnimationFrame(recRaf); }
    view = next;
    ctx.shell.setTitle(next === 'clone' ? 'Clone suara' : next === 'library' ? 'Library suara' : 'Voices');
    ctx.shell.setBack(next === 'clone' ? () => (history.length > 1 ? history.back() : ctx.navigate('voices')) : null);
    ctx.shell.setActions(next === 'clone' ? [] : [refreshBtn]);
    segEl.setValue('list'); libSeg.setValue('library');
    page.replaceChildren(next === 'clone' ? cloneView : next === 'library' ? libView : listView);
    document.getElementById('view')?.scrollTo({ top: 0 });
    if (next === 'clone') {
      paintSamples();
      const own = voices.filter((v) => v.own).length;
      if (loaded && own >= maxClones) cloneMsg.replaceChildren(h('div', { class: 'notice warn', html: S('alert') }, h('span', null, `Batas ${maxClones} clone tercapai. Hapus salah satu suara milikmu dulu.`)));
    }
    if (next === 'library') { syncFilterCount(); if (!lib.length && !libBusy) loadLib(true); else requestAnimationFrame(() => paintLib('full')); }
    if (next === 'list') paintList();
  }

  const unPtr = pullToRefresh(scroller, page, () => (view === 'library' ? loadLib(true) : view === 'list' ? reload() : Promise.resolve()), S);
  onDisconnect(page, onOrbsChange(() => { paintList(); paintLib(); }));
  onDisconnect(page, store.select((s) => s.voices, (v) => { if (v) { voices = v; loaded = true; paintList(); paintLib(); } }));
  ctx.data.config().then((c) => { maxClones = c.limits?.maxClones ?? maxClones; maxMb = c.limits?.maxCloneUploadMb ?? maxMb; maxFiles = c.limits?.maxCloneFiles ?? maxFiles; paintList(); }).catch(() => {});
  paintList(); paintSamples();
  ctx.data.voices().then((l) => { voices = l; loaded = true; paintList(); paintLib(); }).catch((e) => { loaded = true; loadErr = e.message; paintList(); });
  show(ctx.route);

  return {
    cleanup: () => {
      player.stop(); uploadCtrl?.abort(); libCtrl?.abort(); rec?.cancel(); cancelAnimationFrame(recRaf); cancelAnimationFrame(raf); pauseAllMini(); io.disconnect(); ro.disconnect(); scroller.removeEventListener('scroll', onScroll); unPtr();
    },
    onRoute: show,
  };
}
