import { h, clear, errorBanner, infoBanner, openDialog } from './dom';
import type { AppContext } from './app';
import type { DecryptedNote } from '../store/types';
import * as authApi from '../api/auth';
import { requireSession } from '../crypto/session';
import { connectionStatus, onConnectionChange } from '../connection';
import { PUBLIC_APP_ORIGIN } from '../config';

const PUBLISH_WARNING =
  "Publishing stores this page as plaintext on Memoza's servers so anyone with the link can read it. This can't be undone — the only way to remove it is to delete the page.";

const RESTORE_PUBLISHED_WARNING = 'This page was published. Restoring it puts it back on its public link immediately.';

export function confirmDialog(title: string, body: string, confirmLabel: string, onConfirm: () => void): void {
  openDialog(close => {
    const cancelBtn = h('button', { type: 'button', class: 'ghost' }, 'Cancel');
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
  confirmDialog('Make this page public', PUBLISH_WARNING, 'Make public', onConfirm);
}

export function confirmRestorePublished(onConfirm: () => void): void {
  confirmDialog('Restore published page', RESTORE_PUBLISHED_WARNING, 'Restore', onConfirm);
}

export function publicPageUrl(pageNo: number): string {
  const { username } = requireSession();
  return `${PUBLIC_APP_ORIGIN}/${username}/${pageNo}`;
}

export function renderShareDialog(ctx: AppContext, note: DecryptedNote, onPublished: (pageNo: number) => void): void {
  const { store } = ctx;

  const shareEmailInput = h('input', { type: 'email', placeholder: 'Recipient email' }) as HTMLInputElement;
  const shareStatus = h('div', {});
  const shareBtn = h('button', { type: 'button', class: 'primary' }, 'Share');
  shareBtn.addEventListener('click', async () => {
    clear(shareStatus);
    const email = shareEmailInput.value.trim();
    if (!email) return;
    try {
      await store.shareNote(note.id, email);
      shareStatus.append(infoBanner(`Shared with ${email}`));
      shareEmailInput.value = '';
    } catch (err) {
      shareStatus.append(errorBanner(err instanceof Error ? err.message : 'Failed to share'));
    }
  });

  const unshareEmailInput = h('input', {
    type: 'email',
    placeholder: 'Recipient email to remove',
  }) as HTMLInputElement;
  const unshareStatus = h('div', {});
  const unshareBtn = h('button', { type: 'button', class: 'danger' }, 'Revoke access');
  unshareBtn.addEventListener('click', async () => {
    clear(unshareStatus);
    const email = unshareEmailInput.value.trim();
    if (!email) return;
    try {
      const recipient = await authApi.lookupPublicKey(email);
      await store.unshareNote(note.id, recipient.user_id);
      unshareStatus.append(infoBanner(`Revoked access for ${email}`));
      unshareEmailInput.value = '';
    } catch (err) {
      unshareStatus.append(errorBanner(err instanceof Error ? err.message : 'Failed to revoke access'));
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
          h('p', {}, 'This page is public.'),
          url ? h('a', { href: url, target: '_blank', rel: 'noopener', class: 'public-link' }, url) : null
        )
      );
      return;
    }
    const publishBtn = h('button', { type: 'button', class: 'primary' }, 'Make public');
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
            publishStatus.append(errorBanner(err instanceof Error ? err.message : 'Failed to publish'));
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
      const closeBtn = h('button', { type: 'button', class: 'ghost' }, 'Close');
      closeBtn.addEventListener('click', close);

      return h(
        'div',
        { class: 'dialog' },
        h('h2', {}, 'Share note'),
        h('p', {}, 'Sharing is read-only — recipients can read and comment, not edit.'),
        h('label', {}, 'Share with', shareEmailInput),
        shareBtn,
        shareStatus,
        h('hr', {}),
        h('label', {}, 'Revoke access', unshareEmailInput),
        unshareBtn,
        unshareStatus,
        h('hr', {}),
        h('h2', {}, 'Public page'),
        publishSection,
        publishStatus,
        closeBtn
      );
    },
    unsubscribe
  );
}
