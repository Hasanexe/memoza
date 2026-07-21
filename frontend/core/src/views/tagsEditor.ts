import { h, icon } from './dom';
import { t } from '../i18n';
import { CONTROL_KEYS, BOOLEAN_CONTROLS, classifyTag, getControlValue, setControlValue } from './controlTags';

export const PIN_TAG = 'pin';

export interface TagsEditorHandle {
  el: HTMLElement;
  getTags(): string[];
  flushPendingInput(): string[];
}

function splitFragments(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

export function renderTagsEditor(
  initialTags: string[],
  readOnly: boolean,
  onChange: (tags: string[], immediate: boolean) => void
): TagsEditorHandle {
  let tags = initialTags.slice();

  const host = h('div', { class: readOnly ? 'tags-editor tags-editor--readonly' : 'tags-editor' });

  const pinBtn = h('button', {
    type: 'button',
    class: 'tag-pin-toggle',
    'aria-label': t('common.pin'),
    title: t('common.pin'),
  }, icon('pin', 16));
  pinBtn.addEventListener('click', () => {
    if (tags.includes(PIN_TAG)) removeTag(PIN_TAG, true);
    else addTag(PIN_TAG, true);
  });

  const input = readOnly
    ? null
    : (h('input', { type: 'text', class: 'tags-editor-input', placeholder: t('tags.addTagsPlaceholder') }) as HTMLInputElement);

  const suggestHost = h('div', { class: 'tags-suggest hidden' });
  let currentSuggestions: Suggestion[] = [];
  let activeIndex = -1;

  function visibleTags(): string[] {
    return tags.filter(t => !BOOLEAN_CONTROLS.includes(t));
  }

  function addTag(word: string, immediate = false): void {
    if (!word || tags.includes(word)) return;
    tags = [...tags, word];
    render();
    onChange(tags.slice(), immediate || word === PIN_TAG);
  }

  function removeTag(word: string, immediate = false): void {
    if (!tags.includes(word)) return;
    tags = tags.filter(t => t !== word);
    render();
    onChange(tags.slice(), immediate || word === PIN_TAG);
  }

  function commitWord(word: string): void {
    if (word.startsWith(':')) word = word.slice(1);
    if (!word) return;
    const classified = classifyTag(word);
    if (classified.kind === 'control') {
      tags = setControlValue(tags, classified.key, classified.value);
      render();
      onChange(tags.slice(), false);
      return;
    }
    addTag(word);
  }

  function applyControlValue(key: string, value: string): void {
    tags = setControlValue(tags, key, value);
    if (input) input.value = '';
    render();
    onChange(tags.slice(), true);
  }

  interface Suggestion {
    label: string;
    apply: () => void;
  }

  function keySuggestions(prefix: string): Suggestion[] {
    return Object.keys(CONTROL_KEYS)
      .filter(k => k.startsWith(prefix.toLowerCase()))
      .map(k => ({
        label: `${k}:`,
        apply: () => {
          if (!input) return;
          input.value = `${k}:`;
          input.focus();
          updateSuggestions();
        },
      }));
  }

  function suggestionsFor(word: string): Suggestion[] {
    const leadingColon = word.startsWith(':');
    const body = leadingColon ? word.slice(1) : word;
    const idx = body.indexOf(':');

    if (idx === -1) return leadingColon ? keySuggestions(body) : [];

    const key = body.slice(0, idx);
    const valuePrefix = body.slice(idx + 1).toLowerCase();
    const spec = CONTROL_KEYS[key];
    if (!spec) return keySuggestions(key);

    const current = getControlValue(tags, key);
    let values = spec.values.filter(v => v.toLowerCase().startsWith(valuePrefix));
    if (current && values.includes(current)) values = [current, ...values.filter(v => v !== current)];
    return values.map(v => ({ label: `${key}:${v}`, apply: () => applyControlValue(key, v) }));
  }

  function highlightActive(): void {
    const btns = Array.from(suggestHost.querySelectorAll('.tags-suggest-item'));
    btns.forEach((b, i) => b.classList.toggle('active', i === activeIndex));
    if (activeIndex >= 0) btns[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function updateSuggestions(): void {
    if (!input) return;
    currentSuggestions = suggestionsFor(input.value.trim());
    activeIndex = -1;
    suggestHost.replaceChildren();
    if (currentSuggestions.length === 0) {
      suggestHost.classList.add('hidden');
      return;
    }
    for (const item of currentSuggestions) {
      const btn = h('button', { type: 'button', class: 'tags-suggest-item' }, item.label);
      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        item.apply();
        updateSuggestions();
      });
      suggestHost.append(btn);
    }
    suggestHost.classList.remove('hidden');
  }

  function commitInput(): void {
    if (!input) return;
    const word = input.value.trim();
    input.value = '';
    suggestHost.classList.add('hidden');
    if (word) commitWord(word);
  }

  function chip(tag: string): HTMLElement {
    if (readOnly) return h('span', { class: 'tag-chip' }, tag);
    const el = h('span', { class: 'tag-chip', tabindex: '0' }, tag);
    el.addEventListener('focus', () => el.classList.add('selected'));
    el.addEventListener('blur', () => el.classList.remove('selected'));
    el.addEventListener('keydown', e => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        removeTag(tag);
      }
    });
    el.addEventListener('dblclick', () => {
      removeTag(tag);
      if (input) {
        input.value = tag;
        input.focus();
        updateSuggestions();
      }
    });
    const removeBtn = h('button', { type: 'button', class: 'tag-chip-remove', 'aria-label': t('tags.removeTag', { tag }) }, '×');
    removeBtn.addEventListener('click', () => removeTag(tag));
    el.append(removeBtn);
    return el;
  }

  function render(): void {
    const focusInput = document.activeElement === input;
    host.replaceChildren();
    pinBtn.classList.toggle('active', tags.includes(PIN_TAG));
    if (!readOnly || tags.includes(PIN_TAG)) host.append(pinBtn);
    if (readOnly) pinBtn.setAttribute('disabled', 'true');
    for (const tag of visibleTags()) host.append(chip(tag));
    if (input) host.append(input);
    if (input) host.append(suggestHost);
    if (focusInput && input) input.focus();
  }

  if (input) {
    input.addEventListener('input', updateSuggestions);
    input.addEventListener('keydown', e => {
      const open = !suggestHost.classList.contains('hidden') && currentSuggestions.length > 0;
      if (e.key === 'ArrowDown') {
        if (open) {
          e.preventDefault();
          activeIndex = (activeIndex + 1) % currentSuggestions.length;
          highlightActive();
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        if (open) {
          e.preventDefault();
          activeIndex = activeIndex <= 0 ? currentSuggestions.length - 1 : activeIndex - 1;
          highlightActive();
        }
        return;
      }
      if (e.key === 'Escape') {
        suggestHost.classList.add('hidden');
        activeIndex = -1;
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (open) {
          currentSuggestions[activeIndex >= 0 ? activeIndex : 0].apply();
          updateSuggestions();
        } else {
          commitInput();
        }
        return;
      }
      if (e.key === 'Tab' && open && activeIndex >= 0) {
        e.preventDefault();
        currentSuggestions[activeIndex].apply();
        updateSuggestions();
        return;
      }
      if (e.key === ' ' || e.key === ',') {
        e.preventDefault();
        commitInput();
        return;
      }
      if (e.key === 'Backspace' && input.value === '') {
        const last = visibleTags()[visibleTags().length - 1];
        if (last) removeTag(last);
      }
    });
    input.addEventListener('paste', e => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text) return;
      e.preventDefault();
      for (const fragment of splitFragments(text)) commitWord(fragment);
    });
    input.addEventListener('blur', commitInput);
  }

  render();

  return {
    el: host,
    getTags: () => tags.slice(),
    flushPendingInput: () => {
      commitInput();
      return tags.slice();
    },
  };
}
