import { json } from '../types';
import type { NotesEnv } from '../types';
import {
  validateUUID,
  validateCiphertext,
  validateOptionalCiphertext,
  validateFormat,
  MAX_WRAPPED_CEK_BYTES,
} from '../validation';

interface NoteMetaRow {
  id: string;
  owner_id: string;
  rev: number;
  created_at: number;
  updated_at: number;
  page_no: number | null;
}

interface CurrentNoteRow {
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
  is_public: number;
  wrapped_cek: string;
  wrap_method: string;
}

interface MirrorFields {
  title: string;
  body: string;
  format: string;
}

export async function handlePutNote(
  request: Request,
  env: NotesEnv,
  userId: string,
  noteId: string
): Promise<Response> {
  if (!validateUUID(noteId)) return json({ error: 'Invalid note id' }, 400);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { title_ct, body_ct, tags_ct, wrapped_cek, base_rev, title, body: plainBody, format } = body;

  const maxTitle = parseInt(env.MAX_TITLE_CT_BYTES, 10);
  const maxBody = parseInt(env.MAX_BODY_CT_BYTES, 10);
  const maxTags = parseInt(env.MAX_TAGS_CT_BYTES, 10);

  if (
    !validateCiphertext(title_ct, maxTitle) ||
    !validateCiphertext(body_ct, maxBody) ||
    !validateOptionalCiphertext(tags_ct, maxTags)
  ) {
    return json({ error: 'Invalid note content' }, 400);
  }
  const tagsCt = (tags_ct as string | null | undefined) ?? null;

  let mirror: MirrorFields | null = null;
  if (title !== undefined || plainBody !== undefined || format !== undefined) {
    if (!validateCiphertext(title, maxTitle) || !validateCiphertext(plainBody, maxBody) || !validateFormat(format)) {
      return json({ error: 'Invalid publish fields' }, 400);
    }
    mirror = { title, body: plainBody, format };
  }

  if (base_rev !== undefined) {
    if (typeof base_rev !== 'number' || !Number.isInteger(base_rev) || base_rev < 1) {
      return json({ error: 'Invalid base_rev' }, 400);
    }
    return updateNote(env, userId, noteId, title_ct, body_ct, tagsCt, base_rev, mirror);
  }

  if (!validateCiphertext(wrapped_cek, MAX_WRAPPED_CEK_BYTES)) {
    return json({ error: 'Invalid wrapped_cek' }, 400);
  }

  return createNote(env, userId, noteId, title_ct, body_ct, tagsCt, wrapped_cek);
}

async function nextPageNo(env: NotesEnv, ownerId: string): Promise<number> {
  await env.DB.prepare(
    'INSERT INTO owner_page_seq (owner_id, next_page) VALUES (?, 1) ON CONFLICT (owner_id) DO NOTHING'
  )
    .bind(ownerId)
    .run();

  const row = await env.DB.prepare(
    'UPDATE owner_page_seq SET next_page = next_page + 1 WHERE owner_id = ? RETURNING next_page'
  )
    .bind(ownerId)
    .first<{ next_page: number }>();

  return row!.next_page - 1;
}

async function createNote(
  env: NotesEnv,
  userId: string,
  noteId: string,
  titleCt: string,
  bodyCt: string,
  tagsCt: string | null,
  wrappedCek: string
): Promise<Response> {
  const existing = await env.DB.prepare(
    'SELECT id, owner_id, rev, created_at, updated_at, page_no FROM note WHERE id = ?'
  )
    .bind(noteId)
    .first<NoteMetaRow>();

  if (existing) {
    if (existing.owner_id !== userId) return json({ error: 'Note id already in use' }, 409);
    return json(
      {
        id: existing.id,
        rev: existing.rev,
        created_at: existing.created_at,
        updated_at: existing.updated_at,
        page_no: existing.page_no,
      },
      201
    );
  }

  const pageNo = await nextPageNo(env, userId);
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO note (id, owner_id, title_ct, body_ct, tags_ct, rev, created_at, updated_at, page_no)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(noteId, userId, titleCt, bodyCt, tagsCt, now, now, pageNo),
      env.DB.prepare(
        `INSERT INTO note_grant (note_id, user_id, wrapped_cek, wrap_method, last_viewed_at, updated_at)
         VALUES (?, ?, ?, 'dek', ?, ?)`
      ).bind(noteId, userId, wrappedCek, now, now),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      const row = await env.DB.prepare(
        'SELECT id, owner_id, rev, created_at, updated_at, page_no FROM note WHERE id = ?'
      )
        .bind(noteId)
        .first<NoteMetaRow>();
      if (row && row.owner_id === userId) {
        return json(
          { id: row.id, rev: row.rev, created_at: row.created_at, updated_at: row.updated_at, page_no: row.page_no },
          201
        );
      }
      return json({ error: 'Note id already in use' }, 409);
    }
    throw err;
  }

  return json({ id: noteId, rev: 1, created_at: now, updated_at: now, page_no: pageNo }, 201);
}

async function updateNote(
  env: NotesEnv,
  userId: string,
  noteId: string,
  titleCt: string,
  bodyCt: string,
  tagsCt: string | null,
  baseRev: number,
  mirror: MirrorFields | null
): Promise<Response> {
  const now = Date.now();
  const newRev = baseRev + 1;

  let results: D1Result[];
  if (mirror) {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE note SET title_ct = ?, body_ct = ?, tags_ct = ?, rev = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND rev = ? AND deleted_at IS NULL AND purged_at IS NULL AND is_public = 1`
      ).bind(titleCt, bodyCt, tagsCt, newRev, now, noteId, userId, baseRev),
      env.DB.prepare(
        `UPDATE public_page SET title = ?, body = ?, format = ?, updated_at = ?
         WHERE owner_id = ? AND page_no = (SELECT page_no FROM note WHERE id = ?)
         AND EXISTS (
           SELECT 1 FROM note
           WHERE id = ? AND owner_id = ? AND rev = ? AND deleted_at IS NULL AND purged_at IS NULL AND is_public = 1
         )`
      ).bind(mirror.title, mirror.body, mirror.format, now, userId, noteId, noteId, userId, newRev),
    ]);
  } else {
    results = [
      await env.DB.prepare(
        `UPDATE note SET title_ct = ?, body_ct = ?, tags_ct = ?, rev = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND rev = ? AND deleted_at IS NULL AND purged_at IS NULL AND is_public = 0`
      )
        .bind(titleCt, bodyCt, tagsCt, newRev, now, noteId, userId, baseRev)
        .run(),
    ];
  }

  if (results[0].meta.changes > 0) {
    await env.DB.prepare('UPDATE note_grant SET updated_at = ? WHERE note_id = ?').bind(now, noteId).run();
    return json({ rev: newRev, updated_at: now }, 200);
  }

  const current = await env.DB.prepare(
    `SELECT n.id, n.owner_id, n.title_ct, n.body_ct, n.tags_ct, n.rev, n.created_at, n.updated_at,
            n.deleted_at, n.purged_at, n.is_public, g.wrapped_cek, g.wrap_method
     FROM note_grant g JOIN note n ON n.id = g.note_id
     WHERE g.note_id = ? AND g.user_id = ?`
  )
    .bind(noteId, userId)
    .first<CurrentNoteRow>();

  if (!current) return json({ error: 'Not found' }, 404);
  if (current.owner_id !== userId) return json({ error: 'Forbidden' }, 403);
  if (current.purged_at !== null) return json({ error: 'Note is purged' }, 409);
  if (current.deleted_at !== null) return json({ error: 'Note is trashed' }, 409);
  if (mirror && current.is_public !== 1) return json({ error: 'Note is not published' }, 400);
  if (!mirror && current.is_public === 1) {
    return json({ error: 'Published note update requires title, body, and format' }, 400);
  }

  return json(
    {
      error: 'Conflict',
      note: {
        id: current.id,
        owner_id: current.owner_id,
        title_ct: current.title_ct,
        body_ct: current.body_ct,
        tags_ct: current.tags_ct,
        wrapped_cek: current.wrapped_cek,
        wrap_method: current.wrap_method,
        rev: current.rev,
        created_at: current.created_at,
        updated_at: current.updated_at,
        deleted_at: current.deleted_at,
      },
    },
    409
  );
}
