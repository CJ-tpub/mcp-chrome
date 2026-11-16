import { cdpSessionManager } from './cdp-session-manager';

/**
 * Page-level affordances for a real-browser control session:
 *  - a cursor overlay that shows where the agent is about to act,
 *  - a small "AI" favicon badge that marks controlled tabs,
 *  - element highlight rectangles.
 *
 * Everything is injected on demand with chrome.scripting.executeScript, so a
 * restricted page (edge://, PDF viewer, extension stores) simply degrades to
 * "no overlay" instead of breaking the action.
 */

const OVERLAY_HOST_ID = 'dsh-cursor-overlay-host';
const FAVICON_MARK = 'data-dsh-controlled';
const ORIGINAL_FAVICON_ATTR = 'data-dsh-original-favicon';

export interface CursorState {
  x: number;
  y: number;
  clicking?: boolean;
  label?: string;
}

async function inTab(tabId: number, func: (...args: any[]) => unknown, args: any[]): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: func as any, args });
  } catch {
    // Injection is impossible on restricted pages — silently skip.
  }
}

/**
 * Runs inside the page (isolated world). Self-contained: no closures.
 */
function installOverlayFn() {
  const HOST_ID = 'dsh-cursor-overlay-host';
  if (document.getElementById(HOST_ID)) return true;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent =
    '.cursor{position:fixed;left:0;top:0;width:22px;height:22px;transform:translate3d(-40px,-40px,0);' +
    'transition:transform 70ms ease-out;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));opacity:0}' +
    '.cursor.on{opacity:1}' +
    '.ring{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;' +
    'border:2px solid rgba(37,99,235,.9);opacity:0;pointer-events:none}' +
    '.ring.pulse{animation:dsh-pulse 420ms ease-out forwards}' +
    '@keyframes dsh-pulse{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(1.6)}}' +
    '.hl{position:fixed;border:2px solid rgba(37,99,235,.95);background:rgba(37,99,235,.12);' +
    'border-radius:3px;pointer-events:none;opacity:.9}';
  shadow.appendChild(style);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 22 22');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2 1.5 L2 17 L6.2 13 L8.8 19.5 L12 18 L9.4 11.6 L15 11.6 Z');
  path.setAttribute('fill', '#ffffff');
  path.setAttribute('stroke', '#1d4ed8');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  const cursor = document.createElement('div');
  cursor.className = 'cursor';
  cursor.appendChild(svg);
  shadow.appendChild(cursor);

  document.documentElement.appendChild(host);
  return true;
}

/**
 * Runs inside the page: move / click / hide the cursor.
 */
function cursorStateFn(x: number, y: number, show: boolean, click: boolean) {
  const host = document.getElementById('dsh-cursor-overlay-host');
  const shadow = host && (host as any).shadowRoot;
  if (!shadow) return false;
  const cursor = shadow.querySelector('.cursor') as HTMLElement | null;
  if (!cursor) return false;

  if (!show) {
    cursor.classList.remove('on');
    return true;
  }
  cursor.classList.add('on');
  cursor.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';

  if (click) {
    const ring = document.createElement('div');
    ring.className = 'ring pulse';
    ring.style.left = Math.round(x) + 'px';
    ring.style.top = Math.round(y) + 'px';
    shadow.appendChild(ring);
    setTimeout(() => ring.remove(), 480);
  }
  return true;
}

function highlightRectFn(x: number, y: number, w: number, h: number) {
  const host = document.getElementById('dsh-cursor-overlay-host');
  const shadow = host && (host as any).shadowRoot;
  if (!shadow) return false;
  shadow.querySelectorAll('.hl').forEach((n) => n.remove());
  if (w <= 0 || h <= 0) return true;
  const box = document.createElement('div');
  box.className = 'hl';
  box.style.left = Math.round(x) + 'px';
  box.style.top = Math.round(y) + 'px';
  box.style.width = Math.round(w) + 'px';
  box.style.height = Math.round(h) + 'px';
  shadow.appendChild(box);
  setTimeout(() => box.remove(), 900);
  return true;
}

function faviconFn(on: boolean) {
  const MARK = 'data-dsh-controlled';
  const ORIG = 'data-dsh-original-favicon';
  const links = Array.from(document.querySelectorAll('link[rel~="icon"]')) as HTMLLinkElement[];

  if (on) {
    if (document.querySelector('link[' + MARK + ']')) return true;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#1d4ed8"/>' +
      '<text x="16" y="22" font-family="Segoe UI,Arial" font-size="14" font-weight="700" ' +
      'fill="#fff" text-anchor="middle">AI</text></svg>';
    const href = 'data:image/svg+xml,' + encodeURIComponent(svg);
    if (links.length === 0) {
      const l = document.createElement('link');
      l.rel = 'icon';
      l.href = href;
      l.setAttribute(MARK, '1');
      l.setAttribute(ORIG, '');
      document.head.appendChild(l);
      return true;
    }
    const first = links[0];
    if (!first.getAttribute(MARK)) first.setAttribute(ORIG, first.getAttribute('href') || '');
    first.setAttribute(MARK, '1');
    first.setAttribute('href', href);
    return true;
  }

  const marked = Array.from(document.querySelectorAll('link[' + MARK + ']')) as HTMLLinkElement[];
  for (const l of marked) {
    const orig = l.getAttribute(ORIG) || '';
    l.removeAttribute(MARK);
    l.removeAttribute(ORIG);
    if (orig) l.setAttribute('href', orig);
    else l.remove();
  }
  return true;
}

export async function installCursor(tabId: number): Promise<void> {
  await inTab(tabId, installOverlayFn, []);
}

export async function showCursor(
  tabId: number,
  x: number,
  y: number,
  click = false,
): Promise<void> {
  await inTab(tabId, cursorStateFn, [x, y, true, click]);
}

export async function hideCursor(tabId: number): Promise<void> {
  await inTab(tabId, cursorStateFn, [0, 0, false, false]);
}

export async function highlightElement(
  tabId: number,
  rect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  await inTab(tabId, highlightRectFn, [rect.x, rect.y, rect.width, rect.height]);
}

export async function setFaviconBadge(tabId: number, on: boolean): Promise<void> {
  await inTab(tabId, faviconFn, [on]);
}

/** Center of an element, in CSS pixels relative to the viewport (top frame). */
export async function elementCenter(
  tabId: number,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      },
      args: [selector],
    });
    const value = results?.[0]?.result as any;
    if (!value) return null;
    return {
      x: value.x + value.width / 2,
      y: value.y + value.height / 2,
      width: value.width,
      height: value.height,
    };
  } catch {
    return null;
  }
}

/** Viewport CSS size (used to keep coordinates in the same space as CDP input). */
export async function viewportSize(
  tabId: number,
): Promise<{ width: number; height: number } | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: window.innerWidth, height: window.innerHeight }),
    });
    return (results?.[0]?.result as any) || null;
  } catch {
    return null;
  }
}

export async function isDebuggerAttached(tabId: number): Promise<boolean> {
  return cdpSessionManager.isAttached(tabId);
}
