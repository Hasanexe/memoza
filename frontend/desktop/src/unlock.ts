import { invoke } from '@tauri-apps/api/core';
import { deriveMasterKey, deriveWrapKeyBits, importWrapKeyBits } from '@memoza/core/crypto/kdf';
import { unwrapDek, unwrapPrivateKey } from '@memoza/core/crypto/keys';
import { setSession } from '@memoza/core/crypto/session';
import { fromBase64, toBase64 } from '@memoza/core/crypto/codec';
import type { UnlockProvider } from '@memoza/core/views/app';
import { getDb } from './store/db';

const SERVICE = 'io.memoza.desktop';
const ACCOUNT = 'wrapkey';
const KDF_ITERATIONS = 600000;

interface LocalAccountRow {
  user_id: string;
  email: string;
  username: string;
  wrapped_dek: string;
  wrapped_private_key: string;
  biometric_enabled: number;
}

export async function saveLocalAccount(
  userId: string,
  email: string,
  username: string,
  wrappedDek: string,
  wrappedPrivateKey: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO local_account (id, user_id, email, username, wrapped_dek, wrapped_private_key, biometric_enabled)
     VALUES (1, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (id) DO UPDATE SET
       user_id = excluded.user_id, email = excluded.email, username = excluded.username,
       wrapped_dek = excluded.wrapped_dek, wrapped_private_key = excluded.wrapped_private_key`,
    [userId, email, username, wrappedDek, wrappedPrivateKey]
  );
}

async function getLocalAccount(): Promise<LocalAccountRow | null> {
  const db = await getDb();
  const rows = await db.select<LocalAccountRow[]>('SELECT * FROM local_account WHERE id = 1');
  return rows[0] ?? null;
}

export async function clearLocalAccount(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM local_account WHERE id = 1');
  await invoke('clear_secret', { service: SERVICE, account: ACCOUNT }).catch(() => undefined);
}

export async function enableBiometricUnlock(password: string, email: string): Promise<void> {
  const masterKey = await deriveMasterKey(password, email, KDF_ITERATIONS);
  const bits = await deriveWrapKeyBits(masterKey);
  await invoke('seal_secret', { service: SERVICE, account: ACCOUNT, secret: toBase64(bits) });

  const db = await getDb();
  await db.execute('UPDATE local_account SET biometric_enabled = 1 WHERE id = 1');
}

export async function isBiometricEnabled(): Promise<boolean> {
  const account = await getLocalAccount();
  return account !== null && account.biometric_enabled === 1;
}

export async function disableBiometricUnlock(): Promise<void> {
  await invoke('clear_secret', { service: SERVICE, account: ACCOUNT }).catch(() => undefined);
  const db = await getDb();
  await db.execute('UPDATE local_account SET biometric_enabled = 0 WHERE id = 1');
}

export const biometricUnlockProvider: UnlockProvider = {
  async isAvailable(): Promise<boolean> {
    const account = await getLocalAccount();
    return account !== null && account.biometric_enabled === 1;
  },

  async unlock(): Promise<void> {
    const account = await getLocalAccount();
    if (!account) throw new Error('No local account cached');

    const secretB64 = await invoke<string>('unseal_secret', { service: SERVICE, account: ACCOUNT });
    const wrapKey = await importWrapKeyBits(fromBase64(secretB64).buffer);

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
  },
};
