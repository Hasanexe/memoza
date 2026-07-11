import '@memoza/core/views/styles.css';
import { mountApp } from '@memoza/core/views/app';
import { isUnlocked } from '@memoza/core/crypto/session';
import { createMemoryStore } from './store/memoryStore';

const THEME_KEY = 'theme';
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const store = createMemoryStore();
const app = mountApp(root, store);

async function syncAndRefresh(): Promise<void> {
  if (!isUnlocked()) return;
  await store.sync();
  app.refresh();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncAndRefresh();
});
window.addEventListener('online', () => void syncAndRefresh());
