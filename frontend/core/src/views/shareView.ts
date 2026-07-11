import { h, clear, errorBanner, infoBanner } from './dom';
import type { AppContext } from './app';
import * as authApi from '../api/auth';

export function renderShareDialog(ctx: AppContext, noteId: string): void {
  const { store } = ctx;
  const overlay = h('div', { class: 'dialog-overlay' });

  const shareEmailInput = h('input', { type: 'email', placeholder: 'Recipient email' }) as HTMLInputElement;
  const shareStatus = h('div', {});
  const shareBtn = h('button', { type: 'button' }, 'Share');
  shareBtn.addEventListener('click', async () => {
    clear(shareStatus);
    const email = shareEmailInput.value.trim();
    if (!email) return;
    try {
      await store.shareNote(noteId, email);
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
  const unshareBtn = h('button', { type: 'button' }, 'Revoke access');
  unshareBtn.addEventListener('click', async () => {
    clear(unshareStatus);
    const email = unshareEmailInput.value.trim();
    if (!email) return;
    try {
      const recipient = await authApi.lookupPublicKey(email);
      await store.unshareNote(noteId, recipient.user_id);
      unshareStatus.append(infoBanner(`Revoked access for ${email}`));
      unshareEmailInput.value = '';
    } catch (err) {
      unshareStatus.append(errorBanner(err instanceof Error ? err.message : 'Failed to revoke access'));
    }
  });

  const closeBtn = h('button', { type: 'button' }, 'Close');
  closeBtn.addEventListener('click', () => overlay.remove());

  overlay.append(
    h(
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
      closeBtn
    )
  );

  document.body.append(overlay);
}
