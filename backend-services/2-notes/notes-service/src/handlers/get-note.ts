import { json } from '../types';
import type { NotesEnv } from '../types';
import { validateUUID } from '../validation';

interface NoteGrantRow {
  id: string;
  owner_id: string;
  title_ct: string;
  body_ct: string;
  tags_ct: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  purged_at: number | null;
  wrapped_cek: string;
  wrap_method: string;
  pinned: number;
  revoked_at: number | null;
}

export async function handleGetNote(env: NotesEnv, userId: string, noteId: string): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  const row = await env.DB.prepare(
    `SELECT n.id, n.owner_id, n.title_ct, n.body_ct, n.tags_ct, n.rev, n.created_at, n.updated_at,
            n.deleted_at, n.purged_at, g.wrapped_cek, g.wrap_method, g.pinned, g.revoked_at
     FROM note_grant g JOIN note n ON n.id = g.note_id
     WHERE g.note_id = ? AND g.user_id = ?`
  )
    .bind(noteId, userId)
    .first<NoteGrantRow>();

  if (!row || row.revoked_at !== null || row.purged_at !== null) {
    return json({ error: 'Not found' }, 404);
  }

  return json(
    {
      id: row.id,
      owner_id: row.owner_id,
      title_ct: row.title_ct,
      body_ct: row.body_ct,
      tags_ct: row.tags_ct,
      wrapped_cek: row.wrapped_cek,
      wrap_method: row.wrap_method,
      pinned: row.pinned,
      rev: row.rev,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    },
    200
  );
}
