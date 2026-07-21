import {
  validateEmail,
  validateAuthHash,
  validatePublicKey,
  validateEnvelopeField,
  validateKdfIterations,
  validateRecoveryMode,
  validateLanguage,
} from '../validation';
import { hash } from '../password';
import { toBase64Url, hashRefreshToken } from '../tokens';
import { sendActivation, sendAlreadyRegistered } from '../email';
import { json } from '../types';
import type { AuthEnv } from '../types';

export async function handleRegister(
  request: Request,
  env: AuthEnv,
  ctx: ExecutionContext
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const {
    email,
    password,
    language,
    kdf_iterations,
    public_key,
    wrapped_dek,
    wrapped_private_key,
    wrapped_dek_recovery,
    wrapped_private_key_recovery,
    escrowed_recovery,
  } = body;
  const recoveryMode = body.recovery_mode === undefined ? 'private' : body.recovery_mode;

  if (typeof email !== 'string' || typeof password !== 'string') {
    return json({ error: 'email and password are required' }, 400);
  }
  if (!validateEmail(email)) {
    return json({ error: 'Invalid email format' }, 400);
  }
  if (!validateAuthHash(password)) {
    return json({ error: 'Invalid password' }, 400);
  }
  if (!validateLanguage(language)) {
    return json({ error: 'Invalid language' }, 400);
  }
  if (!validateKdfIterations(kdf_iterations)) {
    return json({ error: 'Invalid kdf_iterations' }, 400);
  }
  if (!validatePublicKey(public_key)) {
    return json({ error: 'Invalid public_key' }, 400);
  }
  if (
    !validateEnvelopeField(wrapped_dek) ||
    !validateEnvelopeField(wrapped_private_key) ||
    !validateEnvelopeField(wrapped_dek_recovery) ||
    !validateEnvelopeField(wrapped_private_key_recovery)
  ) {
    return json({ error: 'Invalid key envelope' }, 400);
  }
  if (!validateRecoveryMode(recoveryMode)) {
    return json({ error: 'Invalid recovery_mode' }, 400);
  }
  if (recoveryMode === 'convenient' && !validateEnvelopeField(escrowed_recovery)) {
    return json({ error: 'escrowed_recovery is required in convenient mode' }, 400);
  }
  if (recoveryMode === 'private' && escrowed_recovery !== undefined) {
    return json({ error: 'escrowed_recovery is not allowed in private mode' }, 400);
  }

  const normalizedEmail = email.toLowerCase();

  await env.DB.prepare('DELETE FROM users WHERE active = 0 AND created_at < ?')
    .bind(Date.now() - parseInt(env.UNACTIVATED_RETENTION_MS, 10))
    .run();

  const passwordHash = await hash(password, parseInt(env.PBKDF2_ITERATIONS, 10));
  const newId = crypto.randomUUID();
  const createdAt = Date.now();

  const row = await env.DB.prepare(
    `INSERT INTO users (
       id, email, password_hash, language, created_at, active,
       kdf_iterations, public_key, wrapped_dek, wrapped_private_key,
       wrapped_dek_recovery, wrapped_private_key_recovery, recovery_mode, escrowed_recovery
     ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       password_hash = excluded.password_hash,
       language = excluded.language,
       kdf_iterations = excluded.kdf_iterations,
       public_key = excluded.public_key,
       wrapped_dek = excluded.wrapped_dek,
       wrapped_private_key = excluded.wrapped_private_key,
       wrapped_dek_recovery = excluded.wrapped_dek_recovery,
       wrapped_private_key_recovery = excluded.wrapped_private_key_recovery,
       recovery_mode = excluded.recovery_mode,
       escrowed_recovery = excluded.escrowed_recovery
     WHERE users.active = 0
     RETURNING id`
  )
    .bind(
      newId,
      normalizedEmail,
      passwordHash,
      language,
      createdAt,
      kdf_iterations,
      public_key,
      wrapped_dek,
      wrapped_private_key,
      wrapped_dek_recovery,
      wrapped_private_key_recovery,
      recoveryMode,
      recoveryMode === 'convenient' ? escrowed_recovery : null
    )
    .first<{ id: string }>();

  if (!row) {
    ctx.waitUntil(sendAlreadyRegistered(env, normalizedEmail));
    return json({ ok: true }, 202);
  }

  const rawToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const tokenHash = await hashRefreshToken(rawToken);
  const expiresAt = Date.now() + parseInt(env.ACTIVATION_TOKEN_TTL_MS, 10);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM activation_token WHERE user_id = ?').bind(row.id),
    env.DB.prepare(
      'INSERT INTO activation_token (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(tokenHash, row.id, expiresAt),
  ]);

  ctx.waitUntil(sendActivation(env, normalizedEmail, rawToken));

  return json({ ok: true }, 202);
}
