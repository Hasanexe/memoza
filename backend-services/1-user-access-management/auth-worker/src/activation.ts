import { hashRefreshToken } from './tokens';
import type { AuthEnv } from './types';

export interface ActivationTokenRow {
  user_id: string;
  expires_at: number;
}

export async function loadValidActivationToken(
  env: AuthEnv,
  token: string
): Promise<ActivationTokenRow | null> {
  const tokenHash = await hashRefreshToken(token);
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at FROM activation_token WHERE token_hash = ?'
  )
    .bind(tokenHash)
    .first<ActivationTokenRow>();

  if (!row || row.expires_at < Date.now()) return null;
  return row;
}
