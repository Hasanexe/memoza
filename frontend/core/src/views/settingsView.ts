import { h, clear, errorBanner, infoBanner, icon } from './dom';
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
import { performLogout } from './authViews';
import { t, getLanguage, setLanguage, LANGUAGES } from '../i18n';

const THEME_KEY = 'theme';

export function renderSettings(ctx: AppContext): void {
  const { navigate, store } = ctx;
  const { main } = ctx.ensureShell('settings', null);
  clear(main);
  const session = requireSession();

  const backBtn = h(
    'button',
    { type: 'button', class: 'icon-btn', 'aria-label': t('common.backToNotes'), title: t('common.backToNotes') },
    icon('chevronLeft')
  );
  backBtn.addEventListener('click', () => navigate('/'));

  main.append(
    h(
      'div',
      { class: 'main-inner settings-view' },
      backBtn,
      h('h1', {}, t('settings.title')),
      renderAccountSection(),
      renderThemeSection(),
      renderLanguageSection(),
      renderPasswordSection(),
      renderExportSection(),
      renderImportSection(),
      renderDeleteSection()
    )
  );

  function renderAccountSection(): HTMLElement {
    const logoutBtn = h('button', { type: 'button', class: 'primary' }, t('auth.logOut'));
    logoutBtn.addEventListener('click', () => void performLogout(ctx));
    return h(
      'section',
      {},
      h('h2', {}, t('settings.account')),
      h('p', { class: 'settings-email' }, session.email),
      ctx.platform === 'native'
        ? h('p', { class: 'settings-hint' }, t('settings.loggingOutDeletesDevice'))
        : null,
      logoutBtn
    );
  }

  function renderThemeSection(): HTMLElement {
    const select = h(
      'select',
      {},
      h('option', { value: 'system' }, t('settings.themeSystem')),
      h('option', { value: 'light' }, t('settings.themeLight')),
      h('option', { value: 'dark' }, t('settings.themeDark'))
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
    return h('section', {}, h('h2', {}, t('settings.appearance')), h('label', {}, t('settings.theme'), select));
  }

  function renderLanguageSection(): HTMLElement {
    const select = h(
      'select',
      {},
      ...LANGUAGES.map(l => h('option', { value: l.code }, l.nativeName))
    ) as HTMLSelectElement;
    select.value = getLanguage();
    select.addEventListener('change', () => {
      const value = select.value;
      void setLanguage(value);
      authApi.updateLanguage(value).catch(() => undefined);
    });
    return h(
      'section',
      {},
      h('h2', {}, t('settings.language')),
      h('p', {}, t('settings.languageHint')),
      h('label', {}, t('settings.language'), select)
    );
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
    const submitBtn = h('button', { type: 'button', class: 'primary' }, t('settings.changePassword'));

    submitBtn.addEventListener('click', async () => {
      if (submitBtn.disabled) return;
      clear(statusHost);
      if (newInput.value.length < MIN_PASSWORD_LENGTH) {
        statusHost.append(errorBanner(t('auth.passwordTooShort', { min: MIN_PASSWORD_LENGTH })));
        return;
      }
      if (newInput.value !== confirmInput.value) {
        statusHost.append(errorBanner(t('auth.passwordMismatch')));
        return;
      }
      submitBtn.disabled = true;
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
          username: session.username,
          dek: sessionDek,
          privateKey: sessionPrivateKey,
          wrappedDek: envelope.wrappedDek,
          wrappedPrivateKey: envelope.wrappedPrivateKey,
        });
        await ctx.onUnlock?.({
          userId,
          email: session.email,
          username: session.username,
          wrappedDek: envelope.wrappedDek,
          wrappedPrivateKey: envelope.wrappedPrivateKey,
        });

        oldInput.value = '';
        newInput.value = '';
        confirmInput.value = '';
        statusHost.append(infoBanner(t('settings.passwordChanged')));
      } catch (err) {
        statusHost.append(errorBanner(err instanceof ApiError ? err.message : t('settings.failedToChangePassword')));
      } finally {
        submitBtn.disabled = false;
      }
    });

    return h(
      'section',
      {},
      h('h2', {}, t('settings.changePassword')),
      h('p', {}, t('settings.recoveryKeyUnchanged')),
      h('label', {}, t('settings.currentPassword'), oldInput),
      h('label', {}, t('auth.newPasswordMinHint', { min: MIN_PASSWORD_LENGTH }), newInput),
      h('label', {}, t('auth.confirmNewPassword'), confirmInput),
      submitBtn,
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
    const btn = h('button', { type: 'button', class: 'primary' }, t('settings.exportButton'));
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      clear(statusHost);
      btn.disabled = true;
      try {
        const summaries = (await store.listNotes()).filter(n => n.deletedAt === null);
        const fulls = await Promise.all(summaries.map(summary => store.getNote(summary.id)));
        const parts = fulls.filter((full): full is NonNullable<typeof full> => full !== null).map(full => `# ${full.title}\n\n${full.body}\n`);
        if (parts.length === 0) {
          statusHost.append(infoBanner(t('settings.exportNoNotes')));
          return;
        }
        downloadText('memoza-notes-export.md', parts.join('\n---\n\n'));
      } catch {
        statusHost.append(errorBanner(t('settings.exportFailed')));
      } finally {
        btn.disabled = false;
      }
    });
    return h('section', {}, h('h2', {}, t('settings.export')), btn, statusHost);
  }

  function renderImportSection(): HTMLElement {
    const fileInput = h('input', { type: 'file', accept: '.md', multiple: 'true' }) as HTMLInputElement;
    const statusHost = h('div', {});
    const btn = h('button', { type: 'button', class: 'primary' }, t('settings.importButton'));
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      clear(statusHost);
      const files = fileInput.files;
      if (!files || files.length === 0) return;
      btn.disabled = true;
      try {
        let imported = 0;
        for (const file of Array.from(files)) {
          const text = await file.text();
          const title = file.name.replace(/\.md$/i, '');
          await store.saveNote(null, title, text, []);
          imported++;
        }
        statusHost.append(infoBanner(t('settings.importedCount', { count: imported })));
        fileInput.value = '';
      } finally {
        btn.disabled = false;
      }
    });
    return h(
      'section',
      {},
      h('h2', {}, t('settings.import')),
      h('p', {}, t('settings.importHint')),
      fileInput,
      btn,
      statusHost
    );
  }

  function renderDeleteSection(): HTMLElement {
    const passwordInput = h('input', { type: 'password', placeholder: t('settings.currentPassword') }) as HTMLInputElement;
    const confirmInput = h('input', { type: 'text', placeholder: t('settings.typeDeleteToConfirm') }) as HTMLInputElement;
    const statusHost = h('div', {});
    const btn = h('button', { type: 'button', class: 'danger' }, t('settings.deleteAccount'));
    btn.addEventListener('click', async () => {
      clear(statusHost);
      if (confirmInput.value !== 'DELETE') {
        statusHost.append(errorBanner(t('settings.typeDeleteToConfirm')));
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
        statusHost.append(errorBanner(err instanceof ApiError ? err.message : t('settings.failedToDeleteAccount')));
      }
    });
    return h(
      'section',
      { class: 'danger-zone' },
      h('h2', {}, t('settings.dangerZone')),
      h('p', {}, t('settings.deleteAccountBody')),
      h('label', {}, t('settings.currentPassword'), passwordInput),
      h('label', {}, t('settings.confirmation'), confirmInput),
      btn,
      statusHost
    );
  }
}
