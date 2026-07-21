import en from './en';
import type { StringKey } from './en';
import { DEFAULT_LANGUAGE, detectLanguage, isSupportedLanguage, isRtl } from './languages';

export type { StringKey } from './en';
export { LANGUAGES, DEFAULT_LANGUAGE, detectLanguage, isSupportedLanguage, isRtl } from './languages';
export type { LanguageInfo } from './languages';

type Dictionary = Record<StringKey, string>;

const LANGUAGE_STORAGE_KEY = 'memoza_language';

const cache = new Map<string, Dictionary>([['en', en]]);

const loaders: Record<string, () => Promise<{ default: Dictionary }>> = {
  es: () => import('./locales/es'),
  pt: () => import('./locales/pt'),
  fr: () => import('./locales/fr'),
  de: () => import('./locales/de'),
  it: () => import('./locales/it'),
  nl: () => import('./locales/nl'),
  pl: () => import('./locales/pl'),
  ro: () => import('./locales/ro'),
  sv: () => import('./locales/sv'),
  da: () => import('./locales/da'),
  nb: () => import('./locales/nb'),
  fi: () => import('./locales/fi'),
  cs: () => import('./locales/cs'),
  sk: () => import('./locales/sk'),
  hu: () => import('./locales/hu'),
  el: () => import('./locales/el'),
  tr: () => import('./locales/tr'),
  ru: () => import('./locales/ru'),
  uk: () => import('./locales/uk'),
  ar: () => import('./locales/ar'),
  he: () => import('./locales/he'),
  hi: () => import('./locales/hi'),
  bn: () => import('./locales/bn'),
  ur: () => import('./locales/ur'),
  id: () => import('./locales/id'),
  ms: () => import('./locales/ms'),
  th: () => import('./locales/th'),
  vi: () => import('./locales/vi'),
  zh: () => import('./locales/zh'),
  ja: () => import('./locales/ja'),
  ko: () => import('./locales/ko'),
};

let currentLanguage: string = DEFAULT_LANGUAGE;
let currentDict: Dictionary = en;
const listeners = new Set<() => void>();

function applyDocumentAttrs(lang: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl(lang) ? 'rtl' : 'ltr';
}

async function loadDictionary(lang: string): Promise<Dictionary> {
  const cached = cache.get(lang);
  if (cached) return cached;
  const loader = loaders[lang];
  if (!loader) return en;
  const mod = await loader();
  cache.set(lang, mod.default);
  return mod.default;
}

export function getLanguage(): string {
  return currentLanguage;
}

export async function setLanguage(lang: string): Promise<void> {
  const next = isSupportedLanguage(lang) ? lang : DEFAULT_LANGUAGE;
  currentDict = await loadDictionary(next);
  currentLanguage = next;
  if (typeof localStorage !== 'undefined') localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  applyDocumentAttrs(next);
  for (const listener of listeners) listener();
}

export function onLanguageChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key: StringKey, vars?: Record<string, string | number>): string {
  const template = currentDict[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export async function initLanguage(): Promise<void> {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LANGUAGE_STORAGE_KEY) : null;
  const initial = stored && isSupportedLanguage(stored) ? stored : detectLanguage();
  await setLanguage(initial);
}
