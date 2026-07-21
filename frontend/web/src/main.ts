import '@memoza/core/views/styles.css';
import { mountApp } from '@memoza/core/views/app';
import { isUnlocked } from '@memoza/core/crypto/session';
import { initLanguage } from '@memoza/core/i18n/index';
import { createMemoryStore } from './store/memoryStore';

const THEME_KEY = 'theme';
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

if (!location.hash) {
  const publicPage = /^\/([^/]+)\/([0-9]+)\/?$/.exec(location.pathname);
  if (publicPage) history.replaceState(null, '', `/#/${publicPage[1]}/${publicPage[2]}`);
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

await initLanguage();

const store = createMemoryStore();
const app = mountApp(root, store, { platform: 'web', rememberEmail: false });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isUnlocked()) app.refresh();
});
window.addEventListener('online', () => {
  if (!isUnlocked()) return;
  void store.sync(true).then(() => app.refresh());
});
