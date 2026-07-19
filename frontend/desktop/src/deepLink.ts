import type { Store } from '@memoza/core/store/types';
import { isUnlocked } from '@memoza/core/crypto/session';

async function resolvePageNumber(store: Store, pageNo: number): Promise<string | null> {
  const notes = await store.listNotes();
  const match = notes.find(n => n.isOwner && n.pageNo === pageNo && n.deletedAt === null);
  return match ? match.id : null;
}

export async function resolveDeepLink(store: Store, url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '#/';
  }

  if (parsed.hash && parsed.hash.length > 1) return parsed.hash;

  if (parsed.protocol === 'memoza:' && parsed.hostname === 'page') {
    const pageNo = Number(parsed.pathname.replace(/^\//, ''));
    if (Number.isInteger(pageNo) && pageNo > 0) {
      const id = isUnlocked() ? await resolvePageNumber(store, pageNo) : null;
      return id ? `#/note/${id}` : '#/';
    }
  }

  if (parsed.protocol === 'memoza:' && parsed.hostname === 'note') {
    const noteId = parsed.pathname.replace(/^\//, '');
    if (noteId) return `#/note/${noteId}`;
  }

  return `#/reset${parsed.search}`;
}
