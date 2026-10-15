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
import { locale, t } from '../../i18n';
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
  languages: [['en', 'English'], ['id', t('Indonesia')], ['ms', t('Melayu')], ['ja', t('Jepang')], ['ko', t('Korea')], ['zh', t('Mandarin')], ['hi', 'Hindi'],
    ['ar', t('Arab')], ['es', t('Spanyol')], ['pt', t('Portugis')], ['fr', t('Prancis')], ['de', t('Jerman')], ['it', t('Italia')], ['nl', t('Belanda')],
    ['ru', t('Rusia')], ['pl', t('Polandia')], ['tr', t('Turki')], ['sv', t('Swedia')], ['vi', t('Vietnam')], ['th', 'Thai'], ['fil', 'Filipino'],
    ['ta', 'Tamil'], ['uk', t('Ukraina')], ['cs', t('Ceko')], ['el', t('Yunani')], ['ro', t('Rumania')], ['da', t('Denmark')], ['fi', t('Finlandia')], ['no', t('Norwegia')], ['hu', t('Hungaria')]]
    .map(([code, name]) => ({ code, name })),
  categories: ['high_quality', 'professional'],
  useCases: ['conversational', 'narrative_story', 'characters_animation', 'social_media', 'entertainment_tv', 'advertisement', 'informative_educational'],
};
const cap = (s: string) => s.replace(/[_-]+/g, ' ').replace(/(^|\s)(\p{L})/gu, (_m, a: string, c: string) => a + c.toUpperCase());
const G_LABEL: Record<string, string> = { female: t('Perempuan'), male: t('Laki-laki'), neutral: t('Netral') };
const AGE_LABEL: Record<string, string> = { young: t('Muda'), middle_aged: t('Dewasa'), old: t('Tua') };
const CAT_LABEL: Record<string, string> = { high_quality: t('Kualitas tinggi'), professional: t('Profesional'), generated: t('Buatan AI'), famous: t('Terkenal') };
const UC_LABEL: Record<string, string> = {
  conversational: t('Percakapan'), narrative_story: t('Narasi & cerita'), characters_animation: t('Karakter & animasi'), social_media: t('Media sosial'),
  entertainment_tv: t('Hiburan & TV'), advertisement: t('Iklan'), informative_educational: t('Edukasi'),
};
const F_LABEL = { gender: 'Gender', age: t('Usia'), accent: t('Aksen'), language: t('Bahasa'), category: t('Kategori'), useCase: t('Kegunaan') };

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

  const segEl = seg<'list' | 'library'>([['list', t('Koleksiku'), 'voices'], ['library', 'Library', 'search']], 'list', (v) => ctx.navigate(v === 'list' ? 'voices' : 'voices/library'), t('Bagian'), true);
  const segWrap = h('div', { class: 'voices-seg' }, segEl);

  /* ================= collection ================= */
  const search = h('input', { class: 'input', type: 'search', placeholder: t('Cari di koleksimu...'), 'aria-label': t('Cari suara'), autocomplete: 'off' }) as HTMLInputElement;
  search.oninput = () => { query = search.value.trim().toLowerCase(); paintList(); };
  const listBox = h('div', { class: 'stack', style: 'gap:22px' });
  const cloneBtn = ui.btn({ label: 'Clone', icon: 'plus', cls: 'primary', onClick: () => ctx.navigate('voices/clone') });
  const listView = h('div', { class: 'page-inner' },
    segWrap,
    h('div', { class: 'voices-top' }, h('div', { class: 'search-wrap', html: S('search') }, search), cloneBtn),
    listBox);

  function useMenu(v: Voice, more: HTMLElement) {
    const box = h('div', null,
      ui.menuItem(t('Pakai di TTS'), 'studio', () => ctx.navigate(`tts?voice=${encodeURIComponent(v.id)}`)),
      ui.menuItem(t('Pakai di Voice Changer'), 'changer', () => ctx.navigate(`vc?voice=${encodeURIComponent(v.id)}`)),
      ui.menuItem(t('Buat persona dengan suara ini'), 'sparkle', () => createPersonaFlow(ctx, { voiceId: v.id })),
      ui.menuItem(t('Studio Bola'), 'palette', () => voiceStudio(v)),
      v.own || v.category !== 'shared' ? h('div', { class: 'menu-sep' }) : null,
      v.own ? ui.menuItem(t('Hapus suara'), 'trash', () => deleteClone(v), 'danger')
        : v.category !== 'shared' ? ui.menuItem(t('Hapus dari koleksi'), 'trash', () => removeVoice(v).then(syncFromStore), 'danger') : null);
    ui.popover(more, box, { align: 'end' });
  }
  function voiceStudio(v: Voice, after?: () => void) {
    openOrbStudio({
      title: t('Studio Bola'), subtitle: t('Bola suara {name}', { name: shortName(v) }), initial: voiceCustomOrb(v.id), base: defaultVoiceOrb(v.id), seedKey: 'v:' + v.id,
      resetLabel: t('Pakai bola bawaan'),
      onSave: (o) => { setVoiceOrb(v.id, o); ui.toast(o ? t('Bola suara tersimpan. Persona dengan suara ini ikut memakainya.') : t('Bola suara kembali ke bawaan.'), { kind: 'ok', timeout: 2600 }); after?.(); },
    });
  }
  function voiceRow(v: Voice) {
    const more = h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': t('Aksi untuk {name}', { name: v.name }), 'aria-haspopup': 'menu', html: S('moreV') });
    more.onclick = () => useMenu(v, more);
    const meta = voiceMeta(v);
    const row = h('div', { class: 'v-row' }, voiceOrbButton(v, 48),
      h('div', { class: 'v-t' }, h('b', { title: v.name }, shortName(v)), h('span', null, meta || categoryLabel(v))),
      more);
    const actions = v.own
      ? [{ label: t('Hapus'), icon: 'trash', cls: 'danger', run: () => deleteClone(v) }]
      : v.category === 'shared' ? [{ label: 'TTS', icon: 'studio', run: () => ctx.navigate(`tts?voice=${encodeURIComponent(v.id)}`) }]
        : [{ label: 'TTS', icon: 'studio', run: () => ctx.navigate(`tts?voice=${encodeURIComponent(v.id)}`) }, { label: t('Hapus'), icon: 'trash', cls: 'danger', run: () => removeVoice(v).then(syncFromStore) }];
    const host = swipeRow(row, [{ label: t('Bola'), icon: 'palette', run: () => voiceStudio(v) }, ...actions], S);
    host.setAttribute('role', 'listitem');
    return host;
  }
  function paintList() {
    if (!loaded) { listBox.replaceChildren(h('div', { class: 'v-list' }, ...Array.from({ length: 5 }, () => h('div', { class: 'v-row' }, h('span', { class: 'skel', style: 'width:48px;height:48px;border-radius:50%' }), h('div', { class: 'v-t' }, h('span', { class: 'skel', style: 'height:14px;width:40%' }), h('span', { class: 'skel', style: 'height:12px;width:60%;margin-top:6px' })))))); return; }
    if (loadErr) { listBox.replaceChildren(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, t('Gagal memuat suara: {err}', { err: loadErr })))); return; }
    const match = (v: Voice) => !query || `${v.name} ${Object.values(v.labels || {}).join(' ')} ${v.description || ''}`.toLowerCase().includes(query);
    const own = voices.filter((v) => v.own && match(v));
    const shared = voices.filter((v) => !v.own && v.category === 'shared' && match(v));
    const added = voices.filter((v) => !v.own && v.category !== 'shared' && match(v));
    const ownAll = voices.filter((v) => v.own).length;
    const sec = (title: string, list: Voice[], side: Node | null, empty?: Node) => h('section', null,
      h('div', { class: 'sec-head' }, h('h2', null, title), side), list.length ? h('div', { class: 'v-list', role: 'list' }, ...list.map(voiceRow)) : empty || null);
    const out: Node[] = [];
    out.push(sec(t('Milikmu'), own, h('span', { class: 'badge' + (ownAll >= maxClones ? ' warn' : '') }, `${ownAll} / ${maxClones}`),
      h('div', { class: 'v-empty' }, h('span', { class: 'empty-ic', html: S('mic') }),
        h('div', null, h('b', null, query ? t('Tidak ada yang cocok') : t('Belum ada suara clone')), h('p', null, query ? t('Coba kata kunci lain.') : canClone() ? t('Buat suara dari rekamanmu sendiri.') : t('Clone suara tidak tersedia untuk akunmu.'))))));
    if (shared.length) out.push(sec(t('Bersama'), shared, h('span', { class: 'hint' }, t('Dibagikan untuk semua penguji'))));
    if (added.length || !query) out.push(sec(t('Dari Library'), added, h('span', { class: 'hint' }, added.length === 1 ? t('1 suara') : t('{n} suara', { n: added.length })),
      h('div', { class: 'v-empty lib-cta' }, h('span', { class: 'empty-ic', html: S('search') }),
        h('div', null, h('b', null, t('Koleksimu masih sepi')), h('p', null, t('Jelajahi Library dan tambahkan suara yang kamu suka. Suara di koleksi muncul di TTS, Changer, dan persona.'))),
        ui.btn({ label: t('Jelajahi Library'), icon: 'search', cls: 'soft', onClick: () => ctx.navigate('voices/library') }))));
    listBox.replaceChildren(...out);
    cloneBtn.hidden = !canClone();
  }
  async function deleteClone(v: Voice) {
    const ok = await ui.confirm({ title: t('Hapus "{name}"?', { name: shortName(v) }), message: t('Suara clone ini dihapus permanen dan tidak bisa dipakai lagi.'), confirm: t('Hapus'), danger: true });
    if (!ok) return;
    try { await api.del(`/voices/${encodeURIComponent(v.id)}`); ui.toast(t('Suara dihapus.'), { kind: 'ok' }); await reload(); }
    catch (e: any) { ui.toast(e.message, { kind: 'bad', title: t('Gagal menghapus') }); }
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
  const libSearch = h('input', { class: 'input', type: 'search', placeholder: t('Cari nama, gaya, aksen...'), 'aria-label': t('Cari di Library'), autocomplete: 'off' }) as HTMLInputElement;
  const sel = (label: string, opts: Array<[string, string]>) => h('select', { class: 'select', 'aria-label': label }, ...opts.map(([v, l]) => new Option(l, v))) as HTMLSelectElement;
  const sortSel = sel(t('Urutkan'), [['trending', t('Sedang populer')], ['usage', t('Paling dipakai')], ['cloned', t('Paling banyak ditambah')], ['created', t('Terbaru')]]);
  const filterBtn = h('button', { type: 'button', class: 'btn soft lib-fbtn', 'aria-expanded': 'false', html: S('sliders') }, h('span', null, 'Filter'), h('span', { class: 'lib-fcount', hidden: true }));
  const fSel = {
    gender: sel('Gender', [['', t('Semua gender')], ...FACET.genders.map((g): [string, string] => [g, G_LABEL[g] || cap(g)])]),
    age: sel(t('Usia'), [['', t('Semua usia')], ...FACET.ages.map((a): [string, string] => [a, AGE_LABEL[a] || cap(a)])]),
    accent: sel(t('Aksen'), [['', t('Semua aksen')], ...FACET.accents.map((a): [string, string] => [a, cap(a)])]),
    language: sel(t('Bahasa'), [['', t('Semua bahasa')], ...FACET.languages.map((l): [string, string] => [l.code, l.name])]),
    category: sel(t('Kategori'), [['', t('Semua kategori')], ...FACET.categories.map((c): [string, string] => [c, CAT_LABEL[c] || cap(c)])]),
    useCase: sel(t('Kegunaan'), [['', t('Semua kegunaan')], ...FACET.useCases.map((u): [string, string] => [u, UC_LABEL[u] || cap(u)])]),
  };
  const resetBtn = ui.btn({ label: t('Reset filter'), cls: 'ghost sm', onClick: () => { for (const k of Object.keys(fSel) as Array<keyof typeof fSel>) { fSel[k].value = ''; lq[k] = ''; } syncFilterCount(); loadLib(true); } });
  const fPanel = h('div', { class: 'lib-fpanel', hidden: true },
    ...(Object.entries(fSel) as Array<[keyof typeof fSel, HTMLSelectElement]>).map(([k, s]) => h('label', { class: 'lib-f' }, h('span', null, F_LABEL[k]), s)),
    h('div', { class: 'lib-freset' }, resetBtn));
  filterBtn.onclick = () => { fPanel.hidden = !fPanel.hidden; filterBtn.setAttribute('aria-expanded', String(!fPanel.hidden)); };
  const libInfo = h('div', { class: 'lib-info', 'aria-live': 'polite' });
  const virt = h('div', { class: 'lib-virt', role: 'list', 'aria-label': t('Library suara') });
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
  const fmtNum = (n: number) => n >= 1_000_000 ? t('{n} jt', { n: (n / 1_000_000).toFixed(1).replace('.0', '') }) : n >= 1000 ? t('{n} rb', { n: (n / 1000).toFixed(1).replace('.0', '') }) : String(n);
  const langName = (c?: string) => (c ? FACET.languages.find((l) => l.code === c)?.name || c.toUpperCase() : '');
  const libMeta = (v: LibraryVoice) => [v.gender && (G_LABEL[v.gender] || cap(v.gender)), v.age && (AGE_LABEL[v.age] || cap(v.age)), v.accent && cap(v.accent), langName(v.language)].filter(Boolean).join(' · ');
  const warnOf = (v: LibraryVoice) => v.warnings.filter((w) => w.level === 'warn');
  const WARN_SHORT: Record<string, (w: LibraryWarning) => string> = {
    notice_period: (w) => t('Notice {days} hr', { days: w.days ?? '' }), live_moderation: () => t('Dimoderasi'), custom_rate: (w) => t('Tarif {rate}x', { rate: w.rate ?? '' }), not_on_plan: () => t('Tidak di paket'),
  };

  function addBtnFor(v: LibraryVoice) {
    const added = inCol(v), st = addState.get(v.id);
    const blocked = !v.addable || st === 'blocked';
    const [label, icon, cls] = st === 'adding' ? [t('Menambahkan...'), '', 'soft'] : added ? [t('Terpasang'), 'check', 'on'] : st === 'full' ? [t('Slot penuh'), 'alert', 'warnb'] : blocked ? [t('Tidak tersedia'), 'ban', 'ghost'] : [t('Tambah'), 'plus', 'soft'];
    const btn = h('button', { type: 'button', class: `btn sm lib-add ${cls}`, 'aria-pressed': String(added), 'aria-label': t('{label}: {name}', { label, name: shortName(v) }), disabled: st === 'adding' || (!added && blocked) },
      st === 'adding' ? h('span', { class: 'spinner' }) : h('span', { class: 'ic-w', html: S(icon) }), h('span', null, label));
    btn.title = added ? t('Ketuk untuk menghapus dari koleksi') : st === 'full' ? t('Slot suara server penuh. Ketuk untuk mencoba lagi.') : blocked ? t('Tidak bisa dipakai pada paket akun server') : t('Tambahkan ke koleksimu');
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
      haptic(); ui.toast(t('"{name}" ditambahkan ke koleksimu.', { name: shortName(v) }), { kind: 'ok', timeout: 2600 });
      syncFromStore();
      return;
    }
    if (r.code === 'slots_full') addState.set(v.id, 'full');
    else if (r.code === 'not_addable' || r.code === 'not_in_library') addState.set(v.id, 'blocked');
    else addState.delete(v.id);
    ui.toast(r.message, { kind: r.code === 'slots_full' || r.code === 'collection_full' ? 'warn' : 'bad', title: r.code === 'slots_full' ? t('Slot suara penuh') : t('Belum bisa ditambahkan') });
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
    if (!warns.length && v.clonedBy > 0) chips.push(h('span', { class: 'lib-chip muted' }, t('{n} pakai', { n: fmtNum(v.clonedBy) })));
    const body = h('button', { type: 'button', class: 'lib-body', 'aria-label': t('Detail {name}', { name: v.name }) },
      h('b', { title: v.name }, shortName(v)),
      h('span', { class: 'lib-meta' }, libMeta(v) || v.description || 'Library'),
      h('span', { class: 'lib-chips' }, ...chips));
    body.onclick = () => libDetail(v);
    const card = h('div', { class: 'lib-card' + (added ? ' added' : ''), role: 'listitem', 'data-id': v.id }, voiceOrbButton(v, 52), body, addBtnFor(v));
    return card;
  }
  function libDetail(v: LibraryVoice) {
    const rows: Array<[string, string]> = [
      ['Gender', v.gender ? G_LABEL[v.gender] || cap(v.gender) : '-'], [t('Usia'), v.age ? AGE_LABEL[v.age] || cap(v.age) : '-'],
      [t('Aksen'), v.accent ? cap(v.accent) : '-'], [t('Bahasa'), [langName(v.language), v.locale].filter(Boolean).join(' · ') || '-'],
      [t('Kegunaan'), v.useCase ? UC_LABEL[v.useCase] || cap(v.useCase) : '-'], [t('Gaya'), v.descriptive ? cap(v.descriptive) : '-'],
      [t('Kategori'), v.category ? CAT_LABEL[v.category] || cap(v.category) : '-'], [t('Dipakai'), t('{n} pengguna', { n: fmtNum(v.clonedBy) })],
      [t('Masa pemberitahuan'), v.noticePeriodDays ? t('{n} hari', { n: v.noticePeriodDays }) : t('Tidak ada')],
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
        h('p', { class: 'hint' }, t('Suara komunitas dari Voice Library ElevenLabs. Menambahkannya memasang suara ini di akun server (satu slot, dipakai bersama semua pengguna).')),
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
    libInfo.textContent = libErr || (!lib.length && libBusy) ? '' : libTotal != null ? t('{n} suara di Voice Library ElevenLabs', { n: libTotal.toLocaleString(locale()) }) : lib.length ? t('{n} suara dimuat', { n: lib.length.toLocaleString(locale()) }) : '';
    const foot: Node[] = [];
    if (!lib.length && libBusy) foot.push(h('div', { class: 'lib-skel' }, ...Array.from({ length: 6 }, () => h('div', { class: 'lib-card' }, h('span', { class: 'skel', style: 'width:52px;height:52px;border-radius:50%' }), h('div', { class: 'v-t' }, h('span', { class: 'skel', style: 'height:14px;width:50%' }), h('span', { class: 'skel', style: 'height:12px;width:70%;margin-top:6px' }))))));
    else if (libErr) foot.push(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, libErr), ui.btn({ label: t('Coba lagi'), cls: 'sm ghost', onClick: () => loadLib(!lib.length) })));
    else if (!lib.length && !libBusy) foot.push(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: S('search') }), h('h3', null, t('Tidak ada suara')), h('p', null, t('Coba kata kunci atau filter lain.'))));
    else if (libBusy) foot.push(h('span', { class: 'spinner' }));
    else if (libMore) foot.push(ui.btn({ label: t('Muat lagi'), cls: 'ghost', onClick: () => loadLib(false) }));
    else foot.push(h('span', { class: 'hint' }, t('Sudah semua.')));
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
      libErr = e?.status === 404 ? t('Library belum tersedia di server.') : e.message || t('Gagal memuat Library.');
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
  const name = h('input', { class: 'input', maxLength: 60, placeholder: t('mis. Suaraku'), autocomplete: 'off' }) as HTMLInputElement;
  const desc = h('textarea', { class: 'textarea', rows: 2, maxLength: 500, placeholder: t('Opsional: ciri suara, aksen, catatan') }) as HTMLTextAreaElement;
  const fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac', multiple: true, hidden: true }) as HTMLInputElement;
  const addFileBtn = h('button', { type: 'button', class: 'add-tile', html: S('upload') }, h('b', null, t('Unggah file')), h('span', null, 'MP3, WAV, M4A'));
  const recTile = h('button', { type: 'button', class: 'add-tile', html: S('mic') }, h('b', null, t('Rekam')), h('span', null, t('dari mikrofon')));
  const sampleList = h('div', { class: 'samples' });
  const consent = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const progress = h('div', { class: 'progress', hidden: true }, h('i'));
  const submit = h('button', { type: 'submit', class: 'btn primary lg block' }, t('Buat clone suara'));
  const cloneMsg = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'stack', style: 'gap:20px', novalidate: true },
    field(t('Nama suara'), name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, t('Sampel audio')),
      h('div', { class: 'hint' }, t('1–{n} sampel, total 1–3 menit, satu pembicara, tanpa musik atau gema.', { n: maxFiles })),
      h('div', { class: 'add-tiles' }, addFileBtn, recTile), sampleList, fileInput),
    h('details', { class: 'disclosure' }, h('summary', null, h('span', null, t('Lanjutan')), h('small', null, t('Deskripsi'))), h('div', { class: 'disc-b' }, field(t('Deskripsi'), desc))),
    h('label', { class: 'check consent' }, consent,
      h('span', null, t('Ini suaraku sendiri, suara yang aku punya izinnya, atau suara karakter yang kupakai untuk bersenang-senang. Tidak untuk tujuan komersial, melanggar hak cipta, atau menipu orang.'),
        h('small', null, t('Wajib. Clone bisa dihapus kapan saja.')))),
    cloneMsg, progress, submit);
  const cloneView = h('div', { class: 'page-inner' }, form);

  const clearWarn = () => { if (cloneMsg.querySelector('.notice.warn')) cloneMsg.replaceChildren(); };
  name.addEventListener('input', clearWarn); consent.addEventListener('change', clearWarn);
  function paintSamples() {
    clearWarn();
    sampleList.replaceChildren(...samples.map((s, i) => {
      const rm = h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': t('Hapus sampel'), title: t('Hapus'), html: S('x') });
      rm.onclick = () => { samples.splice(i, 1); paintSamples(); };
      return h('div', { class: 'sample' }, miniPlayer(s.file, { label: s.source === 'mic' ? t('Rekaman {n}', { n: i + 1 }) : s.file.name, sub: [fmtDur(s.duration), `${(s.file.size / 1024 / 1024).toFixed(1)} MB`].filter(Boolean).join(' · '), knownDuration: s.duration }), rm);
    }));
    const full = samples.length >= maxFiles;
    addFileBtn.disabled = full; recTile.disabled = full && !rec;
  }
  async function addFiles(files: Iterable<File>) {
    for (const f of files) {
      if (samples.length >= maxFiles) { ui.toast(t('Maksimal {n} sampel.', { n: maxFiles }), { kind: 'warn' }); break; }
      const okType = f.type.startsWith('audio/') || f.type === 'video/webm' || /\.(mp3|wav|m4a|ogg|oga|webm|flac|aac|opus)$/i.test(f.name);
      if (!okType) { ui.toast(t('{name}: bukan file audio.', { name: f.name }), { kind: 'warn' }); continue; }
      if (f.size > maxMb * 1024 * 1024) { ui.toast(t('{name}: lebih dari {mb} MB.', { name: f.name, mb: maxMb }), { kind: 'warn' }); continue; }
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
      recLabel().textContent = t('Rekam'); (recTile.querySelector('span') as HTMLElement).textContent = t('dari mikrofon');
      const out = await r.stop();
      if (!out) { ui.toast(t('Rekaman terlalu pendek.'), { kind: 'warn' }); paintSamples(); return; }
      samples.push({ file: out.file, source: 'mic', duration: out.duration }); paintSamples();
      return;
    }
    if (!canRecord()) { ui.toast(t('Browser ini tidak mendukung perekaman.'), { kind: 'warn' }); return; }
    player.stop(); pauseAllMini();
    try { rec = await startRecording({ maxSec: 300, name: `rekaman-${samples.length + 1}` }); } catch (e: any) { ui.toast(e.message, { kind: 'warn' }); return; }
    recTile.classList.add('on');
    const tick = () => { if (!rec) return; recLabel().textContent = t('Stop · {time}', { time: fmtDur(rec.elapsed()) }); (recTile.querySelector('span') as HTMLElement).textContent = t('ketuk untuk selesai'); recTile.style.setProperty('--lvl', rec.level().toFixed(3)); recRaf = requestAnimationFrame(tick); };
    tick();
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const problems: string[] = [];
    if (!name.value.trim()) problems.push(t('Isi nama suara.'));
    if (!samples.length) problems.push(t('Tambahkan minimal satu sampel.'));
    if (!consent.checked) problems.push(t('Centang pernyataan persetujuan.'));
    if (problems.length) { cloneMsg.replaceChildren(h('div', { class: 'notice warn', html: S('alert') }, h('span', null, problems.join(' ')))); return; }
    const fd = new FormData();
    fd.append('name', name.value.trim());
    if (desc.value.trim()) fd.append('description', desc.value.trim());
    fd.append('consent', 'true');
    for (const s of samples) fd.append('files', s.file, s.file.name);
    uploadCtrl = new AbortController();
    submit.disabled = true; progress.hidden = false; progress.classList.remove('indet');
    cloneMsg.replaceChildren(h('div', { class: 'hint' }, t('Mengunggah sampel...')));
    const bar = progress.firstElementChild as HTMLElement; bar.style.width = '0%';
    try {
      const r = await api.upload<{ voice: Voice }>('/voices/clone', fd, { signal: uploadCtrl.signal, onProgress: (p) => {
        bar.style.width = Math.round(p * 100) + '%';
        if (p >= 1) { progress.classList.add('indet'); cloneMsg.replaceChildren(h('div', { class: 'hint' }, t('Memproses suara...'))); }
      } });
      const made: Voice = r?.voice?.id ? r.voice : { id: '', name: name.value.trim(), category: 'cloned', own: true };
      name.value = ''; desc.value = ''; consent.checked = false; samples.splice(0); paintSamples(); cloneMsg.replaceChildren();
      await reload();
      ctx.navigate('voices');
      // after the route change (modals close on hashchange)
      if (made.id) setTimeout(() => offerAfterClone(voices.find((x) => x.id === made.id) || made), 150);
      else ui.toast(t('Suara "{name}" siap dipakai.', { name: made.name }), { kind: 'ok', title: t('Clone berhasil') });
    } catch (err: any) {
      cloneMsg.replaceChildren(err?.code === 'aborted' ? '' : h('div', { class: 'notice bad', html: S('xCircle') }, h('span', null, err.message)));
    } finally { uploadCtrl = null; progress.hidden = true; submit.disabled = false; }
  };

  /** After a clone: try it, make a persona with it, or shape its orb. */
  function offerAfterClone(v: Voice) {
    const big = orb(voiceOrb(v.id), { size: 132, cls: 'offer-orb', live: true, label: t('Bola suara {name}', { name: shortName(v) }) });
    const persona = h('button', { type: 'button', class: 'btn primary lg block', html: S('sparkle') }, h('span', null, t('Buat persona dengan suara ini')));
    const shape = h('button', { type: 'button', class: 'btn soft lg block', html: S('palette') }, h('span', null, t('Bentuk bola suaranya')));
    const tts = h('button', { type: 'button', class: 'btn ghost block', html: S('studio') }, h('span', null, t('Coba di TTS')));
    const m = ui.modal({ title: t('Clone berhasil'), cls: 'offer-dlg', body: h('div', { class: 'offer' }, big,
      h('h3', null, shortName(v)), h('p', null, t('Suaramu siap. Jadikan suara sebuah persona untuk diajak ngobrol, atau beri dia bola sendiri.')), persona, shape, tts) });
    persona.onclick = () => { m.close(); createPersonaFlow(ctx, { voiceId: v.id }); };
    shape.onclick = () => voiceStudio(v, () => big.setSpec(voiceOrb(v.id)));
    tts.onclick = () => { m.close(); ctx.navigate(`tts?voice=${encodeURIComponent(v.id)}`); };
  }

  /* ================= views ================= */
  // the library view gets its own copy of the segmented control (a node can only live in one place)
  const libSeg = seg<'list' | 'library'>([['list', t('Koleksiku'), 'voices'], ['library', 'Library', 'search']], 'library', (v) => ctx.navigate(v === 'list' ? 'voices' : 'voices/library'), t('Bagian'), true);
  libView.firstElementChild!.replaceWith(h('div', { class: 'voices-seg' }, libSeg));
  const refreshBtn = h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': t('Muat ulang'), title: t('Muat ulang'), html: S('refresh') });
  refreshBtn.onclick = () => (view === 'library' ? loadLib(true) : reload());

  function show(r: RouteInfo) {
    const sub = r.path.split('/')[1] || '';
    let next: typeof view = sub === 'clone' ? 'clone' : sub === 'library' ? 'library' : 'list';
    if (next === 'clone' && !canClone()) { history.replaceState(null, '', '#/voices'); next = 'list'; }
    player.stop(); pauseAllMini();
    if (next !== 'clone' && rec) { rec.cancel(); rec = null; cancelAnimationFrame(recRaf); }
    view = next;
    ctx.shell.setTitle(next === 'clone' ? t('Clone suara') : next === 'library' ? t('Library suara') : 'Voices');
    ctx.shell.setBack(next === 'clone' ? () => (history.length > 1 ? history.back() : ctx.navigate('voices')) : null);
    ctx.shell.setActions(next === 'clone' ? [] : [refreshBtn]);
    segEl.setValue('list'); libSeg.setValue('library');
    page.replaceChildren(next === 'clone' ? cloneView : next === 'library' ? libView : listView);
    document.getElementById('view')?.scrollTo({ top: 0 });
    if (next === 'clone') {
      paintSamples();
      const own = voices.filter((v) => v.own).length;
      if (loaded && own >= maxClones) cloneMsg.replaceChildren(h('div', { class: 'notice warn', html: S('alert') }, h('span', null, t('Batas {n} clone tercapai. Hapus salah satu suara milikmu dulu.', { n: maxClones }))));
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
