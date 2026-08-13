/** Tiny DOM helpers — the widget deliberately ships no framework. */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('data-') || key.startsWith('aria-')) node.setAttribute(key, String(value));
    else node.setAttribute(key, value === true ? '' : String(value));
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Renders assistant text safely: escapes everything, then re-applies the small
 * amount of Markdown the approved templates use (**bold** and line breaks).
 * Never `innerHTML` on raw model output.
 */
export function formatMessage(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const paragraphs = text.split(/\n{2,}/);

  for (const paragraph of paragraphs) {
    const p = document.createElement('p');
    const lines = paragraph.split('\n');

    lines.forEach((line, index) => {
      if (index > 0) p.append(document.createElement('br'));
      // Split on **bold** so the emphasis in the emergency template survives.
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      for (const part of parts) {
        if (!part) continue;
        if (part.startsWith('**') && part.endsWith('**')) {
          const strong = document.createElement('strong');
          strong.textContent = part.slice(2, -2);
          p.append(strong);
        } else {
          p.append(document.createTextNode(part));
        }
      }
    });

    fragment.append(p);
  }
  return fragment;
}

export function scrollToBottom(node: HTMLElement): void {
  requestAnimationFrame(() => {
    node.scrollTop = node.scrollHeight;
  });
}

/** Keeps Tab focus inside the open panel, per the accessibility requirement. */
export function trapFocus(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;

  const focusable = container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
