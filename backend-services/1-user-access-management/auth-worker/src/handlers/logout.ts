import { getRefreshToken, hashRefreshToken, clearRefreshCookie } from '../tokens';
import type { AuthEnv } from '../types';

export async function handleLogout(request: Request, env: AuthEnv): Promise<Response> {
  const rawToken = getRefreshToken(request);
  if (rawToken) {
    const tokenHash = await hashRefreshToken(rawToken);
    await env.DB.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearRefreshCookie(),
    },
  });
}
