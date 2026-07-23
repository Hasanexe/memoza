import * as notesApi from '@memoza/core/api/notes';
import * as noteCrypto from '@memoza/core/crypto/note';
import { requireSession } from '@memoza/core/crypto/session';
import { search as searchIndex } from '@memoza/core/search';
import { ApiError } from '@memoza/core/api/client';
import type { Store, DecryptedNoteSummary, DecryptedNote, DecryptedComment, NoteShare } from '@memoza/core/store/types';
import type { FullNote } from '@memoza/core/api/notes';
import { importRecipientPublicKey } from '@memoza/core/crypto/keys';
import * as authApi from '@memoza/core/api/auth';
import { getFormat } from '@memoza/core/views/controlTags';
import { markSyncing } from '@memoza/core/connection';
import { getDb, getCursor, setCursor } from './db';
import { enqueue, drainQueue, pendingWriteCount } from './queue';

interface LocalNoteRow {
  id: string;
  owner_id: string;
  title_ct: string;
  body_ct: string;
  tags_ct: string | null;
  wrapped_cek: string;
  wrap_method: 'dek' | 'pubkey';
  has_unread_comment: number;
  page_no: number | null;
  is_public: number;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  owner_username: string | null;
}

interface LocalCommentRow {
  id: string;
  note_id: string;
  author_username: string | null;
  body_ct: string;
  created_at: number;
}

interface CacheEntry {
  cek: CryptoKey;
  title: string;
  tags: string[];
}

const SYNC_TTL_MS = 30_000;

export function createSqliteStore(): Store {
  const cache = new Map<string, CacheEntry>();
  let lastSyncAt = 0;

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
      `INSERT INTO local_note (id, owner_id, title_ct, body_ct, tags_ct, wrapped_cek, wrap_method, has_unread_comment, page_no, is_public, rev, created_at, updated_at, deleted_at, owner_username)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         owner_id = excluded.owner_id, title_ct = excluded.title_ct, body_ct = excluded.body_ct, tags_ct = excluded.tags_ct,
         wrapped_cek = excluded.wrapped_cek, wrap_method = excluded.wrap_method, has_unread_comment = excluded.has_unread_comment,
         page_no = excluded.page_no, is_public = excluded.is_public, rev = excluded.rev,
         created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
         owner_username = excluded.owner_username`,
      [
        row.id,
        row.owner_id,
        row.title_ct,
        row.body_ct,
        row.tags_ct,
        row.wrapped_cek,
        row.wrap_method,
        row.has_unread_comment,
        row.page_no,
        row.is_public,
        row.rev,
        row.created_at,
        row.updated_at,
        row.deleted_at,
        row.owner_username,
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

  async function sync(force = false): Promise<void> {
    await loadCacheFromDb();
    await drainQueue();
    if (!force && Date.now() - lastSyncAt < SYNC_TTL_MS) return;

    markSyncing(true);
    try {
      let cursor = await getCursor();
      for (;;) {
        const page = await notesApi.listNotes(cursor ?? undefined);

        for (const row of page.notes) {
          const existing = await getLocalRow(row.id);
          if (existing && existing.rev === row.rev) {
            const db = await getDb();
            await db.execute(
              'UPDATE local_note SET has_unread_comment = ?, is_public = ?, updated_at = ?, deleted_at = ? WHERE id = ?',
              [row.has_unread_comment ? 1 : 0, row.is_public ? 1 : 0, row.updated_at, row.deleted_at, row.id]
            );
            continue;
          }
          const full = await notesApi.getNote(row.id);
          await upsertLocalNote({
            ...full,
            has_unread_comment: row.has_unread_comment ? 1 : 0,
            is_public: full.is_public ? 1 : 0,
            updated_at: row.updated_at,
            owner_username: full.owner_username ?? null,
          });
        }

        for (const id of [...page.tombstones, ...page.revoked]) await deleteLocalNote(id);

        cursor = page.next;
        await setCursor(cursor);
        if (!cursor) break;
      }
      lastSyncAt = Date.now();
    } finally {
      markSyncing(false);
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
      hasUnreadComment: row.has_unread_comment === 1,
      pageNo: row.page_no,
      isPublic: row.is_public === 1,
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
    if (!row || row.has_unread_comment === 1) {
      try {
        const full = await notesApi.getNote(id);
        await upsertLocalNote({
          ...full,
          has_unread_comment: full.has_unread_comment ? 1 : 0,
          is_public: full.is_public ? 1 : 0,
          owner_username: full.owner_username ?? null,
        });
        row = await getLocalRow(id);
      } catch (err) {
        if (!row) {
          if (err instanceof ApiError && err.status === 404) return null;
          throw err;
        }
      }
    }
    if (!row) return null;
    const entry = cache.get(id) ?? (await decryptRow(row));
    cache.set(id, entry);
    const body = await noteCrypto.openBody(entry.cek, id, row.body_ct);
    return { ...toSummary(id, row, entry), body, ownerUsername: row.owner_username };
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
      has_unread_comment: 0,
      page_no: null,
      is_public: 0,
      rev: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      owner_username: null,
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
    await enqueue({
      kind: 'update',
      noteId: id,
      title_ct: titleCt,
      body_ct: bodyCt,
      tags_ct: tagsCt,
      isPublic: row.is_public === 1,
    });

    const newEntry = cache.get(id) as CacheEntry;
    return { ...toSummary(id, updatedRow, newEntry), body };
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

  async function shareNote(id: string, recipientUsername: string): Promise<void> {
    const session = requireSession();
    const row = await getLocalRow(id);
    if (!row) throw new Error('Note not loaded locally');
    if (row.wrap_method !== 'dek') throw new Error('Only the owner can share this note');

    const recipient = await authApi.lookupPublicKey(recipientUsername);
    const publicKey = await importRecipientPublicKey(recipient.public_key);
    const extractableCek = await noteCrypto.unwrapCekWithDekExtractable(session.dek, row.wrapped_cek);
    const wrappedCek = await noteCrypto.wrapCekWithPublicKey(publicKey, extractableCek);
    await enqueue({ kind: 'share', noteId: id, recipientId: recipient.user_id, wrappedCek, username: recipient.username });
  }

  async function unshareNote(id: string, userId: string): Promise<void> {
    await enqueue({ kind: 'unshare', noteId: id, userId });
  }

  async function listShares(id: string): Promise<NoteShare[]> {
    const full = await notesApi.getNote(id);
    return (full.shares ?? []).map(s => ({ userId: s.user_id, username: s.username }));
  }

  async function publish(id: string): Promise<number> {
    const session = requireSession();
    const row = await getLocalRow(id);
    const entry = cache.get(id);
    if (!row || !entry) throw new Error('Note not loaded locally');
    if (row.owner_id !== session.userId) throw new Error('Only the owner can publish');

    const body = await noteCrypto.openBody(entry.cek, id, row.body_ct);
    const format = getFormat(entry.tags);
    const res = await notesApi.publishNote(id, { title: entry.title, body, format });

    const db = await getDb();
    await db.execute('UPDATE local_note SET is_public = 1, page_no = ? WHERE id = ?', [res.page_no, id]);
    return res.page_no;
  }

  async function listComments(noteId: string): Promise<DecryptedComment[]> {
    const row = await getLocalRow(noteId);
    const entry = cache.get(noteId);
    if (!row || !entry) throw new Error('Note not loaded locally');
    const db = await getDb();

    const pending = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) as count FROM write_queue WHERE note_id = ? AND kind IN ('comment', 'deleteComment')",
      [noteId]
    );
    if (pending[0]?.count === 0) {
      try {
        const res = await notesApi.listComments(noteId);
        await db.execute('DELETE FROM local_comment WHERE note_id = ?', [noteId]);
        for (const c of res.comments) {
          await db.execute(
            'INSERT INTO local_comment (id, note_id, author_username, body_ct, created_at) VALUES (?, ?, ?, ?, ?)',
            [c.id, noteId, c.author_username, c.body_ct, c.created_at]
          );
        }
      } catch {
      }
    }

    const cached = await db.select<LocalCommentRow[]>(
      'SELECT * FROM local_comment WHERE note_id = ? ORDER BY created_at ASC',
      [noteId]
    );
    return Promise.all(
      cached.map(async c => ({
        id: c.id,
        authorUsername: c.author_username,
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
    const username = requireSession().username;
    await db.execute('INSERT INTO local_comment (id, note_id, author_username, body_ct, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      noteId,
      username,
      bodyCt,
      now,
    ]);
    await enqueue({ kind: 'comment', noteId, commentId: id, body_ct: bodyCt });

    return { id, authorUsername: username, body, createdAt: now };
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
    const entries = rows.filter(r => cache.has(r.id)).map(r => ({ id: r.id, title: (cache.get(r.id) as CacheEntry).title }));

    const q = query.trim().toLowerCase();
    let matchIds: Set<string>;
    if (!q) {
      matchIds = new Set(entries.map(e => e.id));
    } else {
      const titleMatches = new Set(searchIndex(entries, query));
      const bodyMatches = new Set<string>();
      for (const row of rows) {
        if (titleMatches.has(row.id)) continue;
        const cacheEntry = cache.get(row.id);
        if (!cacheEntry) continue;
        try {
          const body = await noteCrypto.openBody(cacheEntry.cek, row.id, row.body_ct);
          if (body.toLowerCase().includes(q)) bodyMatches.add(row.id);
        } catch {
          continue;
        }
      }
      matchIds = new Set([...titleMatches, ...bodyMatches]);
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
    pendingWriteCount,
  };
}
