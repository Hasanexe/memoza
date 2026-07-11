export interface NotesEnv {
  DB: D1Database;
  MAX_TITLE_CT_BYTES: string;
  MAX_BODY_CT_BYTES: string;
  MAX_TAGS_CT_BYTES: string;
  MAX_COMMENT_CT_BYTES: string;
  MAX_SYNC_LIMIT: string;
  TRASH_RETENTION_DAYS: string;
  TOMBSTONE_RETENTION_DAYS: string;
  PURGE_SWEEP_INTERVAL_MS: string;
}

export function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function readUserId(request: Request): string | null {
  return request.headers.get('X-User-Id');
}

export function encodeCursor(updatedAt: number, id: string): string {
  return btoa(`${updatedAt}:${id}`);
}

export function decodeCursor(cursor: string): { updatedAt: number; id: string } | null {
  try {
    const decoded = atob(cursor);
    const sep = decoded.indexOf(':');
    if (sep === -1) return null;
    const updatedAt = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isInteger(updatedAt) || id.length === 0) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
