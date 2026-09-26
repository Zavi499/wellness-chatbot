/**
 * The HTTP bits both front-ends need.
 *
 * Extracted from `api.ts` when the skin/hair analyzers arrived: they talk to
 * the same WordPress REST proxy and add to the same WooCommerce cart, and a
 * second hand-rolled copy of this would be the kind of thing that quietly
 * drifts — one surface gaining a fix the other never gets.
 */

/**
 * POSTs JSON to the WordPress REST proxy. Throws with the server's own
 * message when there is one, since WP REST puts the useful text in `message`.
 */
export async function postJson<T>(restUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${restUrl}${path}`, {
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

/**
 * Adds to cart through WooCommerce's own AJAX endpoint (`?wc-ajax=add_to_cart`,
 * built server-side via `WC_AJAX::get_endpoint()`) — not admin-ajax.php, which
 * has no matching action registered. The chatbot backend never touches cart
 * or checkout state (spec §4.7).
 */
export async function addToCart(addToCartUrl: string, productId: number): Promise<boolean> {
  if (!addToCartUrl) return false;

  const body = new URLSearchParams({ product_id: String(productId), quantity: '1' });

  try {
    const response = await fetch(addToCartUrl, {
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
