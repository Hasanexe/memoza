import { json } from '../types';
import type { NotesEnv } from '../types';
import { validateUUID, validateCiphertext } from '../validation';

interface CommentRow {
  id: string;
  note_id: string;
  author_username: string | null;
  body_ct: string;
  created_at: number;
}

async function hasGrant(env: NotesEnv, userId: string, noteId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 FROM note_grant WHERE note_id = ? AND user_id = ? AND revoked_at IS NULL'
  )
    .bind(noteId, userId)
    .first();
  return row !== null;
}

export async function handleListComments(env: NotesEnv, userId: string, noteId: string): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);
  if (!(await hasGrant(env, userId, noteId))) return json({ error: 'Not found' }, 404);

  const rows = await env.DB.prepare(
    'SELECT id, author_username, body_ct, created_at FROM note_comment WHERE note_id = ? ORDER BY created_at ASC'
  )
    .bind(noteId)
    .all<Omit<CommentRow, 'note_id'>>();

  return json({ comments: rows.results }, 200);
}

export async function handlePostComment(
  request: Request,
  env: NotesEnv,
  userId: string,
  username: string,
  noteId: string
): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  let body: { id?: unknown; body_ct?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { id, body_ct } = body;
  if (!validateUUID(id)) return json({ error: 'Invalid comment id' }, 400);
  if (!validateCiphertext(body_ct, parseInt(env.MAX_COMMENT_CT_BYTES, 10))) {
    return json({ error: 'Invalid comment body' }, 400);
  }

  const note = await env.DB.prepare('SELECT purged_at FROM note WHERE id = ?')
    .bind(noteId)
    .first<{ purged_at: number | null }>();
  if (!note || note.purged_at !== null) return json({ error: 'Not found' }, 404);
  if (!(await hasGrant(env, userId, noteId))) return json({ error: 'Not found' }, 404);

  const existing = await env.DB.prepare(
    'SELECT id, note_id, author_username, body_ct, created_at FROM note_comment WHERE id = ?'
  )
    .bind(id)
    .first<CommentRow>();

  if (existing) {
    if (existing.note_id !== noteId || existing.author_username !== username) {
      return json({ error: 'Comment id already in use' }, 409);
    }
    return json(
      { id: existing.id, author_username: existing.author_username, body_ct: existing.body_ct, created_at: existing.created_at },
      201
    );
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO note_comment (id, note_id, author_username, body_ct, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      id,
      noteId,
      username,
      body_ct,
      now
    ),
    env.DB.prepare('UPDATE note_grant SET updated_at = ? WHERE note_id = ? AND revoked_at IS NULL').bind(
      now,
      noteId
    ),
    env.DB.prepare('UPDATE note SET last_comment_at = ? WHERE id = ?').bind(now, noteId),
  ]);

  return json({ id, author_username: username, body_ct, created_at: now }, 201);
}

export async function handleDeleteComment(
  env: NotesEnv,
  userId: string,
  username: string,
  noteId: string,
  commentId: string
): Promise<Response> {
  if (!validateUUID(noteId) || !validateUUID(commentId)) return json({ error: 'Invalid id' }, 400);

  const comment = await env.DB.prepare('SELECT author_username FROM note_comment WHERE id = ? AND note_id = ?')
    .bind(commentId, noteId)
    .first<{ author_username: string | null }>();
  if (!comment) return json({ error: 'Not found' }, 404);

  const note = await env.DB.prepare('SELECT owner_id FROM note WHERE id = ?')
    .bind(noteId)
    .first<{ owner_id: string }>();
  if (!note) return json({ error: 'Not found' }, 404);

  const isAuthor = comment.author_username !== null && comment.author_username === username;
  if (!isAuthor && note.owner_id !== userId) {
    return json({ error: 'Forbidden' }, 403);
  }

  await env.DB.prepare('DELETE FROM note_comment WHERE id = ? AND note_id = ?').bind(commentId, noteId).run();

  return json({ ok: true }, 200);
}
