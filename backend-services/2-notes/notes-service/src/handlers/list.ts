import { json, encodeCursor, decodeCursor } from '../types';
import type { NotesEnv } from '../types';
import { runGuardedSweep } from '../sweep';

interface ListRow {
  note_id: string;
  wrapped_cek: string;
  wrap_method: string;
  pinned: number;
  grant_updated_at: number;
  revoked_at: number | null;
  owner_id: string;
  title_ct: string;
  tags_ct: string | null;
  rev: number;
  created_at: number;
  deleted_at: number | null;
  purged_at: number | null;
}

export async function handleList(
  env: NotesEnv,
  userId: string,
  searchParams: URLSearchParams
): Promise<Response> {
  const maxLimit = parseInt(env.MAX_SYNC_LIMIT, 10);
  const requestedRaw = searchParams.get('limit');
  let limit = maxLimit;
  if (requestedRaw !== null) {
    const requested = parseInt(requestedRaw, 10);
    if (!Number.isInteger(requested) || requested <= 0) return json({ error: 'Invalid limit' }, 400);
    limit = Math.min(requested, maxLimit);
  }

  const since = searchParams.get('since');
  let cursor: { updatedAt: number; id: string } | null = null;
  if (since) {
    cursor = decodeCursor(since);
    if (!cursor) return json({ error: 'Invalid cursor' }, 400);
  } else {
    await runGuardedSweep(env);
  }

  const select = `SELECT g.note_id, g.wrapped_cek, g.wrap_method, g.pinned, g.updated_at AS grant_updated_at, g.revoked_at,
                          n.owner_id, n.title_ct, n.tags_ct, n.rev, n.created_at, n.deleted_at, n.purged_at
                   FROM note_grant g JOIN note n ON n.id = g.note_id
                   WHERE g.user_id = ?`;

  const rows = cursor
    ? await env.DB.prepare(
        `${select} AND (g.updated_at > ? OR (g.updated_at = ? AND g.note_id > ?))
         ORDER BY g.updated_at ASC, g.note_id ASC LIMIT ?`
      )
        .bind(userId, cursor.updatedAt, cursor.updatedAt, cursor.id, limit)
        .all<ListRow>()
    : await env.DB.prepare(`${select} ORDER BY g.updated_at ASC, g.note_id ASC LIMIT ?`)
        .bind(userId, limit)
        .all<ListRow>();

  const notes: object[] = [];
  const tombstones: string[] = [];
  const revoked: string[] = [];
  let last: { updatedAt: number; id: string } | null = null;

  for (const r of rows.results) {
    last = { updatedAt: r.grant_updated_at, id: r.note_id };
    if (r.purged_at !== null) {
      tombstones.push(r.note_id);
    } else if (r.revoked_at !== null) {
      revoked.push(r.note_id);
    } else {
      notes.push({
        id: r.note_id,
        owner_id: r.owner_id,
        title_ct: r.title_ct,
        tags_ct: r.tags_ct,
        wrapped_cek: r.wrapped_cek,
        wrap_method: r.wrap_method,
        pinned: r.pinned,
        rev: r.rev,
        created_at: r.created_at,
        updated_at: r.grant_updated_at,
        deleted_at: r.deleted_at,
      });
    }
  }

  const next = rows.results.length === limit && last ? encodeCursor(last.updatedAt, last.id) : null;

  return json({ notes, tombstones, revoked, next }, 200);
}
