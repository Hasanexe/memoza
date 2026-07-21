import { h, logoMark, icon } from './dom';
import type { AppContext } from './app';
import { createSyncStatus } from './syncStatus';
import type { NotePanelSection } from './notePanel';
import { lockSession } from './authViews';
import { t } from '../i18n';

export type SidebarSection = NotePanelSection | 'settings';

export interface SidebarChrome {
  el: HTMLElement;
  setActive(section: SidebarSection): void;
}

function sections(): { key: NotePanelSection; label: string; iconName: Parameters<typeof icon>[0] }[] {
  return [
    { key: 'mine', label: t('nav.myNotes'), iconName: 'notebook' },
    { key: 'shared', label: t('nav.sharedWithMe'), iconName: 'users' },
    { key: 'trash', label: t('nav.trash'), iconName: 'trash' },
  ];
}

const SECTION_PATH: Record<NotePanelSection, string> = { mine: '/', shared: '/shared', trash: '/trash' };

export function renderSidebar(ctx: AppContext, active: SidebarSection): SidebarChrome {
  const navButtons = new Map<SidebarSection, HTMLButtonElement>();

  const newBtn = h(
    'button',
    { type: 'button', class: 'primary icon-btn rail-new', 'aria-label': t('nav.newPage'), title: t('nav.newPage') },
    icon('plus')
  );
  newBtn.addEventListener('click', () => ctx.navigate('/note/new'));

  function railButton(section: SidebarSection, label: string, iconName: Parameters<typeof icon>[0], path: string): HTMLButtonElement {
    const btn = h(
      'button',
      {
        type: 'button',
        class: active === section ? 'rail-link active' : 'rail-link',
        'aria-label': label,
        title: label,
      },
      icon(iconName)
    ) as HTMLButtonElement;
    btn.addEventListener('click', () => ctx.navigate(path));
    navButtons.set(section, btn);
    return btn;
  }

  const nav = h(
    'nav',
    { class: 'rail-nav' },
    ...sections().map(s => railButton(s.key, s.label, s.iconName, SECTION_PATH[s.key]))
  );

  const settingsBtn = railButton('settings', t('nav.settings'), 'settings', '/settings');

  const status = createSyncStatus(ctx.store, ctx.refresh, 'rail');

  const footer = h('div', { class: 'rail-footer' }, settingsBtn);

  if (ctx.platform === 'native') {
    const lockBtn = h(
      'button',
      { type: 'button', class: 'rail-link rail-lock', 'aria-label': t('nav.lock'), title: t('nav.lock') },
      icon('lock')
    );
    lockBtn.addEventListener('click', () => lockSession(ctx));
    footer.append(lockBtn);
  }

  const aside = h(
    'aside',
    { class: 'sidebar rail' },
    h('div', { class: 'rail-brand' }, logoMark()),
    newBtn,
    nav,
    h('div', { class: 'rail-spacer' }),
    status.el,
    footer
  );

  function setActive(section: SidebarSection): void {
    for (const [key, btn] of navButtons) btn.classList.toggle('active', key === section);
  }

  return { el: aside, setActive };
}
