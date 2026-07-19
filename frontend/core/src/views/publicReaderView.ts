import { h, clear, brand, errorBanner } from './dom';
import { renderContent } from './markdown';
import { getPublicPage } from '../api/notes';

export async function renderPublicReader(root: HTMLElement, username: string, pageNo: number): Promise<void> {
  clear(root);
  root.append(h('div', { class: 'public-reader' }, brand(), h('p', {}, 'Loading…')));

  let page;
  try {
    page = await getPublicPage(username, pageNo);
  } catch {
    clear(root);
    root.append(h('div', { class: 'public-reader' }, brand(), errorBanner('Page not found')));
    return;
  }

  clear(root);
  const bodyHost = h('div', { class: 'preview' });
  root.append(
    h(
      'div',
      { class: 'public-reader' },
      brand(),
      h('h1', { class: 'public-reader-title' }, page.title || 'Untitled page'),
      bodyHost
    )
  );
  await renderContent(bodyHost, page.body, page.format === 'html' ? 'html' : 'md');
}
