import { toBase64, toGroupedHex, fromGroupedHex, wrapKeyWithIv, unwrapKeyWithIv } from './codec';
import { deriveAesKeyFromSecret, deriveMasterKey, deriveAuthHash, deriveWrapKey } from './kdf';

export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['wrapKey', 'unwrapKey']);
}

export async function generateKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['wrapKey', 'unwrapKey']
  ) as Promise<CryptoKeyPair>;
}

export function generateRecoveryKey(): string {
  return toGroupedHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return toBase64(spki);
}

export async function importRecipientPublicKey(base64Spki: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(base64Spki), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'spki',
    bytes.buffer as ArrayBuffer,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['wrapKey']
  );
}

async function toNonExtractableAes(key: CryptoKey): Promise<CryptoKey> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['wrapKey', 'unwrapKey']);
}

async function toNonExtractableRsaPrivate(key: CryptoKey): Promise<CryptoKey> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']);
}

export async function sealDekForSession(dek: CryptoKey): Promise<CryptoKey> {
  return toNonExtractableAes(dek);
}

export async function sealPrivateKeyForSession(privateKey: CryptoKey): Promise<CryptoKey> {
  return toNonExtractableRsaPrivate(privateKey);
}

export async function wrapDek(wrapKey: CryptoKey, dek: CryptoKey): Promise<string> {
  return wrapKeyWithIv(wrapKey, dek, 'raw');
}

export async function unwrapDek(wrapKey: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return unwrapKeyWithIv(wrapKey, wrapped, 'raw', { name: 'AES-GCM' }, false, ['wrapKey', 'unwrapKey']);
}

export async function unwrapDekExtractable(wrapKey: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return unwrapKeyWithIv(wrapKey, wrapped, 'raw', { name: 'AES-GCM' }, true, ['wrapKey', 'unwrapKey']);
}

export async function wrapPrivateKey(wrapKey: CryptoKey, privateKey: CryptoKey): Promise<string> {
  return wrapKeyWithIv(wrapKey, privateKey, 'pkcs8');
}

export async function unwrapPrivateKey(wrapKey: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return unwrapKeyWithIv(wrapKey, wrapped, 'pkcs8', { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']);
}

export async function unwrapPrivateKeyExtractable(wrapKey: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return unwrapKeyWithIv(wrapKey, wrapped, 'pkcs8', { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['unwrapKey']);
}

export interface DerivedCredential {
  authHash: string;
  wrapKey: CryptoKey;
}

export async function deriveCredential(password: string, email: string, iterations: number): Promise<DerivedCredential> {
  const masterKey = await deriveMasterKey(password, email, iterations);
  return {
    authHash: await deriveAuthHash(masterKey, password),
    wrapKey: await deriveWrapKey(masterKey),
  };
}

export interface PasswordEnvelope {
  authHash: string;
  wrappedDek: string;
  wrappedPrivateKey: string;
}

export async function buildPasswordEnvelope(
  password: string,
  email: string,
  iterations: number,
  dek: CryptoKey,
  privateKey: CryptoKey
): Promise<PasswordEnvelope> {
  const { authHash, wrapKey } = await deriveCredential(password, email, iterations);
  return {
    authHash,
    wrappedDek: await wrapDek(wrapKey, dek),
    wrappedPrivateKey: await wrapPrivateKey(wrapKey, privateKey),
  };
}

export async function deriveRecoveryDekWrapKey(recoveryKey: string): Promise<CryptoKey> {
  return deriveAesKeyFromSecret(fromGroupedHex(recoveryKey), 'memoza-recovery-dek');
}

export async function deriveRecoveryPrivateKeyWrapKey(recoveryKey: string): Promise<CryptoKey> {
  return deriveAesKeyFromSecret(fromGroupedHex(recoveryKey), 'memoza-recovery-pk');
}
