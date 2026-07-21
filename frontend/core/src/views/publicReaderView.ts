import { h, clear, brand, errorBanner } from './dom';
import { renderContent } from './markdown';
import { getPublicPage } from '../api/notes';
import { t } from '../i18n';

export async function renderPublicReader(root: HTMLElement, username: string, pageNo: number): Promise<void> {
  clear(root);
  root.append(h('div', { class: 'public-reader' }, brand(), h('p', {}, t('common.loading'))));

  let page;
  try {
    page = await getPublicPage(username, pageNo);
  } catch {
    clear(root);
    root.append(h('div', { class: 'public-reader' }, brand(), errorBanner(t('publicReader.pageNotFound'))));
    return;
  }

  clear(root);
  const bodyHost = h('div', { class: 'preview' });
  root.append(
    h(
      'div',
      { class: 'public-reader' },
      brand(),
      h('h1', { class: 'public-reader-title' }, page.title || t('editor.untitledPage')),
      bodyHost
    )
  );
  await renderContent(bodyHost, page.body, page.format === 'html' ? 'html' : 'md');
}
