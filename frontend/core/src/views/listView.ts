import { h, clear, icon } from './dom';
import type { AppContext } from './app';
import { renderSidebar } from './sidebar';

type Tab = 'mine' | 'shared' | 'trash';

const EMPTY_COPY: Record<Tab, string> = {
  mine: 'Select a page, or start a new one.',
  shared: 'Select a page shared with you.',
  trash: 'Select a trashed page to restore or delete it forever.',
};

export function renderList(ctx: AppContext, tab: Tab): void {
  const { root } = ctx;
  clear(root);

  root.append(
    h(
      'div',
      { class: 'app-shell' },
      renderSidebar(ctx, tab),
      h(
        'div',
        { class: 'main' },
        h('div', { class: 'main-empty' }, icon('notebook', 40), h('p', {}, EMPTY_COPY[tab]))
      )
    )
  );
}
