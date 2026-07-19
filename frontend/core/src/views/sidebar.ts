import { h, brand, icon } from './dom';
import type { AppContext } from './app';
import { requireSession } from '../crypto/session';
import { connectionStatus, onConnectionChange, type ConnectionStatus } from '../connection';
import type { NotePanelSection } from './notePanel';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  offline: 'Offline',
  syncing: 'Syncing…',
  synced: 'Synced',
};

export type SidebarSection = NotePanelSection | 'settings';

export interface SidebarChrome {
  el: HTMLElement;
  setActive(section: SidebarSection): void;
  restorePanel(panelRoot: HTMLElement): void;
}

export function renderSidebar(ctx: AppContext, active: SidebarSection, panelSlot: HTMLElement): SidebarChrome {
  const session = requireSession();
  const navButtons = new Map<SidebarSection, HTMLButtonElement>();

  function navItem(section: SidebarSection, label: string, iconName: Parameters<typeof icon>[0], path: string): HTMLElement {
    const btn = h(
      'button',
      { type: 'button', class: active === section ? 'sidebar-link active' : 'sidebar-link' },
      icon(iconName),
      h('span', {}, label)
    ) as HTMLButtonElement;
    btn.addEventListener('click', () => ctx.navigate(path));
    navButtons.set(section, btn);
    return btn;
  }

  const newBtn = h('button', {
    type: 'button',
    class: 'primary icon-btn sidebar-new',
    'aria-label': 'New page',
    title: 'New page',
  }, icon('plus'));
  newBtn.addEventListener('click', () => ctx.navigate('/note/new'));

  panelSlot.classList.toggle('hidden', active === 'settings');

  const spacer = h('div', { class: 'sidebar-spacer' });

  const statusChip = h('span', { class: 'connection-chip' }, '');
  function renderStatusChip(): void {
    const { status, pendingCount } = connectionStatus();
    statusChip.textContent = status === 'offline' && pendingCount > 0 ? `Offline — ${pendingCount} pending` : STATUS_LABEL[status];
    statusChip.className = `connection-chip connection-chip--${status}`;
  }
  renderStatusChip();
  onConnectionChange(renderStatusChip);

  const aside = h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'sidebar-brand' }, brand()),
    newBtn,
    h(
      'nav',
      { class: 'sidebar-nav' },
      navItem('mine', 'My notes', 'notebook', '/'),
      navItem('shared', 'Shared with me', 'users', '/shared'),
      navItem('trash', 'Trash', 'trash', '/trash')
    ),
    panelSlot,
    spacer,
    navItem('settings', 'Settings', 'settings', '/settings'),
    h('div', { class: 'sidebar-email' }, session.email, statusChip)
  );

  function setActive(section: SidebarSection): void {
    for (const [key, btn] of navButtons) btn.classList.toggle('active', key === section);
    panelSlot.classList.toggle('hidden', section === 'settings');
  }

  function restorePanel(panelRoot: HTMLElement): void {
    aside.insertBefore(panelRoot, spacer);
  }

  return { el: aside, setActive, restorePanel };
}
