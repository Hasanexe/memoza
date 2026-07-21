import { verify, hash } from '../password';
import { issueTokens } from '../tokens';
import { json } from '../types';
import type { AuthEnv } from '../types';
import { validateEmail, validateAuthHash, validateEnvelopeField } from '../validation';

const INVALID = 'Invalid credentials';

export async function handleChangePassword(request: Request, env: AuthEnv): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const {
    email,
    old_password,
    new_password,
    wrapped_dek,
    wrapped_private_key,
    wrapped_dek_recovery,
    wrapped_private_key_recovery,
  } = body;

  if (typeof email !== 'string' || !validateEmail(email)) {
    return json({ error: 'Invalid email' }, 400);
  }
  if (!validateAuthHash(old_password) || !validateAuthHash(new_password)) {
    return json({ error: 'Invalid password' }, 400);
  }
  if (!validateEnvelopeField(wrapped_dek) || !validateEnvelopeField(wrapped_private_key)) {
    return json({ error: 'Invalid key envelope' }, 400);
  }
  if (wrapped_dek_recovery !== undefined && !validateEnvelopeField(wrapped_dek_recovery)) {
    return json({ error: 'Invalid key envelope' }, 400);
  }
  if (wrapped_private_key_recovery !== undefined && !validateEnvelopeField(wrapped_private_key_recovery)) {
    return json({ error: 'Invalid key envelope' }, 400);
  }

  const user = await env.DB.prepare('SELECT id, password_hash, active FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first<{ id: string; password_hash: string; active: number }>();

  if (!user) return json({ error: INVALID }, 401);
  const ok = await verify(old_password, user.password_hash);
  if (!ok) return json({ error: INVALID }, 401);
  if (user.active !== 1) return json({ error: 'Account disabled' }, 403);

  const newHash = await hash(new_password, parseInt(env.PBKDF2_ITERATIONS, 10));

  const sets = ['password_hash = ?', 'wrapped_dek = ?', 'wrapped_private_key = ?'];
  const values: unknown[] = [newHash, wrapped_dek, wrapped_private_key];
  if (wrapped_dek_recovery !== undefined) {
    sets.push('wrapped_dek_recovery = ?');
    values.push(wrapped_dek_recovery);
  }
  if (wrapped_private_key_recovery !== undefined) {
    sets.push('wrapped_private_key_recovery = ?');
    values.push(wrapped_private_key_recovery);
  }
  values.push(user.id);

  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values),
    env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(user.id),
  ]);

  const { accessToken, refreshCookie } = await issueTokens(env, { id: user.id });

  return new Response(JSON.stringify({ access_token: accessToken, token_type: 'Bearer' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': refreshCookie,
    },
  });
}
