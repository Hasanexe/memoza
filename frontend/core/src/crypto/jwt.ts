export function decodeAccessToken(token: string): { userId: string; role: string; exp: number } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed access token');
  const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
  const payload = JSON.parse(json) as { user_id: string; role: string; exp: number };
  return { userId: payload.user_id, role: payload.role, exp: payload.exp };
}
