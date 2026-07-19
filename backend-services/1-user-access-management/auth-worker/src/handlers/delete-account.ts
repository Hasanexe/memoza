import { verify } from '../password';
import { clearRefreshCookie } from '../tokens';
import { json } from '../types';
import type { AuthEnv } from '../types';

const INVALID = 'Invalid credentials';

export async function handleDeleteAccount(
  request: Request,
  env: AuthEnv,
  ctx: ExecutionContext
): Promise<Response> {
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

  const user = await env.DB.prepare('SELECT id, password_hash, username FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first<{ id: string; password_hash: string; username: string | null }>();

  if (!user) return json({ error: INVALID }, 401);
  const ok = await verify(password, user.password_hash);
  if (!ok) return json({ error: INVALID }, 401);

  const statements = [
    env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM reset_token WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM activation_token WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ];
  if (user.username !== null) {
    statements.unshift(
      env.DB.prepare(
        "INSERT INTO retired_usernames (username, reason, retired_at) VALUES (?, 'deleted', ?)"
      ).bind(user.username, Date.now())
    );
  }
  await env.DB.batch(statements);

  ctx.waitUntil(
    env.NOTES.fetch('http://internal/notes/internal/purge-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.id }),
    })
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearRefreshCookie(),
    },
  });
}
