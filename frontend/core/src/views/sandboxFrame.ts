import { h } from './dom';
import { PUBLIC_SITE_ORIGIN } from '../config';

const MIN_FRAME_HEIGHT = 120;

let runnerUrl = `${PUBLIC_SITE_ORIGIN}/_runner`;

export function configureSandboxRunner(url: string): void {
  runnerUrl = url;
}

export function renderHtmlFrame(host: HTMLElement, html: string): void {
  const frame = h('iframe', {
    class: 'html-frame',
    sandbox: 'allow-scripts allow-forms allow-modals',
    src: runnerUrl,
  }) as HTMLIFrameElement;

  function onMessage(event: MessageEvent): void {
    if (!frame.isConnected) {
      window.removeEventListener('message', onMessage);
      return;
    }
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { type?: string; value?: number } | null;
    if (data?.type === 'memoza-runner-ready') {
      frame.contentWindow?.postMessage({ type: 'memoza-html', html }, '*');
    } else if (data?.type === 'memoza-height' && typeof data.value === 'number') {
      frame.style.height = `${Math.max(MIN_FRAME_HEIGHT, Math.ceil(data.value))}px`;
    }
  }

  window.addEventListener('message', onMessage);
  host.append(frame);
}
