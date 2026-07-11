export function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export function fromUtf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

export function toUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function toGroupedHex(bytes: Uint8Array): string {
  return (toHex(bytes).match(/.{1,4}/g) ?? []).join('-');
}

export function fromGroupedHex(grouped: string): Uint8Array<ArrayBuffer> {
  const hex = grouped.replace(/-/g, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return fromBase64(base64).buffer;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function aesGcmSeal(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
  return toBase64(concatBytes(iv, new Uint8Array(ciphertext)).buffer);
}

export async function aesGcmOpen(
  key: CryptoKey,
  sealed: string,
  aad: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = fromBase64(sealed);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext);
  return new Uint8Array(plaintext);
}

export async function wrapKeyWithIv(
  wrappingKey: CryptoKey,
  keyToWrap: CryptoKey,
  format: 'raw' | 'pkcs8'
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey(format, keyToWrap, wrappingKey, { name: 'AES-GCM', iv });
  return toBase64(concatBytes(iv, new Uint8Array(wrapped)).buffer);
}

export async function unwrapKeyWithIv(
  wrappingKey: CryptoKey,
  wrappedBase64: string,
  format: 'raw' | 'pkcs8',
  unwrappedKeyAlgo: AlgorithmIdentifier | RsaHashedImportParams,
  extractable: boolean,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const bytes = fromBase64(wrappedBase64);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  return crypto.subtle.unwrapKey(
    format,
    ciphertext.buffer,
    wrappingKey,
    { name: 'AES-GCM', iv },
    unwrappedKeyAlgo,
    extractable,
    usages
  );
}

export async function rsaOaepWrapKey(publicKey: CryptoKey, keyToWrap: CryptoKey): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey('raw', keyToWrap, publicKey, { name: 'RSA-OAEP' });
  return toBase64(wrapped);
}

export async function rsaOaepUnwrapKey(
  privateKey: CryptoKey,
  wrappedBase64: string,
  unwrappedKeyAlgo: AlgorithmIdentifier,
  extractable: boolean,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const bytes = fromBase64(wrappedBase64);
  return crypto.subtle.unwrapKey('raw', bytes.buffer, privateKey, { name: 'RSA-OAEP' }, unwrappedKeyAlgo, extractable, usages);
}
