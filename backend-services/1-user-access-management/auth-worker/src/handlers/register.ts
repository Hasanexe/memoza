import {
  validateEmail,
  validateAuthHash,
  validatePublicKey,
  validateEnvelopeField,
  validateKdfIterations,
  validateRecoveryMode,
} from '../validation';
import { hash } from '../password';
import { issueTokens } from '../tokens';
import { sendWelcome } from '../email';
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
    name,
    kdf_iterations,
    public_key,
    wrapped_dek,
    wrapped_private_key,
    wrapped_dek_recovery,
    wrapped_private_key_recovery,
    escrowed_recovery,
  } = body;
  const recoveryMode = body.recovery_mode === undefined ? 'private' : body.recovery_mode;

  if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string') {
    return json({ error: 'email, password, and name are required' }, 400);
  }
  if (!validateEmail(email)) {
    return json({ error: 'Invalid email format' }, 400);
  }
  if (!validateAuthHash(password)) {
    return json({ error: 'Invalid password' }, 400);
  }
  if (name.length === 0 || name.length > 256) {
    return json({ error: 'Invalid name' }, 400);
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

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first();
  if (existing) {
    return json({ error: 'Email already registered' }, 409);
  }

  const passwordHash = await hash(password, parseInt(env.PBKDF2_ITERATIONS, 10));
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  try {
    await env.DB.prepare(
      `INSERT INTO users (
         id, email, name, password_hash, role, created_at,
         kdf_iterations, public_key, wrapped_dek, wrapped_private_key,
         wrapped_dek_recovery, wrapped_private_key_recovery, recovery_mode, escrowed_recovery
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        email.toLowerCase(),
        name,
        passwordHash,
        'Editor',
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
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return json({ error: 'Email already registered' }, 409);
    }
    throw err;
  }

  ctx.waitUntil(sendWelcome(env, email, name));

  const { accessToken, refreshCookie } = await issueTokens(env, { id, role: 'Editor' });

  return new Response(
    JSON.stringify({ access_token: accessToken, token_type: 'Bearer' }),
    {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': refreshCookie,
      },
    }
  );
}
