import { json } from '../types';
import type { NotesEnv } from '../types';
import { validateUUID, validateCiphertext, MAX_WRAPPED_CEK_BYTES } from '../validation';

const MAX_RECIPIENT_ID_LEN = 128;

export async function handleShareNote(
  request: Request,
  env: NotesEnv,
  userId: string,
  noteId: string
): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  let body: { recipient_id?: unknown; wrapped_cek?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { recipient_id, wrapped_cek } = body;
  if (
    typeof recipient_id !== 'string' ||
    recipient_id.length === 0 ||
    recipient_id.length > MAX_RECIPIENT_ID_LEN
  ) {
    return json({ error: 'Invalid recipient_id' }, 400);
  }
  if (!validateCiphertext(wrapped_cek, MAX_WRAPPED_CEK_BYTES)) {
    return json({ error: 'Invalid wrapped_cek' }, 400);
  }
  if (recipient_id === userId) {
    return json({ error: 'Cannot share with yourself' }, 400);
  }

  const note = await env.DB.prepare('SELECT owner_id, purged_at FROM note WHERE id = ?')
    .bind(noteId)
    .first<{ owner_id: string; purged_at: number | null }>();
  if (!note) return json({ error: 'Not found' }, 404);
  if (note.owner_id !== userId) return json({ error: 'Forbidden' }, 403);
  if (note.purged_at !== null) return json({ error: 'Note is purged' }, 409);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO note_grant (note_id, user_id, wrapped_cek, wrap_method, pinned, updated_at, revoked_at)
     VALUES (?, ?, ?, 'pubkey', 0, ?, NULL)
     ON CONFLICT (note_id, user_id) DO UPDATE SET
       wrapped_cek = excluded.wrapped_cek, wrap_method = 'pubkey', updated_at = excluded.updated_at, revoked_at = NULL`
  )
    .bind(noteId, recipient_id, wrapped_cek, now)
    .run();

  return json({ ok: true }, 200);
}

export async function handleUnshareNote(
  env: NotesEnv,
  userId: string,
  noteId: string,
  recipientId: string
): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  const note = await env.DB.prepare('SELECT owner_id FROM note WHERE id = ?')
    .bind(noteId)
    .first<{ owner_id: string }>();
  if (!note) return json({ error: 'Not found' }, 404);
  if (note.owner_id !== userId) return json({ error: 'Forbidden' }, 403);
  if (recipientId === note.owner_id) return json({ error: 'Cannot revoke the owner grant' }, 400);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE note_grant SET wrapped_cek = '', revoked_at = ?, updated_at = ? WHERE note_id = ? AND user_id = ? AND revoked_at IS NULL`
  )
    .bind(now, now, noteId, recipientId)
    .run();

  return json({ ok: true }, 200);
}
