function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return fromBase64(base64).buffer as ArrayBuffer;
}

export async function decryptEscrowedRecoveryKey(
  privateKeyPem: string,
  escrowedRecovery: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt']
  );
  const plaintext = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, fromBase64(escrowedRecovery));
  return toBase64(plaintext);
}
