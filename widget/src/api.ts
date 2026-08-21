/**
 * Talks to the WordPress REST proxy — never to the backend or OpenAI directly.
 * The session token lives in memory only, matching the spec's stateless-frontend
 * constraint (no localStorage).
 */
import type { ChatResponse, Language, SessionResponse, WidgetConfig } from './types.js';

export class Api {
  private token = '';
  private sessionId = '';

  constructor(private readonly config: WidgetConfig) {}

  get session(): string {
    return this.sessionId;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.config.restUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error((detail as { message?: string }).message ?? `Request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  async start(language?: Language): Promise<SessionResponse> {
    const data = await this.post<SessionResponse>('/session', { language });
    this.sessionId = data.session_id;
    this.token = data.token;
    return data;
  }

  async send(message: string, answer?: { key: string; value: string | string[] }): Promise<ChatResponse> {
    return this.post<ChatResponse>('/message', {
      session_id: this.sessionId,
      token: this.token,
      message,
      answer,
    });
  }

  async feedback(messageId: string, rating: 'up' | 'down', reason?: string): Promise<void> {
    await this.post('/feedback', {
      session_id: this.sessionId,
      token: this.token,
      message_id: messageId,
      rating,
      reason,
    }).catch(() => undefined); // feedback must never break the conversation
  }

  /** Fire-and-forget KPI event. */
  track(name: string, payload?: Record<string, string | number>): void {
    if (!this.sessionId) return;
    void this.post('/event', {
      session_id: this.sessionId,
      token: this.token,
      name,
      payload,
    }).catch(() => undefined);
  }

  /**
   * Adds to cart through WooCommerce's own AJAX endpoint (`?wc-ajax=add_to_cart`,
   * built server-side via `WC_AJAX::get_endpoint()` — see `addToCartUrl` in
   * class-wwc-widget.php) — the chatbot backend never touches cart or
   * checkout state (spec §4.7). This is a different mechanism from
   * WordPress's generic admin-ajax.php: WooCommerce routes it by the
   * `wc-ajax` query param on the URL, not an `action` field in the body.
   */
  async addToCart(productId: number): Promise<boolean> {
    if (!this.config.addToCartUrl) return false;

    const body = new URLSearchParams({
      product_id: String(productId),
      quantity: '1',
    });

    try {
      const response = await fetch(this.config.addToCartUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'same-origin',
        body,
      });
      if (!response.ok) return false;
      const data = (await response.json().catch(() => null)) as { error?: boolean } | null;
      return !data?.error;
    } catch {
      return false;
    }
  }
}
