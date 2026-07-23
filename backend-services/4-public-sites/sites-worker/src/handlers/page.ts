import mdShell from '../md-shell.html';
import { htmlResponse } from '../types';
import type { Env, PublicPage } from '../types';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

export async function handlePage(username: string, pageNo: string, env: Env): Promise<Response | null> {
  const upstream = await env.GATEWAY.fetch(`http://internal/public/${encodeURIComponent(username)}/${pageNo}`);
  if (!upstream.ok) return null;
  const page = (await upstream.json()) as PublicPage;
  const cacheControl = `public, max-age=${parseInt(env.PUBLIC_CACHE_MAX_AGE_S, 10)}`;

  if (page.format === 'html') {
    return htmlResponse(page.body, 200, {
      'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-modals; frame-ancestors 'none'",
      'Cache-Control': cacheControl,
    });
  }

  const title = escapeHtml(page.title || 'Untitled page');
  const data = JSON.stringify({ body: page.body }).replace(/</g, '\\u003c');
  const [beforeData, afterData] = mdShell.split('__DATA__');
  const html = beforeData.replaceAll('__TITLE__', () => title) + data + afterData;
  return htmlResponse(html, 200, {
    'Content-Security-Policy': "default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    'Cache-Control': cacheControl,
  });
}
