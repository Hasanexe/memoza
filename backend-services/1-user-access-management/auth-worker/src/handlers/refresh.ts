import { signAccessToken } from '@memoza/shared';
import { getRefreshToken, hashRefreshToken, buildRefreshCookie, toBase64Url, enforceRefreshTokenCap } from '../tokens';
import { json } from '../types';
import type { AuthEnv } from '../types';

export async function handleRefresh(
  request: Request,
  env: AuthEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const rawToken = getRefreshToken(request);
  if (!rawToken) return json({ error: 'Unauthorized' }, 401);

  const tokenHash = await hashRefreshToken(rawToken);

  const row = await env.DB.prepare(
    'SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = ?'
  )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number }>();

  if (!row) return json({ error: 'Unauthorized' }, 401);

  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
    return json({ error: 'Unauthorized' }, 401);
  }

  const user = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<{ id: string; username: string | null }>();
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const accessToken = await signAccessToken(env.JWT_PRIVATE_KEY, {
    user_id: row.user_id,
    username: user.username ?? '',
  });

  const newRawBytes = crypto.getRandomValues(new Uint8Array(32));
  const newRawToken = toBase64Url(newRawBytes.buffer);
  const newHash = await hashRefreshToken(newRawToken);
  const now = Date.now();
  const expiresAt = now + parseInt(env.REFRESH_TOKEN_TTL_MS, 10);
  const graceExpiry = now + parseInt(env.REFRESH_GRACE_MS, 10);

  await env.DB.batch([
    env.DB.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE token_hash = ?').bind(
      graceExpiry,
      tokenHash
    ),
    env.DB.prepare(
      'INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(newHash, row.user_id, expiresAt),
  ]);

  await enforceRefreshTokenCap(env, row.user_id, parseInt(env.MAX_REFRESH_TOKENS_PER_USER, 10));

  ctx.waitUntil(
    env.DB.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?')
      .bind(Date.now())
      .run()
  );

  return new Response(
    JSON.stringify({ access_token: accessToken, token_type: 'Bearer' }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': buildRefreshCookie(newRawToken, parseInt(env.REFRESH_TOKEN_MAX_AGE_S, 10)),
      },
    }
  );
}
