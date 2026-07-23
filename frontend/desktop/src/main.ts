import '@memoza/core/views/styles.css';
import { mountApp } from '@memoza/core/views/app';
import { configureSandboxRunner } from '@memoza/core/views/sandboxFrame';
import { isUnlocked, requireSession } from '@memoza/core/crypto/session';
import { initLanguage } from '@memoza/core/i18n/index';
import { convertFileSrc } from '@tauri-apps/api/core';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { createSqliteStore } from './store/sqliteStore';
import { drainQueue } from './store/queue';
import {
  biometricUnlockProvider,
  saveLocalAccount,
  clearLocalAccount,
  sealDeviceUnlock,
  lockDevice,
  ensureOnline,
  getLocalAccountFor,
} from './unlock';
import { wipeLocalStore } from './store/db';
import { resolveDeepLink } from './deepLink';
import { createPageShortcut, takePendingMmpUrl } from './shortcuts';

const THEME_KEY = 'theme';
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

configureSandboxRunner(convertFileSrc('_runner', 'sandbox'));

await initLanguage();

const store = createSqliteStore();

let pendingDeepLink: string | null = null;

function openDeepLink(url: string): void {
  if (isUnlocked()) {
    void resolveDeepLink(store, url).then(target => {
      location.hash = target;
    });
  } else {
    pendingDeepLink = url;
  }
}

const app = mountApp(root, store, {
  platform: 'native',
  unlockProvider: biometricUnlockProvider,
  takePendingRoute: async () => {
    if (!pendingDeepLink) return null;
    const url = pendingDeepLink;
    pendingDeepLink = null;
    return resolveDeepLink(store, url);
  },
  onUnlock: async session => {
    await saveLocalAccount(session.userId, session.email, session.username, session.wrappedDek, session.wrappedPrivateKey);
  },
  onLogout: async () => {
    await clearLocalAccount();
    await wipeLocalStore();
  },
  sealDeviceUnlock: password => sealDeviceUnlock(password, requireSession().email),
  onLock: () => lockDevice(),
  createShortcut: (pageNo, title) => createPageShortcut(pageNo, title),
  localAccount: getLocalAccountFor,
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !isUnlocked()) return;
  void ensureOnline()
    .then(() => drainQueue())
    .then(() => app.refresh());
});
window.addEventListener('online', () => {
  if (!isUnlocked()) return;
  void ensureOnline()
    .then(() => drainQueue())
    .then(() => store.sync(true))
    .then(() => app.refresh());
});

void onOpenUrl(urls => {
  for (const url of urls) openDeepLink(url);
});

void takePendingMmpUrl().then(url => {
  if (url) openDeepLink(url);
});
