import { json } from '../types';
import type { NotesEnv } from '../types';

interface PublicPageRow {
  title: string;
  body: string;
  format: string;
}

export async function handleGetPublicPage(env: NotesEnv, ownerId: string, pageNoRaw: string): Promise<Response> {
  const pageNo = Number(pageNoRaw);
  if (!Number.isInteger(pageNo) || pageNo <= 0) return json({ error: 'Not found' }, 404);

  const row = await env.DB.prepare(
    `SELECT p.title, p.body, p.format
     FROM public_page p JOIN note n ON n.id = p.note_id
     WHERE p.owner_id = ? AND p.page_no = ? AND n.deleted_at IS NULL AND n.purged_at IS NULL`
  )
    .bind(ownerId, pageNo)
    .first<PublicPageRow>();

  if (!row) return json({ error: 'Not found' }, 404);
  return json(row, 200);
}
