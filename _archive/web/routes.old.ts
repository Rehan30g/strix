/* Route table. Screens are lazy-loaded modules exporting mount(root, ctx) => cleanup. */
import type { MountFn } from './ctx';

export interface RouteDef {
  name: string;
  label: string;          // nav label
  title: string;          // top bar title
  icon: string;
  load: () => Promise<{ mount: MountFn }>;
  admin?: boolean;
  mobile?: boolean;       // shown in the mobile bottom bar (others go into "Lainnya")
  group?: 'main' | 'manage';
}

export const ROUTES: RouteDef[] = [
  { name: 'coffee', label: 'Coffee Agent', title: 'Coffee Agent', icon: 'cup', load: () => import('./screens/coffee/index'), mobile: true, group: 'main' },
  { name: 'chat', label: 'Roleplay', title: 'Roleplay chat', icon: 'chat', load: () => import('./screens/chat/index'), mobile: true, group: 'main' },
  { name: 'call', label: 'Panggilan', title: 'Panggilan suara', icon: 'headset', load: () => import('./screens/call/index'), mobile: true, group: 'main' },
  { name: 'studio', label: 'TTS Studio', title: 'TTS Studio', icon: 'studio', load: () => import('./screens/studio/index'), mobile: true, group: 'main' },
  { name: 'voices', label: 'Suara', title: 'Suara', icon: 'voices', load: () => import('./screens/voices/index'), group: 'manage' },
  { name: 'settings', label: 'Pengaturan', title: 'Pengaturan', icon: 'sliders', load: () => import('./screens/settings/index'), group: 'manage' },
  { name: 'admin', label: 'Admin', title: 'Admin', icon: 'shield', load: () => import('./screens/admin/index'), admin: true, group: 'manage' },
];

export const DEFAULT_ROUTE = 'coffee';

export function parseHash(hash = location.hash): { name: string; path: string; params: URLSearchParams } {
  const raw = hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  const name = p.split('/')[0] || '';
  return { name, path: p, params: new URLSearchParams(q) };
}
