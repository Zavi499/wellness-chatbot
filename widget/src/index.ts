/**
 * Wellness World chat widget (spec §9).
 *
 * Vanilla TypeScript, no framework, because this loads on every storefront
 * page. All conversation text comes from the backend; this file only owns the
 * chrome, the interactions, and the accessibility behaviour.
 */
import { Api } from './api.js';
import { el, clear, formatMessage, scrollToBottom, trapFocus } from './dom.js';
import { renderCompareDrawer, renderFeedback, renderRecommendations } from './cards.js';
import type { ChatResponse, Language, RecommendationSet, Strings, WidgetConfig } from './types.js';

class ChatWidget {
  private readonly api: Api;
  private strings: Strings;
  private language: Language = 'en';

  private root: HTMLElement;
  private panel!: HTMLElement;
  private messages!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private quickReplies!: HTMLElement;
  private progress!: HTMLElement;
  private launcher: HTMLButtonElement | null = null;
  private drawer: HTMLElement | null = null;

  private open = false;
  private busy = false;
  private started = false;
  private lastRecommendations: RecommendationSet | null = null;
  /** Answers already sent, so "Back" can undo the last one. */
  private history: string[] = [];

  constructor(root: HTMLElement, private readonly config: WidgetConfig) {
    this.root = root;
    this.api = new Api(config);
    this.language = config.isRtl ? 'ar' : 'en';
    this.strings = config.strings[this.language] ?? config.strings.en;
    this.build();
  }

  // --- Construction ---------------------------------------------------------

  private build(): void {
    const mode = this.root.dataset.mode ?? 'inline';
    this.panel = this.buildPanel();

    if (mode === 'launcher') {
      this.launcher = el('button', {
        type: 'button',
        class: 'wwc-launcher',
        'aria-label': this.strings.open,
        'aria-expanded': 'false',
      }, [
        el('span', { class: 'wwc-launcher-icon', 'aria-hidden': 'true', text: '\u{1F4AC}' }),
        el('span', { class: 'wwc-launcher-text', text: this.strings.launcher }),
      ]);
      this.launcher.addEventListener('click', () => this.toggle());

      this.panel.hidden = true;
      const whatsapp = this.buildWhatsappButton();
      if (whatsapp) this.root.append(whatsapp);
      this.root.append(this.launcher, this.panel);
    } else {
      this.root.append(this.panel);
      void this.ensureStarted();
    }

    this.root.classList.add('wwc-ready');
    if (this.config.isRtl) this.root.setAttribute('dir', 'rtl');
  }

  /**
   * A plain link to wa.me, rendered only when a WhatsApp number is configured
   * in Settings → Business. A link rather than a button so it behaves like one
   * — middle-click, long-press, "copy link address" all work, and it needs no
   * JavaScript to function.
   */
  private buildWhatsappButton(): HTMLElement | null {
    // wa.me wants digits only: no +, spaces, dashes or parentheses.
    const digits = (this.config.whatsappNumber ?? '').replace(/\D/g, '');
    if (!digits) return null;

    const link = el('a', {
      class: 'wwc-whatsapp',
      href: `https://wa.me/${digits}`,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': this.strings.whatsapp,
      title: this.strings.whatsapp,
    });
    // Inline SVG: the widget ships no icon font and must not fetch an asset.
    link.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15s-.77.97-.94 1.17c-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.06 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35z"/>' +
      '<path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm0 18.13h-.01c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.82c0 4.54-3.7 8.24-8.23 8.24z"/>' +
      '</svg>';
    return link;
  }

  private buildPanel(): HTMLElement {
    const panel = el('section', {
      class: 'wwc-panel',
      role: 'dialog',
      'aria-label': this.strings.title,
    });

    // Header: avatar + name + presence on the start side, close on the end.
    const header = el('header', { class: 'wwc-header' }, [
      el('div', { class: 'wwc-header-id' }, [
        el('span', { class: 'wwc-avatar', 'aria-hidden': 'true', text: '\u{1F916}' }),
        el('div', { class: 'wwc-header-text' }, [
          el('h2', { class: 'wwc-title', text: this.strings.title }),
          el('p', { class: 'wwc-status', text: this.strings.online }),
        ]),
      ]),
    ]);
    const close = el('button', {
      type: 'button',
      class: 'wwc-icon-btn wwc-close',
      'aria-label': this.strings.close,
      text: '×',
    });
    close.addEventListener('click', () => this.toggle(false));
    header.append(close);

    // Progress indicator ("3 of 6") with back navigation
    this.progress = el('div', { class: 'wwc-progress', hidden: true });

    this.messages = el('div', {
      class: 'wwc-messages',
      role: 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions',
      tabindex: '0',
    });

    this.quickReplies = el('div', { class: 'wwc-quick-replies' });

    // Composer
    this.input = el('textarea', {
      class: 'wwc-input',
      rows: 1,
      placeholder: this.strings.placeholder,
      'aria-label': this.strings.placeholder,
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.send(this.input.value);
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
    });

    this.sendButton = el('button', {
      type: 'button',
      class: 'wwc-btn wwc-btn-primary wwc-send',
      text: this.strings.send,
    });
    this.sendButton.addEventListener('click', () => void this.send(this.input.value));

    const composer = el('div', { class: 'wwc-composer' }, [this.input, this.sendButton]);

    panel.append(header, this.progress, this.messages, this.quickReplies, composer);
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.launcher) this.toggle(false);
      trapFocus(panel, event);
    });

    return panel;
  }

  // --- Session --------------------------------------------------------------

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      const session = await this.api.start(this.language);
      this.applyLanguage(session.language);
      this.addAssistantMessage(session.greeting, null);
      this.addPrivacyNotice(session.privacy_notice);
      this.api.track('questionnaire_started');
    } catch {
      this.addSystemMessage(this.strings.error);
      this.started = false;
    }
  }

  private applyLanguage(language: Language): void {
    if (language === this.language) return;
    this.language = language;
    this.strings = this.config.strings[language] ?? this.strings;
    this.panel.setAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    this.input.placeholder = this.strings.placeholder;
    this.sendButton.textContent = this.strings.send;
  }

  private toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.panel.hidden = !this.open;
    this.launcher?.setAttribute('aria-expanded', String(this.open));
    this.root.classList.toggle('wwc-open', this.open);

    if (this.open) {
      void this.ensureStarted();
      this.input.focus();
    } else {
      this.launcher?.focus();
    }
  }

  // --- Sending --------------------------------------------------------------

  private async send(text: string, answer?: { key: string; value: string }): Promise<void> {
    const message = text.trim();
    if (!message || this.busy) return;

    this.busy = true;
    this.setComposerEnabled(false);
    this.addUserMessage(message);
    this.history.push(message);
    this.input.value = '';
    this.input.style.height = 'auto';
    clear(this.quickReplies);

    const thinking = this.addThinking();

    try {
      const response = await this.api.send(message, answer);
      thinking.remove();
      this.render(response);
    } catch {
      thinking.remove();
      this.addSystemMessage(this.strings.error);
    } finally {
      this.busy = false;
      this.setComposerEnabled(true);
      this.input.focus();
    }
  }

  private render(response: ChatResponse): void {
    this.applyLanguage(response.language);
    this.addAssistantMessage(response.message, response.message_id);

    if (response.recommendations && response.recommendations.items.length > 0) {
      this.lastRecommendations = response.recommendations;
      this.messages.append(
        renderRecommendations(response.recommendations, this.strings, {
          onViewProduct: (item) => this.api.track('recommendation_view_product', { product_id: item.product_id }),
          onAddToCart: (item, button) => void this.addToCart(item.product_id, button),
          onCompare: (set) => this.showCompare(set),
          onReplace: (item) => {
            this.api.track('recommendation_replace', { product_id: item.product_id });
            void this.send(
              this.language === 'ar'
                ? `أرني بديلاً عن ${item.name}`
                : `Show me a different option instead of ${item.name}`,
            );
          },
        }),
      );
    }

    this.renderQuickReplies(response);
    this.renderProgress(response);

    scrollToBottom(this.messages);
  }

  private renderQuickReplies(response: ChatResponse): void {
    clear(this.quickReplies);
    if (!response.quick_replies.length) return;

    for (const reply of response.quick_replies) {
      const button = el('button', { type: 'button', class: 'wwc-chip', text: reply.label });
      button.addEventListener('click', () => void this.send(reply.label));
      this.quickReplies.append(button);
    }
  }

  private renderProgress(response: ChatResponse): void {
    clear(this.progress);
    if (!response.progress) {
      this.progress.hidden = true;
      return;
    }

    this.progress.hidden = false;
    const label = this.strings.stepOf
      .replace('%1$d', String(response.progress.step))
      .replace('%2$d', String(response.progress.total));

    const bar = el('div', {
      class: 'wwc-progress-bar',
      role: 'progressbar',
      'aria-valuemin': '1',
      'aria-valuemax': String(response.progress.total),
      'aria-valuenow': String(response.progress.step),
      'aria-label': label,
    });
    bar.append(
      el('span', {
        class: 'wwc-progress-fill',
        style: `width:${Math.round((response.progress.step / response.progress.total) * 100)}%`,
      }),
    );

    const back = el('button', { type: 'button', class: 'wwc-btn wwc-btn-link', text: this.strings.back });
    back.disabled = this.history.length < 2;
    back.addEventListener('click', () => {
      // Going back re-asks the previous question by telling the assistant so —
      // the server owns the answer state, the widget never rewrites it.
      void this.send(
        this.language === 'ar' ? 'أريد تغيير إجابتي السابقة' : 'I want to change my previous answer',
      );
    });

    this.progress.append(el('span', { class: 'wwc-progress-label', text: label }), bar, back);
  }

  // --- Message helpers ------------------------------------------------------

  private addUserMessage(text: string): void {
    this.messages.append(el('div', { class: 'wwc-msg wwc-msg-user' }, [formatMessage(text)]));
    scrollToBottom(this.messages);
  }

  private addAssistantMessage(text: string, messageId: string | null): void {
    const bubble = el('div', { class: 'wwc-msg wwc-msg-bot' }, [formatMessage(text)]);

    if (messageId) {
      bubble.append(
        renderFeedback(this.strings, (rating, reason) => {
          void this.api.feedback(messageId, rating, reason);
        }),
      );
    }

    this.messages.append(this.botRow(bubble));
    scrollToBottom(this.messages);
  }

  /** Wraps a bot bubble with its avatar so the column reads as a conversation. */
  private botRow(bubble: HTMLElement): HTMLElement {
    return el('div', { class: 'wwc-row wwc-row-bot' }, [
      el('span', { class: 'wwc-msg-avatar', 'aria-hidden': 'true', text: '\u{1F916}' }),
      bubble,
    ]);
  }

  private addSystemMessage(text: string): void {
    this.messages.append(el('div', { class: 'wwc-msg wwc-msg-system', text }));
    scrollToBottom(this.messages);
  }

  private addPrivacyNotice(text: string): void {
    const details = el('details', { class: 'wwc-privacy' });
    details.append(el('summary', { text: this.strings.privacy }), el('p', { text }));
    this.messages.append(details);
  }

  /** Returns the whole row, not the bubble — the caller removes what it gets
   *  back, and removing only the bubble would strand its avatar. */
  private addThinking(): HTMLElement {
    const row = this.botRow(
      el('div', { class: 'wwc-msg wwc-msg-bot wwc-thinking', 'aria-label': this.strings.thinking }, [
        el('span', { class: 'wwc-dot' }),
        el('span', { class: 'wwc-dot' }),
        el('span', { class: 'wwc-dot' }),
      ]),
    );
    this.messages.append(row);
    scrollToBottom(this.messages);
    return row;
  }

  private setComposerEnabled(enabled: boolean): void {
    this.input.disabled = !enabled;
    this.sendButton.disabled = !enabled;
  }

  // --- Actions --------------------------------------------------------------

  private async addToCart(productId: number, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const original = button.textContent;
    const ok = await this.api.addToCart(productId);

    button.textContent = ok ? '✓' : this.strings.error;
    if (ok) {
      this.api.track('recommendation_add_to_cart', { product_id: productId });
      document.body.dispatchEvent(new CustomEvent('wc_fragment_refresh'));
    } else {
      window.setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 2500);
    }
  }

  private showCompare(set: RecommendationSet): void {
    this.api.track('recommendation_compare', { count: set.items.length });
    this.closeCompare();

    this.drawer = renderCompareDrawer(set, this.strings, () => this.closeCompare());
    this.panel.append(this.drawer);
    this.drawer.querySelector<HTMLElement>('button')?.focus();
  }

  private closeCompare(): void {
    this.drawer?.remove();
    this.drawer = null;
  }
}

function boot(): void {
  const config = window.WWC_CONFIG;
  if (!config) return;

  document.querySelectorAll<HTMLElement>('.wwc-widget-root').forEach((root) => {
    if (root.dataset.wwcMounted === '1') return;
    root.dataset.wwcMounted = '1';
    new ChatWidget(root, config);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export { ChatWidget };
