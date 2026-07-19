import { isUnlocked } from '../crypto/session';
import type { Store } from '../store/types';
import {
  renderRegister,
  renderLogin,
  renderLock,
  renderResetRequest,
  renderResetConfirm,
  renderActivate,
} from './authViews';
import { renderList } from './listView';
import { renderEditor } from './editorView';
import { renderSettings } from './settingsView';
import { renderPublicReader } from './publicReaderView';
import { clear, h } from './dom';
import { renderSidebar, type SidebarSection, type SidebarChrome } from './sidebar';
import { createNotePanel, type NotePanel, type NotePanelSection } from './notePanel';
import { EMAIL_STORAGE_KEY } from '../config';

const PAGE_ROUTE_RE = /^[1-9][0-9]*$/;

export interface UnlockProvider {
  isAvailable(): Promise<boolean>;
  unlock(): Promise<void>;
}

export interface ShellHandle {
  main: HTMLElement;
  panelInMain: boolean;
  setSection(section: SidebarSection): void;
  setOpenNote(id: string | null): void;
}

export interface LocalAccountSnapshot {
  userId: string;
  email: string;
  username: string;
  wrappedDek: string;
  wrappedPrivateKey: string;
}

export interface AppContext {
  root: HTMLElement;
  store: Store;
  navigate: (path: string) => void;
  ensureShell: (section: SidebarSection, openNoteId: string | null, showListInMain?: boolean) => ShellHandle;
  unlockProvider?: UnlockProvider;
  onUnlock?: (session: LocalAccountSnapshot) => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
  biometricControl?: {
    isEnabled(): Promise<boolean>;
    enable(password: string): Promise<void>;
    disable(): Promise<void>;
  };
  /** Persist the last-used email so returning users see a quick unlock screen. Defaults to true (desktop's biometric unlock relies on this). Web opts out. */
  rememberEmail?: boolean;
  createShortcut?: (pageNo: number, title: string) => Promise<void>;
  localAccount?: (email: string) => Promise<LocalAccountSnapshot | null>;
}

function currentRoute(): { segments: string[]; params: URLSearchParams } {
  const raw = location.hash.slice(1) || '/';
  const [path, query] = raw.split('?');
  return { segments: path.split('/').filter(Boolean), params: new URLSearchParams(query ?? '') };
}

export interface MountOptions {
  unlockProvider?: UnlockProvider;
  onUnlock?: AppContext['onUnlock'];
  onLogout?: AppContext['onLogout'];
  biometricControl?: AppContext['biometricControl'];
  rememberEmail?: AppContext['rememberEmail'];
  createShortcut?: AppContext['createShortcut'];
  localAccount?: AppContext['localAccount'];
}

interface Shell {
  el: HTMLElement;
  main: HTMLElement;
  sidebar: SidebarChrome;
  panel: NotePanel;
  activeNav: SidebarSection;
  showListInMain: boolean;
  mobileQuery: MediaQueryList;
}

export function mountApp(root: HTMLElement, store: Store, options: MountOptions = {}): { refresh: () => void } {
  const navigate = (path: string): void => {
    const hash = `#${path}`;
    if (location.hash === hash) render();
    else location.hash = hash;
  };

  let shell: Shell | null = null;

  function teardownShell(): void {
    shell = null;
  }

  function layoutPanel(): void {
    if (!shell) return;
    if (shell.mobileQuery.matches && shell.showListInMain) shell.panel.mount(shell.main);
    else shell.sidebar.restorePanel(shell.panel.root);
  }

  function ensureShell(section: SidebarSection, openNoteId: string | null, showListInMain = false): ShellHandle {
    if (!shell) {
      const panel = createNotePanel(ctx);
      const sidebar = renderSidebar(ctx, section, panel.root);
      const main = h('div', { class: 'main' });
      const el = h('div', { class: 'app-shell' }, sidebar.el, main);
      clear(root);
      root.append(el);
      const mobileQuery = window.matchMedia('(max-width:760px)');
      shell = { el, main, sidebar, panel, activeNav: section, showListInMain, mobileQuery };
      mobileQuery.addEventListener('change', layoutPanel);
    } else {
      if (shell.activeNav !== section) {
        shell.sidebar.setActive(section);
        shell.activeNav = section;
      }
      shell.showListInMain = showListInMain;
    }
    if (section !== 'settings') shell.panel.setSection(section as NotePanelSection);
    shell.panel.setOpenNote(openNoteId);
    layoutPanel();

    return {
      main: shell.main,
      panelInMain: shell.mobileQuery.matches && showListInMain,
      setSection(s: SidebarSection): void {
        if (!shell) return;
        if (shell.activeNav !== s) {
          shell.sidebar.setActive(s);
          shell.activeNav = s;
        }
        if (s !== 'settings') shell.panel.setSection(s as NotePanelSection);
      },
      setOpenNote(id: string | null): void {
        shell?.panel.setOpenNote(id);
      },
    };
  }

  const ctx: AppContext = { root, store, navigate, ensureShell, ...options };

  function render(): void {
    const { segments, params } = currentRoute();

    if (segments.length === 2 && PAGE_ROUTE_RE.test(segments[1])) {
      teardownShell();
      clear(root);
      void renderPublicReader(root, segments[0], Number(segments[1]));
      return;
    }

    if (!isUnlocked()) {
      teardownShell();
      clear(root);
      if (segments[0] === 'reset' && params.get('token')) {
        void renderResetConfirm(ctx, params);
        return;
      }
      if (segments[0] === 'reset') {
        renderResetRequest(ctx);
        return;
      }
      if (segments[0] === 'register') {
        renderRegister(ctx);
        return;
      }
      if (segments[0] === 'activate') {
        void renderActivate(ctx, params);
        return;
      }
      const email = ctx.rememberEmail !== false ? localStorage.getItem(EMAIL_STORAGE_KEY) : null;
      if (email) {
        void renderLock(ctx, email);
      } else {
        renderLogin(ctx);
      }
      return;
    }

    if (segments[0] === 'settings') {
      renderSettings(ctx);
      return;
    }
    if (segments[0] === 'note') {
      void renderEditor(ctx, segments[1] ?? null);
      return;
    }
    if (segments[0] === 'shared') {
      renderList(ctx, 'shared');
      return;
    }
    if (segments[0] === 'trash') {
      renderList(ctx, 'trash');
      return;
    }
    renderList(ctx, 'mine');
  }

  window.addEventListener('hashchange', render);
  render();

  function refresh(): void {
    if (shell) shell.panel.refresh();
    else render();
  }

  return { refresh };
}
