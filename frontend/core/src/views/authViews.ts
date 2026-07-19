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
import { setSession, setAccessToken } from '../crypto/session';
import { decodeAccessToken } from '../crypto/jwt';
import { pemToDer, toBase64, fromUtf8 } from '../crypto/codec';
import { ESCROW_PUBLIC_KEY_PEM, MIN_PASSWORD_LENGTH, KDF_ITERATIONS, EMAIL_STORAGE_KEY } from '../config';

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

async function unlockWithPassword(ctx: AppContext, email: string, password: string): Promise<void> {
  const { authHash, wrapKey } = await deriveCredential(password, email, KDF_ITERATIONS);

  if (!navigator.onLine) {
    if (await unlockOffline(ctx, email, wrapKey)) return;
    throw new Error("You're offline and no cached account was found on this device.");
  }

  let result;
  try {
    result = await authApi.login(email, authHash);
  } catch (err) {
    if (!(err instanceof ApiError) && (await unlockOffline(ctx, email, wrapKey))) return;
    throw err;
  }
  setAccessToken(result.access_token);
  if (ctx.rememberEmail !== false) localStorage.setItem(EMAIL_STORAGE_KEY, email);

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
      h('h1', {}, 'Check your email'),
      h(
        'p',
        {},
        "We've sent an activation link to your email address. Open it to pick your username and finish setting up your account."
      ),
      h(
        'button',
        {
          type: 'button',
          onclick: () => navigate('/login'),
        },
        'Go to login'
      )
    )
  );
}

function renderRecoveryKeyScreen(ctx: AppContext, recoveryKey: string): void {
  const { root } = ctx;
  clear(root);

  const ack = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const continueBtn = h('button', { type: 'button', disabled: 'true' }, 'Continue') as HTMLButtonElement;
  ack.addEventListener('change', () => {
    continueBtn.disabled = !ack.checked;
  });
  continueBtn.addEventListener('click', () => renderCheckEmailScreen(ctx));

  const downloadBtn = h('button', { type: 'button' }, 'Download recovery key');
  downloadBtn.addEventListener('click', () => {
    const blob = new Blob(
      [
        `Memoza recovery key\n\n${recoveryKey}\n\nWithout your password AND this key, your notes cannot be recovered — not even by Memoza. Keep it somewhere safe.`,
      ],
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
      h('h1', {}, 'Save your recovery key'),
      h(
        'p',
        {},
        'This is the only time this key will be shown. Without your password AND this key, your notes cannot be recovered — not even by Memoza.'
      ),
      h('pre', { class: 'recovery-key' }, recoveryKey),
      downloadBtn,
      h('label', { class: 'checkbox-label' }, ack, ' I have saved this recovery key somewhere safe.'),
      continueBtn
    )
  );
}

export function renderRegister(ctx: AppContext): void {
  const { root, navigate } = ctx;
  clear(root);

  const emailInput = h('input', { type: 'email', required: 'true', autocomplete: 'email' }) as HTMLInputElement;
  const nameInput = h('input', { type: 'text', required: 'true', autocomplete: 'name' }) as HTMLInputElement;
  const passwordInput = h('input', {
    type: 'password',
    required: 'true',
    autocomplete: 'new-password',
    minlength: String(MIN_PASSWORD_LENGTH),
  }) as HTMLInputElement;
  const confirmInput = h('input', { type: 'password', required: 'true', autocomplete: 'new-password' }) as HTMLInputElement;

  const convenientAllowed = ESCROW_PUBLIC_KEY_PEM.length > 0;
  const modeSelect = h(
    'select',
    {},
    h('option', { value: 'private' }, 'Private — zero-knowledge (recommended)'),
    ...(convenientAllowed ? [h('option', { value: 'convenient' }, 'Convenient — email-only reset, weaker')] : [])
  ) as HTMLSelectElement;

  const errorHost = h('div', {});
  const submitBtn = h('button', { type: 'submit' }, 'Create account') as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    h('label', {}, 'Email', emailInput),
    h('label', {}, 'Name', nameInput),
    h('label', {}, `Password (min ${MIN_PASSWORD_LENGTH} characters)`, passwordInput),
    h('label', {}, 'Confirm password', confirmInput),
    h('label', {}, 'Recovery mode', modeSelect),
    errorHost,
    submitBtn
  );

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, 'Create your Memoza account'),
      form,
      h(
        'p',
        {},
        'Already have an account? ',
        h(
          'a',
          {
            href: '#/login',
            onclick: (e: Event) => {
              e.preventDefault();
              navigate('/login');
            },
          },
          'Log in'
        )
      )
    )
  );

  async function submit(): Promise<void> {
    clear(errorHost);
    const email = emailInput.value.trim();
    const name = nameInput.value.trim();
    const password = passwordInput.value;
    const mode = modeSelect.value as 'private' | 'convenient';

    if (password.length < MIN_PASSWORD_LENGTH) {
      errorHost.append(errorBanner(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`));
      return;
    }
    if (password !== confirmInput.value) {
      errorHost.append(errorBanner('Passwords do not match'));
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
        name,
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
      errorHost.append(errorBanner(err instanceof ApiError ? err.message : 'Registration failed'));
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
  const submitBtn = h('button', { type: 'submit' }, 'Log in') as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    h('label', {}, 'Email', emailInput),
    h('label', {}, 'Password', passwordInput),
    errorHost,
    submitBtn
  );

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, 'Log in to Memoza'),
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
          'Forgot password?'
        )
      ),
      h(
        'p',
        {},
        "Don't have an account? ",
        h(
          'a',
          {
            href: '#/register',
            onclick: (e: Event) => {
              e.preventDefault();
              navigate('/register');
            },
          },
          'Register'
        )
      )
    )
  );

  async function submit(): Promise<void> {
    clear(errorHost);
    submitBtn.disabled = true;
    try {
      await unlockWithPassword(ctx, emailInput.value.trim(), passwordInput.value);
    } catch (err) {
      submitBtn.disabled = false;
      if (err instanceof ApiError && err.status === 403) {
        errorHost.append(errorBanner('Check your email to activate your account before logging in.'));
      } else {
        errorHost.append(errorBanner(err instanceof ApiError ? err.message : 'Login failed'));
      }
    }
  }
}

export async function renderLock(ctx: AppContext, email: string): Promise<void> {
  const { root, navigate, unlockProvider } = ctx;
  clear(root);

  const passwordInput = h('input', {
    type: 'password',
    required: 'true',
    autocomplete: 'current-password',
  }) as HTMLInputElement;
  const errorHost = h('div', {});
  const submitBtn = h('button', { type: 'submit' }, 'Unlock') as HTMLButtonElement;
  const logoutLink = h('a', { href: '#' }, 'Log out');
  logoutLink.addEventListener('click', e => {
    e.preventDefault();
    localStorage.removeItem(EMAIL_STORAGE_KEY);
    navigate('/login');
  });

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    h('p', {}, email),
    h('label', {}, 'Password', passwordInput),
    errorHost,
    submitBtn
  );

  const biometricHost = h('div', {});
  if (unlockProvider && (await unlockProvider.isAvailable())) {
    const biometricBtn = h('button', { type: 'button' }, 'Unlock with biometrics');
    biometricBtn.addEventListener('click', async () => {
      clear(errorHost);
      try {
        await unlockProvider.unlock();
        navigate('/');
      } catch (err) {
        errorHost.append(errorBanner(err instanceof Error ? err.message : 'Biometric unlock failed'));
      }
    });
    biometricHost.append(biometricBtn);
  }

  root.append(h('div', { class: 'auth-view' }, brand(), h('h1', {}, 'Unlock Memoza'), biometricHost, form, logoutLink));

  async function submit(): Promise<void> {
    clear(errorHost);
    submitBtn.disabled = true;
    try {
      await unlockWithPassword(ctx, email, passwordInput.value);
    } catch (err) {
      submitBtn.disabled = false;
      errorHost.append(errorBanner(err instanceof ApiError ? err.message : 'Unlock failed'));
    }
  }
}

export function renderResetRequest(ctx: AppContext): void {
  const { root, navigate } = ctx;
  clear(root);

  const emailInput = h('input', { type: 'email', required: 'true' }) as HTMLInputElement;
  const statusHost = h('div', {});
  const submitBtn = h('button', { type: 'submit' }, 'Send reset link') as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    h('label', {}, 'Email', emailInput),
    statusHost,
    submitBtn
  );

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, 'Reset your password'),
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
          'Back to login'
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
          h('h1', {}, 'Check your email'),
          h('p', {}, 'If an account exists for that address, a reset link is on its way.')
        )
      );
    } catch {
      submitBtn.disabled = false;
      statusHost.append(errorBanner('Something went wrong. Try again.'));
    }
  }
}

export async function renderResetConfirm(ctx: AppContext, params: URLSearchParams): Promise<void> {
  const { root } = ctx;
  clear(root);

  const token = params.get('token') ?? '';
  const email = params.get('email') ?? '';

  if (!token || !email) {
    root.append(h('div', { class: 'auth-view' }, errorBanner('Invalid reset link')));
    return;
  }

  root.append(h('div', { class: 'auth-view' }, h('p', {}, 'Checking your reset link…')));

  let probe: ResetProbeResponse;
  try {
    probe = await authApi.probeReset(token, email);
  } catch (err) {
    clear(root);
    root.append(
      h('div', { class: 'auth-view' }, errorBanner(err instanceof ApiError ? err.message : 'Invalid or expired link'))
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
  const submitBtn = h('button', { type: 'submit' }, 'Set new password') as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    probe.recovery_mode === 'private'
      ? h('label', {}, 'Your recovery key', recoveryKeyInput)
      : h('p', {}, 'Recovery key retrieved automatically.'),
    h('label', {}, `New password (min ${MIN_PASSWORD_LENGTH} characters)`, passwordInput),
    h('label', {}, 'Confirm new password', confirmInput),
    errorHost,
    submitBtn
  );

  root.append(h('div', { class: 'auth-view' }, brand(), h('h1', {}, 'Choose a new password'), form));

  async function submit(): Promise<void> {
    clear(errorHost);
    const password = passwordInput.value;
    if (password.length < MIN_PASSWORD_LENGTH) {
      errorHost.append(errorBanner(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`));
      return;
    }
    if (password !== confirmInput.value) {
      errorHost.append(errorBanner('Passwords do not match'));
      return;
    }
    const recoveryKey = recoveryKeyInput.value.trim();
    if (!recoveryKey) {
      errorHost.append(errorBanner('Recovery key is required'));
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
          h('h1', {}, 'Password reset'),
          h('p', {}, 'Your password has been reset. Log in with your new password.'),
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                ctx.navigate('/login');
              },
            },
            'Go to login'
          )
        )
      );
    } catch (err) {
      submitBtn.disabled = false;
      errorHost.append(errorBanner(err instanceof ApiError ? err.message : 'Reset failed'));
    }
  }
}

export async function renderActivate(ctx: AppContext, params: URLSearchParams): Promise<void> {
  const { root, navigate } = ctx;
  clear(root);

  const token = params.get('token') ?? '';
  if (!token) {
    root.append(h('div', { class: 'auth-view' }, brand(), errorBanner('Invalid or expired activation link')));
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
  const submitBtn = h('button', { type: 'submit' }, 'Activate account') as HTMLButtonElement;

  let debounceTimer: number | undefined;

  function setAvailability(node: HTMLElement | string | null): void {
    clear(availabilityHost);
    if (node) availabilityHost.append(typeof node === 'string' ? h('p', {}, node) : node);
  }

  usernameInput.addEventListener('input', () => {
    const value = usernameInput.value.trim().toLowerCase();
    if (debounceTimer) window.clearTimeout(debounceTimer);
    if (!USERNAME_RE.test(value)) {
      setAvailability(value ? '3–32 characters: a–z, 0–9, hyphen (no leading/trailing hyphen)' : null);
      return;
    }
    setAvailability('Checking…');
    debounceTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await authApi.checkUsernameAvailable(token, value);
          if (usernameInput.value.trim().toLowerCase() !== value) return;
          setAvailability(res.available ? infoBanner('Available') : errorBanner('Not available'));
        } catch {
          setAvailability('Could not check availability');
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
    h('label', {}, 'Choose a username', usernameInput),
    availabilityHost,
    errorHost,
    submitBtn
  );

  root.append(
    h(
      'div',
      { class: 'auth-view' },
      brand(),
      h('h1', {}, 'Activate your account'),
      h('p', {}, 'This is your permanent public handle for page links. It cannot be changed later.'),
      form
    )
  );

  async function submit(): Promise<void> {
    clear(errorHost);
    const username = usernameInput.value.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      errorHost.append(errorBanner('Enter a valid username'));
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
          h('h1', {}, 'Account activated'),
          h('p', {}, 'You can now log in.'),
          h('button', { type: 'button', onclick: () => navigate('/login') }, 'Go to login')
        )
      );
    } catch (err) {
      submitBtn.disabled = false;
      if (err instanceof ApiError && err.status === 409) {
        errorHost.append(errorBanner('That username is not available. Try another.'));
      } else {
        errorHost.append(errorBanner(err instanceof ApiError ? err.message : 'Activation failed. Re-register to get a fresh link.'));
      }
    }
  }
}
