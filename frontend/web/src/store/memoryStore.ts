import * as notesApi from '@memoza/core/api/notes';
import * as authApi from '@memoza/core/api/auth';
import { ApiError } from '@memoza/core/api/client';
import * as noteCrypto from '@memoza/core/crypto/note';
import { importRecipientPublicKey } from '@memoza/core/crypto/keys';
import { requireSession } from '@memoza/core/crypto/session';
import { search as searchIndex } from '@memoza/core/search';
import { getFormat } from '@memoza/core/views/controlTags';
import { markSyncing, markSynced } from '@memoza/core/connection';
import type { Store, DecryptedNoteSummary, DecryptedNote, DecryptedComment, NoteShare } from '@memoza/core/store/types';
import type { NoteRow, FullNote } from '@memoza/core/api/notes';

interface NoteState {
  row: NoteRow;
  cek: CryptoKey;
  title: string;
  tags: string[];
  body: string | null;
  ownerUsername?: string | null;
}

const SYNC_TTL_MS = 30_000;

export function createMemoryStore(): Store {
  const notes = new Map<string, NoteState>();
  let cursor: string | null = null;
  let lastSyncAt = 0;

  async function unwrapAndDecrypt(row: NoteRow): Promise<NoteState> {
    const session = requireSession();
    const cek =
      row.wrap_method === 'dek'
        ? await noteCrypto.unwrapCekWithDek(session.dek, row.wrapped_cek)
        : await noteCrypto.unwrapCekWithPrivateKey(session.privateKey, row.wrapped_cek);
    const title = await noteCrypto.openTitle(cek, row.id, row.title_ct);
    const tags = await noteCrypto.openTags(cek, row.id, row.tags_ct);
    return { row, cek, title, tags, body: null };
  }

  function toSummary(state: NoteState): DecryptedNoteSummary {
    const session = requireSession();
    return {
      id: state.row.id,
      ownerId: state.row.owner_id,
      isOwner: state.row.owner_id === session.userId,
      title: state.title,
      tags: state.tags,
      hasUnreadComment: state.row.has_unread_comment,
      pageNo: state.row.page_no,
      isPublic: state.row.is_public,
      rev: state.row.rev,
      createdAt: state.row.created_at,
      updatedAt: state.row.updated_at,
      deletedAt: state.row.deleted_at,
    };
  }

  async function sync(force = false): Promise<void> {
    if (!force && Date.now() - lastSyncAt < SYNC_TTL_MS) return;
    markSyncing(true);
    try {
      for (;;) {
        const page = await notesApi.listNotes(cursor ?? undefined);
        for (const row of page.notes) {
          notes.set(row.id, await unwrapAndDecrypt(row));
        }
        for (const id of page.tombstones) notes.delete(id);
        for (const id of page.revoked) notes.delete(id);
        cursor = page.next;
        if (!page.next) break;
      }
      lastSyncAt = Date.now();
    } finally {
      markSyncing(false);
    }
  }

  async function listNotes(): Promise<DecryptedNoteSummary[]> {
    return Array.from(notes.values()).map(toSummary);
  }

  async function getNote(id: string): Promise<DecryptedNote | null> {
    const cached = notes.get(id);
    if (cached && cached.body !== null) return { ...toSummary(cached), body: cached.body, ownerUsername: cached.ownerUsername };

    let full: FullNote;
    try {
      full = await notesApi.getNote(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        notes.delete(id);
        return null;
      }
      throw err;
    }
    const state = await unwrapAndDecrypt(full);
    state.body = await noteCrypto.openBody(state.cek, full.id, full.body_ct);
    state.ownerUsername = full.owner_username ?? null;
    notes.set(id, state);
    return { ...toSummary(state), body: state.body, ownerUsername: state.ownerUsername };
  }

  async function createNewNote(title: string, tags: string[], body: string): Promise<DecryptedNote> {
    const session = requireSession();
    const newId = crypto.randomUUID();
    const cek = await noteCrypto.generateCek();
    const titleCt = await noteCrypto.sealTitle(cek, newId, title);
    const bodyCt = await noteCrypto.sealBody(cek, newId, body);
    const tagsCt = tags.length > 0 ? await noteCrypto.sealTags(cek, newId, tags) : null;
    const wrappedCek = await noteCrypto.wrapCekWithDek(session.dek, cek);

    const created = await notesApi.createNote(newId, {
      title_ct: titleCt,
      body_ct: bodyCt,
      tags_ct: tagsCt,
      wrapped_cek: wrappedCek,
    });

    const sessionCek = await noteCrypto.sealCekForSession(cek);
    const row: NoteRow = {
      id: newId,
      owner_id: session.userId,
      title_ct: titleCt,
      tags_ct: tagsCt,
      wrapped_cek: wrappedCek,
      wrap_method: 'dek',
      has_unread_comment: false,
      page_no: created.page_no,
      is_public: false,
      rev: created.rev,
      created_at: created.created_at,
      updated_at: created.updated_at,
      deleted_at: null,
    };
    const state: NoteState = { row, cek: sessionCek, title, tags, body };
    notes.set(newId, state);
    return { ...toSummary(state), body };
  }

  async function saveNote(id: string | null, title: string, body: string, tags: string[]): Promise<DecryptedNote> {
    if (id === null) return createNewNote(title, tags, body);

    const existing = notes.get(id);
    if (!existing) throw new Error('Note not loaded locally');

    const titleCt = await noteCrypto.sealTitle(existing.cek, id, title);
    const bodyCt = await noteCrypto.sealBody(existing.cek, id, body);
    const tagsCt = tags.length > 0 ? await noteCrypto.sealTags(existing.cek, id, tags) : null;
    const mirror = existing.row.is_public
      ? { title, body, format: getFormat(tags) }
      : {};

    try {
      const updated = await notesApi.updateNote(id, {
        title_ct: titleCt,
        body_ct: bodyCt,
        tags_ct: tagsCt,
        base_rev: existing.row.rev,
        ...mirror,
      });
      const state: NoteState = {
        row: { ...existing.row, title_ct: titleCt, tags_ct: tagsCt, rev: updated.rev, updated_at: updated.updated_at },
        cek: existing.cek,
        title,
        tags,
        body,
      };
      notes.set(id, state);
      markSynced();
      return { ...toSummary(state), body };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === 'object' && 'note' in err.body) {
        const conflictRow = (err.body as { note: FullNote }).note;
        const serverState = await unwrapAndDecrypt(conflictRow);
        serverState.body = await noteCrypto.openBody(serverState.cek, id, conflictRow.body_ct);
        notes.set(id, serverState);
        return createNewNote(title, tags, body);
      }
      throw err;
    }
  }

  async function trashNote(id: string): Promise<void> {
    await notesApi.trashNote(id);
    const state = notes.get(id);
    if (state) state.row = { ...state.row, deleted_at: Date.now() };
  }

  async function restoreNote(id: string): Promise<void> {
    await notesApi.restoreNote(id);
    const state = notes.get(id);
    if (state) state.row = { ...state.row, deleted_at: null };
  }

  async function purgeNote(id: string): Promise<void> {
    await notesApi.purgeNote(id);
    notes.delete(id);
  }

  async function shareNote(id: string, recipientUsername: string): Promise<void> {
    const session = requireSession();
    const state = notes.get(id);
    if (!state) throw new Error('Note not loaded locally');
    if (state.row.wrap_method !== 'dek') throw new Error('Only the owner can share this note');

    const recipient = await authApi.lookupPublicKey(recipientUsername);
    const publicKey = await importRecipientPublicKey(recipient.public_key);
    const extractableCek = await noteCrypto.unwrapCekWithDekExtractable(session.dek, state.row.wrapped_cek);
    const wrappedCek = await noteCrypto.wrapCekWithPublicKey(publicKey, extractableCek);
    await notesApi.shareNote(id, recipient.user_id, wrappedCek, recipient.username);
  }

  async function unshareNote(id: string, userId: string): Promise<void> {
    await notesApi.unshareNote(id, userId);
  }

  async function listShares(id: string): Promise<NoteShare[]> {
    const full = await notesApi.getNote(id);
    return (full.shares ?? []).map(s => ({ userId: s.user_id, username: s.username }));
  }

  async function publish(id: string): Promise<number> {
    const session = requireSession();
    let state = notes.get(id);
    if (!state) throw new Error('Note not loaded locally');
    if (state.row.owner_id !== session.userId) throw new Error('Only the owner can publish');

    if (state.body === null) {
      const full = await notesApi.getNote(id);
      state = await unwrapAndDecrypt(full);
      state.body = await noteCrypto.openBody(state.cek, id, full.body_ct);
    }

    const format = getFormat(state.tags);
    const res = await notesApi.publishNote(id, { title: state.title, body: state.body, format });
    state.row = { ...state.row, is_public: true, page_no: res.page_no };
    notes.set(id, state);
    return res.page_no;
  }

  async function listComments(noteId: string): Promise<DecryptedComment[]> {
    const state = notes.get(noteId);
    if (!state) throw new Error('Note not loaded locally');
    const res = await notesApi.listComments(noteId);
    return Promise.all(
      res.comments.map(async c => ({
        id: c.id,
        authorUsername: c.author_username,
        body: await noteCrypto.openComment(state.cek, c.id, c.body_ct),
        createdAt: c.created_at,
      }))
    );
  }

  async function postComment(noteId: string, body: string): Promise<DecryptedComment> {
    const state = notes.get(noteId);
    if (!state) throw new Error('Note not loaded locally');
    const id = crypto.randomUUID();
    const bodyCt = await noteCrypto.sealComment(state.cek, id, body);
    const res = await notesApi.postComment(noteId, id, bodyCt);
    return { id: res.id, authorUsername: res.author_username, body, createdAt: res.created_at };
  }

  async function deleteComment(noteId: string, commentId: string): Promise<void> {
    await notesApi.deleteComment(noteId, commentId);
  }

  async function search(query: string): Promise<DecryptedNoteSummary[]> {
    const entries = Array.from(notes.values()).map(s => ({ id: s.row.id, title: s.title }));
    const ids = new Set(searchIndex(entries, query));
    const all = await listNotes();
    return all.filter(n => ids.has(n.id));
  }

  return {
    sync,
    listNotes,
    getNote,
    saveNote,
    trashNote,
    restoreNote,
    purgeNote,
    shareNote,
    unshareNote,
    listShares,
    publish,
    listComments,
    postComment,
    deleteComment,
    search,
  };
}
