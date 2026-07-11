import { json } from '../types';
import type { NotesEnv } from '../types';
import { validateUUID } from '../validation';

export async function handleUpdateGrant(
  request: Request,
  env: NotesEnv,
  userId: string,
  noteId: string
): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  let body: { pinned?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { pinned } = body;
  if (pinned !== 0 && pinned !== 1) {
    return json({ error: 'pinned must be 0 or 1' }, 400);
  }

  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE note_grant SET pinned = ?, updated_at = ? WHERE note_id = ? AND user_id = ? AND revoked_at IS NULL`
  )
    .bind(pinned, now, noteId, userId)
    .run();

  if (result.meta.changes === 0) return json({ error: 'Not found' }, 404);

  return json({ updated_at: now }, 200);
}
