import { toBase64Url, hashRefreshToken } from '../tokens';
import { sendPasswordReset } from '../email';
import { json } from '../types';
import type { AuthEnv } from '../types';
import { validateEmail } from '../validation';

export async function handleResetRequest(
  request: Request,
  env: AuthEnv,
  ctx: ExecutionContext
): Promise<Response> {
  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email } = body;
  if (typeof email !== 'string' || !validateEmail(email)) {
    return json({ error: 'Invalid email' }, 400);
  }

  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first<{ id: string }>();

  if (user) {
    const rawToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const tokenHash = await hashRefreshToken(rawToken);
    const expiresAt = Date.now() + parseInt(env.RESET_TOKEN_TTL_MS, 10);

    await env.DB.prepare('INSERT INTO reset_token (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(tokenHash, user.id, expiresAt)
      .run();

    ctx.waitUntil(sendPasswordReset(env, email.toLowerCase(), rawToken));
  }

  return json({ ok: true }, 202);
}
