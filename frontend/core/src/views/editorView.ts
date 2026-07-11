import { h, clear, errorBanner } from './dom';
import type { AppContext } from './app';
import type { DecryptedNote, DecryptedComment } from '../store/types';
import { renderMarkdown } from './markdown';
import { renderShareDialog } from './shareView';
import { requireSession } from '../crypto/session';

const AUTOSAVE_DEBOUNCE_MS = 2000;

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
      root.append(errorBanner('Failed to load note'), backLink());
      return;
    }
    if (!note) {
      clear(root);
      root.append(errorBanner('Note not found'), backLink());
      return;
    }
  }

  clear(root);

  const session = requireSession();
  const readOnly = note !== null && !note.isOwner;
  let currentId = note?.id ?? null;

  const titleInput = h('input', { type: 'text', placeholder: 'Title', value: note?.title ?? '' }) as HTMLInputElement;
  const tagsInput = h('input', {
    type: 'text',
    placeholder: 'tags, comma, separated',
    value: (note?.tags ?? []).join(', '),
  }) as HTMLInputElement;
  const bodyArea = h('textarea', { class: 'editor-body', placeholder: 'Write in Markdown…' }) as HTMLTextAreaElement;
  bodyArea.value = note?.body ?? '';
  const previewHost = h('div', { class: 'preview hidden' });
  const statusHost = h('span', { class: 'save-status' }, '');

  if (readOnly) {
    titleInput.setAttribute('readonly', 'true');
    tagsInput.setAttribute('readonly', 'true');
    bodyArea.setAttribute('readonly', 'true');
  }

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
      const tags = tagsInput.value
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const previousId = currentId;
      const saved = await store.saveNote(currentId, titleInput.value, bodyArea.value, tags);
      const isNewId = saved.id !== previousId;
      currentId = saved.id;
      if (isNewId) {
        history.replaceState(null, '', `#/note/${saved.id}`);
        pinBtn.classList.remove('hidden');
        deleteBtn.classList.remove('hidden');
        shareBtn.classList.remove('hidden');
        commentsSection.classList.remove('hidden');
        void loadComments();
      }
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
  tagsInput.addEventListener('input', scheduleSave);
  bodyArea.addEventListener('input', scheduleSave);

  let showingPreview = false;
  const previewToggle = h('button', { type: 'button' }, 'Preview');
  previewToggle.addEventListener('click', async () => {
    showingPreview = !showingPreview;
    if (showingPreview) {
      bodyArea.classList.add('hidden');
      previewHost.classList.remove('hidden');
      previewToggle.textContent = 'Edit';
      await renderMarkdown(previewHost, bodyArea.value);
    } else {
      bodyArea.classList.remove('hidden');
      previewHost.classList.add('hidden');
      previewToggle.textContent = 'Preview';
    }
  });

  let pinned = note?.pinned ?? false;
  const pinBtn = h('button', { type: 'button', class: currentId ? '' : 'hidden' }, pinned ? 'Unpin' : 'Pin');
  pinBtn.addEventListener('click', async () => {
    if (!currentId) return;
    pinned = !pinned;
    await store.setPinned(currentId, pinned);
    pinBtn.textContent = pinned ? 'Unpin' : 'Pin';
  });

  const deleteBtn = h('button', { type: 'button', class: currentId && !readOnly ? '' : 'hidden' }, 'Move to trash');
  deleteBtn.addEventListener('click', async () => {
    if (!currentId) return;
    if (!confirm('Move this note to trash?')) return;
    await store.trashNote(currentId);
    navigate('/');
  });

  const shareBtn = h('button', { type: 'button', class: currentId && !readOnly ? '' : 'hidden' }, 'Share');
  shareBtn.addEventListener('click', () => {
    if (currentId) renderShareDialog(ctx, currentId);
  });

  const commentsHost = h('div', { class: 'comments-list' });
  const commentInput = h('textarea', { placeholder: 'Add a comment…' }) as HTMLTextAreaElement;
  const commentBtn = h('button', { type: 'button' }, 'Post comment');
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
      const del = h('button', { type: 'button' }, 'Delete');
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

  root.append(
    h(
      'div',
      { class: 'editor-view' },
      backLink(),
      h('div', { class: 'editor-toolbar' }, previewToggle, pinBtn, shareBtn, deleteBtn, statusHost),
      readOnly ? h('p', { class: 'readonly-notice' }, 'Shared with you — read only. You can still comment.') : null,
      titleInput,
      tagsInput,
      bodyArea,
      previewHost,
      commentsSection
    )
  );

  if (currentId) void loadComments();

  function backLink(): HTMLElement {
    const link = h('a', { href: '#/' }, '← Back to notes');
    link.addEventListener('click', e => {
      e.preventDefault();
      navigate('/');
    });
    return link;
  }
}
