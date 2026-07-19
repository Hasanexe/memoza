import { h, clear, errorBanner, brand, icon } from './dom';
import type { AppContext } from './app';
import { requireSession } from '../crypto/session';
import type { DecryptedNoteSummary } from '../store/types';
import { PIN_TAG } from './tagsEditor';
import { contentTags, getColor, CONTROL_KEYS } from './controlTags';
import { confirmRestorePublished } from './shareView';

export type SidebarSection = 'mine' | 'shared' | 'trash' | 'settings';

const COLOR_VARS: Record<string, string> = {
  red: 'var(--danger)',
  orange: 'var(--clay)',
  yellow: 'var(--gold-strong)',
  green: 'var(--success)',
  blue: '#3F72AF',
  purple: 'var(--shared)',
};

function colorTag(name: string): string {
  return `color:${name}`;
}

export function renderSidebar(ctx: AppContext, active: SidebarSection, openNoteId: string | null = null): HTMLElement {
  const session = requireSession();

  function navItem(section: SidebarSection, label: string, iconName: Parameters<typeof icon>[0], path: string): HTMLElement {
    const btn = h(
      'button',
      { type: 'button', class: active === section ? 'sidebar-link active' : 'sidebar-link' },
      icon(iconName),
      h('span', {}, label)
    );
    btn.addEventListener('click', () => ctx.navigate(path));
    return btn;
  }

  const newBtn = h('button', {
    type: 'button',
    class: 'primary icon-btn sidebar-new',
    'aria-label': 'New page',
    title: 'New page',
  }, icon('plus'));
  newBtn.addEventListener('click', () => ctx.navigate('/note/new'));

  const body = h('div', { class: 'sidebar-body' });

  const aside = h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'sidebar-brand' }, brand()),
    newBtn,
    h(
      'nav',
      { class: 'sidebar-nav' },
      navItem('mine', 'My notes', 'notebook', '/'),
      navItem('shared', 'Shared with me', 'users', '/shared'),
      navItem('trash', 'Trash', 'trash', '/trash')
    ),
    active === 'settings' ? null : body,
    h('div', { class: 'sidebar-spacer' }),
    navItem('settings', 'Settings', 'settings', '/settings'),
    h('div', { class: 'sidebar-email' }, session.email)
  );

  if (active !== 'settings') void renderSectionBody(ctx, active, body, openNoteId);

  return aside;
}

async function renderSectionBody(
  ctx: AppContext,
  tab: Exclude<SidebarSection, 'settings'>,
  body: HTMLElement,
  openNoteId: string | null
): Promise<void> {
  const { store, navigate } = ctx;
  clear(body);
  body.append(h('p', { class: 'sidebar-status' }, 'Syncing…'));

  try {
    await store.sync();
  } catch {
    clear(body);
    body.append(errorBanner('Sync failed. Showing the last known state.'));
  }

  let tagFilters = new Set<string>();
  let query = '';
  let chipEls: { key: string; el: HTMLElement }[] = [];

  const searchInput = h('input', { type: 'search', placeholder: 'Search title' }) as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    void renderNoteList();
  });

  const tagSearchInput = h('input', { type: 'text', class: 'tag-search-input', placeholder: 'Filter tags…' }) as HTMLInputElement;
  const tagsHost = h('div', { class: 'tag-chips' }, tagSearchInput);
  const tagsExpandBtn = h('button', { type: 'button', class: 'tag-chips-expand hidden' }, 'Show more');
  const tagsWrap = h('div', { class: 'tag-chips-wrap' }, tagsHost, tagsExpandBtn);
  const listHost = h('div', { class: 'note-list' });

  function rebuildChips(chips: HTMLElement[]): void {
    while (tagsHost.lastChild && tagsHost.lastChild !== tagSearchInput) tagsHost.removeChild(tagsHost.lastChild);
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
      tagsExpandBtn.textContent = 'Show more';
    } else {
      tagsExpandBtn.classList.remove('hidden');
      tagsExpandBtn.textContent = 'Show less';
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
    if (tagFilters.has(match.key)) tagFilters.delete(match.key);
    else tagFilters.add(match.key);
    tagSearchInput.value = '';
    void renderNoteList();
  });

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
        { type: 'button', class: tagFilters.has(key) ? 'chip chip--pin active' : 'chip chip--pin', 'aria-label': 'Pin', title: 'Pin' },
        icon('pin', 14)
      );
      el.addEventListener('click', () => {
        if (tagFilters.has(key)) tagFilters.delete(key);
        else tagFilters.add(key);
        void renderNoteList();
      });
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
      el.addEventListener('click', () => {
        if (tagFilters.has(key)) tagFilters.delete(key);
        else tagFilters.add(key);
        void renderNoteList();
      });
      chips.push({ key, el });
    }

    for (const tag of Array.from(contentSet).sort()) {
      const el = h('button', { type: 'button', class: tagFilters.has(tag) ? 'chip active' : 'chip' }, tag);
      el.addEventListener('click', () => {
        if (tagFilters.has(tag)) tagFilters.delete(tag);
        else tagFilters.add(tag);
        void renderNoteList();
      });
      chips.push({ key: tag, el });
    }

    return chips;
  }

  async function renderNoteList(): Promise<void> {
    clear(listHost);
    let entries = await currentSet();

    chipEls = buildChips(entries);
    rebuildChips(chipEls.map(c => c.el));
    applyTagSearchFilter();

    if (tagFilters.size > 0) {
      entries = entries.filter(n => Array.from(tagFilters).every(key => n.tags.includes(key)));
    }

    entries = entries.slice().sort((a, b) => b.updatedAt - a.updatedAt);

    if (entries.length === 0) {
      listHost.append(h('p', { class: 'empty' }, 'No notes here yet.'));
      return;
    }

    for (const note of entries) listHost.append(renderNoteRow(note));
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
      h('span', { class: 'note-title' }, note.title || 'Untitled page'),
      h('span', { class: 'note-time' }, formatWhen(note.updatedAt)),
      renderTagsLine(note.tags)
    );
    if (colorVar) row.style.setProperty('--tag-color', colorVar);
    row.addEventListener('click', () => navigate(`/note/${note.id}`));

    if (tab === 'trash') {
      const restoreBtn = h('button', { type: 'button', class: 'ghost' }, 'Restore');
      restoreBtn.addEventListener('click', e => {
        e.stopPropagation();
        const doRestore = (): void => {
          void store.restoreNote(note.id).then(() => renderNoteList());
        };
        if (note.isPublic) confirmRestorePublished(doRestore);
        else doRestore();
      });
      const purgeBtn = h('button', { type: 'button', class: 'danger' }, 'Delete forever');
      purgeBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (confirm('Permanently delete this note? This cannot be undone.')) {
          await store.purgeNote(note.id);
          await renderNoteList();
        }
      });
      row.append(restoreBtn, purgeBtn);
    }

    return row;
  }

  clear(body);
  body.append(searchInput, tagsWrap, listHost);
  await renderNoteList();
}
