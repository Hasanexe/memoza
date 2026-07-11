export interface AuthEnv {
  DB: D1Database;
  NOTES: Fetcher;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  ESCROW_PRIVATE_KEY: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  FRONTEND_ORIGIN: string;
  PBKDF2_ITERATIONS: string;
  REFRESH_TOKEN_TTL_MS: string;
  REFRESH_TOKEN_MAX_AGE_S: string;
  REFRESH_GRACE_MS: string;
  RESET_TOKEN_TTL_MS: string;
  MAX_REFRESH_TOKENS_PER_USER: string;
}

export function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
