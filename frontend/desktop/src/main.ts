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
} from './unlock';
import { wipeLocalStore } from './store/db';

const THEME_KEY = 'theme';
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const store = createSqliteStore();
const app = mountApp(root, store, {
  unlockProvider: biometricUnlockProvider,
  onUnlock: async session => {
    await saveLocalAccount(session.userId, session.email, session.wrappedDek, session.wrappedPrivateKey);
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
});

async function syncAndRefresh(): Promise<void> {
  if (!isUnlocked()) return;
  await drainQueue();
  await store.sync();
  app.refresh();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncAndRefresh();
});
window.addEventListener('online', () => void syncAndRefresh());

void onOpenUrl(urls => {
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      const target = parsed.hash && parsed.hash.length > 1 ? parsed.hash : `#/reset${parsed.search}`;
      location.hash = target;
    } catch {
      continue;
    }
  }
});
