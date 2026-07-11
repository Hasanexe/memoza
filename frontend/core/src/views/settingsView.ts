import { h, clear, errorBanner, infoBanner } from './dom';
import type { AppContext } from './app';
import * as authApi from '../api/auth';
import { ApiError } from '../api/client';
import {
  unwrapDekExtractable,
  unwrapPrivateKeyExtractable,
  sealDekForSession,
  sealPrivateKeyForSession,
  deriveCredential,
  buildPasswordEnvelope,
} from '../crypto/keys';
import { requireSession, logout as clearSession, setSession, setAccessToken } from '../crypto/session';
import { decodeAccessToken } from '../crypto/jwt';
import { KDF_ITERATIONS, MIN_PASSWORD_LENGTH, EMAIL_STORAGE_KEY } from '../config';

const THEME_KEY = 'theme';

export function renderSettings(ctx: AppContext): void {
  const { root, navigate, store } = ctx;
  clear(root);
  const session = requireSession();

  const backBtn = h('button', { type: 'button' }, 'Back');
  backBtn.addEventListener('click', () => navigate('/'));

  root.append(
    h(
      'div',
      { class: 'settings-view' },
      backBtn,
      h('h1', {}, 'Settings'),
      renderThemeSection(),
      renderPasswordSection(),
      ctx.biometricControl ? renderBiometricSection(ctx.biometricControl) : null,
      renderExportSection(),
      renderImportSection(),
      renderDeleteSection()
    )
  );

  function renderThemeSection(): HTMLElement {
    const select = h(
      'select',
      {},
      h('option', { value: 'system' }, 'System'),
      h('option', { value: 'light' }, 'Light'),
      h('option', { value: 'dark' }, 'Dark')
    ) as HTMLSelectElement;
    select.value = localStorage.getItem(THEME_KEY) ?? 'system';
    select.addEventListener('change', () => {
      if (select.value === 'system') {
        localStorage.removeItem(THEME_KEY);
        document.documentElement.removeAttribute('data-theme');
      } else {
        localStorage.setItem(THEME_KEY, select.value);
        document.documentElement.setAttribute('data-theme', select.value);
      }
    });
    return h('section', {}, h('h2', {}, 'Appearance'), h('label', {}, 'Theme', select));
  }

  function renderPasswordSection(): HTMLElement {
    const oldInput = h('input', { type: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
    const newInput = h('input', {
      type: 'password',
      autocomplete: 'new-password',
      minlength: String(MIN_PASSWORD_LENGTH),
    }) as HTMLInputElement;
    const confirmInput = h('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
    const statusHost = h('div', {});
    const submitBtn = h('button', { type: 'button' }, 'Change password');

    submitBtn.addEventListener('click', async () => {
      clear(statusHost);
      if (newInput.value.length < MIN_PASSWORD_LENGTH) {
        statusHost.append(errorBanner(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`));
        return;
      }
      if (newInput.value !== confirmInput.value) {
        statusHost.append(errorBanner('Passwords do not match'));
        return;
      }
      try {
        const oldCredential = await deriveCredential(oldInput.value, session.email, KDF_ITERATIONS);
        const dek = await unwrapDekExtractable(oldCredential.wrapKey, session.wrappedDek);
        const privateKey = await unwrapPrivateKeyExtractable(oldCredential.wrapKey, session.wrappedPrivateKey);

        const envelope = await buildPasswordEnvelope(newInput.value, session.email, KDF_ITERATIONS, dek, privateKey);

        const result = await authApi.changePassword({
          email: session.email,
          old_password: oldCredential.authHash,
          new_password: envelope.authHash,
          wrapped_dek: envelope.wrappedDek,
          wrapped_private_key: envelope.wrappedPrivateKey,
        });

        setAccessToken(result.access_token);
        const sessionDek = await sealDekForSession(dek);
        const sessionPrivateKey = await sealPrivateKeyForSession(privateKey);
        const { userId } = decodeAccessToken(result.access_token);
        setSession({
          userId,
          email: session.email,
          dek: sessionDek,
          privateKey: sessionPrivateKey,
          wrappedDek: envelope.wrappedDek,
          wrappedPrivateKey: envelope.wrappedPrivateKey,
        });
        await ctx.onUnlock?.({
          userId,
          email: session.email,
          wrappedDek: envelope.wrappedDek,
          wrappedPrivateKey: envelope.wrappedPrivateKey,
        });

        oldInput.value = '';
        newInput.value = '';
        confirmInput.value = '';
        statusHost.append(infoBanner('Password changed. Other devices have been logged out.'));
      } catch (err) {
        statusHost.append(errorBanner(err instanceof ApiError ? err.message : 'Failed to change password'));
      }
    });

    return h(
      'section',
      {},
      h('h2', {}, 'Change password'),
      h('p', {}, 'Your recovery key does not change and cannot be shown again.'),
      h('label', {}, 'Current password', oldInput),
      h('label', {}, `New password (min ${MIN_PASSWORD_LENGTH} characters)`, newInput),
      h('label', {}, 'Confirm new password', confirmInput),
      submitBtn,
      statusHost
    );
  }

  function renderBiometricSection(control: NonNullable<AppContext['biometricControl']>): HTMLElement {
    const passwordInput = h('input', { type: 'password', placeholder: 'Current password' }) as HTMLInputElement;
    const statusHost = h('div', {});
    const enableBtn = h('button', { type: 'button' }, 'Enable');
    const disableBtn = h('button', { type: 'button', class: 'hidden' }, 'Disable');

    void control.isEnabled().then(enabled => {
      enableBtn.classList.toggle('hidden', enabled);
      disableBtn.classList.toggle('hidden', !enabled);
    });

    enableBtn.addEventListener('click', async () => {
      clear(statusHost);
      try {
        await control.enable(passwordInput.value);
        passwordInput.value = '';
        enableBtn.classList.add('hidden');
        disableBtn.classList.remove('hidden');
        statusHost.append(infoBanner('Biometric unlock enabled'));
      } catch (err) {
        statusHost.append(errorBanner(err instanceof ApiError ? err.message : 'Failed to enable biometric unlock'));
      }
    });

    disableBtn.addEventListener('click', async () => {
      clear(statusHost);
      await control.disable();
      disableBtn.classList.add('hidden');
      enableBtn.classList.remove('hidden');
      statusHost.append(infoBanner('Biometric unlock disabled'));
    });

    return h(
      'section',
      {},
      h('h2', {}, 'Biometric / OS unlock'),
      h('p', {}, 'Skip retyping your password on this device using Windows Hello, Touch ID, or your OS keychain.'),
      h('label', {}, 'Current password', passwordInput),
      enableBtn,
      disableBtn,
      statusHost
    );
  }

  function downloadText(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function renderExportSection(): HTMLElement {
    const statusHost = h('div', {});
    const btn = h('button', { type: 'button' }, 'Export all notes (.md)');
    btn.addEventListener('click', async () => {
      clear(statusHost);
      const summaries = (await store.listNotes()).filter(n => n.deletedAt === null);
      const fulls = await Promise.all(summaries.map(summary => store.getNote(summary.id)));
      const parts = fulls.filter((full): full is NonNullable<typeof full> => full !== null).map(full => `# ${full.title}\n\n${full.body}\n`);
      if (parts.length === 0) {
        statusHost.append(infoBanner('No notes to export'));
        return;
      }
      downloadText('memoza-notes-export.md', parts.join('\n---\n\n'));
    });
    return h('section', {}, h('h2', {}, 'Export'), btn, statusHost);
  }

  function renderImportSection(): HTMLElement {
    const fileInput = h('input', { type: 'file', accept: '.md', multiple: 'true' }) as HTMLInputElement;
    const statusHost = h('div', {});
    const btn = h('button', { type: 'button' }, 'Import');
    btn.addEventListener('click', async () => {
      clear(statusHost);
      const files = fileInput.files;
      if (!files || files.length === 0) return;
      let imported = 0;
      for (const file of Array.from(files)) {
        const text = await file.text();
        const title = file.name.replace(/\.md$/i, '');
        await store.saveNote(null, title, text, []);
        imported++;
      }
      statusHost.append(infoBanner(`Imported ${imported} note(s) as new notes`));
      fileInput.value = '';
    });
    return h(
      'section',
      {},
      h('h2', {}, 'Import'),
      h('p', {}, 'Each imported .md file becomes a new note you own.'),
      fileInput,
      btn,
      statusHost
    );
  }

  function renderDeleteSection(): HTMLElement {
    const passwordInput = h('input', { type: 'password', placeholder: 'Current password' }) as HTMLInputElement;
    const confirmInput = h('input', { type: 'text', placeholder: 'Type DELETE to confirm' }) as HTMLInputElement;
    const statusHost = h('div', {});
    const btn = h('button', { type: 'button', class: 'danger' }, 'Delete account');
    btn.addEventListener('click', async () => {
      clear(statusHost);
      if (confirmInput.value !== 'DELETE') {
        statusHost.append(errorBanner('Type DELETE to confirm'));
        return;
      }
      try {
        const { authHash } = await deriveCredential(passwordInput.value, session.email, KDF_ITERATIONS);
        await authApi.deleteAccount(session.email, authHash);
        await ctx.onLogout?.();
        clearSession();
        localStorage.removeItem(EMAIL_STORAGE_KEY);
        navigate('/login');
      } catch (err) {
        statusHost.append(errorBanner(err instanceof ApiError ? err.message : 'Failed to delete account'));
      }
    });
    return h(
      'section',
      { class: 'danger-zone' },
      h('h2', {}, 'Danger zone'),
      h('p', {}, 'This permanently deletes your account and every note you own.'),
      h('label', {}, 'Password', passwordInput),
      h('label', {}, 'Confirmation', confirmInput),
      btn,
      statusHost
    );
  }
}
