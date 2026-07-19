import { h, brand, icon } from './dom';
import type { AppContext } from './app';
import { requireSession } from '../crypto/session';
import { connectionStatus, onConnectionChange, type ConnectionStatus } from '../connection';
import type { NotePanel, NotePanelSection } from './notePanel';
import { performLogout } from './authViews';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  offline: 'Offline',
  syncing: 'Syncing…',
  synced: 'Online',
};

export type SidebarSection = NotePanelSection | 'settings';

export interface SidebarChrome {
  el: HTMLElement;
  setActive(section: SidebarSection): void;
}

const SECTIONS: { key: NotePanelSection; label: string; iconName: Parameters<typeof icon>[0] }[] = [
  { key: 'mine', label: 'My notes', iconName: 'notebook' },
  { key: 'shared', label: 'Shared with me', iconName: 'users' },
  { key: 'trash', label: 'Trash', iconName: 'trash' },
];

const SECTION_PATH: Record<NotePanelSection, string> = { mine: '/', shared: '/shared', trash: '/trash' };
const COLLAPSE_KEY = 'sidebarCollapsed';

export function renderSidebar(ctx: AppContext, active: SidebarSection, panel: NotePanel): SidebarChrome {
  const session = requireSession();
  const navButtons = new Map<SidebarSection, HTMLButtonElement>();

  let mode: 'picker' | 'section' = 'picker';

  const statusChip = h('span', { class: 'connection-chip' }, '');
  function renderStatusChip(): void {
    const { status, pendingCount } = connectionStatus();
    statusChip.textContent =
      status === 'offline' && pendingCount > 0 ? `Offline — ${pendingCount} pending` : STATUS_LABEL[status];
    statusChip.className = `connection-chip connection-chip--${status}`;
  }
  renderStatusChip();
  onConnectionChange(renderStatusChip);

  const collapseBtn = h(
    'button',
    { type: 'button', class: 'icon-btn ghost sidebar-collapse-btn', 'aria-label': 'Collapse sidebar', title: 'Collapse sidebar' },
    icon('chevronsLeft', 18)
  );
  const expandBtn = h(
    'button',
    { type: 'button', class: 'icon-btn sidebar-expand-btn', 'aria-label': 'Expand sidebar', title: 'Expand sidebar' },
    icon('chevronRight', 18)
  );

  const brandRow = h('div', { class: 'sidebar-brand' }, brand(), statusChip, collapseBtn);

  function pickerItem(section: NotePanelSection, label: string, iconName: Parameters<typeof icon>[0]): HTMLElement {
    const btn = h(
      'button',
      { type: 'button', class: active === section ? 'sidebar-link sidebar-link--big active' : 'sidebar-link sidebar-link--big' },
      icon(iconName),
      h('span', {}, label)
    ) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      mode = 'section';
      renderMiddle();
      ctx.navigate(SECTION_PATH[section]);
    });
    navButtons.set(section, btn);
    return btn;
  }

  const pickerEl = h('nav', { class: 'sidebar-picker' }, ...SECTIONS.map(s => pickerItem(s.key, s.label, s.iconName)));

  const backBtn = h(
    'button',
    { type: 'button', class: 'icon-btn', 'aria-label': 'Back to sections', title: 'Back to sections' },
    icon('chevronLeft')
  );
  backBtn.addEventListener('click', () => {
    mode = 'picker';
    renderMiddle();
  });
  const newBtn = h(
    'button',
    { type: 'button', class: 'primary icon-btn', 'aria-label': 'New page', title: 'New page' },
    icon('plus')
  );
  newBtn.addEventListener('click', () => ctx.navigate('/note/new'));
  const searchRow = h('div', { class: 'sidebar-search-row' }, backBtn, newBtn, panel.search);
  const sectionEl = h('div', { class: 'sidebar-section' }, searchRow, panel.root);

  const middleHost = h('div', { class: 'sidebar-middle' });
  function renderMiddle(): void {
    middleHost.replaceChildren(mode === 'picker' ? pickerEl : sectionEl);
  }
  renderMiddle();

  const spacer = h('div', { class: 'sidebar-spacer' });

  const settingsBtn = h(
    'button',
    { type: 'button', class: active === 'settings' ? 'sidebar-link active' : 'sidebar-link' },
    icon('settings'),
    h('span', {}, 'Settings')
  ) as HTMLButtonElement;
  settingsBtn.addEventListener('click', () => ctx.navigate('/settings'));
  navButtons.set('settings', settingsBtn);

  const logoutBtn = h(
    'button',
    { type: 'button', class: 'icon-btn ghost sidebar-logout', 'aria-label': 'Log out', title: 'Log out' },
    icon('logout', 18)
  );
  logoutBtn.addEventListener('click', () => performLogout(ctx));
  const accountRow = h('div', { class: 'sidebar-account' }, h('span', { class: 'sidebar-email' }, session.email), logoutBtn);

  const aside = h(
    'aside',
    { class: 'sidebar' },
    brandRow,
    middleHost,
    spacer,
    settingsBtn,
    accountRow,
    expandBtn
  );

  function setCollapsed(next: boolean): void {
    aside.classList.toggle('sidebar--collapsed', next);
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  }
  collapseBtn.addEventListener('click', () => setCollapsed(true));
  expandBtn.addEventListener('click', () => setCollapsed(false));
  setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');

  function setActive(section: SidebarSection): void {
    for (const [key, btn] of navButtons) btn.classList.toggle('active', key === section);
  }

  return { el: aside, setActive };
}
