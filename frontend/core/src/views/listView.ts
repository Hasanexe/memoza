import { h, clear, errorBanner } from './dom';
import type { AppContext } from './app';
import type { DecryptedNoteSummary } from '../store/types';
import { logout as clearSession, requireSession } from '../crypto/session';
import * as authApi from '../api/auth';

type Tab = 'mine' | 'shared' | 'trash';

export async function renderList(ctx: AppContext): Promise<void> {
  const { root, store, navigate } = ctx;
  clear(root);
  root.append(h('p', {}, 'Syncing…'));

  try {
    await store.sync();
  } catch {
    clear(root);
    root.append(errorBanner('Sync failed. Showing the last known state.'));
  }

  await renderContent();

  async function renderContent(): Promise<void> {
    clear(root);
    const session = requireSession();

    let tab: Tab = 'mine';
    let tagFilter: string | null = null;
    let query = '';

    const searchInput = h('input', { type: 'search', placeholder: 'Search title & tags' }) as HTMLInputElement;
    searchInput.addEventListener('input', () => {
      query = searchInput.value;
      void renderNoteList();
    });

    const tabsHost = h('div', { class: 'tabs' });
    const tagsHost = h('div', { class: 'tag-chips' });
    const listHost = h('div', { class: 'note-list' });

    function makeTabButton(id: Tab, label: string): HTMLElement {
      const btn = h('button', { type: 'button', class: tab === id ? 'tab active' : 'tab' }, label);
      btn.addEventListener('click', () => {
        tab = id;
        tagFilter = null;
        void renderContent();
      });
      return btn;
    }

    tabsHost.append(
      makeTabButton('mine', 'My notes'),
      makeTabButton('shared', 'Shared with me'),
      makeTabButton('trash', 'Trash')
    );

    async function currentSet(): Promise<DecryptedNoteSummary[]> {
      const all = query ? await store.search(query) : await store.listNotes();
      return all.filter(n => {
        if (tab === 'trash') return n.deletedAt !== null && n.isOwner;
        if (n.deletedAt !== null) return false;
        return tab === 'mine' ? n.isOwner : !n.isOwner;
      });
    }

    function allTags(entries: DecryptedNoteSummary[]): string[] {
      const set = new Set<string>();
      for (const n of entries) for (const t of n.tags) set.add(t);
      return Array.from(set).sort();
    }

    async function renderNoteList(): Promise<void> {
      clear(listHost);
      clear(tagsHost);
      let entries = await currentSet();

      for (const tag of allTags(entries)) {
        const chip = h('button', { type: 'button', class: tagFilter === tag ? 'chip active' : 'chip' }, tag);
        chip.addEventListener('click', () => {
          tagFilter = tagFilter === tag ? null : tag;
          void renderNoteList();
        });
        tagsHost.append(chip);
      }

      if (tagFilter) {
        const activeTag = tagFilter;
        entries = entries.filter(n => n.tags.includes(activeTag));
      }

      entries = entries.slice().sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });

      if (entries.length === 0) {
        listHost.append(h('p', { class: 'empty' }, 'No notes here yet.'));
        return;
      }

      for (const note of entries) listHost.append(renderNoteRow(note));
    }

    function renderNoteRow(note: DecryptedNoteSummary): HTMLElement {
      const row = h(
        'div',
        { class: 'note-row' },
        h('span', { class: 'note-title' }, note.pinned ? '\u{1F4CC} ' : '', note.title || '(untitled)'),
        h('span', { class: 'note-tags' }, note.tags.join(', '))
      );
      row.addEventListener('click', () => navigate(`/note/${note.id}`));

      if (tab === 'trash') {
        const restoreBtn = h('button', { type: 'button' }, 'Restore');
        restoreBtn.addEventListener('click', async e => {
          e.stopPropagation();
          await store.restoreNote(note.id);
          await renderContent();
        });
        const purgeBtn = h('button', { type: 'button' }, 'Delete forever');
        purgeBtn.addEventListener('click', async e => {
          e.stopPropagation();
          if (confirm('Permanently delete this note? This cannot be undone.')) {
            await store.purgeNote(note.id);
            await renderContent();
          }
        });
        row.append(restoreBtn, purgeBtn);
      }

      return row;
    }

    const newBtn = h('button', { type: 'button' }, 'New note');
    newBtn.addEventListener('click', () => navigate('/note/new'));

    const settingsBtn = h('button', { type: 'button' }, 'Settings');
    settingsBtn.addEventListener('click', () => navigate('/settings'));

    const logoutBtn = h('button', { type: 'button' }, 'Log out');
    logoutBtn.addEventListener('click', async () => {
      try {
        await authApi.logout();
      } catch {}
      await ctx.onLogout?.();
      clearSession();
      navigate('/login');
    });

    root.append(
      h(
        'div',
        { class: 'list-view' },
        h('header', {}, h('h1', {}, 'Memoza'), h('span', {}, session.email), newBtn, settingsBtn, logoutBtn),
        searchInput,
        tabsHost,
        tagsHost,
        listHost
      )
    );

    await renderNoteList();
  }
}
