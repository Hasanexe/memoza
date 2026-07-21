export interface ControlKeySpec {
  single: boolean;
  values: string[];
}

export const CONTROL_KEYS: Record<string, ControlKeySpec> = {
  color: { single: true, values: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] },
  format: { single: true, values: ['md', 'html'] },
};

export const COLOR_VARS: Record<string, string> = {
  red: 'var(--danger)',
  orange: 'var(--clay)',
  yellow: 'var(--gold-strong)',
  green: 'var(--success)',
  blue: '#3F72AF',
  purple: 'var(--shared)',
};

export const BOOLEAN_CONTROLS = ['pin'];

export type ClassifiedTag =
  | { kind: 'control'; key: string; value: string }
  | { kind: 'boolean'; key: string }
  | { kind: 'content'; tag: string };

export function classifyTag(tag: string): ClassifiedTag {
  const idx = tag.indexOf(':');
  if (idx > 0) {
    const key = tag.slice(0, idx);
    const value = tag.slice(idx + 1);
    if (CONTROL_KEYS[key] && value) return { kind: 'control', key, value };
  }
  if (BOOLEAN_CONTROLS.includes(tag)) return { kind: 'boolean', key: tag };
  return { kind: 'content', tag };
}

export function isControlTag(tag: string): boolean {
  return classifyTag(tag).kind !== 'content';
}

export function contentTags(tags: string[]): string[] {
  return tags.filter(t => classifyTag(t).kind === 'content');
}

export function getControlValue(tags: string[], key: string): string | null {
  for (const t of tags) {
    const c = classifyTag(t);
    if (c.kind === 'control' && c.key === key) return c.value;
  }
  return null;
}

export function setControlValue(tags: string[], key: string, value: string): string[] {
  const filtered = tags.filter(t => {
    const c = classifyTag(t);
    return !(c.kind === 'control' && c.key === key);
  });
  return [...filtered, `${key}:${value}`];
}

export function getFormat(tags: string[]): 'md' | 'html' {
  return getControlValue(tags, 'format') === 'html' ? 'html' : 'md';
}

export function getColor(tags: string[]): string | null {
  return getControlValue(tags, 'color');
}
