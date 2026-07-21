import { h, clear, errorBanner, icon, showToast } from './dom';
import type { AppContext } from './app';
import type { DecryptedNoteSummary } from '../store/types';
import { PIN_TAG } from './tagsEditor';
import { contentTags, getColor, CONTROL_KEYS, COLOR_VARS } from './controlTags';
import { confirmRestorePublished, confirmDialog } from './shareView';
import { t } from '../i18n';

export type NotePanelSection = 'mine' | 'shared' | 'trash';

export interface NotePanel {
  root: HTMLElement;
  search: HTMLInputElement;
  mount(host: HTMLElement): void;
  setSection(section: NotePanelSection): void;
  setOpenNote(id: string | null): void;
  refresh(): void;
}

function colorTag(name: string): string {
  return `color:${name}`;
}

export function createNotePanel(ctx: AppContext): NotePanel {
  const { store, navigate } = ctx;

  let tab: NotePanelSection = 'mine';
  let openNoteId: string | null = null;
  let query = '';
  let tagFilters = new Set<string>();
  let chipEls: { key: string; el: HTMLElement }[] = [];
  let cachedEntries: DecryptedNoteSummary[] = [];
  const rowEls = new Map<string, HTMLElement>();

  const statusHost = h('p', { class: 'sidebar-status hidden' }, '');

  const searchInput = h('input', { type: 'search', placeholder: t('notePanel.searchPlaceholder') }) as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    void reload();
  });

  const tagSearchInput = h('input', { type: 'text', class: 'tag-search-input', placeholder: t('notePanel.filterTagsPlaceholder') }) as HTMLInputElement;
  const clearFiltersBtn = h(
    'button',
    { type: 'button', class: 'tag-clear', 'aria-label': t('common.close'), title: t('common.close') },
    icon('x', 14)
  ) as HTMLButtonElement;
  clearFiltersBtn.addEventListener('click', () => {
    if (tagFilters.size === 0) return;
    tagFilters.clear();
    tagSearchInput.value = '';
    applyTagSearchFilter();
    updateChipActive();
    renderRows();
  });
  const tagsHost = h('div', { class: 'tag-chips' }, tagSearchInput, clearFiltersBtn);
  const tagsExpandBtn = h('button', { type: 'button', class: 'tag-chips-expand hidden' }, t('notePanel.showMore'));
  const tagsWrap = h('div', { class: 'tag-chips-wrap' }, tagsHost, tagsExpandBtn);
  const listHost = h('div', { class: 'note-list' });

  const root = h('div', { class: 'sidebar-body' }, statusHost, searchInput, tagsWrap, listHost);

  function rebuildChips(chips: HTMLElement[]): void {
    while (tagsHost.lastChild && tagsHost.lastChild !== clearFiltersBtn) tagsHost.removeChild(tagsHost.lastChild);
    for (const c of chips) tagsHost.append(c);
    tagsHost.scrollTop = 0;
  }

  function updateFade(): void {
    if (tagsHost.classList.contains('expanded')) {
      tagsHost.classList.remove('fade');
      return;
    }
    const overflowing = tagsHost.scrollHeight > tagsHost.clientHeight + 1;
    const atBottom = tagsHost.scrollTop + tagsHost.clientHeight >= tagsHost.scrollHeight - 1;
    tagsHost.classList.toggle('fade', overflowing && !atBottom);
  }

  function updateOverflow(): void {
    const expanded = tagsHost.classList.contains('expanded');
    if (!expanded) {
      const overflowing = tagsHost.scrollHeight > tagsHost.clientHeight + 1;
      tagsExpandBtn.classList.toggle('hidden', !overflowing);
      tagsExpandBtn.textContent = t('notePanel.showMore');
    } else {
      tagsExpandBtn.classList.remove('hidden');
      tagsExpandBtn.textContent = t('notePanel.showLess');
    }
    updateFade();
  }

  tagsHost.addEventListener('scroll', updateFade);
  tagsExpandBtn.addEventListener('click', () => {
    tagsHost.classList.toggle('expanded');
    updateOverflow();
  });

  function applyTagSearchFilter(): void {
    const q = tagSearchInput.value.trim().toLowerCase();
    for (const { key, el } of chipEls) el.classList.toggle('hidden', q !== '' && !key.toLowerCase().includes(q));
    updateOverflow();
  }

  tagSearchInput.addEventListener('input', applyTagSearchFilter);
  tagSearchInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const match = chipEls.find(c => !c.el.classList.contains('hidden'));
    if (!match) return;
    toggleFilter(match.key);
    tagSearchInput.value = '';
    applyTagSearchFilter();
  });

  function toggleFilter(key: string): void {
    if (tagFilters.has(key)) tagFilters.delete(key);
    else tagFilters.add(key);
    updateChipActive();
    renderRows();
  }

  function updateChipActive(): void {
    for (const { key, el } of chipEls) el.classList.toggle('active', tagFilters.has(key));
    clearFiltersBtn.disabled = tagFilters.size === 0;
  }

  async function currentSet(): Promise<DecryptedNoteSummary[]> {
    const all = query ? await store.search(query) : await store.listNotes();
    return all.filter(n => {
      if (tab === 'trash') return n.deletedAt !== null && n.isOwner;
      if (n.deletedAt !== null) return false;
      return tab === 'mine' ? n.isOwner : !n.isOwner;
    });
  }

  function buildChips(entries: DecryptedNoteSummary[]): { key: string; el: HTMLElement }[] {
    const contentSet = new Set<string>();
    const colorSet = new Set<string>();
    let hasPin = false;
    for (const n of entries) {
      for (const t of contentTags(n.tags)) contentSet.add(t);
      const c = getColor(n.tags);
      if (c && CONTROL_KEYS.color.values.includes(c)) colorSet.add(c);
      if (n.tags.includes(PIN_TAG)) hasPin = true;
    }

    const chips: { key: string; el: HTMLElement }[] = [];

    if (hasPin) {
      const key = PIN_TAG;
      const el = h(
        'button',
        { type: 'button', class: tagFilters.has(key) ? 'chip chip--pin active' : 'chip chip--pin', 'aria-label': t('common.pin'), title: t('common.pin') },
        icon('pin', 14)
      );
      el.addEventListener('click', () => toggleFilter(key));
      chips.push({ key, el });
    }

    for (const name of Array.from(colorSet).sort()) {
      const key = colorTag(name);
      const el = h('button', {
        type: 'button',
        class: tagFilters.has(key) ? 'chip chip--color active' : 'chip chip--color',
        'aria-label': name,
        title: name,
      }) as HTMLButtonElement;
      el.style.setProperty('--tag-color', COLOR_VARS[name] ?? 'var(--clay)');
      el.addEventListener('click', () => toggleFilter(key));
      chips.push({ key, el });
    }

    for (const tag of Array.from(contentSet).sort()) {
      const el = h('button', { type: 'button', class: tagFilters.has(tag) ? 'chip active' : 'chip' }, tag);
      el.addEventListener('click', () => toggleFilter(tag));
      chips.push({ key: tag, el });
    }

    return chips;
  }

  function formatWhen(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderTagsLine(tags: string[]): HTMLElement | null {
    const rest = contentTags(tags).slice(0, 3);
    if (rest.length === 0 && !tags.includes(PIN_TAG)) return null;
    const children: (Node | string)[] = [];
    if (tags.includes(PIN_TAG)) children.push(icon('pin', 13));
    if (rest.length) children.push(rest.map(t => `#${t}`).join('  '));
    return h('span', { class: 'note-tags' }, ...children);
  }

  function renderNoteRow(note: DecryptedNoteSummary): HTMLElement {
    const colorName = getColor(note.tags);
    const colorVar = colorName ? (COLOR_VARS[colorName] ?? null) : null;
    const classes = ['note-row'];
    if (colorVar) classes.push('note-row--color');
    if (note.hasUnreadComment) classes.push('note-row--unread');
    if (note.id === openNoteId) classes.push('note-row--open');

    const row = h(
      'div',
      { class: classes.join(' ') },
      h('span', { class: 'note-title' }, note.title || t('editor.untitledPage')),
      h('span', { class: 'note-time' }, formatWhen(note.updatedAt)),
      renderTagsLine(note.tags)
    );
    if (colorVar) row.style.setProperty('--tag-color', colorVar);
    row.addEventListener('click', () => navigate(`/note/${note.id}`));

    if (tab === 'trash') {
      const restoreBtn = h('button', { type: 'button', class: 'ghost' }, t('common.restore'));
      restoreBtn.addEventListener('click', e => {
        e.stopPropagation();
        const doRestore = (): void => {
          void store.restoreNote(note.id).then(() => {
            showToast(t('notePanel.pageRestored'));
            return reload();
          });
        };
        if (note.isPublic) confirmRestorePublished(doRestore);
        else doRestore();
      });
      const purgeBtn = h('button', { type: 'button', class: 'danger' }, t('notePanel.deleteForever'));
      purgeBtn.addEventListener('click', e => {
        e.stopPropagation();
        confirmDialog(t('notePanel.deleteForever'), t('notePanel.deleteForeverConfirmBody'), t('notePanel.deleteForever'), () => {
          void store.purgeNote(note.id).then(() => {
            showToast(t('notePanel.pagePermanentlyDeleted'));
            return reload();
          });
        });
      });
      row.append(restoreBtn, purgeBtn);
    }

    return row;
  }

  async function reload(): Promise<void> {
    cachedEntries = await currentSet();
    chipEls = buildChips(cachedEntries);
    rebuildChips(chipEls.map(c => c.el));
    applyTagSearchFilter();
    updateChipActive();
    renderRows();
  }

  function renderRows(): void {
    clear(listHost);
    rowEls.clear();

    let entries = cachedEntries;
    if (tagFilters.size > 0) {
      entries = entries.filter(n => Array.from(tagFilters).every(key => n.tags.includes(key)));
    }
    entries = entries.slice().sort((a, b) => b.updatedAt - a.updatedAt);

    if (entries.length === 0) {
      listHost.append(h('p', { class: 'empty' }, t('notePanel.noNotesYet')));
      return;
    }

    for (const note of entries) {
      const row = renderNoteRow(note);
      rowEls.set(note.id, row);
      listHost.append(row);
    }
  }

  async function loadAndSync(): Promise<void> {
    const hasCached = (await store.listNotes()).length > 0;
    if (hasCached) {
      await reload();
    } else {
      statusHost.textContent = t('syncStatus.syncing');
      statusHost.classList.remove('hidden');
    }
    try {
      await store.sync();
    } catch {
      statusHost.classList.add('hidden');
      if (!hasCached) listHost.append(errorBanner(t('notePanel.syncFailed')));
      return;
    }
    statusHost.classList.add('hidden');
    await reload();
  }

  function mount(host: HTMLElement): void {
    host.append(root);
  }

  function setSection(section: NotePanelSection): void {
    tab = section;
    void reload();
  }

  function setOpenNote(id: string | null): void {
    openNoteId = id;
    for (const [noteId, row] of rowEls) row.classList.toggle('note-row--open', noteId === id);
  }

  function refresh(): void {
    void loadAndSync();
  }

  void loadAndSync();

  return { root, search: searchInput, mount, setSection, setOpenNote, refresh };
}
