import { invoke } from '@tauri-apps/api/core';
import { deriveMasterKey, deriveWrapKeyBits, deriveAuthHash, importWrapKeyBits } from '@memoza/core/crypto/kdf';
import { unwrapDek, unwrapPrivateKey } from '@memoza/core/crypto/keys';
import { setSession, isUnlocked, getAccessToken, setAccessToken } from '@memoza/core/crypto/session';
import { login } from '@memoza/core/api/auth';
import { setLanguage } from '@memoza/core/i18n/index';
import { fromBase64, toBase64 } from '@memoza/core/crypto/codec';
import type { UnlockProvider, LocalAccountSnapshot } from '@memoza/core/views/app';
import { getDb, wipeLocalStore } from './store/db';

const SERVICE = 'io.memoza.desktop';
const ACCOUNT_WRAP = 'wrapkey';
const ACCOUNT_AUTH = 'authhash';
const KDF_ITERATIONS = 600000;

interface LocalAccountRow {
  user_id: string;
  email: string;
  username: string;
  wrapped_dek: string;
  wrapped_private_key: string;
  locked: number;
}

export async function saveLocalAccount(
  userId: string,
  email: string,
  username: string,
  wrappedDek: string,
  wrappedPrivateKey: string
): Promise<void> {
  const existing = await getLocalAccount();
  if (existing && existing.user_id !== userId) {
    await clearDeviceSecrets();
    await wipeLocalStore();
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO local_account (id, user_id, email, username, wrapped_dek, wrapped_private_key, locked)
     VALUES (1, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (id) DO UPDATE SET
       user_id = excluded.user_id, email = excluded.email, username = excluded.username,
       wrapped_dek = excluded.wrapped_dek, wrapped_private_key = excluded.wrapped_private_key,
       locked = CASE WHEN local_account.user_id = excluded.user_id
                     THEN local_account.locked ELSE 0 END`,
    [userId, email, username, wrappedDek, wrappedPrivateKey]
  );
}

async function getLocalAccount(): Promise<LocalAccountRow | null> {
  const db = await getDb();
  const rows = await db.select<LocalAccountRow[]>('SELECT * FROM local_account WHERE id = 1');
  return rows[0] ?? null;
}

export async function getLocalAccountFor(email: string): Promise<LocalAccountSnapshot | null> {
  const account = await getLocalAccount();
  if (!account || account.email !== email) return null;
  return {
    userId: account.user_id,
    email: account.email,
    username: account.username,
    wrappedDek: account.wrapped_dek,
    wrappedPrivateKey: account.wrapped_private_key,
  };
}

async function clearDeviceSecrets(): Promise<void> {
  await invoke('clear_secret', { service: SERVICE, account: ACCOUNT_WRAP }).catch(() => undefined);
  await invoke('clear_secret', { service: SERVICE, account: ACCOUNT_AUTH }).catch(() => undefined);
}

export async function clearLocalAccount(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM local_account WHERE id = 1');
  await clearDeviceSecrets();
}

export async function sealDeviceUnlock(password: string, email: string): Promise<void> {
  const masterKey = await deriveMasterKey(password, email, KDF_ITERATIONS);
  const wrapBits = await deriveWrapKeyBits(masterKey);
  const authHash = await deriveAuthHash(masterKey, password);
  await invoke('seal_secret', { service: SERVICE, account: ACCOUNT_WRAP, secret: toBase64(wrapBits) });
  await invoke('seal_secret', { service: SERVICE, account: ACCOUNT_AUTH, secret: authHash });

  const db = await getDb();
  await db.execute('UPDATE local_account SET locked = 0 WHERE id = 1');
}

export async function lockDevice(): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE local_account SET locked = 1 WHERE id = 1');
}

export async function ensureOnline(): Promise<void> {
  if (!isUnlocked() || getAccessToken() !== null || !navigator.onLine) return;
  const account = await getLocalAccount();
  if (!account) return;

  let authHash: string;
  try {
    authHash = await invoke<string>('unseal_secret', { service: SERVICE, account: ACCOUNT_AUTH });
  } catch {
    return;
  }
  try {
    const result = await login(account.email, authHash);
    setAccessToken(result.access_token);
    void setLanguage(result.language);
  } catch {
    // stays offline; a later attempt or a password sign-in will restore auth
  }
}

export const biometricUnlockProvider: UnlockProvider = {
  async isAvailable(): Promise<boolean> {
    const account = await getLocalAccount();
    return account !== null && account.locked === 0;
  },

  async unlock(): Promise<void> {
    const account = await getLocalAccount();
    if (!account) throw new Error('No local account cached');

    const wrapBits = await invoke<string>('unseal_secret', { service: SERVICE, account: ACCOUNT_WRAP });
    const wrapKey = await importWrapKeyBits(fromBase64(wrapBits).buffer);

    const dek = await unwrapDek(wrapKey, account.wrapped_dek);
    const privateKey = await unwrapPrivateKey(wrapKey, account.wrapped_private_key);

    setSession({
      userId: account.user_id,
      email: account.email,
      username: account.username,
      dek,
      privateKey,
      wrappedDek: account.wrapped_dek,
      wrappedPrivateKey: account.wrapped_private_key,
    });

    await ensureOnline();
  },
};
