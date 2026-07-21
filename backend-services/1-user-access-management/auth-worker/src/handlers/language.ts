import { getRefreshToken, hashRefreshToken } from '../tokens';
import { validateLanguage } from '../validation';
import { json } from '../types';
import type { AuthEnv } from '../types';

export async function handleUpdateLanguage(request: Request, env: AuthEnv): Promise<Response> {
  const rawToken = getRefreshToken(request);
  if (!rawToken) return json({ error: 'Unauthorized' }, 401);

  const tokenHash = await hashRefreshToken(rawToken);
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = ?'
  )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number }>();

  if (!row || row.expires_at < Date.now()) return json({ error: 'Unauthorized' }, 401);

  let body: { language?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!validateLanguage(body.language)) {
    return json({ error: 'Invalid language' }, 400);
  }

  await env.DB.prepare('UPDATE users SET language = ? WHERE id = ?')
    .bind(body.language, row.user_id)
    .run();

  return json({ ok: true, language: body.language }, 200);
}
