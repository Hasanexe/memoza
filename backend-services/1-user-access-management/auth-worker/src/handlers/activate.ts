import { normalizeUsername } from '@memoza/shared';
import { loadValidActivationToken } from '../activation';
import { hashRefreshToken } from '../tokens';
import { validateUsername } from '../validation';
import { json } from '../types';
import type { AuthEnv } from '../types';

export async function handleActivate(request: Request, env: AuthEnv): Promise<Response> {
  let body: { token?: unknown; username?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { token, username } = body;
  if (typeof token !== 'string' || token.length === 0) {
    return json({ error: 'Invalid or expired token' }, 400);
  }
  if (!validateUsername(username)) {
    return json({ error: 'Invalid username' }, 400);
  }

  const activationToken = await loadValidActivationToken(env, token);
  if (!activationToken) {
    return json({ error: 'Invalid or expired token' }, 400);
  }

  const normalizedUsername = normalizeUsername(username);

  try {
    const result = await env.DB.prepare(
      `UPDATE users SET username = ?, active = 1
       WHERE id = ? AND username IS NULL
         AND NOT EXISTS (SELECT 1 FROM retired_usernames WHERE username = ?)`
    )
      .bind(normalizedUsername, activationToken.user_id, normalizedUsername)
      .run();

    if (result.meta.changes === 0) {
      return json({ error: 'Username not available' }, 409);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return json({ error: 'Username not available' }, 409);
    }
    throw err;
  }

  const tokenHash = await hashRefreshToken(token);
  await env.DB.prepare('DELETE FROM activation_token WHERE token_hash = ?').bind(tokenHash).run();

  return json({ ok: true }, 200);
}
