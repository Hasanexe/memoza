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
  page_no: number | null;
  is_public: number;
  wrapped_cek: string;
  wrap_method: string;
  revoked_at: number | null;
  username: string | null;
}

export async function handleGetNote(env: NotesEnv, userId: string, username: string, noteId: string): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  const row = await env.DB.prepare(
    `SELECT n.id, n.owner_id, n.title_ct, n.body_ct, n.tags_ct, n.rev, n.created_at, n.updated_at,
            n.deleted_at, n.purged_at, n.page_no, n.is_public, g.wrapped_cek, g.wrap_method, g.revoked_at, g.username
     FROM note_grant g JOIN note n ON n.id = g.note_id
     WHERE g.note_id = ? AND g.user_id = ?`
  )
    .bind(noteId, userId)
    .first<NoteGrantRow>();

  if (!row || row.revoked_at !== null || row.purged_at !== null) {
    return json({ error: 'Not found' }, 404);
  }

  await env.DB.prepare('UPDATE note_grant SET last_viewed_at = ? WHERE note_id = ? AND user_id = ?')
    .bind(Date.now(), noteId, userId)
    .run();

  const isOwner = row.owner_id === userId;
  let ownerUsername: string | null = null;
  let shares: { user_id: string; username: string | null }[] = [];
  if (isOwner) {
    ownerUsername = username;
    if (row.username !== username) {
      await env.DB.prepare('UPDATE note_grant SET username = ? WHERE note_id = ? AND user_id = ?')
        .bind(username, noteId, userId)
        .run();
    }
    const grants = await env.DB.prepare(
      'SELECT user_id, username FROM note_grant WHERE note_id = ? AND revoked_at IS NULL AND user_id != ? ORDER BY updated_at ASC'
    )
      .bind(noteId, userId)
      .all<{ user_id: string; username: string | null }>();
    shares = grants.results;
  } else {
    const owner = await env.DB.prepare('SELECT username FROM note_grant WHERE note_id = ? AND user_id = ?')
      .bind(noteId, row.owner_id)
      .first<{ username: string | null }>();
    ownerUsername = owner?.username ?? null;
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
      rev: row.rev,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
      page_no: isOwner ? row.page_no : null,
      is_public: row.is_public === 1,
      owner_username: ownerUsername,
      shares,
    },
    200
  );
}
