import { verify } from '../password';
import { issueTokens } from '../tokens';
import { json } from '../types';
import type { AuthEnv } from '../types';

const INVALID = 'Invalid credentials';

export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email, password } = body;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return json({ error: 'email and password are required' }, 400);
  }

  const user = await env.DB.prepare(
    'SELECT id, password_hash, active, kdf_iterations, wrapped_dek, wrapped_private_key, username, language FROM users WHERE email = ?'
  )
    .bind(email.toLowerCase())
    .first<{
      id: string;
      password_hash: string;
      active: number;
      kdf_iterations: number;
      wrapped_dek: string;
      wrapped_private_key: string;
      username: string | null;
      language: string;
    }>();

  if (!user) return json({ error: INVALID }, 401);

  const ok = await verify(password, user.password_hash);
  if (!ok) return json({ error: INVALID }, 401);

  if (user.active !== 1) return json({ error: 'Not activated' }, 403);

  const { accessToken, refreshCookie } = await issueTokens(env, { id: user.id, username: user.username ?? '' });

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      kdf_iterations: user.kdf_iterations,
      wrapped_dek: user.wrapped_dek,
      wrapped_private_key: user.wrapped_private_key,
      username: user.username,
      language: user.language,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': refreshCookie,
      },
    }
  );
}
