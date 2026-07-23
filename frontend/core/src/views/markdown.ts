import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { renderHtmlFrame } from './sandboxFrame';

type MermaidModule = typeof import('mermaid');

let mermaidModule: MermaidModule | null = null;

function prefersDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr) return attr === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

async function ensureMermaid(): Promise<MermaidModule> {
  if (!mermaidModule) mermaidModule = await import('mermaid');
  mermaidModule.default.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: prefersDark() ? 'dark' : 'default',
  });
  return mermaidModule;
}

export async function renderContent(host: HTMLElement, source: string, format: 'md' | 'html'): Promise<void> {
  if (format === 'html') {
    host.replaceChildren();
    renderHtmlFrame(host, source);
    return;
  }
  await renderMarkdown(host, source);
}

export async function renderMarkdown(host: HTMLElement, source: string): Promise<void> {
  const rawHtml = await marked.parse(source);
  host.innerHTML = DOMPurify.sanitize(rawHtml);

  const mermaidBlocks = Array.from(host.querySelectorAll('code.language-mermaid'));
  if (mermaidBlocks.length === 0) return;

  const mermaid = await ensureMermaid();
  let index = 0;
  for (const block of mermaidBlocks) {
    const pre = block.parentElement;
    if (!pre) continue;
    const id = `mermaid-${Date.now()}-${index++}`;
    try {
      const { svg } = await mermaid.default.render(id, block.textContent ?? '');
      const container = document.createElement('div');
      container.innerHTML = DOMPurify.sanitize(svg);
      pre.replaceWith(container);
    } catch {
      pre.classList.add('mermaid-error');
    }
  }
}
