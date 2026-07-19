import { json } from '../types';
import type { NotesEnv } from '../types';
import { validateUUID } from '../validation';

interface GrantOwnerRow {
  owner_id: string;
  deleted_at: number | null;
  purged_at: number | null;
}

async function loadOwnerState(env: NotesEnv, userId: string, noteId: string): Promise<GrantOwnerRow | null> {
  return env.DB.prepare(
    `SELECT n.owner_id, n.deleted_at, n.purged_at
     FROM note_grant g JOIN note n ON n.id = g.note_id
     WHERE g.note_id = ? AND g.user_id = ? AND g.revoked_at IS NULL`
  )
    .bind(noteId, userId)
    .first<GrantOwnerRow>();
}

export async function handleTrashNote(env: NotesEnv, userId: string, noteId: string): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  const state = await loadOwnerState(env, userId, noteId);
  if (!state) return json({ error: 'Not found' }, 404);
  if (state.owner_id !== userId) return json({ error: 'Forbidden' }, 403);
  if (state.purged_at !== null) return json({ error: 'Note is purged' }, 409);
  if (state.deleted_at !== null) return json({ ok: true }, 200);

  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE note SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND purged_at IS NULL`
  )
    .bind(now, now, noteId, userId)
    .run();

  if (result.meta.changes > 0) {
    await env.DB.prepare('UPDATE note_grant SET updated_at = ? WHERE note_id = ?').bind(now, noteId).run();
  }

  return json({ ok: true }, 200);
}

export async function handleRestoreNote(env: NotesEnv, userId: string, noteId: string): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  const state = await loadOwnerState(env, userId, noteId);
  if (!state) return json({ error: 'Not found' }, 404);
  if (state.owner_id !== userId) return json({ error: 'Forbidden' }, 403);
  if (state.purged_at !== null) return json({ error: 'Note is purged' }, 409);
  if (state.deleted_at === null) return json({ ok: true }, 200);

  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE note SET deleted_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL`
  )
    .bind(now, noteId, userId)
    .run();

  if (result.meta.changes > 0) {
    await env.DB.prepare('UPDATE note_grant SET updated_at = ? WHERE note_id = ?').bind(now, noteId).run();
  }

  return json({ ok: true }, 200);
}

export async function handlePurgeNote(env: NotesEnv, userId: string, noteId: string): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  const state = await loadOwnerState(env, userId, noteId);
  if (!state) return json({ error: 'Not found' }, 404);
  if (state.owner_id !== userId) return json({ error: 'Forbidden' }, 403);
  if (state.purged_at !== null) return json({ ok: true }, 200);

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE note SET title_ct = '', body_ct = '', tags_ct = NULL, purged_at = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND purged_at IS NULL`
    ).bind(now, now, noteId, userId),
    env.DB.prepare(
      `UPDATE note_grant SET wrapped_cek = '', updated_at = ? WHERE note_id = ?
       AND EXISTS (SELECT 1 FROM note WHERE id = ? AND purged_at = ?)`
    ).bind(now, noteId, noteId, now),
    env.DB.prepare(
      `DELETE FROM public_page WHERE owner_id = ? AND note_id = ?
       AND EXISTS (SELECT 1 FROM note WHERE id = ? AND purged_at = ?)`
    ).bind(userId, noteId, noteId, now),
  ]);

  return json({ ok: true }, 200);
}
