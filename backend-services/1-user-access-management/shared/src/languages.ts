export const ALLOWED_LANGUAGES = [
  'en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ro', 'sv',
  'da', 'nb', 'fi', 'cs', 'sk', 'hu', 'el', 'tr', 'ru', 'uk',
  'ar', 'he', 'hi', 'bn', 'ur', 'id', 'ms', 'th', 'vi', 'zh',
  'ja', 'ko',
] as const;

export type LanguageCode = (typeof ALLOWED_LANGUAGES)[number];

export function isValidLanguage(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (ALLOWED_LANGUAGES as readonly string[]).includes(value);
}
