const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_WRAPPED_CEK_BYTES = 1024;

export function validateUUID(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function validateCiphertext(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && byteLength(value) <= maxBytes;
}

export function validateOptionalCiphertext(
  value: unknown,
  maxBytes: number
): value is string | null | undefined {
  if (value === null || value === undefined) return true;
  return validateCiphertext(value, maxBytes);
}

export function validateFormat(value: unknown): value is 'md' | 'html' {
  return value === 'md' || value === 'html';
}
