import { json } from '../types';
import type { AuthEnv } from '../types';
import { validateEmail } from '../validation';

export async function handlePublicKeyLookup(request: Request, env: AuthEnv): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');
  if (!email || !validateEmail(email)) {
    return json({ error: 'Invalid email' }, 400);
  }

  const user = await env.DB.prepare('SELECT id, public_key FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first<{ id: string; public_key: string }>();

  if (!user) return json({ error: 'Not found' }, 404);

  return json({ user_id: user.id, public_key: user.public_key }, 200);
}
