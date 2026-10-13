/* "Telepon..." / "Tambah orang": pick a persona to ring into a group call (built-ins + the user's own personas).
   Each row: its orb, name, one line, and a status (on the call / ringing / declined / phone off). */
import type { ScreenCtx } from '../../ctx';
import { h } from '../../ui/dom';
import { orb } from '../../ui/orb';
import { orbSpecFor, type Persona } from '../../lib/persona';

export interface PickRow { p: Persona; status?: string; disabled?: boolean }

export function pickPersona(ctx: ScreenCtx, o: { title?: string; rows: PickRow[]; note?: string }): Promise<{ p: Persona; orbEl: HTMLElement } | null> {
  const { ui, icons } = ctx;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { p: Persona; orbEl: HTMLElement } | null) => { if (done) return; done = true; resolve(v); };
    const list = h('div', { class: 'ps-list duo-pick', role: 'list' });
    for (const r of o.rows) {
      const ob = orb(orbSpecFor(r.p), { size: 46 });
      const b = h('button', { type: 'button', class: 'ps-main', role: 'listitem', disabled: r.disabled || null },
        ob, h('span', { class: 'ps-t' }, h('b', null, r.p.name), h('span', null, r.status || (r.p.builtin ? 'Persona bawaan' : (r.p.sub || 'Persona buatanmu')))),
        r.disabled ? null : h('span', { class: 'ps-on', html: icons.svg('phone') }));
      b.onclick = () => { finish({ p: r.p, orbEl: ob }); m.close(); };
      list.append(b);
    }
    if (!o.rows.length) list.append(h('div', { class: 'empty', style: 'padding:20px 8px' }, h('p', null, 'Tidak ada persona lain untuk ditelepon.')));
    const m = ui.modal({
      title: o.title || 'Telepon siapa?', cls: 'ps-dlg', key: 'duo-pick',
      body: h('div', { class: 'ps' }, list, o.note ? h('p', { class: 'ps-tip', style: 'display:block' }, o.note) : null),
      onClose: () => finish(null),
    });
  });
}
