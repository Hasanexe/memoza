import { errors } from 'jose';
import { verifyToken, handlePreflight, addCors } from '@memoza/shared';
import type { AccessClaims, Role } from '@memoza/shared';

interface GatewayEnv {
  JWT_PUBLIC_KEY: string;
  JWT_PUBLIC_KEY_PREVIOUS?: string;
  FRONTEND_ORIGIN: string;
  NOTES: Fetcher;
  AUTH: Fetcher;
}

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkRbac(_pathname: string, role: Role): boolean {
  return role === 'Editor';
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
  headers.set('X-User-Role', claims.role);
  return headers;
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const preflight = handlePreflight(request, env.FRONTEND_ORIGIN, 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (preflight) return preflight;

    const { pathname, search } = new URL(request.url);

    if (request.method === 'GET' && pathname === '/health') {
      return addCors(json({ ok: true }, 200), request, env.FRONTEND_ORIGIN);
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return addCors(json({ error: 'Unauthorized' }, 401), request, env.FRONTEND_ORIGIN);
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
      return addCors(
        json({ error: expired ? 'Token expired' : 'Unauthorized' }, 401),
        request,
        env.FRONTEND_ORIGIN
      );
    }

    if (!checkRbac(pathname, claims.role)) {
      return addCors(json({ error: 'Forbidden' }, 403), request, env.FRONTEND_ORIGIN);
    }

    if (request.method === 'GET' && pathname === '/users/public-key') {
      const upstreamResponse = await env.AUTH.fetch(`http://internal/internal/auth/public-key${search}`, {
        method: 'GET',
        headers: identityHeaders(request, claims),
      });
      return addCors(upstreamResponse, request, env.FRONTEND_ORIGIN);
    }

    const upstream = resolveBinding(env, pathname);
    if (!upstream) {
      return addCors(json({ error: 'Not found' }, 404), request, env.FRONTEND_ORIGIN);
    }

    const forwardedRequest = new Request(request, { headers: identityHeaders(request, claims) });
    const upstreamResponse = await upstream.fetch(forwardedRequest);
    return addCors(upstreamResponse, request, env.FRONTEND_ORIGIN);
  },
};
