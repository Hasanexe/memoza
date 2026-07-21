import { h, clear, errorBanner, infoBanner, openDialog } from './dom';
import type { AppContext } from './app';
import type { DecryptedNote } from '../store/types';
import * as authApi from '../api/auth';
import { requireSession } from '../crypto/session';
import { connectionStatus, onConnectionChange } from '../connection';
import { PUBLIC_APP_ORIGIN } from '../config';
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
  return `${PUBLIC_APP_ORIGIN}/${username}/${pageNo}`;
}

export function renderShareDialog(ctx: AppContext, note: DecryptedNote, onPublished: (pageNo: number) => void): void {
  const { store } = ctx;

  const shareEmailInput = h('input', { type: 'email', placeholder: t('share.recipientEmail') }) as HTMLInputElement;
  const shareStatus = h('div', {});
  const shareBtn = h('button', { type: 'button', class: 'primary' }, t('common.share'));
  shareBtn.addEventListener('click', async () => {
    clear(shareStatus);
    const email = shareEmailInput.value.trim();
    if (!email) return;
    try {
      await store.shareNote(note.id, email);
      shareStatus.append(infoBanner(t('share.sharedWith', { email })));
      shareEmailInput.value = '';
    } catch (err) {
      shareStatus.append(errorBanner(err instanceof Error ? err.message : t('share.failedToShare')));
    }
  });

  const unshareEmailInput = h('input', {
    type: 'email',
    placeholder: t('share.recipientEmailToRemove'),
  }) as HTMLInputElement;
  const unshareStatus = h('div', {});
  const unshareBtn = h('button', { type: 'button', class: 'danger' }, t('share.revokeAccess'));
  unshareBtn.addEventListener('click', async () => {
    clear(unshareStatus);
    const email = unshareEmailInput.value.trim();
    if (!email) return;
    try {
      const recipient = await authApi.lookupPublicKey(email);
      await store.unshareNote(note.id, recipient.user_id);
      unshareStatus.append(infoBanner(t('share.revokedAccessFor', { email })));
      unshareEmailInput.value = '';
    } catch (err) {
      unshareStatus.append(errorBanner(err instanceof Error ? err.message : t('share.failedToRevoke')));
    }
  });

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
    unshareBtn.disabled = offline;
    const publishBtn = publishSection.querySelector('button');
    if (publishBtn) publishBtn.disabled = offline;
  }
  updateOfflineState();
  const unsubscribe = onConnectionChange(updateOfflineState);

  openDialog(
    close => {
      const closeBtn = h('button', { type: 'button', class: 'ghost' }, t('common.close'));
      closeBtn.addEventListener('click', close);

      return h(
        'div',
        { class: 'dialog' },
        h('h2', {}, t('share.shareNoteTitle')),
        h('p', {}, t('share.shareReadOnlyNotice')),
        h('label', {}, t('share.shareWith'), shareEmailInput),
        shareBtn,
        shareStatus,
        h('hr', {}),
        h('label', {}, t('share.revokeAccess'), unshareEmailInput),
        unshareBtn,
        unshareStatus,
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
