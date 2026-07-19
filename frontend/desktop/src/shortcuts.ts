import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

export async function createPageShortcut(pageNo: number, title: string): Promise<void> {
  const displayName = title.trim() || `Page ${pageNo}`;
  const path = await save({
    title: 'Create shortcut',
    defaultPath: `${displayName}.mmp`,
    filters: [{ name: 'Memoza Page', extensions: ['mmp'] }],
  });
  if (!path) return;
  await invoke('create_shortcut', { path, url: `memoza://page/${pageNo}`, name: displayName });
}

export async function takePendingMmpUrl(): Promise<string | null> {
  return invoke<string | null>('take_pending_mmp_url');
}
