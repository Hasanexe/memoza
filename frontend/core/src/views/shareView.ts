import { h, clear, errorBanner, infoBanner, openDialog } from './dom';
import type { AppContext } from './app';
import type { DecryptedNote, NoteShare } from '../store/types';
import { requireSession } from '../crypto/session';
import { connectionStatus, onConnectionChange } from '../connection';
import { PUBLIC_SITE_ORIGIN } from '../config';
import { t } from '../i18n';

export function confirmDialog(title: string, body: string, confirmLabel: string, onConfirm: () => void): void {
  openDialog(close => {
    const cancelBtn = h('button', { type: 'button', class: 'ghost' }, t('common.cancel'));
    cancelBtn.addEventListener('click', close);
    const confirmBtn = h('button', { type: 'button', class: 'primary' }, confirmLabel);
    confirmBtn.addEventListener('click', () => {
      close();
      onConfirm();
    });
    return h('div', { class: 'dialog' }, h('h2', {}, title), h('p', {}, body), cancelBtn, confirmBtn);
  });
}

export function confirmPublish(onConfirm: () => void): void {
  confirmDialog(t('share.makePagePublicTitle'), t('share.publishWarning'), t('share.makePublic'), onConfirm);
}

export function confirmRestorePublished(onConfirm: () => void): void {
  confirmDialog(t('share.restorePublishedTitle'), t('share.restorePublishedWarning'), t('common.restore'), onConfirm);
}

export function publicPageUrl(pageNo: number): string {
  const { username } = requireSession();
  return `${PUBLIC_SITE_ORIGIN}/${username}/${pageNo}`;
}

export function renderShareDialog(ctx: AppContext, note: DecryptedNote, onPublished: (pageNo: number) => void): void {
  const { store } = ctx;

  const shareUsernameInput = h('input', { type: 'text', placeholder: t('share.recipientUsername'), autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const shareStatus = h('div', {});
  const shareBtn = h('button', { type: 'button', class: 'primary' }, t('common.share'));
  shareBtn.addEventListener('click', async () => {
    clear(shareStatus);
    const username = shareUsernameInput.value.trim().replace(/^@/, '');
    if (!username) return;
    shareBtn.disabled = true;
    try {
      await store.shareNote(note.id, username);
      shareStatus.append(infoBanner(t('share.sharedWithUsername', { username })));
      shareUsernameInput.value = '';
      await loadShares();
    } catch (err) {
      shareStatus.append(errorBanner(err instanceof Error ? err.message : t('share.failedToShare')));
    } finally {
      shareBtn.disabled = connectionStatus().status === 'offline';
    }
  });

  const sharesList = h('div', { class: 'shares-list' });

  function renderShareRow(share: NoteShare): HTMLElement {
    const removeBtn = h(
      'button',
      { type: 'button', class: 'icon-btn ghost share-remove', 'aria-label': t('share.remove'), title: t('share.remove') },
      '×'
    ) as HTMLButtonElement;
    removeBtn.disabled = connectionStatus().status === 'offline';
    removeBtn.addEventListener('click', async () => {
      removeBtn.disabled = true;
      try {
        await store.unshareNote(note.id, share.userId);
        await loadShares();
      } catch {
        removeBtn.disabled = false;
      }
    });
    return h('div', { class: 'share-row' }, h('span', { class: 'share-name' }, share.username ? `@${share.username}` : '—'), removeBtn);
  }

  async function loadShares(): Promise<void> {
    clear(sharesList);
    let shares: NoteShare[];
    try {
      shares = await store.listShares(note.id);
    } catch {
      sharesList.append(errorBanner(t('share.failedToLoadShares')));
      return;
    }
    if (shares.length === 0) {
      sharesList.append(h('p', { class: 'empty' }, t('share.noRecipients')));
      return;
    }
    for (const share of shares) sharesList.append(renderShareRow(share));
  }

  const publishStatus = h('div', {});
  const publishSection = h('div', {});

  function renderPublishSection(): void {
    clear(publishSection);
    if (note.isPublic) {
      const url = note.pageNo !== null ? publicPageUrl(note.pageNo) : '';
      publishSection.append(
        h(
          'div',
          {},
          h('p', {}, t('share.pageIsPublic')),
          url ? h('a', { href: url, target: '_blank', rel: 'noopener', class: 'public-link' }, url) : null
        )
      );
      return;
    }
    const publishBtn = h('button', { type: 'button', class: 'primary' }, t('share.makePublic'));
    publishBtn.addEventListener('click', () => {
      confirmPublish(() => {
        void (async () => {
          clear(publishStatus);
          try {
            const pageNo = await store.publish(note.id);
            note.isPublic = true;
            note.pageNo = pageNo;
            renderPublishSection();
            onPublished(pageNo);
          } catch (err) {
            publishStatus.append(errorBanner(err instanceof Error ? err.message : t('share.failedToPublish')));
          }
        })();
      });
    });
    publishSection.append(publishBtn);
  }
  renderPublishSection();

  function updateOfflineState(): void {
    const offline = connectionStatus().status === 'offline';
    shareBtn.disabled = offline;
    for (const btn of Array.from(sharesList.querySelectorAll('button'))) (btn as HTMLButtonElement).disabled = offline;
    const publishBtn = publishSection.querySelector('button');
    if (publishBtn) publishBtn.disabled = offline;
  }

  void loadShares();
  updateOfflineState();
  const unsubscribe = onConnectionChange(updateOfflineState);

  openDialog(
    close => {
      const closeBtn = h('button', { type: 'button', class: 'ghost dialog-close' }, t('common.close'));
      closeBtn.addEventListener('click', close);

      return h(
        'div',
        { class: 'dialog' },
        h('h2', {}, t('share.shareNoteTitle')),
        h('p', {}, t('share.shareReadOnlyNotice')),
        h('label', {}, t('share.shareWith'), shareUsernameInput),
        shareBtn,
        shareStatus,
        h('hr', {}),
        h('h3', { class: 'share-subhead' }, t('share.peopleWithAccess')),
        sharesList,
        h('hr', {}),
        h('h2', {}, t('share.publicPage')),
        publishSection,
        publishStatus,
        closeBtn
      );
    },
    unsubscribe
  );
}
