import runnerHtml from '../runner.html';
import { htmlResponse } from '../types';
import type { Env } from '../types';

export function handleRunner(env: Env): Response {
  const origins = env.PARENT_ALLOWED_ORIGINS.split(',')
    .map(o => o.trim())
    .filter(Boolean);
  const html = runnerHtml.replace('__PARENT_ORIGINS__', origins.join(','));
  return htmlResponse(html, 200, {
    'Content-Security-Policy': `default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors ${origins.join(' ')}`,
    'Cache-Control': 'public, max-age=300',
  });
}
