import { handleRunner } from './handlers/runner';
import { handlePage } from './handlers/page';
import { htmlResponse } from './types';
import type { Env } from './types';

const PAGE_RE = /^\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\/([1-9][0-9]{0,8})$/;

function notFound(): Response {
  return htmlResponse('<!doctype html><meta charset="utf-8"><title>Not found</title><p>Page not found.</p>', 404, {
    'Cache-Control': 'no-store',
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method !== 'GET') return notFound();
      const { pathname } = new URL(request.url);
      if (pathname === '/_runner') return handleRunner(env);
      const match = PAGE_RE.exec(pathname);
      if (match) {
        const page = await handlePage(match[1], match[2], env);
        if (page) return page;
      }
      return notFound();
    } catch {
      return htmlResponse('<!doctype html><meta charset="utf-8"><title>Error</title><p>Internal error.</p>', 500, {
        'Cache-Control': 'no-store',
      });
    }
  },
};
