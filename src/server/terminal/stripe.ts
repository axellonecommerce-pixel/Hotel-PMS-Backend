// Minimal Stripe API client for Stripe Terminal (server-driven readers),
// refunds and payouts. Plain HTTPS with form encoding; no SDK needed.

export class ProcessorError extends Error {
  constructor(message: string, readonly status = 502, readonly code?: string) {
    super(message);
  }
}

type Params = Record<string, unknown>;

/** Stripe's form encoding: nested objects as a[b]=c, arrays as a[]=c. */
export function encode(params: Params, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [rawKey, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const key = prefix ? `${prefix}[${rawKey}]` : rawKey;
    if (Array.isArray(value)) for (const item of value) parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
    else if (typeof value === "object") parts.push(...encode(value as Params, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts;
}

export async function stripeRequest<T>(secretKey: string, method: "GET" | "POST", path: string, params: Params = {}, idempotencyKey?: string): Promise<T> {
  const query = encode(params).join("&");
  const url = `https://api.stripe.com${path}${method === "GET" && query ? `?${query}` : ""}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": "2024-06-20",
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: method === "POST" ? query : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ProcessorError("The card processor could not be reached. Check the internet connection and try again.");
  }
  const data = await response.json().catch(() => null) as (T & { error?: { message?: string; code?: string } }) | null;
  if (!response.ok || !data) {
    const message = data?.error?.message ?? `The card processor answered ${response.status}.`;
    throw new ProcessorError(response.status === 401 ? "The Stripe key was refused. Check it in Settings › Payment Terminal." : message, response.status === 401 ? 401 : 502, data?.error?.code);
  }
  return data;
}

export type StripeReader = { id: string; label: string | null; device_type: string; status: "online" | "offline" | null; location: string | null; action: { status: string; failure_message?: string | null } | null };
export type StripePaymentIntent = {
  id: string; status: string; amount: number;
  last_payment_error?: { message?: string } | null;
  latest_charge?: { id: string; payment_method_details?: { card_present?: { brand?: string; last4?: string } } } | string | null;
};
export type StripeBalanceTransaction = {
  id: string; type: string; amount: number; fee: number; net: number;
  source: { object: string; id: string; payment_intent?: string | null } | string | null;
};

/** Every page of a Stripe list. */
export async function stripeList<T extends { id: string }>(secretKey: string, path: string, params: Params = {}, max = 1000) {
  const items: T[] = [];
  let startingAfter: string | undefined;
  while (items.length < max) {
    const page = await stripeRequest<{ data: T[]; has_more: boolean }>(secretKey, "GET", path, { limit: 100, ...params, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    items.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return items;
}

export const isStripeKey = (value: string) => /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(value.trim());
export const isLiveKey = (value: string) => /^(sk|rk)_live_/.test(value.trim());
