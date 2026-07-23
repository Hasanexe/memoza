export interface Env {
  PARENT_ALLOWED_ORIGINS: string;
  PUBLIC_CACHE_MAX_AGE_S: string;
  GATEWAY: Fetcher;
}

export interface PublicPage {
  title: string;
  body: string;
  format: string;
}

export function htmlResponse(body: string, status: number, headers: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}
