import { fromUtf8, toBase64 } from './codec';

const HKDF_SALT = new Uint8Array(0);

export async function deriveMasterKey(password: string, email: string, iterations: number): Promise<ArrayBuffer> {
  const salt = await crypto.subtle.digest('SHA-256', fromUtf8(email.toLowerCase()));
  const keyMaterial = await crypto.subtle.importKey('raw', fromUtf8(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, keyMaterial, 256);
}

export async function deriveAuthHash(masterKey: ArrayBuffer, password: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey('raw', masterKey, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromUtf8(password), iterations: 1 },
    keyMaterial,
    256
  );
  return toBase64(bits);
}

export async function deriveAesKeyFromSecret(secret: ArrayBuffer | Uint8Array<ArrayBuffer>, info: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: fromUtf8(info) },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

export async function deriveWrapKey(masterKey: ArrayBuffer): Promise<CryptoKey> {
  return deriveAesKeyFromSecret(masterKey, 'memoza-wrap');
}

export async function deriveWrapKeyBits(masterKey: ArrayBuffer): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey('raw', masterKey, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: fromUtf8('memoza-wrap') },
    keyMaterial,
    256
  );
}

export async function importWrapKeyBits(bits: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['wrapKey', 'unwrapKey']);
}
