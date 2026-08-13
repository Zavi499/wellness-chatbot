/**
 * Wellness World chat widget (spec §9).
 *
 * Vanilla TypeScript, no framework, because this loads on every storefront
 * page. All conversation text comes from the backend; this file only owns the
 * chrome, the interactions, and the accessibility behaviour.
 */
import { Api } from './api.js';
import { el, clear, formatMessage, scrollToBottom, trapFocus } from './dom.js';
import { renderCompareDrawer, renderFeedback, renderHandoff, renderRecommendations } from './cards.js';
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
      this.root.append(this.launcher, this.panel);
    } else {
      this.root.append(this.panel);
      void this.ensureStarted();
    }

    this.root.classList.add('wwc-ready');
    if (this.config.isRtl) this.root.setAttribute('dir', 'rtl');
  }

  private buildPanel(): HTMLElement {
    const panel = el('section', {
      class: 'wwc-panel',
      role: 'dialog',
      'aria-label': this.strings.title,
    });

    // Header
    const header = el('header', { class: 'wwc-header' }, [
      el('h2', { class: 'wwc-title', text: this.strings.title }),
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

    if (response.escalation) {
      this.messages.append(renderHandoff(response.escalation.handoff, this.strings));
    }

    // Selling is off for the rest of the conversation: hide the product-finder
    // affordances rather than leaving dead controls on screen.
    if (response.selling_blocked) {
      this.progress.hidden = true;
      clear(this.quickReplies);
    } else {
      this.renderQuickReplies(response);
      this.renderProgress(response);
    }

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

    this.messages.append(bubble);
    scrollToBottom(this.messages);
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

  private addThinking(): HTMLElement {
    const node = el('div', { class: 'wwc-msg wwc-msg-bot wwc-thinking', 'aria-label': this.strings.thinking }, [
      el('span', { class: 'wwc-dot' }),
      el('span', { class: 'wwc-dot' }),
      el('span', { class: 'wwc-dot' }),
    ]);
    this.messages.append(node);
    scrollToBottom(this.messages);
    return node;
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
