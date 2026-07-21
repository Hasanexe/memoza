import { errors } from 'jose';
import { verifyToken, handlePreflight, addCors, withSecurityHeaders, isValidUsernameFormat } from '@memoza/shared';
import type { AccessClaims } from '@memoza/shared';

const PUBLIC_PAGE_RE = /^\/public\/([^/]+)\/([^/]+)$/;
const PAGE_NO_RE = /^\d+$/;

interface GatewayEnv {
  JWT_PUBLIC_KEY: string;
  JWT_PUBLIC_KEY_PREVIOUS?: string;
  CORS_ALLOWED_ORIGINS: string;
  NOTES: Fetcher;
  AUTH: Fetcher;
}

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function respond(response: Response, request: Request, env: GatewayEnv, cacheControl: string): Response {
  return addCors(withSecurityHeaders(response, cacheControl), request, env.CORS_ALLOWED_ORIGINS);
}

function resolveBinding(env: GatewayEnv, pathname: string): Fetcher | null {
  if (pathname.startsWith('/notes/internal/')) return null;
  if (pathname === '/notes' || pathname.startsWith('/notes/')) return env.NOTES;
  return null;
}

function identityHeaders(request: Request, claims: AccessClaims): Headers {
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  headers.delete('X-User-Id');
  headers.delete('X-User-Role');
  headers.set('X-User-Id', claims.user_id);
  return headers;
}

async function handlePublicPage(pathname: string, env: GatewayEnv): Promise<Response> {
  const match = PUBLIC_PAGE_RE.exec(pathname);
  if (!match) return json({ error: 'Not found' }, 404);

  const [, username, pageNo] = match;
  if (!isValidUsernameFormat(username) || !PAGE_NO_RE.test(pageNo)) {
    return json({ error: 'Not found' }, 404);
  }

  const resolveResponse = await env.AUTH.fetch(
    `http://internal/internal/auth/resolve-username?username=${encodeURIComponent(username)}`
  );
  if (!resolveResponse.ok) return json({ error: 'Not found' }, 404);
  const { user_id } = (await resolveResponse.json()) as { user_id: string };

  const pageResponse = await env.NOTES.fetch(
    `http://internal/notes/internal/public/${encodeURIComponent(user_id)}/${pageNo}`
  );
  if (!pageResponse.ok) return json({ error: 'Not found' }, 404);
  const page = (await pageResponse.json()) as { title: string; body: string; format: string };

  return json({ title: page.title, body: page.body, format: page.format }, 200);
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const preflight = handlePreflight(request, env.CORS_ALLOWED_ORIGINS, 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (preflight) return preflight;

    const { pathname, search } = new URL(request.url);

    if (request.method === 'GET' && pathname === '/health') {
      return respond(json({ ok: true }, 200), request, env, 'no-store');
    }

    if (request.method === 'GET' && pathname.startsWith('/public/')) {
      return respond(await handlePublicPage(pathname, env), request, env, 'public, max-age=60');
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return respond(json({ error: 'Unauthorized' }, 401), request, env, 'no-store');
    }
    const token = authHeader.slice(7);

    let claims: AccessClaims;
    try {
      claims = await verifyToken(
        [env.JWT_PUBLIC_KEY, env.JWT_PUBLIC_KEY_PREVIOUS].filter((k): k is string => Boolean(k)),
        token
      );
    } catch (err: unknown) {
      const expired = err instanceof errors.JWTExpired;
      return respond(json({ error: expired ? 'Token expired' : 'Unauthorized' }, 401), request, env, 'no-store');
    }

    if (request.method === 'GET' && pathname === '/users/public-key') {
      const upstreamResponse = await env.AUTH.fetch(`http://internal/internal/auth/public-key${search}`, {
        method: 'GET',
        headers: identityHeaders(request, claims),
      });
      return respond(upstreamResponse, request, env, 'no-store');
    }

    const upstream = resolveBinding(env, pathname);
    if (!upstream) {
      return respond(json({ error: 'Not found' }, 404), request, env, 'no-store');
    }

    const forwardedRequest = new Request(request, { headers: identityHeaders(request, claims) });
    const upstreamResponse = await upstream.fetch(forwardedRequest);
    return respond(upstreamResponse, request, env, 'no-store');
  },
};
