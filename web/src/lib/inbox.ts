/* Whether the person has a message thread and whether the other side has replied (drives the "Pesan" button). */
import { api } from '../api';
import { store } from '../store';

export const inbox = { exists: false, unread: 0 };
const subs = new Set<() => void>();
export const onInbox = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export async function refreshMessages(): Promise<void> {
  if (!store.get().me) return;
  try {
    const r = await api.get<{ exists: boolean; unread: number }>('/quota/thread');
    inbox.exists = r.exists; inbox.unread = r.unread;
  } catch { return; }
  subs.forEach((f) => f());
}
