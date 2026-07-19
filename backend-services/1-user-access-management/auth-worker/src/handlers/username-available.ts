import { normalizeUsername } from '@memoza/shared';
import { loadValidActivationToken } from '../activation';
import { validateUsername } from '../validation';
import { json } from '../types';
import type { AuthEnv } from '../types';

export async function handleUsernameAvailable(request: Request, env: AuthEnv): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const username = searchParams.get('username');

  if (!token || !username) {
    return json({ error: 'token and username are required' }, 400);
  }
  if (!validateUsername(username)) {
    return json({ error: 'Invalid username' }, 400);
  }

  const activationToken = await loadValidActivationToken(env, token);
  if (!activationToken) {
    return json({ error: 'Invalid or expired token' }, 401);
  }

  const normalizedUsername = normalizeUsername(username);

  const taken = await env.DB.prepare(
    `SELECT 1 FROM users WHERE username = ?
     UNION SELECT 1 FROM retired_usernames WHERE username = ?`
  )
    .bind(normalizedUsername, normalizedUsername)
    .first();

  return json({ available: !taken }, 200);
}
