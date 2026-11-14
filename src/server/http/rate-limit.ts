import { createHash } from "node:crypto";

import { hasProductionDatabase, productionSql } from "@/server/db/production";

/**
 * Limits how often one caller (by IP address) may hit an endpoint that needs
 * no sign-in, so nobody can flood it or try codes and keys at speed. Counted
 * in the database, so every server instance shares the count. A database
 * hiccup never blocks a real guest or the Gmail import: the request goes on.
 */
export function callerAddress(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

// Only a hash of the address is stored.
const bucketFor = (request: Request, name: string) => `${name}:${createHash("sha256").update(callerAddress(request)).digest("hex").slice(0, 32)}`;

/** Counts this request and says whether the caller is over the limit. */
export async function overRateLimit(request: Request, name: string, limit: number, windowSeconds = 60) {
  if (!hasProductionDatabase()) return false;
  const bucket = bucketFor(request, name);
  try {
    const [row] = await productionSql()<Array<{ hits: number }>>`
      insert into api_rate_limits (bucket, window_start, hits)
      values (${bucket}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
      on conflict (bucket, window_start) do update set hits = api_rate_limits.hits + 1
      returning hits
    `;
    return (row?.hits ?? 0) > limit;
  } catch {
    return false;
  }
}

/** Whether the caller already went over the limit (without counting this request). */
export async function rateLimitReached(request: Request, name: string, limit: number, windowSeconds = 60) {
  if (!hasProductionDatabase()) return false;
  try {
    const [row] = await productionSql()<Array<{ hits: number }>>`
      select hits from api_rate_limits
      where bucket=${bucketFor(request, name)} and window_start=to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds})
    `;
    return (row?.hits ?? 0) >= limit;
  } catch {
    return false;
  }
}

export const tooManyRequests = (retryAfterSeconds = 60) => Response.json(
  { error: "Too many requests. Please wait a minute and try again." },
  { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
);
