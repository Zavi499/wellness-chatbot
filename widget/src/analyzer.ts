/**
 * Skin / hair analyzer page (shortcode-embedded, not the chat widget).
 *
 * A step machine: intro → optional photo → what the AI saw → the
 * questionnaire, one question per screen → product cards. Every step's shape
 * comes from the backend, so the wizard never has to know which questions
 * exist, which are conditional, or how many there are.
 */
import { el, clear, formatMessage } from './dom.js';
import { renderRecommendations } from './cards.js';
import { postJson, addToCart } from './http.js';
import { preparePhoto } from './analyzer-photo.js';
import type {
  AnalyzerConfig,
  AnalyzerKind,
  AnalyzerSession,
  AnalyzerStep,
  AnalyzerStrings,
  PhotoResult,
} from './analyzer-types.js';
import type { Language, RecommendationSet } from './types.js';

class Analyzer {
  private readonly strings: AnalyzerStrings;
  private readonly language: Language;
  private readonly kind: AnalyzerKind;

  private sessionId = '';
  private token = '';
  /** Answered keys, newest last — the trail the Back button walks. */
  private readonly trail: string[] = [];
  private busy = false;

  private readonly body: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly progressWrap: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly config: AnalyzerConfig,
  ) {
    this.kind = root.dataset.kind === 'hair' ? 'hair' : 'skin';
    this.language = config.language === 'ar' ? 'ar' : 'en';
    this.strings = config.strings[this.language];

    this.progressLabel = el('span', { class: 'wwc-an-progress-label' });
    this.progressBar = el('span', { class: 'wwc-an-progress-fill' });
    this.progressWrap = el('div', { class: 'wwc-an-progress', hidden: true }, [
      this.progressLabel,
      el('span', { class: 'wwc-an-progress-track' }, [this.progressBar]),
    ]);

    this.body = el('div', { class: 'wwc-an-body' });

    root.classList.add('wwc-analyzer-root', 'wwc-ready');
    if (config.isRtl) root.setAttribute('dir', 'rtl');
    clear(root);
    root.append(this.progressWrap, this.body);

    this.renderIntro();
  }

  // --- Chrome ---------------------------------------------------------------

  private setProgress(step: number, total: number): void {
    if (total <= 0) {
      this.progressWrap.hidden = true;
      return;
    }
    this.progressWrap.hidden = false;
    this.progressLabel.textContent = this.strings.stepOf
      .replace('%1$d', String(step))
      .replace('%2$d', String(total));
    this.progressBar.style.width = `${Math.round((step / total) * 100)}%`;
  }

  private screen(title: string, nodes: (Node | string)[], className = ''): void {
    clear(this.body);
    this.body.append(
      el('section', { class: `wwc-an-screen ${className}`.trim() }, [
        el('h2', { class: 'wwc-an-title', text: title }),
        ...nodes,
      ]),
    );
    this.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private showError(message: string): void {
    this.body.prepend(el('p', { class: 'wwc-an-error', role: 'alert', text: message }));
  }

  /** Guards every network action so a double-tap can't double-submit. */
  private async guard<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.busy) return null;
    this.busy = true;
    this.root.classList.add('wwc-an-busy');
    try {
      return await fn();
    } catch (err) {
      this.showError(err instanceof Error && err.message ? err.message : this.strings.error);
      return null;
    } finally {
      this.busy = false;
      this.root.classList.remove('wwc-an-busy');
    }
  }

  private post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return postJson<T>(this.config.restUrl, path, {
      session_id: this.sessionId,
      token: this.token,
      ...body,
    });
  }

  // --- Steps ----------------------------------------------------------------

  private renderIntro(): void {
    const isSkin = this.kind === 'skin';
    const start = el('button', {
      type: 'button',
      class: 'wwc-btn wwc-btn-primary wwc-an-cta',
      text: this.strings.start,
    });
    start.addEventListener('click', () => void this.start());

    this.screen(
      isSkin ? this.strings.skinTitle : this.strings.hairTitle,
      [
        el('p', { class: 'wwc-an-lede', text: isSkin ? this.strings.skinIntro : this.strings.hairIntro }),
        start,
      ],
      'wwc-an-intro',
    );
  }

  private async start(): Promise<void> {
    await this.guard(async () => {
      const session = await postJson<AnalyzerSession>(this.config.restUrl, '/analyzer/session', {
        kind: this.kind,
        language: this.language,
      });
      this.sessionId = session.session_id;
      this.token = session.token;
      this.renderPhotoStep(session);
    });
  }

  private renderPhotoStep(step: AnalyzerStep, notice?: string): void {
    this.setProgress(0, 0);

    const input = el('input', {
      type: 'file',
      accept: 'image/*',
      class: 'wwc-an-file',
      id: 'wwc-an-file',
    });
    const choose = el('label', {
      class: 'wwc-btn wwc-btn-primary wwc-an-choose',
      for: 'wwc-an-file',
      text: this.strings.choosePhoto,
    });
    const skip = el('button', {
      type: 'button',
      class: 'wwc-btn wwc-btn-ghost',
      text: this.strings.skipPhoto,
    });
    skip.addEventListener('click', () => this.renderStep(step));

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.uploadPhoto(file);
    });

    const nodes: (Node | string)[] = [];
    if (notice) nodes.push(el('p', { class: 'wwc-an-notice', role: 'alert', text: notice }));
    nodes.push(
      el('p', { class: 'wwc-an-lede', text: this.strings.photoHint }),
      el('div', { class: 'wwc-an-actions' }, [input, choose, skip]),
      el('p', { class: 'wwc-an-privacy', text: this.strings.photoPrivacy }),
    );

    this.screen(this.strings.photoPrompt, nodes, 'wwc-an-photo');
  }

  private async uploadPhoto(file: File): Promise<void> {
    await this.guard(async () => {
      this.screen(this.strings.photoPrompt, [
        el('p', { class: 'wwc-an-lede wwc-an-working', text: this.strings.analyzing }),
      ], 'wwc-an-photo');

      let dataUrl: string;
      try {
        ({ dataUrl } = await preparePhoto(file));
      } catch {
        this.renderPhotoStep({ done: false, progress: { step: 0, total: 0 } }, this.strings.notAnImage);
        return;
      }

      let result: PhotoResult;
      try {
        result = await this.post<PhotoResult>('/analyzer/photo', { image: dataUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        const friendly =
          message === 'too_large'
            ? this.strings.tooLarge
            : message === 'not_an_image'
              ? this.strings.notAnImage
              : message || this.strings.error;
        this.renderPhotoStep({ done: false, progress: { step: 0, total: 0 } }, friendly);
        return;
      }

      if (!result.usable && !result.refer_to_professional) {
        // Specific, fixable feedback beats a generic failure — the customer
        // gets told what to change and lands straight back on the picker.
        this.renderPhotoStep(result, result.unusable_reason ?? this.strings.photoUnusable);
        return;
      }

      this.renderReading(result);
    });
  }

  /** What the AI saw, before any question — or a referral instead of it. */
  private renderReading(result: PhotoResult): void {
    const cont = el('button', {
      type: 'button',
      class: 'wwc-btn wwc-btn-primary wwc-an-cta',
      text: this.strings.next,
    });
    cont.addEventListener('click', () => this.renderStep(result));

    const nodes: (Node | string)[] = [];
    if (result.refer_to_professional && result.referral_note) {
      nodes.push(el('p', { class: 'wwc-an-referral', role: 'alert' }, [formatMessage(result.referral_note)]));
    } else if (result.summary) {
      nodes.push(el('div', { class: 'wwc-an-summary' }, [formatMessage(result.summary)]));
      if (result.prefilled.length) {
        nodes.push(el('p', { class: 'wwc-an-note', text: this.strings.prefilledNote }));
      }
    }
    nodes.push(cont);

    this.screen(this.strings.whatISaw, nodes, 'wwc-an-reading');
  }

  private renderStep(step: AnalyzerStep): void {
    if (step.done) {
      this.renderResults(step.recommendations);
      return;
    }
    const question = step.question;
    if (!question) {
      this.showError(this.strings.error);
      return;
    }

    this.setProgress(step.progress.step, step.progress.total);

    const options = el('div', { class: 'wwc-an-options' });
    for (const option of question.options) {
      const button = el('button', {
        type: 'button',
        class: 'wwc-chip wwc-an-option',
        text: option.label,
      });
      button.addEventListener('click', () => void this.answer(question.key, option.value));
      options.append(button);
    }

    const nodes: (Node | string)[] = [options];
    if (this.trail.length) {
      const back = el('button', { type: 'button', class: 'wwc-btn wwc-btn-link', text: this.strings.back });
      back.addEventListener('click', () => void this.goBack());
      nodes.push(back);
    }

    this.screen(question.text, nodes, 'wwc-an-question');
  }

  private async answer(key: string, value: string): Promise<void> {
    await this.guard(async () => {
      const step = await this.post<AnalyzerStep>('/analyzer/answer', { key, value });
      this.trail.push(key);
      this.renderStep(step);
    });
  }

  private async goBack(): Promise<void> {
    const key = this.trail.pop();
    if (!key) return;
    await this.guard(async () => {
      const step = await this.post<AnalyzerStep>('/analyzer/answer', { key, clear: true });
      this.renderStep(step);
    });
  }

  private renderResults(set: RecommendationSet | undefined): void {
    this.setProgress(0, 0);

    const again = el('button', {
      type: 'button',
      class: 'wwc-btn wwc-btn-ghost wwc-an-restart',
      text: this.strings.startOver,
    });
    again.addEventListener('click', () => {
      this.sessionId = '';
      this.token = '';
      this.trail.length = 0;
      this.renderIntro();
    });

    const nodes: (Node | string)[] = [];
    if (set && set.items.length) {
      // Strip the two actions this surface has no answer for, rather than
      // render buttons wired to no-op handlers: "replace" needs a re-run
      // endpoint the analyzer does not have, and the compare drawer is
      // positioned to cover a chat panel that is not on this page.
      const shown = {
        ...set,
        items: set.items.map((item) => ({
          ...item,
          actions: item.actions.filter((a) => a !== 'replace' && a !== 'compare'),
        })),
      };
      nodes.push(
        renderRecommendations(
          shown,
          this.strings,
          {
            onViewProduct: () => undefined,
            onAddToCart: (item, button) => void this.handleAddToCart(item.product_id, button),
            onCompare: () => undefined,
            onReplace: () => undefined,
          },
          { allowCompare: false },
        ),
      );
    } else {
      nodes.push(el('p', { class: 'wwc-an-lede', text: set?.shortfall_note ?? this.strings.error }));
    }
    nodes.push(again);

    this.screen(this.strings.resultsTitle, nodes, 'wwc-an-results');
  }

  private async handleAddToCart(productId: number, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const original = button.textContent;
    const ok = await addToCart(this.config.addToCartUrl, productId);
    button.textContent = ok ? '✓' : this.strings.error;
    window.setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 2000);
  }
}

function boot(): void {
  const config = window.WWC_ANALYZER_CONFIG;
  if (!config) return;

  document.querySelectorAll<HTMLElement>('.wwc-analyzer-mount').forEach((root) => {
    if (root.dataset.wwcMounted === '1') return;
    root.dataset.wwcMounted = '1';
    new Analyzer(root, config);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export { Analyzer };
