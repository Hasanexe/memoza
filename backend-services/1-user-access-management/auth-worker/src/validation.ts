import { isValidUsernameFormat } from '@memoza/shared';

const MAX_AUTH_HASH_LEN = 512;
const MAX_PUBLIC_KEY_LEN = 2048;
const MAX_ENVELOPE_LEN = 4096;
const ALLOWED_KDF_ITERATIONS = 600000;

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateAuthHash(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_AUTH_HASH_LEN;
}

export function validatePublicKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PUBLIC_KEY_LEN;
}

export function validateEnvelopeField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ENVELOPE_LEN;
}

export function validateKdfIterations(value: unknown): value is number {
  return value === ALLOWED_KDF_ITERATIONS;
}

export function validateRecoveryMode(value: unknown): value is 'private' | 'convenient' {
  return value === 'private' || value === 'convenient';
}

export function validateUsername(value: unknown): value is string {
  return typeof value === 'string' && isValidUsernameFormat(value);
}
