/* UI language switch. Each option is written in its own language. Choosing one saves it and reloads the page
   (i18n.setLang); meanwhile the control shows a short busy state.
   - 'seg'   : segmented control (account sheet)
   - 'quiet' : two small text buttons with a globe (login and other auth pages) */
import '../styles/lang.css';
import { h } from './dom';
import { svg } from '../icons';
import { getLang, setLang, t, type Lang } from '../i18n';

const OPTIONS: Array<[Lang, string, string]> = [['id', 'Bahasa Indonesia', 'id'], ['en', 'English (US)', 'en-US']];

export function langSwitch(variant: 'seg' | 'quiet' = 'seg'): HTMLElement {
  const cur = getLang();
  const el = h('div', { class: variant === 'seg' ? 'seg block lang-seg' : 'lang-quiet', role: 'group', 'aria-label': 'Bahasa / Language' });
  if (variant === 'quiet') el.append(h('span', { class: 'lang-ic', 'aria-hidden': 'true', html: svg('globe') }));
  for (const [v, label, tag] of OPTIONS) {
    const b = h('button', { type: 'button', lang: tag, 'aria-pressed': String(v === cur) }, h('span', null, label)) as HTMLButtonElement;
    b.onclick = () => {
      if (v === getLang() || el.classList.contains('busy')) return;
      el.classList.add('busy');
      el.setAttribute('aria-busy', 'true');
      for (const x of el.querySelectorAll('button')) { x.setAttribute('aria-pressed', String(x === b)); (x as HTMLButtonElement).disabled = true; }
      b.prepend(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
      b.title = t('Mengganti bahasa…');
      void setLang(v);
    };
    if (variant === 'quiet' && v !== OPTIONS[0][0]) el.append(h('span', { class: 'lang-dot', 'aria-hidden': 'true' }, '·'));
    el.append(b);
  }
  return el;
}
