import { hashRefreshToken } from '../tokens';
import { hash } from '../password';
import { decryptEscrowedRecoveryKey } from '../escrow';
import { json } from '../types';
import type { AuthEnv } from '../types';
import { validateEmail, validateAuthHash, validateEnvelopeField } from '../validation';

interface ResetTokenRow {
  user_id: string;
  expires_at: number;
  email: string;
  recovery_mode: string;
  escrowed_recovery: string | null;
  wrapped_dek_recovery: string | null;
  wrapped_private_key_recovery: string | null;
}

async function loadValidToken(env: AuthEnv, token: string, email: string): Promise<ResetTokenRow | null> {
  const tokenHash = await hashRefreshToken(token);
  const row = await env.DB.prepare(
    `SELECT reset_token.user_id, reset_token.expires_at, users.email, users.recovery_mode, users.escrowed_recovery,
            users.wrapped_dek_recovery, users.wrapped_private_key_recovery
     FROM reset_token JOIN users ON users.id = reset_token.user_id
     WHERE reset_token.token_hash = ?`
  )
    .bind(tokenHash)
    .first<ResetTokenRow>();

  if (!row || row.expires_at < Date.now() || row.email !== email.toLowerCase()) return null;
  return row;
}

export async function handleResetConfirm(request: Request, env: AuthEnv): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const {
    token,
    email,
    new_password,
    wrapped_dek,
    wrapped_private_key,
    wrapped_dek_recovery,
    wrapped_private_key_recovery,
    escrowed_recovery,
  } = body;

  if (typeof token !== 'string' || token.length === 0) return json({ error: 'Invalid or expired token' }, 400);
  if (typeof email !== 'string' || !validateEmail(email)) return json({ error: 'Invalid or expired token' }, 400);

  const row = await loadValidToken(env, token, email);
  if (!row) return json({ error: 'Invalid or expired token' }, 400);

  if (new_password === undefined) {
    const envelope = {
      wrapped_dek_recovery: row.wrapped_dek_recovery,
      wrapped_private_key_recovery: row.wrapped_private_key_recovery,
    };
    if (row.recovery_mode !== 'convenient') {
      return json({ recovery_mode: row.recovery_mode, ...envelope }, 200);
    }
    if (!row.escrowed_recovery) {
      return json({ error: 'Invalid or expired token' }, 400);
    }
    const recoveryKey = await decryptEscrowedRecoveryKey(env.ESCROW_PRIVATE_KEY, row.escrowed_recovery);
    return json({ recovery_mode: row.recovery_mode, recovery_key: recoveryKey, ...envelope }, 200);
  }

  if (!validateAuthHash(new_password)) return json({ error: 'Invalid password' }, 400);
  if (
    !validateEnvelopeField(wrapped_dek) ||
    !validateEnvelopeField(wrapped_private_key) ||
    !validateEnvelopeField(wrapped_dek_recovery) ||
    !validateEnvelopeField(wrapped_private_key_recovery)
  ) {
    return json({ error: 'Invalid key envelope' }, 400);
  }

  const sets = [
    'password_hash = ?',
    'wrapped_dek = ?',
    'wrapped_private_key = ?',
    'wrapped_dek_recovery = ?',
    'wrapped_private_key_recovery = ?',
  ];
  const newHash = await hash(new_password, parseInt(env.PBKDF2_ITERATIONS, 10));
  const values: unknown[] = [newHash, wrapped_dek, wrapped_private_key, wrapped_dek_recovery, wrapped_private_key_recovery];

  if (row.recovery_mode === 'convenient') {
    if (!validateEnvelopeField(escrowed_recovery)) {
      return json({ error: 'Invalid key envelope' }, 400);
    }
    sets.push('escrowed_recovery = ?');
    values.push(escrowed_recovery);
  } else if (escrowed_recovery !== undefined) {
    return json({ error: 'escrowed_recovery is not allowed in private mode' }, 400);
  }

  const tokenHash = await hashRefreshToken(token);
  values.push(row.user_id);

  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values),
    env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(row.user_id),
    env.DB.prepare('DELETE FROM reset_token WHERE token_hash = ?').bind(tokenHash),
  ]);

  return json({ ok: true }, 200);
}
