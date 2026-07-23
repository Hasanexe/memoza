import { h, clear, errorBanner, infoBanner, brand } from './dom';
import type { AppContext } from './app';
import * as authApi from '../api/auth';
import type { ResetProbeResponse } from '../api/auth';
import { ApiError } from '../api/client';
import {
  generateDek,
  generateKeypair,
  generateRecoveryKey,
  exportPublicKey,
  wrapDek,
  unwrapDek,
  wrapPrivateKey,
  unwrapPrivateKey,
  unwrapDekExtractable,
  unwrapPrivateKeyExtractable,
  deriveRecoveryDekWrapKey,
  deriveRecoveryPrivateKeyWrapKey,
  deriveCredential,
  buildPasswordEnvelope,
} from '../crypto/keys';
import { setSession, setAccessToken, logout as clearSession } from '../crypto/session';
import { decodeAccessToken } from '../crypto/jwt';
import { pemToDer, toBase64, fromUtf8 } from '../crypto/codec';
import { ESCROW_PUBLIC_KEY_PEM, MIN_PASSWORD_LENGTH, KDF_ITERATIONS, EMAIL_STORAGE_KEY } from '../config';
import { connectionStatus } from '../connection';
import { confirmDialog } from './shareView';
import { t, getLanguage, setLanguage, LANGUAGES } from '../i18n';

export async function lockSession(ctx: AppContext): Promise<void> {
  await ctx.onLock?.();
  clearSession();
  ctx.navigate('/');
}

export async function performLogout(ctx: AppContext): Promise<void> {
  const pendingCount = ctx.store.pendingWriteCount
    ? await ctx.store.pendingWriteCount().catch(() => 0)
    : connectionStatus().pendingCount;

  function doLogout(): void {
    void (async () => {
      await authApi.logout().catch(() => undefined);
      await ctx.onLogout?.();
      clearSession();
      localStorage.removeItem(EMAIL_STORAGE_KEY);
      ctx.navigate('/login');
    })();
  }

  const localWarning = ctx.platform === 'native' ? t('auth.logoutLocalWarningSuffix') : '';

  if (pendingCount > 0) {
    confirmDialog(
      t('auth.logoutConfirmTitle'),
      t(pendingCount === 1 ? 'auth.logoutWarningOne' : 'auth.logoutWarningMany', { count: pendingCount, localWarning }),
      t('auth.logoutAnyway'),
      doLogout
    );
  } else if (ctx.platform === 'native') {
    confirmDialog(t('auth.logoutConfirmTitle'), t('auth.logoutNativeWarningBody'), t('auth.logOut'), doLogout);
  } else {
    doLogout();
  }
}

const USERNAME_RE = /^(?!-)[a-z0-9-]{3,32}(?<!-)$/;

async function encryptRecoveryKeyForEscrow(recoveryKey: string): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    'spki',
    pemToDer(ESCROW_PUBLIC_KEY_PEM),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const ciphertext = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, fromUtf8(recoveryKey));
  return toBase64(ciphertext);
}

async function unlockOffline(ctx: AppContext, email: string, wrapKey: CryptoKey): Promise<boolean> {
  if (!ctx.localAccount) return false;
  const cached = await ctx.localAccount(email);
  if (!cached) return false;

  const dek = await unwrapDek(wrapKey, cached.wrappedDek);
  const privateKey = await unwrapPrivateKey(wrapKey, cached.wrappedPrivateKey);
  setSession({
    userId: cached.userId,
    email,
    username: cached.username,
    dek,
    privateKey,
    wrappedDek: cached.wrappedDek,
    wrappedPrivateKey: cached.wrappedPrivateKey,
  });
  if (ctx.rememberEmail !== false) localStorage.setItem(EMAIL_STORAGE_KEY, email);
  ctx.navigate('/');
  return true;
}

async function sealDeviceUnlock(ctx: AppContext, password: string): Promise<void> {
  if (!ctx.sealDeviceUnlock) return;
  try {
    await ctx.sealDeviceUnlock(password);
  } catch (err) {
    console.error('Could not store this device unlock key; Memoza will keep asking for the password.', err);
  }
}

async function unlockWithPassword(ctx: AppContext, email: string, password: string): Promise<void> {
  const { authHash, wrapKey } = await deriveCredential(password, email, KDF_ITERATIONS);

  if (!navigator.onLine) {
    if (await unlockOffline(ctx, email, wrapKey)) {
      await sealDeviceUnlock(ctx, password);
      return;
    }
    throw new Error(t('auth.offlineNoCachedAccount'));
  }

  let result;
  try {
    result = await authApi.login(email, authHash);
  } catch (err) {
    if (!(err instanceof ApiError) && (await unlockOffline(ctx, email, wrapKey))) {
      await sealDeviceUnlock(ctx, password);
      return;
    }
    throw err;
  }
  setAccessToken(result.access_token);
  if (ctx.rememberEmail !== false) localStorage.setItem(EMAIL_STORAGE_KEY, email);
  void setLanguage(result.language);

  const dek = await unwrapDek(wrapKey, result.wrapped_dek);
  const privateKey = await unwrapPrivateKey(wrapKey, result.wrapped_private_key);
  const { userId } = decodeAccessToken(result.access_token);
  setSession({
    userId,
    email,
    username: result.username,
    dek,
    privateKey,
    wrappedDek: result.wrapped_dek,
    wrappedPrivateKey: result.wrapped_private_key,
  });
  await ctx.onUnlock?.({
    userId,
    email,
    username: result.username,
    wrappedDek: result.wrapped_dek,
    wrappedPrivateKey: result.wrapped_private_key,
  });
  await sealDeviceUnlock(ctx, password);

  ctx.navigate('/');
}

function renderCheckEmailScreen(ctx: AppContext): void {
  const { root, navigate } = ctx;
  clear(root);
  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, t('auth.checkEmailTitle')),
      h('p', {}, t('auth.checkEmailBody')),
      h(
        'button',
        {
          type: 'button',
          onclick: () => navigate('/login'),
        },
        t('auth.goToLogin')
      )
    )
  );
}

function renderRecoveryKeyScreen(ctx: AppContext, recoveryKey: string): void {
  const { root } = ctx;
  clear(root);

  const ack = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const continueBtn = h('button', { type: 'button', disabled: 'true' }, t('auth.continue')) as HTMLButtonElement;
  ack.addEventListener('change', () => {
    continueBtn.disabled = !ack.checked;
  });
  continueBtn.addEventListener('click', () => renderCheckEmailScreen(ctx));

  const downloadBtn = h('button', { type: 'button' }, t('auth.downloadRecoveryKey'));
  downloadBtn.addEventListener('click', () => {
    const blob = new Blob(
      [`${t('auth.recoveryKeyFileHeader')}\n\n${recoveryKey}\n\n${t('auth.recoveryKeyFileBody')}`],
      { type: 'text/plain' }
    );
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'memoza-recovery-key.txt' });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, t('auth.saveRecoveryKeyTitle')),
      h('p', {}, t('auth.saveRecoveryKeyBody')),
      h('pre', { class: 'recovery-key' }, recoveryKey),
      downloadBtn,
      h('label', { class: 'checkbox-label' }, ack, ' ', t('auth.recoveryKeyAck')),
      continueBtn
    )
  );
}

export function renderRegister(ctx: AppContext): void {
  const { root, navigate } = ctx;
  clear(root);

  const emailInput = h('input', { type: 'email', required: 'true', autocomplete: 'email' }) as HTMLInputElement;
  const passwordInput = h('input', {
    type: 'password',
    required: 'true',
    autocomplete: 'new-password',
    minlength: String(MIN_PASSWORD_LENGTH),
  }) as HTMLInputElement;
  const confirmInput = h('input', { type: 'password', required: 'true', autocomplete: 'new-password' }) as HTMLInputElement;

  const languageSelect = h(
    'select',
    {},
    ...LANGUAGES.map(l => h('option', { value: l.code }, l.nativeName))
  ) as HTMLSelectElement;
  languageSelect.value = getLanguage();
  languageSelect.addEventListener('change', () => {
    void setLanguage(languageSelect.value);
  });

  const convenientAllowed = ESCROW_PUBLIC_KEY_PEM.length > 0;
  const modeSelect = h(
    'select',
    {},
    h('option', { value: 'private' }, t('auth.recoveryModePrivate')),
    ...(convenientAllowed ? [h('option', { value: 'convenient' }, t('auth.recoveryModeConvenient'))] : [])
  ) as HTMLSelectElement;

  const errorHost = h('div', {});
  const submitBtn = h('button', { type: 'submit' }, t('auth.createAccount')) as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    h('label', {}, t('auth.email'), emailInput),
    h('label', {}, t('auth.language'), languageSelect),
    h('label', {}, t('auth.passwordMinHint', { min: MIN_PASSWORD_LENGTH }), passwordInput),
    h('label', {}, t('auth.confirmPassword'), confirmInput),
    h('label', {}, t('auth.recoveryMode'), modeSelect),
    errorHost,
    submitBtn
  );

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, t('auth.createAccountTitle')),
      form,
      h(
        'p',
        {},
        t('auth.alreadyHaveAccount'),
        h(
          'a',
          {
            href: '#/login',
            onclick: (e: Event) => {
              e.preventDefault();
              navigate('/login');
            },
          },
          t('auth.logIn')
        )
      )
    )
  );

  async function submit(): Promise<void> {
    clear(errorHost);
    const email = emailInput.value.trim();
    const language = languageSelect.value;
    const password = passwordInput.value;
    const mode = modeSelect.value as 'private' | 'convenient';

    if (password.length < MIN_PASSWORD_LENGTH) {
      errorHost.append(errorBanner(t('auth.passwordTooShort', { min: MIN_PASSWORD_LENGTH })));
      return;
    }
    if (password !== confirmInput.value) {
      errorHost.append(errorBanner(t('auth.passwordMismatch')));
      return;
    }

    submitBtn.disabled = true;
    try {
      const dek = await generateDek();
      const keypair = await generateKeypair();
      const recoveryKey = generateRecoveryKey();

      const publicKeyB64 = await exportPublicKey(keypair.publicKey);
      const envelope = await buildPasswordEnvelope(password, email, KDF_ITERATIONS, dek, keypair.privateKey);

      const recoveryDekWrapKey = await deriveRecoveryDekWrapKey(recoveryKey);
      const recoveryPkWrapKey = await deriveRecoveryPrivateKeyWrapKey(recoveryKey);
      const wrappedDekRecovery = await wrapDek(recoveryDekWrapKey, dek);
      const wrappedPrivateKeyRecovery = await wrapPrivateKey(recoveryPkWrapKey, keypair.privateKey);

      const escrowedRecovery = mode === 'convenient' ? await encryptRecoveryKeyForEscrow(recoveryKey) : undefined;

      await authApi.register({
        email,
        language,
        password: envelope.authHash,
        kdf_iterations: KDF_ITERATIONS,
        public_key: publicKeyB64,
        wrapped_dek: envelope.wrappedDek,
        wrapped_private_key: envelope.wrappedPrivateKey,
        wrapped_dek_recovery: wrappedDekRecovery,
        wrapped_private_key_recovery: wrappedPrivateKeyRecovery,
        recovery_mode: mode,
        escrowed_recovery: escrowedRecovery,
      });

      renderRecoveryKeyScreen(ctx, recoveryKey);
    } catch (err) {
      submitBtn.disabled = false;
      errorHost.append(errorBanner(err instanceof ApiError ? err.message : t('auth.registrationFailed')));
    }
  }
}

export function renderLogin(ctx: AppContext): void {
  const { root, navigate } = ctx;
  clear(root);

  const emailInput = h('input', { type: 'email', required: 'true', autocomplete: 'email' }) as HTMLInputElement;
  const passwordInput = h('input', {
    type: 'password',
    required: 'true',
    autocomplete: 'current-password',
  }) as HTMLInputElement;
  const errorHost = h('div', {});
  const submitBtn = h('button', { type: 'submit' }, t('auth.logIn')) as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    h('label', {}, t('auth.email'), emailInput),
    h('label', {}, t('auth.password'), passwordInput),
    errorHost,
    submitBtn
  );
  form.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !submitBtn.disabled) {
      e.preventDefault();
      void submit();
    }
  });

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, t('auth.logInTitle')),
      form,
      h(
        'p',
        {},
        h(
          'a',
          {
            href: '#/reset',
            onclick: (e: Event) => {
              e.preventDefault();
              navigate('/reset');
            },
          },
          t('auth.forgotPassword')
        )
      ),
      h(
        'p',
        {},
        t('auth.noAccount'),
        h(
          'a',
          {
            href: '#/register',
            onclick: (e: Event) => {
              e.preventDefault();
              navigate('/register');
            },
          },
          t('auth.register')
        )
      )
    )
  );

  async function submit(): Promise<void> {
    if (submitBtn.disabled) return;
    clear(errorHost);
    submitBtn.disabled = true;
    try {
      await unlockWithPassword(ctx, emailInput.value.trim(), passwordInput.value);
    } catch (err) {
      submitBtn.disabled = false;
      if (err instanceof ApiError && err.status === 403) {
        errorHost.append(errorBanner(t('auth.notActivatedMessage')));
      } else {
        errorHost.append(errorBanner(err instanceof ApiError ? err.message : t('auth.loginFailed')));
      }
    }
  }
}

export async function renderLock(ctx: AppContext, email: string): Promise<void> {
  const { root, navigate, unlockProvider } = ctx;

  const errorHost = h('div', {});

  function renderPasswordForm(): void {
    clear(root);
    const passwordInput = h('input', {
      type: 'password',
      required: 'true',
      autocomplete: 'current-password',
    }) as HTMLInputElement;
    const submitBtn = h('button', { type: 'submit' }, t('auth.unlock')) as HTMLButtonElement;
    const logoutBtn = h('button', { type: 'button', class: 'secondary' }, t('auth.logOut'));
    logoutBtn.addEventListener('click', () => void performLogout(ctx));

    const form = h(
      'form',
      {
        onsubmit: (e: Event) => {
          e.preventDefault();
          void submit();
        },
      },
      h('p', {}, email),
      h('label', {}, t('auth.password'), passwordInput),
      errorHost,
      submitBtn
    );

    root.append(
      h(
        'div',
        { class: 'auth-view' },
        brand(),
        h('h1', {}, t('auth.unlockTitle')),
        form,
        h('div', { class: 'auth-alt-action' }, logoutBtn)
      )
    );

    async function submit(): Promise<void> {
      clear(errorHost);
      submitBtn.disabled = true;
      try {
        await unlockWithPassword(ctx, email, passwordInput.value);
      } catch (err) {
        submitBtn.disabled = false;
        errorHost.append(errorBanner(err instanceof ApiError ? err.message : t('auth.unlockFailed')));
      }
    }
  }

  if (unlockProvider && (await unlockProvider.isAvailable())) {
    clear(root);
    root.append(h('div', { class: 'auth-view' }, brand(), h('h1', {}, t('auth.unlocking')), h('p', {}, email)));
    try {
      await unlockProvider.unlock();
      navigate('/');
      return;
    } catch (err) {
      console.warn('Automatic unlock failed; falling back to password.', err);
    }
  }

  renderPasswordForm();
}

export function renderResetRequest(ctx: AppContext): void {
  const { root, navigate } = ctx;
  clear(root);

  const emailInput = h('input', { type: 'email', required: 'true' }) as HTMLInputElement;
  const statusHost = h('div', {});
  const submitBtn = h('button', { type: 'submit' }, t('auth.sendResetLink')) as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    h('label', {}, t('auth.email'), emailInput),
    statusHost,
    submitBtn
  );

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, t('auth.resetPasswordTitle')),
      form,
      h(
        'p',
        {},
        h(
          'a',
          {
            href: '#/login',
            onclick: (e: Event) => {
              e.preventDefault();
              navigate('/login');
            },
          },
          t('auth.backToLogin')
        )
      )
    )
  );

  async function submit(): Promise<void> {
    clear(statusHost);
    submitBtn.disabled = true;
    try {
      await authApi.requestReset(emailInput.value.trim());
      clear(root);
      root.append(
        h(
          'div',
          { class: 'auth-view' },
          brand(),
          h('h1', {}, t('auth.checkEmailTitle')),
          h('p', {}, t('auth.resetLinkSentBody'))
        )
      );
    } catch {
      submitBtn.disabled = false;
      statusHost.append(errorBanner(t('auth.resetSomethingWrong')));
    }
  }
}

export async function renderResetConfirm(ctx: AppContext, params: URLSearchParams): Promise<void> {
  const { root } = ctx;
  clear(root);

  const token = params.get('token') ?? '';
  const email = params.get('email') ?? '';

  if (!token || !email) {
    root.append(h('div', { class: 'auth-view' }, errorBanner(t('auth.invalidResetLink'))));
    return;
  }

  root.append(h('div', { class: 'auth-view' }, h('p', {}, t('auth.checkingResetLink'))));

  let probe: ResetProbeResponse;
  try {
    probe = await authApi.probeReset(token, email);
  } catch (err) {
    clear(root);
    root.append(
      h('div', { class: 'auth-view' }, errorBanner(err instanceof ApiError ? err.message : t('auth.invalidOrExpiredLink')))
    );
    return;
  }

  clear(root);

  const recoveryKeyInput = h('input', {
    type: 'text',
    placeholder: 'xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx',
  }) as HTMLInputElement;
  if (probe.recovery_mode === 'convenient' && probe.recovery_key) {
    recoveryKeyInput.value = probe.recovery_key;
    recoveryKeyInput.setAttribute('readonly', 'true');
  }

  const passwordInput = h('input', {
    type: 'password',
    required: 'true',
    minlength: String(MIN_PASSWORD_LENGTH),
  }) as HTMLInputElement;
  const confirmInput = h('input', { type: 'password', required: 'true' }) as HTMLInputElement;
  const errorHost = h('div', {});
  const submitBtn = h('button', { type: 'submit' }, t('auth.setNewPassword')) as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    probe.recovery_mode === 'private'
      ? h('label', {}, t('auth.yourRecoveryKey'), recoveryKeyInput)
      : h('p', {}, t('auth.recoveryKeyAutoRetrieved')),
    h('label', {}, t('auth.newPasswordMinHint', { min: MIN_PASSWORD_LENGTH }), passwordInput),
    h('label', {}, t('auth.confirmNewPassword'), confirmInput),
    errorHost,
    submitBtn
  );

  root.append(h('div', { class: 'auth-view' }, brand(), h('h1', {}, t('auth.chooseNewPasswordTitle')), form));

  async function submit(): Promise<void> {
    clear(errorHost);
    const password = passwordInput.value;
    if (password.length < MIN_PASSWORD_LENGTH) {
      errorHost.append(errorBanner(t('auth.passwordTooShort', { min: MIN_PASSWORD_LENGTH })));
      return;
    }
    if (password !== confirmInput.value) {
      errorHost.append(errorBanner(t('auth.passwordMismatch')));
      return;
    }
    const recoveryKey = recoveryKeyInput.value.trim();
    if (!recoveryKey) {
      errorHost.append(errorBanner(t('auth.recoveryKeyRequired')));
      return;
    }

    submitBtn.disabled = true;
    try {
      const recoveryDekWrapKey = await deriveRecoveryDekWrapKey(recoveryKey);
      const recoveryPkWrapKey = await deriveRecoveryPrivateKeyWrapKey(recoveryKey);
      const dek = await unwrapDekExtractable(recoveryDekWrapKey, probe.wrapped_dek_recovery);
      const privateKey = await unwrapPrivateKeyExtractable(recoveryPkWrapKey, probe.wrapped_private_key_recovery);

      const envelope = await buildPasswordEnvelope(password, email, KDF_ITERATIONS, dek, privateKey);
      const newWrappedDekRecovery = await wrapDek(recoveryDekWrapKey, dek);
      const newWrappedPrivateKeyRecovery = await wrapPrivateKey(recoveryPkWrapKey, privateKey);

      const escrowedRecovery =
        probe.recovery_mode === 'convenient' ? await encryptRecoveryKeyForEscrow(recoveryKey) : undefined;

      await authApi.confirmReset({
        token,
        email,
        new_password: envelope.authHash,
        wrapped_dek: envelope.wrappedDek,
        wrapped_private_key: envelope.wrappedPrivateKey,
        wrapped_dek_recovery: newWrappedDekRecovery,
        wrapped_private_key_recovery: newWrappedPrivateKeyRecovery,
        escrowed_recovery: escrowedRecovery,
      });

      clear(root);
      root.append(
        h(
          'div',
          { class: 'auth-view' },
          brand(),
          h('h1', {}, t('auth.passwordResetTitle')),
          h('p', {}, t('auth.passwordResetBody')),
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                ctx.navigate('/login');
              },
            },
            t('auth.goToLogin')
          )
        )
      );
    } catch (err) {
      submitBtn.disabled = false;
      errorHost.append(errorBanner(err instanceof ApiError ? err.message : t('auth.resetFailed')));
    }
  }
}

export async function renderActivate(ctx: AppContext, params: URLSearchParams): Promise<void> {
  const { root, navigate } = ctx;
  clear(root);

  const token = params.get('token') ?? '';
  if (!token) {
    root.append(h('div', { class: 'auth-view' }, brand(), errorBanner(t('auth.invalidActivationLink'))));
    return;
  }

  const usernameInput = h('input', {
    type: 'text',
    required: 'true',
    autocomplete: 'off',
    placeholder: 'yourname',
  }) as HTMLInputElement;
  const availabilityHost = h('div', {});
  const errorHost = h('div', {});
  const submitBtn = h('button', { type: 'submit' }, t('auth.activateAccount')) as HTMLButtonElement;

  let debounceTimer: number | undefined;

  function setAvailability(node: HTMLElement | string | null): void {
    clear(availabilityHost);
    if (node) availabilityHost.append(typeof node === 'string' ? h('p', {}, node) : node);
  }

  usernameInput.addEventListener('input', () => {
    const value = usernameInput.value.trim().toLowerCase();
    if (debounceTimer) window.clearTimeout(debounceTimer);
    if (!USERNAME_RE.test(value)) {
      setAvailability(value ? t('auth.usernameFormatHint') : null);
      return;
    }
    setAvailability(t('auth.checkingAvailability'));
    debounceTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await authApi.checkUsernameAvailable(token, value);
          if (usernameInput.value.trim().toLowerCase() !== value) return;
          setAvailability(res.available ? infoBanner(t('auth.available')) : errorBanner(t('auth.notAvailable')));
        } catch {
          setAvailability(t('auth.couldNotCheckAvailability'));
        }
      })();
    }, 400);
  });

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    h('label', {}, t('auth.chooseUsername'), usernameInput),
    availabilityHost,
    errorHost,
    submitBtn
  );

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, t('auth.activateAccountTitle')),
      h('p', {}, t('auth.activateAccountBody')),
      form
    )
  );

  async function submit(): Promise<void> {
    clear(errorHost);
    const username = usernameInput.value.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      errorHost.append(errorBanner(t('auth.enterValidUsername')));
      return;
    }
    submitBtn.disabled = true;
    try {
      await authApi.activate(token, username);
      clear(root);
      root.append(
        h(
          'div',
          { class: 'auth-view' },
          brand(),
          h('h1', {}, t('auth.accountActivatedTitle')),
          h('p', {}, t('auth.accountActivatedBody')),
          h('button', { type: 'button', onclick: () => navigate('/login') }, t('auth.goToLogin'))
        )
      );
    } catch (err) {
      submitBtn.disabled = false;
      if (err instanceof ApiError && err.status === 409) {
        errorHost.append(errorBanner(t('auth.usernameNotAvailable')));
      } else {
        errorHost.append(errorBanner(err instanceof ApiError ? err.message : t('auth.activationFailed')));
      }
    }
  }
}
