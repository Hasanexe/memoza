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
import { clear } from './dom';
import { EMAIL_STORAGE_KEY } from '../config';

const PAGE_ROUTE_RE = /^[1-9][0-9]*$/;

export interface UnlockProvider {
  isAvailable(): Promise<boolean>;
  unlock(): Promise<void>;
}

export interface AppContext {
  root: HTMLElement;
  store: Store;
  navigate: (path: string) => void;
  unlockProvider?: UnlockProvider;
  onUnlock?: (session: {
    userId: string;
    email: string;
    username: string;
    wrappedDek: string;
    wrappedPrivateKey: string;
  }) => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
  biometricControl?: {
    isEnabled(): Promise<boolean>;
    enable(password: string): Promise<void>;
    disable(): Promise<void>;
  };
  /** Persist the last-used email so returning users see a quick unlock screen. Defaults to true (desktop's biometric unlock relies on this). Web opts out. */
  rememberEmail?: boolean;
  createShortcut?: (pageNo: number, title: string) => Promise<void>;
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
}

export function mountApp(root: HTMLElement, store: Store, options: MountOptions = {}): { refresh: () => void } {
  const navigate = (path: string): void => {
    const hash = `#${path}`;
    if (location.hash === hash) render();
    else location.hash = hash;
  };

  const ctx: AppContext = { root, store, navigate, ...options };

  function render(): void {
    clear(root);
    const { segments, params } = currentRoute();

    if (segments.length === 2 && PAGE_ROUTE_RE.test(segments[1])) {
      void renderPublicReader(root, segments[0], Number(segments[1]));
      return;
    }

    if (!isUnlocked()) {
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

  return { refresh: render };
}
