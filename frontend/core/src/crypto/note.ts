import {
  aesGcmSeal,
  aesGcmOpen,
  fromUtf8,
  toUtf8,
  wrapKeyWithIv,
  unwrapKeyWithIv,
  rsaOaepWrapKey,
  rsaOaepUnwrapKey,
} from './codec';

export async function generateCek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function sealCekForSession(cek: CryptoKey): Promise<CryptoKey> {
  const raw = await crypto.subtle.exportKey('raw', cek);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function wrapCekWithDek(dek: CryptoKey, cek: CryptoKey): Promise<string> {
  return wrapKeyWithIv(dek, cek, 'raw');
}

export async function unwrapCekWithDek(dek: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return unwrapKeyWithIv(dek, wrapped, 'raw', { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function unwrapCekWithDekExtractable(dek: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return unwrapKeyWithIv(dek, wrapped, 'raw', { name: 'AES-GCM' }, true, []);
}

export async function wrapCekWithPublicKey(publicKey: CryptoKey, cek: CryptoKey): Promise<string> {
  return rsaOaepWrapKey(publicKey, cek);
}

export async function unwrapCekWithPrivateKey(privateKey: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return rsaOaepUnwrapKey(privateKey, wrapped, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function noteAad(noteId: string): Uint8Array<ArrayBuffer> {
  return fromUtf8(noteId);
}

function commentAad(commentId: string): Uint8Array<ArrayBuffer> {
  return fromUtf8(commentId);
}

export async function sealTitle(cek: CryptoKey, noteId: string, title: string): Promise<string> {
  return aesGcmSeal(cek, fromUtf8(title), noteAad(noteId));
}

export async function openTitle(cek: CryptoKey, noteId: string, titleCt: string): Promise<string> {
  return toUtf8(await aesGcmOpen(cek, titleCt, noteAad(noteId)));
}

export async function sealBody(cek: CryptoKey, noteId: string, body: string): Promise<string> {
  return aesGcmSeal(cek, fromUtf8(body), noteAad(noteId));
}

export async function openBody(cek: CryptoKey, noteId: string, bodyCt: string): Promise<string> {
  return toUtf8(await aesGcmOpen(cek, bodyCt, noteAad(noteId)));
}

export async function sealTags(cek: CryptoKey, noteId: string, tags: string[]): Promise<string> {
  return aesGcmSeal(cek, fromUtf8(JSON.stringify(tags)), noteAad(noteId));
}

export async function openTags(cek: CryptoKey, noteId: string, tagsCt: string | null): Promise<string[]> {
  if (tagsCt === null) return [];
  const bytes = await aesGcmOpen(cek, tagsCt, noteAad(noteId));
  return JSON.parse(toUtf8(bytes)) as string[];
}

export async function sealComment(cek: CryptoKey, commentId: string, body: string): Promise<string> {
  return aesGcmSeal(cek, fromUtf8(body), commentAad(commentId));
}

export async function openComment(cek: CryptoKey, commentId: string, bodyCt: string): Promise<string> {
  return toUtf8(await aesGcmOpen(cek, bodyCt, commentAad(commentId)));
}
