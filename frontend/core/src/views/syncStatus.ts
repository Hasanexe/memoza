import { h, icon, relativeTime } from './dom';
import { connectionStatus, onConnectionChange, type ConnectionStatus } from '../connection';
import { t } from '../i18n';
import type { Store } from '../store/types';

export type SyncStatusVariant = 'rail' | 'panel' | 'page';

const STATUS_LABEL: Record<ConnectionStatus, () => string> = {
  offline: () => t('syncStatus.offline'),
  syncing: () => t('syncStatus.syncing'),
  synced: () => t('syncStatus.online'),
};

function label(compact: boolean): string {
  const { status, pendingCount, lastSyncAt, saveState } = connectionStatus();

  if (saveState === 'saving') return t('syncStatus.saving');
  if (saveState === 'unsaved') return t(compact ? 'syncStatus.unsavedCompact' : 'syncStatus.unsaved');
  if (saveState === 'error') return t(compact ? 'syncStatus.notSavedCompact' : 'syncStatus.notSaved');

  if (status === 'offline') {
    if (pendingCount === 0) return STATUS_LABEL.offline();
    return t(compact ? 'syncStatus.pendingCompact' : 'syncStatus.offlinePending', { count: pendingCount });
  }
  if (status === 'syncing') return STATUS_LABEL.syncing();
  if (lastSyncAt === null) return STATUS_LABEL.synced();
  return relativeTime(lastSyncAt);
}

export function createSyncStatus(
  store: Store,
  refresh: () => void,
  variant: SyncStatusVariant
): { el: HTMLElement; destroy: () => void } {
  const compact = variant === 'rail';
  const el = h('button', { type: 'button', class: `sync-status sync-status--${variant}` }) as HTMLButtonElement;

  function render(): void {
    const { status, saveState } = connectionStatus();
    const busy = status === 'syncing' || saveState === 'saving';
    el.replaceChildren(label(compact), icon('refresh', compact ? 11 : 12));
    el.className = `sync-status sync-status--${variant} sync-status--${status}`;
    if (saveState === 'error') el.classList.add('sync-status--error');
    el.disabled = busy;
    el.setAttribute('aria-label', busy ? t('syncStatus.syncingAria') : t('syncStatus.syncNow'));
    el.setAttribute('title', busy ? t('syncStatus.syncing') : t('syncStatus.syncNow'));
  }

  el.addEventListener('click', () => {
    void store.sync(true).then(refresh);
  });

  render();
  const unsubscribe = onConnectionChange(render);
  const ticker = window.setInterval(render, 30_000);

  return {
    el,
    destroy(): void {
      unsubscribe();
      window.clearInterval(ticker);
    },
  };
}
