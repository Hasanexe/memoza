import { json } from '../types';
import type { NotesEnv } from '../types';
import { validateUUID, validateCiphertext, validateFormat } from '../validation';

interface PublishNoteRow {
  owner_id: string;
  page_no: number | null;
  is_public: number;
  purged_at: number | null;
}

export async function handlePublishNote(
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

  const { title, body: plainBody, format } = body;
  const maxTitle = parseInt(env.MAX_TITLE_CT_BYTES, 10);
  const maxBody = parseInt(env.MAX_BODY_CT_BYTES, 10);

  if (!validateCiphertext(title, maxTitle) || !validateCiphertext(plainBody, maxBody) || !validateFormat(format)) {
    return json({ error: 'Invalid publish fields' }, 400);
  }

  const note = await env.DB.prepare('SELECT owner_id, page_no, is_public, purged_at FROM note WHERE id = ?')
    .bind(noteId)
    .first<PublishNoteRow>();

  if (!note) return json({ error: 'Not found' }, 404);
  if (note.owner_id !== userId) return json({ error: 'Forbidden' }, 403);
  if (note.purged_at !== null) return json({ error: 'Note is purged' }, 409);
  if (note.page_no === null) return json({ error: 'Note has no page number yet' }, 400);

  const now = Date.now();
  const wasPublic = note.is_public === 1;

  await env.DB.batch([
    env.DB.prepare('UPDATE note SET is_public = 1, updated_at = ? WHERE id = ?').bind(now, noteId),
    env.DB.prepare(
      `INSERT INTO public_page (owner_id, page_no, note_id, title, body, format, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, page_no) DO UPDATE SET
         note_id = excluded.note_id, title = excluded.title, body = excluded.body,
         format = excluded.format, updated_at = excluded.updated_at`
    ).bind(userId, note.page_no, noteId, title, plainBody, format, now),
    env.DB.prepare('UPDATE note_grant SET updated_at = ? WHERE note_id = ?').bind(now, noteId),
  ]);

  return json({ page_no: note.page_no }, wasPublic ? 200 : 201);
}
