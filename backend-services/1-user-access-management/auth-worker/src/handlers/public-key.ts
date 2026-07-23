import { isValidUsernameFormat, normalizeUsername } from '@memoza/shared';
import { json } from '../types';
import type { AuthEnv } from '../types';

export async function handlePublicKeyLookup(request: Request, env: AuthEnv): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const username = searchParams.get('username');
  if (!username || !isValidUsernameFormat(username)) {
    return json({ error: 'Invalid username' }, 400);
  }

  const user = await env.DB.prepare('SELECT id, username, public_key FROM users WHERE username = ? AND active = 1')
    .bind(normalizeUsername(username))
    .first<{ id: string; username: string; public_key: string }>();

  if (!user) return json({ error: 'Not found' }, 404);

  return json({ user_id: user.id, username: user.username, public_key: user.public_key }, 200);
}
