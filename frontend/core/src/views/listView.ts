import type { AppContext } from './app';

type Tab = 'mine' | 'shared' | 'trash';

export function renderList(ctx: AppContext, tab: Tab): void {
  ctx.ensureShell(tab, null);
}
