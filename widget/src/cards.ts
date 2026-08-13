/**
 * Recommendation cards, the compare drawer and the human-handover block
 * (spec §4.7, §9.2).
 */
import { el, clear } from './dom.js';
import type { HandoffOptions, RecommendationItem, RecommendationSet, Strings } from './types.js';

export interface CardCallbacks {
  onViewProduct: (item: RecommendationItem) => void;
  onAddToCart: (item: RecommendationItem, button: HTMLButtonElement) => void;
  onCompare: (set: RecommendationSet) => void;
  onReplace: (item: RecommendationItem) => void;
}

export function renderRecommendations(
  set: RecommendationSet,
  strings: Strings,
  callbacks: CardCallbacks,
): HTMLElement {
  const wrapper = el('div', { class: 'wwc-recommendations', role: 'region', 'aria-label': strings.compareTitle });

  for (const item of set.items) {
    wrapper.append(renderCard(item, strings, callbacks));
  }

  if (set.items.length > 1) {
    const compare = el('button', {
      type: 'button',
      class: 'wwc-btn wwc-btn-ghost wwc-compare-all',
      text: strings.compare,
    });
    compare.addEventListener('click', () => callbacks.onCompare(set));
    wrapper.append(compare);
  }

  if (set.shortfall_note) {
    wrapper.append(el('p', { class: 'wwc-shortfall', text: set.shortfall_note }));
  }
  wrapper.append(el('p', { class: 'wwc-disclaimer', text: set.disclaimer }));

  return wrapper;
}

function renderCard(item: RecommendationItem, strings: Strings, callbacks: CardCallbacks): HTMLElement {
  const card = el('article', { class: 'wwc-card' });

  card.append(el('span', { class: 'wwc-card-label', text: item.label }));

  const head = el('div', { class: 'wwc-card-head' });
  if (item.image_url) {
    head.append(el('img', { class: 'wwc-card-image', src: item.image_url, alt: '', loading: 'lazy' }));
  }

  const headText = el('div', { class: 'wwc-card-headtext' }, [
    el('h3', { class: 'wwc-card-name', text: item.name }),
  ]);

  const metaBits: string[] = [];
  if (item.price) metaBits.push(item.price);
  if (item.size) metaBits.push(item.size);
  if (metaBits.length) headText.append(el('p', { class: 'wwc-card-meta', text: metaBits.join(' · ') }));

  headText.append(
    el('span', {
      class: `wwc-stock ${item.in_stock ? 'wwc-stock-in' : 'wwc-stock-out'}`,
      text: item.in_stock ? strings.inStock : strings.outOfStock,
    }),
  );

  head.append(headText);
  card.append(head);

  card.append(el('p', { class: 'wwc-card-bestfor', text: `${strings.bestFor}: ${item.best_for}` }));

  // "Why this?" is collapsed by default so the card stays scannable on mobile.
  if (item.why_it_suits_you.length) {
    const details = el('details', { class: 'wwc-why' });
    details.append(el('summary', { text: strings.why }));
    const list = el('ul');
    for (const reason of item.why_it_suits_you) list.append(el('li', { text: reason }));
    details.append(list);
    details.append(el('p', { class: 'wwc-card-know', text: `${strings.whatToKnow}: ${item.what_to_know}` }));
    details.append(el('p', { class: 'wwc-card-how', text: `${strings.howToUse}: ${item.how_to_use}` }));
    card.append(details);
  }

  const actions = el('div', { class: 'wwc-card-actions' });

  if (item.permalink) {
    const view = el('a', {
      class: 'wwc-btn wwc-btn-ghost',
      href: item.permalink,
      target: '_blank',
      rel: 'noopener',
      text: strings.viewProduct,
    });
    view.addEventListener('click', () => callbacks.onViewProduct(item));
    actions.append(view);
  }

  if (item.in_stock && item.actions.includes('add_to_cart')) {
    const add = el('button', { type: 'button', class: 'wwc-btn wwc-btn-primary', text: strings.addToCart });
    add.addEventListener('click', () => callbacks.onAddToCart(item, add));
    actions.append(add);
  }

  if (item.actions.includes('replace')) {
    const replace = el('button', { type: 'button', class: 'wwc-btn wwc-btn-link', text: strings.replace });
    replace.addEventListener('click', () => callbacks.onReplace(item));
    actions.append(replace);
  }

  card.append(actions);
  return card;
}

/** Side-by-side comparison without leaving the chat (spec §9.2). */
export function renderCompareDrawer(
  set: RecommendationSet,
  strings: Strings,
  onClose: () => void,
): HTMLElement {
  const drawer = el('div', {
    class: 'wwc-drawer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': strings.compareTitle,
  });

  const header = el('div', { class: 'wwc-drawer-head' }, [
    el('h2', { text: strings.compareTitle }),
  ]);
  const close = el('button', {
    type: 'button',
    class: 'wwc-icon-btn',
    'aria-label': strings.close,
    text: '×',
  });
  close.addEventListener('click', onClose);
  header.append(close);
  drawer.append(header);

  const table = el('table', { class: 'wwc-compare' });
  const rows: [string, (item: RecommendationItem) => string][] = [
    ['', (i) => i.label],
    [strings.price, (i) => i.price ?? '—'],
    [strings.size, (i) => i.size ?? '—'],
    [strings.bestFor, (i) => i.best_for],
    [strings.whatToKnow, (i) => i.what_to_know],
    [strings.howToUse, (i) => i.how_to_use],
  ];

  const head = el('tr', {}, [el('th', { scope: 'col', text: '' })]);
  for (const item of set.items) head.append(el('th', { scope: 'col', text: item.name }));
  table.append(el('thead', {}, [head]));

  const body = el('tbody');
  for (const [label, getter] of rows) {
    const tr = el('tr', {}, [el('th', { scope: 'row', text: label })]);
    for (const item of set.items) tr.append(el('td', { text: getter(item) }));
    body.append(tr);
  }
  table.append(body);

  drawer.append(el('div', { class: 'wwc-drawer-body' }, [table]));
  return drawer;
}

/**
 * Handover block. Renders only the channels the store actually configured —
 * an unconfigured channel is absent rather than shown as a dead link.
 */
export function renderHandoff(handoff: HandoffOptions, strings: Strings): HTMLElement {
  const box = el('div', { class: 'wwc-handoff' });

  if (handoff.whatsapp_url) {
    box.append(
      el('a', {
        class: 'wwc-btn wwc-btn-primary',
        href: handoff.whatsapp_url,
        target: '_blank',
        rel: 'noopener',
        text: strings.talkToHuman,
      }),
    );
  }

  if (handoff.phone) {
    box.append(
      el('a', {
        class: 'wwc-btn wwc-btn-ghost',
        href: `tel:${handoff.phone.replace(/[^\d+]/g, '')}`,
        text: `${strings.callUs} ${handoff.phone}`,
      }),
    );
  }

  if (handoff.live_chat_note) {
    box.append(el('p', { class: 'wwc-handoff-note', text: handoff.live_chat_note }));
  }
  if (handoff.hours) {
    box.append(el('p', { class: 'wwc-handoff-note', text: handoff.hours }));
  }

  return box;
}

/** Thumbs up/down with an optional reason (spec §9.2, KPI in §14). */
export function renderFeedback(
  strings: Strings,
  onRate: (rating: 'up' | 'down', reason?: string) => void,
): HTMLElement {
  const box = el('div', { class: 'wwc-feedback' });
  box.append(el('span', { class: 'wwc-feedback-label', text: strings.helpful }));

  const up = el('button', { type: 'button', class: 'wwc-icon-btn', 'aria-label': strings.yes, text: '\u{1F44D}' });
  const down = el('button', { type: 'button', class: 'wwc-icon-btn', 'aria-label': strings.no, text: '\u{1F44E}' });

  up.addEventListener('click', () => {
    onRate('up');
    clear(box);
    box.append(el('span', { class: 'wwc-feedback-label', text: '✓' }));
  });

  down.addEventListener('click', () => {
    clear(box);
    const input = el('input', { type: 'text', class: 'wwc-feedback-input', placeholder: strings.feedbackReason });
    const send = el('button', { type: 'button', class: 'wwc-btn wwc-btn-ghost', text: strings.send });
    send.addEventListener('click', () => {
      onRate('down', input.value.trim() || undefined);
      clear(box);
      box.append(el('span', { class: 'wwc-feedback-label', text: '✓' }));
    });
    box.append(input, send);
    input.focus();
  });

  box.append(up, down);
  return box;
}
