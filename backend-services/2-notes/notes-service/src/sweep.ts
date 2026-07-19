import type { NotesEnv } from './types';

const SWEEP_CHUNK_SIZE = 200;

export async function runGuardedSweep(env: NotesEnv): Promise<void> {
  const now = Date.now();
  const interval = parseInt(env.PURGE_SWEEP_INTERVAL_MS, 10);

  const claim = await env.DB.prepare('UPDATE sweep SET last_run = ? WHERE id = 1 AND last_run < ?')
    .bind(now, now - interval)
    .run();

  if (claim.meta.changes === 0) return;

  const trashCutoff = now - parseInt(env.TRASH_RETENTION_DAYS, 10) * 86400000;
  const tombstoneCutoff = now - parseInt(env.TOMBSTONE_RETENTION_DAYS, 10) * 86400000;

  const purged = await env.DB.prepare(
    `UPDATE note SET title_ct = '', body_ct = '', tags_ct = NULL, purged_at = ?, updated_at = ?
     WHERE id IN (SELECT id FROM note WHERE deleted_at IS NOT NULL AND deleted_at < ? AND purged_at IS NULL LIMIT ?)
     RETURNING id`
  )
    .bind(now, now, trashCutoff, SWEEP_CHUNK_SIZE)
    .all<{ id: string }>();

  const purgedIds = purged.results.map(r => r.id);
  if (purgedIds.length > 0) {
    const placeholders = purgedIds.map(() => '?').join(', ');
    await env.DB.batch([
      env.DB.prepare(`UPDATE note_grant SET wrapped_cek = '', updated_at = ? WHERE note_id IN (${placeholders})`).bind(
        now,
        ...purgedIds
      ),
      env.DB.prepare(`DELETE FROM public_page WHERE note_id IN (${placeholders})`).bind(...purgedIds),
    ]);
  }

  await env.DB.prepare(
    `DELETE FROM note_comment WHERE note_id IN
     (SELECT id FROM note WHERE purged_at IS NOT NULL AND purged_at < ? LIMIT ?)`
  )
    .bind(tombstoneCutoff, SWEEP_CHUNK_SIZE)
    .run();

  await env.DB.prepare(
    `DELETE FROM note_grant WHERE note_id IN
     (SELECT id FROM note WHERE purged_at IS NOT NULL AND purged_at < ? LIMIT ?)`
  )
    .bind(tombstoneCutoff, SWEEP_CHUNK_SIZE)
    .run();

  await env.DB.prepare(
    `DELETE FROM note_grant WHERE (note_id, user_id) IN
     (SELECT note_id, user_id FROM note_grant WHERE revoked_at IS NOT NULL AND revoked_at < ? LIMIT ?)`
  )
    .bind(tombstoneCutoff, SWEEP_CHUNK_SIZE)
    .run();

  await env.DB.prepare('DELETE FROM note WHERE id IN (SELECT id FROM note WHERE purged_at IS NOT NULL AND purged_at < ? LIMIT ?)')
    .bind(tombstoneCutoff, SWEEP_CHUNK_SIZE)
    .run();

  await env.DB.prepare(
    `DELETE FROM public_page WHERE note_id IN
     (SELECT p.note_id FROM public_page p LEFT JOIN note n ON n.id = p.note_id WHERE n.id IS NULL LIMIT ?)`
  )
    .bind(SWEEP_CHUNK_SIZE)
    .run();
}
