import * as notesApi from '@memoza/core/api/notes';
import * as noteCrypto from '@memoza/core/crypto/note';
import { requireSession } from '@memoza/core/crypto/session';
import { search as searchIndex } from '@memoza/core/search';
import { ApiError } from '@memoza/core/api/client';
import type { Store, DecryptedNoteSummary, DecryptedNote, DecryptedComment } from '@memoza/core/store/types';
import type { FullNote } from '@memoza/core/api/notes';
import { importRecipientPublicKey } from '@memoza/core/crypto/keys';
import * as authApi from '@memoza/core/api/auth';
import { getDb, getCursor, setCursor } from './db';
import { enqueue, drainQueue } from './queue';

interface LocalNoteRow {
  id: string;
  owner_id: string;
  title_ct: string;
  body_ct: string;
  tags_ct: string | null;
  wrapped_cek: string;
  wrap_method: 'dek' | 'pubkey';
  pinned: number;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface LocalCommentRow {
  id: string;
  note_id: string;
  author_id: string;
  body_ct: string;
  created_at: number;
}

interface CacheEntry {
  cek: CryptoKey;
  title: string;
  tags: string[];
}

export function createSqliteStore(): Store {
  const cache = new Map<string, CacheEntry>();

  async function unwrapCek(row: LocalNoteRow): Promise<CryptoKey> {
    const session = requireSession();
    return row.wrap_method === 'dek'
      ? noteCrypto.unwrapCekWithDek(session.dek, row.wrapped_cek)
      : noteCrypto.unwrapCekWithPrivateKey(session.privateKey, row.wrapped_cek);
  }

  async function decryptRow(row: LocalNoteRow): Promise<CacheEntry> {
    const cek = await unwrapCek(row);
    const title = await noteCrypto.openTitle(cek, row.id, row.title_ct);
    const tags = await noteCrypto.openTags(cek, row.id, row.tags_ct);
    return { cek, title, tags };
  }

  async function getLocalRow(id: string): Promise<LocalNoteRow | null> {
    const db = await getDb();
    const rows = await db.select<LocalNoteRow[]>('SELECT * FROM local_note WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  async function upsertLocalNote(row: LocalNoteRow): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT INTO local_note (id, owner_id, title_ct, body_ct, tags_ct, wrapped_cek, wrap_method, pinned, rev, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         owner_id = excluded.owner_id, title_ct = excluded.title_ct, body_ct = excluded.body_ct, tags_ct = excluded.tags_ct,
         wrapped_cek = excluded.wrapped_cek, wrap_method = excluded.wrap_method, pinned = excluded.pinned, rev = excluded.rev,
         created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
      [
        row.id,
        row.owner_id,
        row.title_ct,
        row.body_ct,
        row.tags_ct,
        row.wrapped_cek,
        row.wrap_method,
        row.pinned,
        row.rev,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    cache.set(row.id, await decryptRow(row));
  }

  async function deleteLocalNote(id: string): Promise<void> {
    const db = await getDb();
    await db.execute('DELETE FROM local_note WHERE id = ?', [id]);
    await db.execute('DELETE FROM local_comment WHERE note_id = ?', [id]);
    cache.delete(id);
  }

  async function loadCacheFromDb(): Promise<void> {
    const db = await getDb();
    const rows = await db.select<LocalNoteRow[]>('SELECT * FROM local_note');
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      if (!cache.has(row.id)) cache.set(row.id, await decryptRow(row));
    }
    for (const id of Array.from(cache.keys())) {
      if (!seen.has(id)) cache.delete(id);
    }
  }

  async function sync(): Promise<void> {
    await loadCacheFromDb();
    await drainQueue();

    let cursor = await getCursor();
    for (;;) {
      const page = await notesApi.listNotes(cursor ?? undefined);

      for (const row of page.notes) {
        const existing = await getLocalRow(row.id);
        if (existing && existing.rev === row.rev) {
          const db = await getDb();
          await db.execute('UPDATE local_note SET pinned = ?, updated_at = ?, deleted_at = ? WHERE id = ?', [
            row.pinned,
            row.updated_at,
            row.deleted_at,
            row.id,
          ]);
          continue;
        }
        const full = await notesApi.getNote(row.id);
        await upsertLocalNote({ ...full, pinned: row.pinned, updated_at: row.updated_at });
      }

      for (const id of [...page.tombstones, ...page.revoked]) await deleteLocalNote(id);

      cursor = page.next;
      await setCursor(cursor);
      if (!cursor) break;
    }
  }

  function toSummary(id: string, row: LocalNoteRow, entry: CacheEntry): DecryptedNoteSummary {
    const session = requireSession();
    return {
      id,
      ownerId: row.owner_id,
      isOwner: row.owner_id === session.userId,
      title: entry.title,
      tags: entry.tags,
      pinned: row.pinned === 1,
      rev: row.rev,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  async function listNotes(): Promise<DecryptedNoteSummary[]> {
    if (cache.size === 0) await loadCacheFromDb();
    const db = await getDb();
    const rows = await db.select<LocalNoteRow[]>('SELECT * FROM local_note');
    return rows.filter(r => cache.has(r.id)).map(r => toSummary(r.id, r, cache.get(r.id) as CacheEntry));
  }

  async function getNote(id: string): Promise<DecryptedNote | null> {
    let row = await getLocalRow(id);
    if (!row) {
      try {
        const full = await notesApi.getNote(id);
        await upsertLocalNote({ ...full });
        row = await getLocalRow(id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        return null;
      }
    }
    if (!row) return null;
    const entry = cache.get(id) ?? (await decryptRow(row));
    cache.set(id, entry);
    const body = await noteCrypto.openBody(entry.cek, id, row.body_ct);
    return { ...toSummary(id, row, entry), body };
  }

  async function createNewNote(title: string, tags: string[], body: string): Promise<DecryptedNote> {
    const session = requireSession();
    const newId = crypto.randomUUID();
    const cek = await noteCrypto.generateCek();
    const titleCt = await noteCrypto.sealTitle(cek, newId, title);
    const bodyCt = await noteCrypto.sealBody(cek, newId, body);
    const tagsCt = tags.length > 0 ? await noteCrypto.sealTags(cek, newId, tags) : null;
    const wrappedCek = await noteCrypto.wrapCekWithDek(session.dek, cek);

    const now = Date.now();
    const row: LocalNoteRow = {
      id: newId,
      owner_id: session.userId,
      title_ct: titleCt,
      body_ct: bodyCt,
      tags_ct: tagsCt,
      wrapped_cek: wrappedCek,
      wrap_method: 'dek',
      pinned: 0,
      rev: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await upsertLocalNote(row);
    await enqueue({ kind: 'create', noteId: newId, title_ct: titleCt, body_ct: bodyCt, tags_ct: tagsCt, wrapped_cek: wrappedCek });

    const entry = cache.get(newId) as CacheEntry;
    return { ...toSummary(newId, row, entry), body };
  }

  async function saveNote(id: string | null, title: string, body: string, tags: string[]): Promise<DecryptedNote> {
    if (id === null) return createNewNote(title, tags, body);

    const row = await getLocalRow(id);
    const entry = cache.get(id);
    if (!row || !entry) throw new Error('Note not loaded locally');

    const titleCt = await noteCrypto.sealTitle(entry.cek, id, title);
    const bodyCt = await noteCrypto.sealBody(entry.cek, id, body);
    const tagsCt = tags.length > 0 ? await noteCrypto.sealTags(entry.cek, id, tags) : null;
    const now = Date.now();

    const updatedRow: LocalNoteRow = { ...row, title_ct: titleCt, body_ct: bodyCt, tags_ct: tagsCt, updated_at: now };
    await upsertLocalNote(updatedRow);
    await enqueue({ kind: 'update', noteId: id, title_ct: titleCt, body_ct: bodyCt, tags_ct: tagsCt, base_rev: row.rev });

    const newEntry = cache.get(id) as CacheEntry;
    return { ...toSummary(id, updatedRow, newEntry), body };
  }

  async function setPinned(id: string, pinned: boolean): Promise<void> {
    const db = await getDb();
    await db.execute('UPDATE local_note SET pinned = ?, updated_at = ? WHERE id = ?', [pinned ? 1 : 0, Date.now(), id]);
    await enqueue({ kind: 'pin', noteId: id, pinned: pinned ? 1 : 0 });
  }

  async function trashNote(id: string): Promise<void> {
    const db = await getDb();
    await db.execute('UPDATE local_note SET deleted_at = ? WHERE id = ?', [Date.now(), id]);
    await enqueue({ kind: 'trash', noteId: id });
  }

  async function restoreNote(id: string): Promise<void> {
    const db = await getDb();
    await db.execute('UPDATE local_note SET deleted_at = NULL WHERE id = ?', [id]);
    await enqueue({ kind: 'restore', noteId: id });
  }

  async function purgeNote(id: string): Promise<void> {
    await deleteLocalNote(id);
    await enqueue({ kind: 'purge', noteId: id });
  }

  async function shareNote(id: string, recipientEmail: string): Promise<void> {
    const session = requireSession();
    const row = await getLocalRow(id);
    if (!row) throw new Error('Note not loaded locally');
    if (row.wrap_method !== 'dek') throw new Error('Only the owner can share this note');

    const recipient = await authApi.lookupPublicKey(recipientEmail);
    const publicKey = await importRecipientPublicKey(recipient.public_key);
    const extractableCek = await noteCrypto.unwrapCekWithDekExtractable(session.dek, row.wrapped_cek);
    const wrappedCek = await noteCrypto.wrapCekWithPublicKey(publicKey, extractableCek);
    await enqueue({ kind: 'share', noteId: id, recipientId: recipient.user_id, wrappedCek });
  }

  async function unshareNote(id: string, userId: string): Promise<void> {
    await enqueue({ kind: 'unshare', noteId: id, userId });
  }

  async function listComments(noteId: string): Promise<DecryptedComment[]> {
    const row = await getLocalRow(noteId);
    const entry = cache.get(noteId);
    if (!row || !entry) throw new Error('Note not loaded locally');
    const db = await getDb();

    try {
      const res = await notesApi.listComments(noteId);
      await db.execute('DELETE FROM local_comment WHERE note_id = ?', [noteId]);
      for (const c of res.comments) {
        await db.execute(
          'INSERT INTO local_comment (id, note_id, author_id, body_ct, created_at) VALUES (?, ?, ?, ?, ?)',
          [c.id, noteId, c.author_id, c.body_ct, c.created_at]
        );
      }
    } catch {
    }

    const cached = await db.select<LocalCommentRow[]>(
      'SELECT * FROM local_comment WHERE note_id = ? ORDER BY created_at ASC',
      [noteId]
    );
    return Promise.all(
      cached.map(async c => ({
        id: c.id,
        authorId: c.author_id,
        body: await noteCrypto.openComment(entry.cek, c.id, c.body_ct),
        createdAt: c.created_at,
      }))
    );
  }

  async function postComment(noteId: string, body: string): Promise<DecryptedComment> {
    const entry = cache.get(noteId);
    if (!entry) throw new Error('Note not loaded locally');
    const id = crypto.randomUUID();
    const bodyCt = await noteCrypto.sealComment(entry.cek, id, body);
    const now = Date.now();

    const db = await getDb();
    await db.execute('INSERT INTO local_comment (id, note_id, author_id, body_ct, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      noteId,
      requireSession().userId,
      bodyCt,
      now,
    ]);
    await enqueue({ kind: 'comment', noteId, commentId: id, body_ct: bodyCt });

    return { id, authorId: requireSession().userId, body, createdAt: now };
  }

  async function deleteComment(noteId: string, commentId: string): Promise<void> {
    const db = await getDb();
    await db.execute('DELETE FROM local_comment WHERE id = ? AND note_id = ?', [commentId, noteId]);
    await enqueue({ kind: 'deleteComment', noteId, commentId });
  }

  async function search(query: string): Promise<DecryptedNoteSummary[]> {
    if (cache.size === 0) await loadCacheFromDb();
    const db = await getDb();
    const rows = await db.select<LocalNoteRow[]>('SELECT * FROM local_note');
    const entries = rows.filter(r => cache.has(r.id)).map(r => ({ id: r.id, title: (cache.get(r.id) as CacheEntry).title, tags: (cache.get(r.id) as CacheEntry).tags }));

    const q = query.trim().toLowerCase();
    let matchIds: Set<string>;
    if (!q) {
      matchIds = new Set(entries.map(e => e.id));
    } else {
      const titleTagMatches = new Set(searchIndex(entries, query));
      const bodyMatches = new Set<string>();
      for (const row of rows) {
        if (titleTagMatches.has(row.id)) continue;
        const cacheEntry = cache.get(row.id);
        if (!cacheEntry) continue;
        try {
          const body = await noteCrypto.openBody(cacheEntry.cek, row.id, row.body_ct);
          if (body.toLowerCase().includes(q)) bodyMatches.add(row.id);
        } catch {
          continue;
        }
      }
      matchIds = new Set([...titleTagMatches, ...bodyMatches]);
    }

    return rows
      .filter(r => matchIds.has(r.id) && cache.has(r.id))
      .map(r => toSummary(r.id, r, cache.get(r.id) as CacheEntry));
  }

  return {
    sync,
    listNotes,
    getNote,
    saveNote,
    setPinned,
    trashNote,
    restoreNote,
    purgeNote,
    shareNote,
    unshareNote,
    listComments,
    postComment,
    deleteComment,
    search,
  };
}
