import * as notesApi from '@memoza/core/api/notes';
import { ApiError } from '@memoza/core/api/client';
import * as noteCrypto from '@memoza/core/crypto/note';
import { requireSession } from '@memoza/core/crypto/session';
import { getFormat } from '@memoza/core/views/controlTags';
import { setPendingCount } from '@memoza/core/connection';
import { getDb } from './db';

export type QueueOp =
  | { kind: 'create'; noteId: string; title_ct: string; body_ct: string; tags_ct: string | null; wrapped_cek: string }
  | {
      kind: 'update';
      noteId: string;
      title_ct: string;
      body_ct: string;
      tags_ct: string | null;
      base_rev: number;
      isPublic: boolean;
    }
  | { kind: 'trash'; noteId: string }
  | { kind: 'restore'; noteId: string }
  | { kind: 'purge'; noteId: string }
  | { kind: 'share'; noteId: string; recipientId: string; wrappedCek: string }
  | { kind: 'unshare'; noteId: string; userId: string }
  | { kind: 'comment'; noteId: string; commentId: string; body_ct: string }
  | { kind: 'deleteComment'; noteId: string; commentId: string };

async function refreshPendingCount(): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>('SELECT COUNT(*) as count FROM write_queue');
  setPendingCount(rows[0]?.count ?? 0);
}

export async function enqueue(op: QueueOp): Promise<void> {
  const db = await getDb();
  const noteId = 'noteId' in op ? op.noteId : null;
  await db.execute(
    'INSERT INTO write_queue (id, kind, note_id, payload_json, created_at, attempts) VALUES (?, ?, ?, ?, ?, 0)',
    [crypto.randomUUID(), op.kind, noteId, JSON.stringify(op), Date.now()]
  );
  await refreshPendingCount();
  void drainQueue();
}

let draining = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const RETRY_DELAY_MS = 15_000;

export async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  try {
    const db = await getDb();
    for (;;) {
      const rows = await db.select<{ id: string; payload_json: string }[]>(
        'SELECT id, payload_json FROM write_queue ORDER BY created_at ASC LIMIT 1'
      );
      if (rows.length === 0) break;
      const row = rows[0];
      const op = JSON.parse(row.payload_json) as QueueOp;
      try {
        await applyOp(op);
        await db.execute('DELETE FROM write_queue WHERE id = ?', [row.id]);
        await refreshPendingCount();
      } catch (err) {
        await db.execute('UPDATE write_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?', [
          err instanceof Error ? err.message : 'Unknown error',
          row.id,
        ]);
        await refreshPendingCount();
        retryTimer = setTimeout(() => void drainQueue(), RETRY_DELAY_MS);
        break;
      }
    }
  } finally {
    draining = false;
  }
}

async function forkConflictingUpdate(op: Extract<QueueOp, { kind: 'update' }>, conflictNote: notesApi.FullNote): Promise<void> {
  const session = requireSession();
  const db = await getDb();

  const cek = await noteCrypto.unwrapCekWithDek(session.dek, conflictNote.wrapped_cek);
  const title = await noteCrypto.openTitle(cek, op.noteId, op.title_ct);
  const body = await noteCrypto.openBody(cek, op.noteId, op.body_ct);
  const tags = await noteCrypto.openTags(cek, op.noteId, op.tags_ct);

  await db.execute(
    `UPDATE local_note SET title_ct = ?, body_ct = ?, tags_ct = ?, rev = ?, updated_at = ?, deleted_at = ?, page_no = ?, is_public = ?
     WHERE id = ?`,
    [
      conflictNote.title_ct,
      conflictNote.body_ct,
      conflictNote.tags_ct,
      conflictNote.rev,
      conflictNote.updated_at,
      conflictNote.deleted_at,
      conflictNote.page_no,
      conflictNote.is_public ? 1 : 0,
      op.noteId,
    ]
  );

  const newId = crypto.randomUUID();
  const newCek = await noteCrypto.generateCek();
  const newTitleCt = await noteCrypto.sealTitle(newCek, newId, title);
  const newBodyCt = await noteCrypto.sealBody(newCek, newId, body);
  const newTagsCt = tags.length > 0 ? await noteCrypto.sealTags(newCek, newId, tags) : null;
  const newWrappedCek = await noteCrypto.wrapCekWithDek(session.dek, newCek);

  const created = await notesApi.createNote(newId, {
    title_ct: newTitleCt,
    body_ct: newBodyCt,
    tags_ct: newTagsCt,
    wrapped_cek: newWrappedCek,
  });

  await db.execute(
    `INSERT INTO local_note (id, owner_id, title_ct, body_ct, tags_ct, wrapped_cek, wrap_method, has_unread_comment, page_no, is_public, rev, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'dek', 0, ?, 0, ?, ?, ?, NULL)`,
    [
      newId,
      session.userId,
      newTitleCt,
      newBodyCt,
      newTagsCt,
      newWrappedCek,
      created.page_no,
      created.rev,
      created.created_at,
      created.updated_at,
    ]
  );
}

async function attachPublishedMirror(
  noteId: string,
  titleCt: string,
  bodyCt: string,
  tagsCt: string | null
): Promise<{ title: string; body: string; format: string }> {
  const session = requireSession();
  const db = await getDb();
  const rows = await db.select<{ wrapped_cek: string }[]>('SELECT wrapped_cek FROM local_note WHERE id = ?', [noteId]);
  const wrappedCek = rows[0]?.wrapped_cek;
  if (!wrappedCek) throw new Error('Note not loaded locally');

  const cek = await noteCrypto.unwrapCekWithDek(session.dek, wrappedCek);
  const title = await noteCrypto.openTitle(cek, noteId, titleCt);
  const body = await noteCrypto.openBody(cek, noteId, bodyCt);
  const tags = await noteCrypto.openTags(cek, noteId, tagsCt);
  return { title, body, format: getFormat(tags) };
}

async function applyOp(op: QueueOp): Promise<void> {
  switch (op.kind) {
    case 'create': {
      const created = await notesApi.createNote(op.noteId, {
        title_ct: op.title_ct,
        body_ct: op.body_ct,
        tags_ct: op.tags_ct,
        wrapped_cek: op.wrapped_cek,
      });
      const db = await getDb();
      await db.execute('UPDATE local_note SET page_no = ? WHERE id = ?', [created.page_no, op.noteId]);
      return;
    }
    case 'update':
      try {
        const mirror = op.isPublic ? await attachPublishedMirror(op.noteId, op.title_ct, op.body_ct, op.tags_ct) : {};
        await notesApi.updateNote(op.noteId, {
          title_ct: op.title_ct,
          body_ct: op.body_ct,
          tags_ct: op.tags_ct,
          base_rev: op.base_rev,
          ...mirror,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === 'object' && 'note' in err.body) {
          await forkConflictingUpdate(op, (err.body as { note: notesApi.FullNote }).note);
          return;
        }
        throw err;
      }
      return;
    case 'trash':
      await notesApi.trashNote(op.noteId);
      return;
    case 'restore':
      await notesApi.restoreNote(op.noteId);
      return;
    case 'purge':
      await notesApi.purgeNote(op.noteId);
      return;
    case 'share':
      await notesApi.shareNote(op.noteId, op.recipientId, op.wrappedCek);
      return;
    case 'unshare':
      await notesApi.unshareNote(op.noteId, op.userId);
      return;
    case 'comment':
      await notesApi.postComment(op.noteId, op.commentId, op.body_ct);
      return;
    case 'deleteComment':
      await notesApi.deleteComment(op.noteId, op.commentId);
      return;
  }
}
