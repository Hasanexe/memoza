import { getAccessToken } from './crypto/session';

export type ConnectionStatus = 'offline' | 'syncing' | 'synced';

interface State {
  lastSyncAt: number | null;
  pendingCount: number;
  syncing: boolean;
}

let state: State = { lastSyncAt: null, pendingCount: 0, syncing: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function onConnectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function markSyncing(active: boolean): void {
  state = active ? { ...state, syncing: true } : { ...state, syncing: false, lastSyncAt: Date.now() };
  emit();
}

export function setPendingCount(count: number): void {
  state = { ...state, pendingCount: count };
  emit();
}

export function connectionStatus(): { status: ConnectionStatus; pendingCount: number; lastSyncAt: number | null } {
  const online = navigator.onLine && getAccessToken() !== null;
  const status: ConnectionStatus = !online ? 'offline' : state.syncing ? 'syncing' : 'synced';
  return { status, pendingCount: state.pendingCount, lastSyncAt: state.lastSyncAt };
}

window.addEventListener('online', emit);
window.addEventListener('offline', emit);
