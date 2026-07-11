import { json } from '../types';
import type { NotesEnv } from '../types';

const CHUNK_SIZE = 200;
const MAX_CHUNKS = 500;

export async function handlePurgeUser(request: Request, env: NotesEnv): Promise<Response> {
  let body: { user_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { user_id } = body;
  if (typeof user_id !== 'string' || user_id.length === 0) {
    return json({ error: 'user_id is required' }, 400);
  }

  for (let i = 0; i < MAX_CHUNKS; i++) {
    const owned = await env.DB.prepare('SELECT id FROM note WHERE owner_id = ? AND purged_at IS NULL LIMIT ?')
      .bind(user_id, CHUNK_SIZE)
      .all<{ id: string }>();
    if (owned.results.length === 0) break;

    const ids = owned.results.map(r => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM note_comment WHERE note_id IN (${placeholders})`).bind(...ids),
      env.DB.prepare(`UPDATE note_grant SET wrapped_cek = '', updated_at = ? WHERE note_id IN (${placeholders})`).bind(
        now,
        ...ids
      ),
      env.DB.prepare(
        `UPDATE note SET title_ct = '', body_ct = '', tags_ct = NULL, purged_at = ?, updated_at = ? WHERE id IN (${placeholders})`
      ).bind(now, now, ...ids),
    ]);
  }

  for (let i = 0; i < MAX_CHUNKS; i++) {
    const now = Date.now();
    const result = await env.DB.prepare(
      `UPDATE note_grant SET wrapped_cek = '', revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL AND note_id IN
       (SELECT note_id FROM note_grant WHERE user_id = ? AND revoked_at IS NULL LIMIT ?)`
    )
      .bind(now, now, user_id, user_id, CHUNK_SIZE)
      .run();
    if (result.meta.changes === 0) break;
  }

  return json({ ok: true }, 200);
}
