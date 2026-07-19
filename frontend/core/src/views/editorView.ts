import { h, clear, errorBanner, showToast, icon } from './dom';
import type { AppContext } from './app';
import type { DecryptedNote, DecryptedComment, DecryptedNoteSummary } from '../store/types';
import { renderContent } from './markdown';
import { renderShareDialog, confirmRestorePublished, publicPageUrl } from './shareView';
import { requireSession } from '../crypto/session';
import { renderTagsEditor } from './tagsEditor';
import { renderSidebar, type SidebarSection } from './sidebar';
import { getFormat } from './controlTags';

const AUTOSAVE_DEBOUNCE_MS = 4000;

function backLink(navigate: (path: string) => void, section: SidebarSection): HTMLElement {
  const link = h(
    'button',
    { type: 'button', class: 'icon-btn back-link', 'aria-label': 'Back to notes', title: 'Back to notes' },
    icon('chevronLeft')
  );
  link.addEventListener('click', () => navigate(section === 'shared' ? '/shared' : '/'));
  return link;
}

function shell(ctx: AppContext, section: SidebarSection, openNoteId: string | null, content: HTMLElement): void {
  ctx.root.append(
    h('div', { class: 'app-shell' }, renderSidebar(ctx, section, openNoteId), h('div', { class: 'main' }, content))
  );
}

function renderDeletedState(ctx: AppContext, note: DecryptedNote): void {
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

  shell(ctx, 'mine', note.id, content);
}

export async function renderEditor(ctx: AppContext, idParam: string | null): Promise<void> {
  const { root, store, navigate } = ctx;
  clear(root);

  const isNew = idParam === null || idParam === 'new';
  let note: DecryptedNote | null = null;

  if (!isNew && idParam) {
    root.append(h('p', {}, 'Loading…'));
    try {
      note = await store.getNote(idParam);
    } catch {
      clear(root);
      root.append(errorBanner('Failed to load note'));
      return;
    }
    if (!note) {
      clear(root);
      root.append(errorBanner('Note not found'));
      return;
    }
  }

  if (note && note.deletedAt !== null) {
    renderDeletedState(ctx, note);
    return;
  }

  clear(root);

  const session = requireSession();
  const readOnly = note !== null && !note.isOwner;
  const section: SidebarSection = note && !note.isOwner ? 'shared' : 'mine';
  let currentId = note?.id ?? null;
  let currentPageNo = note?.pageNo ?? null;
  let currentIsPublic = note?.isPublic ?? false;

  const titleInput = h('input', { type: 'text', class: 'title-input', placeholder: 'Untitled page…', value: note?.title ?? '' }) as HTMLInputElement;
  const bodyArea = h('textarea', { class: 'editor-body', placeholder: 'Write in Markdown…' }) as HTMLTextAreaElement;
  bodyArea.value = note?.body ?? '';
  const previewHost = h('div', { class: 'preview hidden' });
  const statusHost = h('span', { class: 'save-status' }, '');

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

    pageBarHost.append(prevBtn, h('span', { class: 'page-bar-label' }, 'Page'), pageInput, nextBtn, pageStatus);
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
        void loadComments();
      }
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
      previewHost.classList.remove('hidden');
      previewToggle.replaceChildren(icon('pencil'));
      previewToggle.setAttribute('aria-label', 'Edit');
      previewToggle.setAttribute('title', 'Edit');
      await renderContent(previewHost, bodyArea.value, getFormat(tagsEditor.getTags()));
    } else {
      bodyArea.classList.remove('hidden');
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
    const view = root.querySelector('.editor-view') as HTMLElement | null;
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
    if (!currentId || !commentInput.value.trim()) return;
    await store.postComment(currentId, commentInput.value.trim());
    commentInput.value = '';
    await loadComments();
  });

  const commentsSection = h(
    'section',
    { class: currentId ? 'comments' : 'comments hidden' },
    h('h2', {}, 'Comments'),
    commentsHost,
    commentInput,
    commentBtn
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
  }

  const content = h(
    'div',
    { class: 'editor-view' },
    backLink(navigate, section),
    pageBarHost,
    publicBadgeHost,
    h('div', { class: 'editor-toolbar' }, previewToggle, shareBtn, shortcutBtn, deleteBtn, statusHost),
    readOnly ? h('p', { class: 'readonly-notice' }, 'Shared with you — read only. You can still comment.') : null,
    titleInput,
    tagsEditor.el,
    bodyArea,
    previewHost,
    commentsSection
  );

  shell(ctx, section, currentId, content);

  if (currentId) void loadComments();
}
