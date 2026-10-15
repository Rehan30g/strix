/* Route table. Screens are lazy-loaded modules exporting mount(root, ctx) => cleanup.
   Lite app: 4 tabs (Chat, TTS, Changer, Voices) + Admin (reachable from the account sheet). */
import type { MountFn } from './ctx';
import { t } from './i18n';

export interface RouteDef {
  name: string;
  label: string;          // nav label (tab bar / sidebar)
  title: string;          // top bar title
  icon: string;
  load: () => Promise<{ mount: MountFn }>;
  admin?: boolean;
  tab?: boolean;          // shown in the tab bar / sidebar
  wide?: boolean;         // content may use the full width on desktop
}

export const ROUTES: RouteDef[] = [
  { name: 'chat', label: 'Chat', title: 'Chat Persona', icon: 'chat', load: () => import('./screens/chat/index'), tab: true, wide: true },
  { name: 'tts', label: 'TTS', title: t('Teks ke Suara'), icon: 'studio', load: () => import('./screens/tts/index'), tab: true },
  { name: 'vc', label: 'Changer', title: 'Voice Changer', icon: 'changer', load: () => import('./screens/vc/index'), tab: true },
  { name: 'voices', label: 'Voices', title: 'Voices', icon: 'voices', load: () => import('./screens/voices/index'), tab: true },
  // group call (Strix + Lena, or any personas): reached from the Chat persona sheet / menus, not a tab
  { name: 'duo', label: t('Panggilan'), title: t('Panggilan'), icon: 'phone', load: () => import('./screens/duo/index'), wide: true },
  { name: 'messages', label: t('Pesan'), title: t('Pesan'), icon: 'message', load: () => import('./screens/messages/index') },
  { name: 'admin', label: 'Admin', title: 'Admin', icon: 'shield', load: () => import('./screens/admin/index'), admin: true, wide: true },
];

export const DEFAULT_ROUTE = 'chat';

export function parseHash(hash = location.hash): { name: string; path: string; params: URLSearchParams } {
  const raw = hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  const name = p.split('/')[0] || '';
  return { name, path: p, params: new URLSearchParams(q) };
}
