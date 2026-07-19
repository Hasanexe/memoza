function parseAllowedOrigins(allowed: string): string[] {
  return allowed.split(',').map((origin) => origin.trim()).filter(Boolean);
}

function corsHeaders(origin: string | null, allowed: string): Record<string, string> {
  const base: Record<string, string> = { 'Vary': 'Origin' };
  if (origin && parseAllowedOrigins(allowed).includes(origin)) {
    base['Access-Control-Allow-Origin'] = origin;
    base['Access-Control-Allow-Credentials'] = 'true';
  }
  return base;
}

export function handlePreflight(request: Request, allowed: string, methods: string): Response | null {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request.headers.get('Origin'), allowed),
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function addCors(response: Response, request: Request, allowed: string): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request.headers.get('Origin'), allowed))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function withSecurityHeaders(response: Response, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', cacheControl);
  return new Response(response.body, { status: response.status, headers });
}
