/**
 * Talks to the WordPress REST proxy — never to the backend or OpenAI directly.
 * The session token lives in memory only, matching the spec's stateless-frontend
 * constraint (no localStorage).
 */
import { postJson, addToCart } from './http.js';
import type { ChatResponse, Language, SessionResponse, WidgetConfig } from './types.js';

export class Api {
  private token = '';
  private sessionId = '';

  constructor(private readonly config: WidgetConfig) {}

  get session(): string {
    return this.sessionId;
  }

  private post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return postJson<T>(this.config.restUrl, path, body);
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

  /** See `http.ts` — shared with the skin/hair analyzers. */
  addToCart(productId: number): Promise<boolean> {
    return addToCart(this.config.addToCartUrl, productId);
  }
}
