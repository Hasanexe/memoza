export interface LanguageInfo {
  code: string;
  englishName: string;
  nativeName: string;
  rtl: boolean;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'en', englishName: 'English', nativeName: 'English', rtl: false },
  { code: 'es', englishName: 'Spanish', nativeName: 'Español', rtl: false },
  { code: 'pt', englishName: 'Portuguese', nativeName: 'Português', rtl: false },
  { code: 'fr', englishName: 'French', nativeName: 'Français', rtl: false },
  { code: 'de', englishName: 'German', nativeName: 'Deutsch', rtl: false },
  { code: 'it', englishName: 'Italian', nativeName: 'Italiano', rtl: false },
  { code: 'nl', englishName: 'Dutch', nativeName: 'Nederlands', rtl: false },
  { code: 'pl', englishName: 'Polish', nativeName: 'Polski', rtl: false },
  { code: 'ro', englishName: 'Romanian', nativeName: 'Română', rtl: false },
  { code: 'sv', englishName: 'Swedish', nativeName: 'Svenska', rtl: false },
  { code: 'da', englishName: 'Danish', nativeName: 'Dansk', rtl: false },
  { code: 'nb', englishName: 'Norwegian', nativeName: 'Norsk bokmål', rtl: false },
  { code: 'fi', englishName: 'Finnish', nativeName: 'Suomi', rtl: false },
  { code: 'cs', englishName: 'Czech', nativeName: 'Čeština', rtl: false },
  { code: 'sk', englishName: 'Slovak', nativeName: 'Slovenčina', rtl: false },
  { code: 'hu', englishName: 'Hungarian', nativeName: 'Magyar', rtl: false },
  { code: 'el', englishName: 'Greek', nativeName: 'Ελληνικά', rtl: false },
  { code: 'tr', englishName: 'Turkish', nativeName: 'Türkçe', rtl: false },
  { code: 'ru', englishName: 'Russian', nativeName: 'Русский', rtl: false },
  { code: 'uk', englishName: 'Ukrainian', nativeName: 'Українська', rtl: false },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', rtl: true },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', rtl: true },
  { code: 'hi', englishName: 'Hindi', nativeName: 'हिन्दी', rtl: false },
  { code: 'bn', englishName: 'Bengali', nativeName: 'বাংলা', rtl: false },
  { code: 'ur', englishName: 'Urdu', nativeName: 'اردو', rtl: true },
  { code: 'id', englishName: 'Indonesian', nativeName: 'Bahasa Indonesia', rtl: false },
  { code: 'ms', englishName: 'Malay', nativeName: 'Bahasa Melayu', rtl: false },
  { code: 'th', englishName: 'Thai', nativeName: 'ไทย', rtl: false },
  { code: 'vi', englishName: 'Vietnamese', nativeName: 'Tiếng Việt', rtl: false },
  { code: 'zh', englishName: 'Chinese', nativeName: '简体中文', rtl: false },
  { code: 'ja', englishName: 'Japanese', nativeName: '日本語', rtl: false },
  { code: 'ko', englishName: 'Korean', nativeName: '한국어', rtl: false },
];

export const LANGUAGE_CODES = LANGUAGES.map(l => l.code);
export const DEFAULT_LANGUAGE = 'en';

export function isSupportedLanguage(code: string): boolean {
  return LANGUAGE_CODES.includes(code);
}

export function detectLanguage(): string {
  const candidates = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = candidate.toLowerCase().split('-')[0];
    if (isSupportedLanguage(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}

export function isRtl(code: string): boolean {
  return LANGUAGES.find(l => l.code === code)?.rtl ?? false;
}
