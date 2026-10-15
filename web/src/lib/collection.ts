/* Voice collection: GET /voices is the user's collection (own clones + shared + voices added from the Library).
   Library voices (public ElevenLabs Voice Library) are added / removed explicitly. */
import { api, type Voice } from '../api';
import { loadVoices, store } from '../store';
import { toast } from '../ui/overlay';
import { haptic } from '../ui/gesture';
import { brandName } from './persona';
import { t } from '../i18n';

export const shortName = (v: Pick<Voice, 'name'>) => brandName(v.name.split(' - ')[0]);
/** Is this voice in the collection? Matches the collection id and, for library voices, the source voice id. */
export const inCollection = (id: string) => !!(store.get().voices || []).some((v) => v.id === id || v.sourceId === id);

export type AddResult = { ok: true; voiceId: string } | { ok: false; code: string; message: string };

/** Add a voice (library voices carry `ownerId`). No toast; see addVoice for the toasting variant. */
export async function addVoiceResult(v: Pick<Voice, 'id' | 'ownerId'>): Promise<AddResult> {
  try {
    const r = await api.addToCollection(v.id, v.ownerId);
    await loadVoices(true).catch(() => {});
    return { ok: true, voiceId: r?.voiceId || v.id };
  } catch (e: any) {
    if (e?.code === 'already_in_collection') { await loadVoices(true).catch(() => {}); return { ok: true, voiceId: v.id }; }
    return { ok: false, code: e?.code || 'error', message: e?.message || t('Gagal menambahkan suara.') };
  }
}

/** Add a library voice. Returns true on success (also when it was already there). */
export async function addVoice(v: Voice): Promise<boolean> {
  const r = await addVoiceResult(v);
  if (!r.ok) {
    const soft = r.code === 'slots_full' || r.code === 'collection_full' || r.code === 'not_addable' || r.code === 'voice_forbidden';
    toast(r.message, { kind: soft ? 'warn' : 'bad', title: r.code === 'slots_full' ? t('Slot suara penuh') : t('Belum bisa ditambahkan') });
    return false;
  }
  haptic();
  toast(t('"{name}" ditambahkan ke koleksimu.', { name: shortName(v) }), { kind: 'ok', timeout: 2600 });
  return true;
}

/** Remove a library voice from the collection (not for own clones: those are deleted in Voices). */
export async function removeVoice(v: Voice): Promise<boolean> {
  try { await api.removeFromCollection(v.id); }
  catch (e: any) {
    if (e?.status !== 404) { toast(e?.message || t('Gagal menghapus suara dari koleksi.'), { kind: 'bad' }); return false; }
  }
  haptic();
  toast(t('"{name}" dihapus dari koleksi.', { name: shortName(v) }), { kind: 'ok', timeout: 2600 });
  await loadVoices(true).catch(() => {});
  return true;
}

export function categoryLabel(v: Voice): string {
  if (v.own) return t('Milikmu');
  if (v.category === 'shared') return t('Bersama');
  if (v.category === 'premade') return t('Bawaan');
  return 'Library';
}
