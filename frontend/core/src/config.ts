export const ESCROW_PUBLIC_KEY_PEM = (import.meta.env.VITE_ESCROW_PUBLIC_KEY as string | undefined) ?? '';
export const MIN_PASSWORD_LENGTH = 10;
export const KDF_ITERATIONS = 600000;
export const EMAIL_STORAGE_KEY = 'user_email';
export const PUBLIC_SITE_ORIGIN = (import.meta.env.VITE_PUBLIC_SITE_ORIGIN as string | undefined) ?? 'https://memozasites.com';
