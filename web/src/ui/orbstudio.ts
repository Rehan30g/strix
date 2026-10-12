/* Studio Bola: make / edit an orb (2-5 colours, style, speed, smoothness) with a live preview.
   Used for personas (CustomPersona.orb / built-in override) and voices (settings "orbs"). Flat 2D, no highlight. */
import { h } from './dom';
import { svg } from '../icons';
import { modal } from './overlay';
import { slider } from './controls';
import { orb, jelly, splash, customOrb, specToCustom, cleanOrb, randomPalette, ORB_STYLES, type CustomOrb, type OrbSpec, type OrbStyle } from './orb';

export const PALETTES: Array<[string, string[]]> = [
  ['Senja', ['#5b2a86', '#c94b8b', '#ff7a59', '#ffb347']],
  ['Laut', ['#0b3d91', '#1e88e5', '#26c6da', '#9be7f0']],
  ['Hutan', ['#1b4332', '#2d6a4f', '#52b788', '#b7e4c7']],
  ['Permen', ['#7c3aed', '#ff6fb5', '#a78bfa', '#7dd3fc']],
  ['Lava', ['#3d0c02', '#b23a48', '#ff6b35', '#fcbf49']],
  ['Aurora', ['#0d1b2a', '#2ec4b6', '#9b5de5', '#f15bb5', '#c2f970']],
  ['Kopi', ['#3e2723', '#795548', '#c08552', '#e6c79c']],
  ['Neon', ['#120458', '#7a04eb', '#ff00a0', '#00e5ff']],
  ['Batu', ['#1f2937', '#475569', '#94a3b8', '#cbd5e1']],
  ['Persik', ['#c44569', '#ff9a8b', '#ffc3a0', '#f6d6ad']],
];
export const STYLE_LABEL: Record<OrbStyle, string> = { aurora: 'Aurora', swirl: 'Pusaran', mesh: 'Mesh', cell: 'Sel', marble: 'Marmer' };

/** Simulated speech amplitude for previews. */
export function demoLevel(): () => number {
  const t0 = performance.now();
  return () => {
    const t = (performance.now() - t0) / 1000;
    const syll = Math.max(0, Math.sin(t * 9.5) * 0.5 + Math.sin(t * 5.3 + 1) * 0.35);
    const phrase = Math.sin(t * 0.9) > -0.55 ? 1 : 0.1;
    return Math.min(1, (0.15 + syll * 0.75) * phrase);
  };
}

export interface StudioOpts {
  title: string;
  subtitle?: string;
  /** current custom orb, or null when it uses the default / inherited orb */
  initial: CustomOrb | null;
  /** the orb shown without customisation (used as the starting point) */
  base: OrbSpec;
  seedKey: string;
  /** label of the reset action, e.g. "Pakai bola suara" for a persona */
  resetLabel?: string;
  onSave: (o: CustomOrb | null) => void;
}

export function openOrbStudio(o: StudioOpts): void {
  let cur: CustomOrb = cleanOrb(o.initial) || specToCustom(o.base);
  const preview = orb(customOrb(cur, o.seedKey), { size: 176, cls: 'os-orb', label: 'Pratinjau bola' });
  let talking = false;
  const talk = h('button', { type: 'button', class: 'btn sm soft os-talk', html: svg('waveform') }, h('span', null, 'Coba bicara'));
  const level = demoLevel();
  const quiet = () => 0;
  preview.setLive(true, quiet);
  jelly(preview);   // drag = jelly stretch, tap = splash
  talk.onclick = () => { talking = !talking; preview.setLive(true, talking ? level : quiet); talk.setAttribute('aria-pressed', String(talking)); talk.querySelector('span')!.textContent = talking ? 'Berhenti' : 'Coba bicara'; };

  /* colours */
  const colorsBox = h('div', { class: 'os-colors', role: 'group', 'aria-label': 'Warna bola' });
  const addBtn = h('button', { type: 'button', class: 'os-add', 'aria-label': 'Tambah warna', title: 'Tambah warna', html: svg('plus') });
  const shuffle = h('button', { type: 'button', class: 'btn sm ghost os-rand', html: svg('refresh') }, h('span', null, 'Acak'));
  function paintColors() {
    const slots = cur.colors.map((c, i) => {
      const inp = h('input', { type: 'color', value: c, 'aria-label': `Warna ${i + 1}` }) as HTMLInputElement;
      inp.oninput = () => { cur = { ...cur, colors: cur.colors.map((x, j) => (j === i ? inp.value.toLowerCase() : x)) }; sw.style.background = inp.value; update(false); };
      const sw = h('label', { class: 'os-sw', title: 'Ubah warna' }, inp);
      sw.style.background = c;
      const rm = cur.colors.length > 2 ? h('button', { type: 'button', class: 'os-rm', 'aria-label': `Hapus warna ${i + 1}`, html: svg('x') }) : null;
      if (rm) rm.onclick = () => { cur = { ...cur, colors: cur.colors.filter((_, j) => j !== i) }; update(); };
      return h('div', { class: 'os-slot' }, sw, rm);
    });
    addBtn.hidden = cur.colors.length >= 5;
    colorsBox.replaceChildren(...slots, addBtn);
  }
  addBtn.onclick = () => { if (cur.colors.length >= 5) return; const extra = randomPalette(5)[cur.colors.length % 5]; cur = { ...cur, colors: [...cur.colors, extra] }; update(); };
  shuffle.onclick = () => { cur = { ...cur, colors: randomPalette(), style: ORB_STYLES[Math.floor(Math.random() * ORB_STYLES.length)] }; update(); };

  /* palettes */
  const pal = h('div', { class: 'os-pal', 'data-hswipe': '1' }, ...PALETTES.map(([name, cols]) => {
    const b = h('button', { type: 'button', class: 'os-pal-b', title: name, 'aria-label': `Palet ${name}` },
      h('span', { class: 'os-strip' }, ...cols.map((c) => { const s = h('i'); s.style.background = c; return s; })), h('small', null, name));
    b.onclick = () => { cur = { ...cur, colors: [...cols] }; update(); };
    return b;
  }));

  /* styles */
  const styleBtns = new Map<OrbStyle, { b: HTMLButtonElement; o: ReturnType<typeof orb> }>();
  const styles = h('div', { class: 'os-styles', role: 'radiogroup', 'aria-label': 'Gaya bola' }, ...ORB_STYLES.map((s) => {
    const mini = orb(customOrb({ ...cur, style: s }, o.seedKey), { size: 40 });
    const b = h('button', { type: 'button', class: 'os-style', role: 'radio' }, mini, h('span', null, STYLE_LABEL[s]));
    b.onclick = () => { cur = { ...cur, style: s }; update(false); };
    styleBtns.set(s, { b, o: mini });
    return b;
  }));

  const speed = slider({ label: 'Kecepatan gerak', min: 0.3, max: 2, step: 0.05, value: cur.speed, fmt: (v) => v.toFixed(2) + 'x', onInput: (v) => { cur = { ...cur, speed: v }; update(false); } });
  const soft = slider({ label: 'Kehalusan', min: 0, max: 1, step: 0.05, value: cur.soft, fmt: (v) => (v < 0.34 ? 'Tegas' : v < 0.67 ? 'Sedang' : 'Lembut') + ` · ${Math.round(v * 100)}%`, onInput: (v) => { cur = { ...cur, soft: v }; update(false); } });

  let miniT: ReturnType<typeof setTimeout> | null = null, opened = false;
  const paintMinis = () => { miniT = null; for (const [s, x] of styleBtns) x.o.setSpec(customOrb({ ...cur, style: s, speed: 1 }, o.seedKey)); };
  function update(repaintColors = true) {
    preview.setSpec(customOrb(cur, o.seedKey));
    if (repaintColors && opened) splash(preview);
    for (const [s, x] of styleBtns) x.b.setAttribute('aria-checked', String(s === cur.style));
    if (miniT) clearTimeout(miniT);
    miniT = setTimeout(paintMinis, 140);
    if (repaintColors) paintColors();
    speed.setValue(cur.speed); soft.setValue(cur.soft);
  }

  const body = h('div', { class: 'os' },
    h('div', { class: 'os-stage' }, preview, o.subtitle ? h('p', { class: 'os-sub' }, o.subtitle) : null, talk),
    h('section', { class: 'os-sec' }, h('div', { class: 'os-h' }, h('span', null, 'Warna'), h('small', null, '2 sampai 5'), shuffle), colorsBox),
    h('section', { class: 'os-sec' }, h('div', { class: 'os-h' }, h('span', null, 'Palet siap pakai')), pal),
    h('section', { class: 'os-sec' }, h('div', { class: 'os-h' }, h('span', null, 'Gaya')), styles),
    h('section', { class: 'os-sec os-sl' }, speed, soft));

  const save = h('button', { type: 'button', class: 'btn primary' }, 'Simpan bola');
  const cancel = h('button', { type: 'button', class: 'btn ghost' }, 'Batal');
  const reset = o.initial ? h('button', { type: 'button', class: 'btn ghost os-reset', html: svg('refresh') }, h('span', null, o.resetLabel || 'Pakai bawaan')) : null;
  const m = modal({ title: o.title, body, cls: 'os-dlg', actions: [...(reset ? [reset] : []), cancel, save] });
  save.onclick = () => { m.close(); o.onSave(cleanOrb(cur)); };
  cancel.onclick = () => m.close();
  if (reset) reset.onclick = () => { m.close(); o.onSave(null); };
  update();
  opened = true;
}
