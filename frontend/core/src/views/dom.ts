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

export function logoMark(): HTMLElement {
  return h('img', { class: 'mz-logo', src: '/logomark.svg', alt: '', width: '38', height: '38' });
}

export function brand(): HTMLElement {
  return h('span', { class: 'mz-brand' }, logoMark(), h('span', { class: 'mz-wordmark' }, 'Memoza'));
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgShape(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

export type IconName =
  | 'plus'
  | 'chevronLeft'
  | 'chevronRight'
  | 'share'
  | 'pin'
  | 'trash'
  | 'eye'
  | 'pencil'
  | 'settings'
  | 'notebook'
  | 'users'
  | 'globe'
  | 'link';

const ICON_SHAPES: Record<IconName, () => SVGElement[]> = {
  plus: () => [
    svgShape('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
    svgShape('line', { x1: '5', y1: '12', x2: '19', y2: '12' }),
  ],
  chevronLeft: () => [svgShape('polyline', { points: '15 18 9 12 15 6' })],
  chevronRight: () => [svgShape('polyline', { points: '9 18 15 12 9 6' })],
  share: () => [
    svgShape('circle', { cx: '18', cy: '5', r: '3' }),
    svgShape('circle', { cx: '6', cy: '12', r: '3' }),
    svgShape('circle', { cx: '18', cy: '19', r: '3' }),
    svgShape('line', { x1: '8.6', y1: '10.6', x2: '15.4', y2: '6.6' }),
    svgShape('line', { x1: '8.6', y1: '13.4', x2: '15.4', y2: '17.4' }),
  ],
  pin: () => [
    svgShape('circle', { cx: '12', cy: '8', r: '4' }),
    svgShape('line', { x1: '12', y1: '12', x2: '12', y2: '21' }),
  ],
  trash: () => [
    svgShape('line', { x1: '4', y1: '7', x2: '20', y2: '7' }),
    svgShape('path', { d: 'M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13' }),
    svgShape('path', { d: 'M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3' }),
    svgShape('line', { x1: '10', y1: '11', x2: '10', y2: '17' }),
    svgShape('line', { x1: '14', y1: '11', x2: '14', y2: '17' }),
  ],
  eye: () => [
    svgShape('path', { d: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z' }),
    svgShape('circle', { cx: '12', cy: '12', r: '3' }),
  ],
  pencil: () => [svgShape('path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' })],
  settings: () => [
    svgShape('line', { x1: '4', y1: '6', x2: '20', y2: '6' }),
    svgShape('circle', { cx: '14', cy: '6', r: '2' }),
    svgShape('line', { x1: '4', y1: '12', x2: '20', y2: '12' }),
    svgShape('circle', { cx: '8', cy: '12', r: '2' }),
    svgShape('line', { x1: '4', y1: '18', x2: '20', y2: '18' }),
    svgShape('circle', { cx: '16', cy: '18', r: '2' }),
  ],
  notebook: () => [
    svgShape('path', { d: 'M6 4h9l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z' }),
    svgShape('line', { x1: '8', y1: '11', x2: '15', y2: '11' }),
    svgShape('line', { x1: '8', y1: '14', x2: '15', y2: '14' }),
    svgShape('line', { x1: '8', y1: '17', x2: '12', y2: '17' }),
  ],
  users: () => [
    svgShape('circle', { cx: '9', cy: '8', r: '3' }),
    svgShape('path', { d: 'M4 20c0-3 2.3-5 5-5s5 2 5 5' }),
    svgShape('circle', { cx: '17', cy: '9', r: '2.3' }),
    svgShape('path', { d: 'M15 20c.3-2.2 1.8-3.6 3.6-4' }),
  ],
  globe: () => [
    svgShape('circle', { cx: '12', cy: '12', r: '9' }),
    svgShape('line', { x1: '3', y1: '12', x2: '21', y2: '12' }),
    svgShape('path', { d: 'M12 3c2.8 2.5 4.3 5.7 4.3 9s-1.5 6.5-4.3 9c-2.8-2.5-4.3-5.7-4.3-9s1.5-6.5 4.3-9z' }),
  ],
  link: () => [
    svgShape('path', { d: 'M9.5 14.5l5-5' }),
    svgShape('path', { d: 'M11 6.5l1.5-1.5a3.5 3.5 0 0 1 5 5L16 11.5' }),
    svgShape('path', { d: 'M13 17.5l-1.5 1.5a3.5 3.5 0 0 1-5-5L8 12.5' }),
  ],
};

export function icon(name: IconName, size = 20): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.8');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.append(...ICON_SHAPES[name]());
  return el;
}

export function showToast(message: string, actionLabel?: string, onAction?: () => void): void {
  const toast = h('div', { class: 'mz-toast' }, h('span', { class: 'mz-toast__label' }, message));
  let timer: number | undefined;
  const dismiss = (): void => {
    if (timer) window.clearTimeout(timer);
    toast.remove();
  };
  if (actionLabel && onAction) {
    const btn = h('button', { type: 'button' }, actionLabel);
    btn.addEventListener('click', () => {
      dismiss();
      onAction();
    });
    toast.append(btn);
  }
  toast.append(h('div', { class: 'mz-toast__bar' }));
  document.body.append(toast);
  timer = window.setTimeout(dismiss, 5000);
}
