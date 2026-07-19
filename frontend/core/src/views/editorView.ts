import { h, clear, errorBanner, showToast, icon, type IconName } from './dom';
import type { AppContext } from './app';
import type { DecryptedNote, DecryptedComment, DecryptedNoteSummary } from '../store/types';
import { renderContent } from './markdown';
import { renderShareDialog, confirmRestorePublished, publicPageUrl } from './shareView';
import { requireSession } from '../crypto/session';
import { renderTagsEditor } from './tagsEditor';
import type { SidebarSection } from './sidebar';
import { getFormat } from './controlTags';
import { connectionStatus, onConnectionChange } from '../connection';

const AUTOSAVE_DEBOUNCE_MS = 4000;

function fireInput(el: HTMLTextAreaElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

function wrapSelection(el: HTMLTextAreaElement, before: string, after: string, placeholder: string): void {
  const { selectionStart, selectionEnd, value } = el;
  const selected = value.slice(selectionStart, selectionEnd) || placeholder;
  el.value = value.slice(0, selectionStart) + before + selected + after + value.slice(selectionEnd);
  const start = selectionStart + before.length;
  el.setSelectionRange(start, start + selected.length);
  fireInput(el);
}

function prefixLines(el: HTMLTextAreaElement, prefix: string): void {
  const { selectionStart, selectionEnd, value } = el;
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const lineEndSearch = value.indexOf('\n', selectionEnd);
  const lineEnd = lineEndSearch === -1 ? value.length : lineEndSearch;
  const block = value.slice(lineStart, lineEnd);
  const newBlock = block
    .split('\n')
    .map(line => (line.startsWith(prefix) ? line : prefix + line))
    .join('\n');
  el.value = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
  el.setSelectionRange(lineStart, lineStart + newBlock.length);
  fireInput(el);
}

function insertLink(el: HTMLTextAreaElement): void {
  const { selectionStart, selectionEnd, value } = el;
  const text = value.slice(selectionStart, selectionEnd) || 'link text';
  const insert = `[${text}](url)`;
  el.value = value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
  const urlStart = selectionStart + text.length + 3;
  el.setSelectionRange(urlStart, urlStart + 3);
  fireInput(el);
}

const MARKDOWN_ACTIONS: { icon: IconName; label: string; run: (el: HTMLTextAreaElement) => void }[] = [
  { icon: 'bold', label: 'Bold', run: el => wrapSelection(el, '**', '**', 'bold text') },
  { icon: 'italic', label: 'Italic', run: el => wrapSelection(el, '*', '*', 'italic text') },
  { icon: 'heading', label: 'Heading', run: el => prefixLines(el, '## ') },
  { icon: 'list', label: 'List', run: el => prefixLines(el, '- ') },
  { icon: 'checkbox', label: 'Checklist', run: el => prefixLines(el, '- [ ] ') },
  { icon: 'link', label: 'Link', run: el => insertLink(el) },
  { icon: 'code', label: 'Code', run: el => wrapSelection(el, '`', '`', 'code') },
];

function renderMarkdownToolbar(bodyArea: HTMLTextAreaElement): HTMLElement {
  const row = h('div', { class: 'markdown-toolbar' });
  for (const action of MARKDOWN_ACTIONS) {
    const btn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': action.label, title: action.label },
      icon(action.icon)
    );
    btn.addEventListener('click', () => action.run(bodyArea));
    row.append(btn);
  }
  return row;
}

function backLink(navigate: (path: string) => void, section: SidebarSection): HTMLElement {
  const link = h(
    'button',
    { type: 'button', class: 'icon-btn ghost back-link', 'aria-label': 'Back to notes', title: 'Back to notes' },
    icon('chevronsLeft')
  );
  link.addEventListener('click', () => navigate(section === 'shared' ? '/shared' : '/'));
  return link;
}

function renderDeletedState(ctx: AppContext, main: HTMLElement, note: DecryptedNote): void {
  const { store, navigate } = ctx;
  const dateStr = note.deletedAt
    ? new Date(note.deletedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  const restoreBtn = h('button', { type: 'button', class: 'primary' }, 'Restore');
  restoreBtn.addEventListener('click', () => {
    const doRestore = (): void => {
      void store.restoreNote(note.id).then(() => navigate(`/note/${note.id}`));
    };
    if (note.isPublic) confirmRestorePublished(doRestore);
    else doRestore();
  });

  const content = h(
    'div',
    { class: 'editor-view deleted-page' },
    backLink(navigate, 'mine'),
    h('h1', {}, note.title || 'Untitled page'),
    h(
      'p',
      { class: 'deleted-meta' },
      note.pageNo !== null ? `Page ${note.pageNo} · deleted ${dateStr}` : `Deleted ${dateStr}`
    ),
    restoreBtn
  );

  clear(main);
  main.append(content);
}

function renderEditorForm(
  ctx: AppContext,
  main: HTMLElement,
  note: DecryptedNote | null,
  section: SidebarSection,
  setOpenNote: (id: string | null) => void
): void {
  const { store, navigate } = ctx;
  const session = requireSession();
  const readOnly = note !== null && !note.isOwner;
  let currentId = note?.id ?? null;
  let currentPageNo = note?.pageNo ?? null;
  let currentIsPublic = note?.isPublic ?? false;

  const titleInput = h('input', { type: 'text', class: 'title-input', placeholder: 'Untitled page…', value: note?.title ?? '' }) as HTMLInputElement;
  const bodyArea = h('textarea', { class: 'editor-body', placeholder: 'Write in Markdown…' }) as HTMLTextAreaElement;
  bodyArea.value = note?.body ?? '';
  const previewHost = h('div', { class: 'preview hidden' });
  const statusHost = h('span', { class: 'save-status' }, '');
  const markdownToolbar = readOnly ? null : renderMarkdownToolbar(bodyArea);

  if (readOnly) {
    titleInput.setAttribute('readonly', 'true');
    bodyArea.setAttribute('readonly', 'true');
  }

  const tagsEditor = renderTagsEditor(note?.tags ?? [], readOnly, (_tags, immediate) => {
    if (immediate) void save();
    else scheduleSave();
  });

  const pageBarHost = h('div', { class: 'page-bar hidden' });
  const publicBadgeHost = h('div', {});

  async function refreshPageBar(): Promise<void> {
    if (!currentId || readOnly || currentPageNo === null) {
      pageBarHost.classList.add('hidden');
      return;
    }
    const pageNo = currentPageNo;
    clear(pageBarHost);
    pageBarHost.classList.remove('hidden');

    const all = await store.listNotes();
    const owned = all.filter((n): n is DecryptedNoteSummary & { pageNo: number } => n.isOwner && n.pageNo !== null);
    const known = new Map<number, DecryptedNoteSummary>();
    let highWater = 0;
    for (const n of owned) {
      known.set(n.pageNo, n);
      if (n.pageNo > highWater) highWater = n.pageNo;
    }
    const available = owned.filter(n => n.deletedAt === null).sort((a, b) => a.pageNo - b.pageNo);

    const prevTarget = available.filter(n => n.pageNo < pageNo).pop() ?? null;
    const nextTarget = available.find(n => n.pageNo > pageNo) ?? null;

    const prevBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': 'Previous page', title: 'Previous page' },
      icon('chevronLeft')
    ) as HTMLButtonElement;
    const nextBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': 'Next page', title: 'Next page' },
      icon('chevronRight')
    ) as HTMLButtonElement;
    prevBtn.disabled = !prevTarget;
    nextBtn.disabled = !nextTarget;
    prevBtn.addEventListener('click', () => prevTarget && navigate(`/note/${prevTarget.id}`));
    nextBtn.addEventListener('click', () => nextTarget && navigate(`/note/${nextTarget.id}`));

    const pageInput = h('input', { type: 'text', class: 'page-jump-input', value: String(pageNo) }) as HTMLInputElement;
    const pageStatus = h('span', { class: 'page-status' }, '');
    pageInput.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const target = parseInt(pageInput.value, 10);
      if (!Number.isInteger(target) || target <= 0) return;
      const found = known.get(target);
      if (found) {
        navigate(`/note/${found.id}`);
        return;
      }
      pageStatus.textContent = target > highWater ? 'No page here yet' : 'Deleted or never existed';
    });
    pageInput.addEventListener('blur', () => {
      pageInput.value = String(pageNo);
      pageStatus.textContent = '';
    });

    pageBarHost.append(h('span', { class: 'page-bar-label' }, 'Page'), prevBtn, pageInput, nextBtn, pageStatus);
  }

  function refreshPublicBadge(): void {
    clear(publicBadgeHost);
    if (!currentIsPublic || currentPageNo === null) return;
    const url = publicPageUrl(currentPageNo);
    publicBadgeHost.append(
      h(
        'div',
        { class: 'public-badge' },
        icon('globe', 14),
        'Public',
        h('a', { href: url, target: '_blank', rel: 'noopener', class: 'public-link' }, url)
      )
    );
  }

  void refreshPageBar();
  refreshPublicBadge();

  let saveTimer: number | undefined;
  let saving = false;
  let dirty = false;
  let active = true;

  function scheduleSave(): void {
    if (readOnly) return;
    dirty = true;
    statusHost.textContent = 'Unsaved changes…';
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
  }

  async function save(): Promise<void> {
    if (saving || !dirty) return;
    saving = true;
    dirty = false;
    statusHost.textContent = 'Saving…';
    try {
      const tags = tagsEditor.flushPendingInput();
      const previousId = currentId;
      const saved = await store.saveNote(currentId, titleInput.value, bodyArea.value, tags);
      const isNewId = saved.id !== previousId;
      currentId = saved.id;
      currentPageNo = saved.pageNo;
      currentIsPublic = saved.isPublic;
      void refreshPageBar();
      refreshPublicBadge();
      if (isNewId) {
        history.replaceState(null, '', `#/note/${saved.id}`);
        deleteBtn.classList.remove('hidden');
        shareBtn.classList.remove('hidden');
        commentsSection.classList.remove('hidden');
      }
      if (active) setOpenNote(currentId);
      shortcutBtn.classList.toggle('hidden', !(currentPageNo !== null && ctx.createShortcut));
      statusHost.textContent =
        previousId !== null && isNewId ? 'Saved as a new copy — another device changed this note' : 'Saved';
    } catch {
      statusHost.textContent = 'Not saved — retrying';
      dirty = true;
      saveTimer = window.setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    } finally {
      saving = false;
    }
  }

  titleInput.addEventListener('input', scheduleSave);
  bodyArea.addEventListener('input', scheduleSave);
  titleInput.addEventListener('blur', () => void save());
  bodyArea.addEventListener('blur', () => void save());

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden' && dirty) void save();
  }
  function onPageHide(): void {
    if (dirty) void save();
  }
  function teardown(): void {
    window.removeEventListener('hashchange', teardown);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    unsubscribeCommentConnection();
    active = false;
    if (saveTimer) window.clearTimeout(saveTimer);
    if (dirty) void save();
  }
  window.addEventListener('hashchange', teardown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  let showingPreview = false;
  const previewToggle = h(
    'button',
    { type: 'button', class: 'icon-btn', 'aria-label': 'Preview', title: 'Preview' },
    icon('eye')
  );
  previewToggle.addEventListener('click', async () => {
    showingPreview = !showingPreview;
    if (showingPreview) {
      bodyArea.classList.add('hidden');
      markdownToolbar?.classList.add('hidden');
      previewHost.classList.remove('hidden');
      previewToggle.replaceChildren(icon('pencil'));
      previewToggle.setAttribute('aria-label', 'Edit');
      previewToggle.setAttribute('title', 'Edit');
      await renderContent(previewHost, bodyArea.value, getFormat(tagsEditor.getTags()));
    } else {
      bodyArea.classList.remove('hidden');
      markdownToolbar?.classList.remove('hidden');
      previewHost.classList.add('hidden');
      previewToggle.replaceChildren(icon('eye'));
      previewToggle.setAttribute('aria-label', 'Preview');
      previewToggle.setAttribute('title', 'Preview');
    }
  });

  const deleteBtn = h(
    'button',
    {
      type: 'button',
      class: currentId && !readOnly ? 'icon-btn danger' : 'icon-btn danger hidden',
      'aria-label': 'Move to trash',
      title: 'Move to trash',
    },
    icon('trash')
  );
  deleteBtn.addEventListener('click', async () => {
    if (!currentId) return;
    const id = currentId;
    const view = main.querySelector('.editor-view') as HTMLElement | null;
    view?.classList.add('mz-page--tearing');
    try {
      await store.trashNote(id);
    } catch {
      view?.classList.remove('mz-page--tearing');
      statusHost.textContent = 'Could not move to trash';
      return;
    }
    window.setTimeout(() => {
      navigate('/');
      showToast('Page moved to trash', 'Undo', () => {
        void store.restoreNote(id).then(() => navigate(`/note/${id}`));
      });
    }, 460);
  });

  const shortcutBtn = h(
    'button',
    {
      type: 'button',
      class: currentId && !readOnly && currentPageNo !== null && ctx.createShortcut ? 'icon-btn' : 'icon-btn hidden',
      'aria-label': 'Create shortcut',
      title: 'Create shortcut',
    },
    icon('link')
  );
  shortcutBtn.addEventListener('click', () => {
    if (!ctx.createShortcut || currentPageNo === null) return;
    void ctx.createShortcut(currentPageNo, titleInput.value);
  });

  const shareBtn = h(
    'button',
    {
      type: 'button',
      class: currentId && !readOnly ? 'icon-btn' : 'icon-btn hidden',
      'aria-label': 'Share',
      title: 'Share',
    },
    icon('share')
  );
  shareBtn.addEventListener('click', () => {
    if (!currentId) return;
    const noteForDialog: DecryptedNote = {
      id: currentId,
      ownerId: session.userId,
      isOwner: true,
      title: titleInput.value,
      tags: tagsEditor.getTags(),
      hasUnreadComment: false,
      pageNo: currentPageNo,
      isPublic: currentIsPublic,
      rev: 0,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      body: bodyArea.value,
    };
    renderShareDialog(ctx, noteForDialog, pageNo => {
      currentIsPublic = true;
      currentPageNo = pageNo;
      refreshPublicBadge();
      void refreshPageBar();
    });
  });

  const commentsHost = h('div', { class: 'comments-list' });
  const commentInput = h('textarea', { placeholder: 'Add a comment…' }) as HTMLTextAreaElement;
  const commentBtn = h('button', { type: 'button', class: 'primary' }, 'Post comment');
  commentBtn.addEventListener('click', async () => {
    if (!currentId || !commentInput.value.trim() || connectionStatus().status === 'offline') return;
    commentBtn.disabled = true;
    try {
      await store.postComment(currentId, commentInput.value.trim());
      commentInput.value = '';
      showToast('Comment posted');
      await loadComments();
    } finally {
      commentBtn.disabled = connectionStatus().status === 'offline';
    }
  });

  function updateCommentOfflineState(): void {
    const offline = connectionStatus().status === 'offline';
    commentBtn.disabled = offline;
    for (const btn of Array.from(commentsHost.querySelectorAll('button'))) (btn as HTMLButtonElement).disabled = offline;
  }
  updateCommentOfflineState();
  const unsubscribeCommentConnection = onConnectionChange(updateCommentOfflineState);

  let commentsLoaded = false;
  const commentsExpandIcon = icon('chevronRight');
  const commentsBody = h('div', { class: 'comments-body hidden' }, commentsHost, commentInput, commentBtn);
  const commentsToggle = h('h2', { class: 'comments-toggle' }, 'Comments', commentsExpandIcon);
  commentsToggle.addEventListener('click', () => {
    const opening = commentsBody.classList.contains('hidden');
    commentsBody.classList.toggle('hidden');
    commentsToggle.classList.toggle('comments-toggle--open', opening);
    if (opening && !commentsLoaded) {
      commentsLoaded = true;
      void loadComments();
    }
  });

  const commentsSection = h(
    'section',
    { class: currentId ? 'comments' : 'comments hidden' },
    commentsToggle,
    commentsBody
  );

  function renderComment(c: DecryptedComment): HTMLElement {
    const canDelete = c.authorId === session.userId || note?.ownerId === session.userId;
    const el = h(
      'div',
      { class: 'comment' },
      h('p', {}, c.body),
      h('span', { class: 'comment-meta' }, new Date(c.createdAt).toLocaleString())
    );
    if (canDelete) {
      const del = h('button', { type: 'button', class: 'danger' }, 'Delete');
      del.addEventListener('click', async () => {
        if (!currentId) return;
        await store.deleteComment(currentId, c.id);
        showToast('Comment deleted');
        await loadComments();
      });
      el.append(del);
    }
    return el;
  }

  async function loadComments(): Promise<void> {
    if (!currentId) return;
    clear(commentsHost);
    try {
      const comments = await store.listComments(currentId);
      if (comments.length === 0) {
        commentsHost.append(h('p', { class: 'empty' }, 'No comments yet.'));
      } else {
        for (const c of comments) commentsHost.append(renderComment(c));
      }
    } catch {
      commentsHost.append(errorBanner('Failed to load comments'));
    }
    updateCommentOfflineState();
  }

  const toolbarRow = h(
    'div',
    { class: 'editor-toolbar' },
    backLink(navigate, section),
    pageBarHost,
    h('div', { class: 'editor-toolbar-actions' }, previewToggle, shareBtn, shortcutBtn, deleteBtn, statusHost)
  );

  const content = h(
    'div',
    { class: 'editor-view' },
    toolbarRow,
    publicBadgeHost,
    readOnly ? h('p', { class: 'readonly-notice' }, 'Shared with you — read only. You can still comment.') : null,
    titleInput,
    tagsEditor.el,
    markdownToolbar,
    bodyArea,
    previewHost,
    commentsSection
  );

  clear(main);
  main.append(content);

  if (currentId && note?.hasUnreadComment) {
    commentsLoaded = true;
    commentsBody.classList.remove('hidden');
    commentsToggle.classList.add('comments-toggle--open');
    void loadComments();
  }
}

export async function renderEditor(ctx: AppContext, idParam: string | null): Promise<void> {
  const { store } = ctx;
  const isNew = idParam === null || idParam === 'new';

  if (isNew) {
    const { main, setOpenNote } = ctx.ensureShell('mine', null);
    renderEditorForm(ctx, main, null, 'mine', setOpenNote);
    return;
  }

  const id = idParam as string;
  const { main, setSection, setOpenNote } = ctx.ensureShell('mine', id);
  clear(main);
  main.append(h('p', {}, 'Loading…'));

  let note: DecryptedNote | null;
  try {
    note = await store.getNote(id);
  } catch {
    clear(main);
    main.append(errorBanner('Failed to load note'));
    return;
  }
  if (!note) {
    clear(main);
    main.append(errorBanner('Note not found'));
    return;
  }

  if (note.deletedAt !== null) {
    setSection('mine');
    setOpenNote(note.id);
    renderDeletedState(ctx, main, note);
    return;
  }

  const section: SidebarSection = note.isOwner ? 'mine' : 'shared';
  setSection(section);
  setOpenNote(note.id);
  renderEditorForm(ctx, main, note, section, setOpenNote);
}
