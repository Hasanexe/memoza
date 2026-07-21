import { signAccessToken } from '@memoza/shared';

export function toBase64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toBase64Url(buf);
}

export function buildRefreshCookie(token: string, maxAge: number): string {
  return `__Secure-refresh_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=${maxAge}`;
}

export function clearRefreshCookie(): string {
  return `__Secure-refresh_token=; HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=0`;
}

export function getRefreshToken(request: Request): string | null {
  const cookies = request.headers.get('Cookie') ?? '';
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '__Secure-refresh_token') return part.slice(eq + 1).trim();
  }
  return null;
}

export async function hashRefreshToken(token: string): Promise<string> {
  return hashToken(token);
}

export async function enforceRefreshTokenCap(
  env: { DB: D1Database },
  userId: string,
  maxPerUser: number
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM refresh_tokens WHERE user_id = ? AND token_hash NOT IN
     (SELECT token_hash FROM refresh_tokens WHERE user_id = ? ORDER BY expires_at DESC LIMIT ?)`
  )
    .bind(userId, userId, maxPerUser)
    .run();
}

export async function issueTokens(
  env: {
    JWT_PRIVATE_KEY: string;
    DB: D1Database;
    REFRESH_TOKEN_TTL_MS: string;
    REFRESH_TOKEN_MAX_AGE_S: string;
    MAX_REFRESH_TOKENS_PER_USER: string;
  },
  user: { id: string }
): Promise<{ accessToken: string; refreshCookie: string }> {
  const accessToken = await signAccessToken(env.JWT_PRIVATE_KEY, {
    user_id: user.id,
  });

  const rawBytes = crypto.getRandomValues(new Uint8Array(32));
  const refreshToken = toBase64Url(rawBytes.buffer);
  const tokenHash = await hashToken(refreshToken);
  const expiresAt = Date.now() + parseInt(env.REFRESH_TOKEN_TTL_MS, 10);

  await env.DB.prepare(
    'INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(tokenHash, user.id, expiresAt)
    .run();

  await enforceRefreshTokenCap(env, user.id, parseInt(env.MAX_REFRESH_TOKENS_PER_USER, 10));

  return { accessToken, refreshCookie: buildRefreshCookie(refreshToken, parseInt(env.REFRESH_TOKEN_MAX_AGE_S, 10)) };
}
