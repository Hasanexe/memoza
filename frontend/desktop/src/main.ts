import '@memoza/core/views/styles.css';
import { mountApp } from '@memoza/core/views/app';
import { isUnlocked, requireSession } from '@memoza/core/crypto/session';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { createSqliteStore } from './store/sqliteStore';
import { drainQueue } from './store/queue';
import {
  biometricUnlockProvider,
  saveLocalAccount,
  clearLocalAccount,
  enableBiometricUnlock,
  disableBiometricUnlock,
  isBiometricEnabled,
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

const store = createSqliteStore();
const app = mountApp(root, store, {
  unlockProvider: biometricUnlockProvider,
  onUnlock: async session => {
    await saveLocalAccount(session.userId, session.email, session.username, session.wrappedDek, session.wrappedPrivateKey);
  },
  onLogout: async () => {
    await clearLocalAccount();
    await wipeLocalStore();
  },
  biometricControl: {
    isEnabled: () => isBiometricEnabled(),
    enable: password => enableBiometricUnlock(password, requireSession().email),
    disable: () => disableBiometricUnlock(),
  },
  createShortcut: (pageNo, title) => createPageShortcut(pageNo, title),
  localAccount: getLocalAccountFor,
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !isUnlocked()) return;
  void drainQueue();
  app.refresh();
});
window.addEventListener('online', () => {
  if (!isUnlocked()) return;
  void drainQueue()
    .then(() => store.sync(true))
    .then(() => app.refresh());
});

void onOpenUrl(urls => {
  for (const url of urls) {
    void resolveDeepLink(store, url).then(target => {
      location.hash = target;
    });
  }
});

void takePendingMmpUrl().then(url => {
  if (!url) return;
  void resolveDeepLink(store, url).then(target => {
    location.hash = target;
  });
});
