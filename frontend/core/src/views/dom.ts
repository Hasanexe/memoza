type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value as string;
    } else if (typeof value === 'string') {
      el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function errorBanner(message: string): HTMLElement {
  return h('div', { class: 'banner banner-error' }, message);
}

export function infoBanner(message: string): HTMLElement {
  return h('div', { class: 'banner banner-info' }, message);
}
