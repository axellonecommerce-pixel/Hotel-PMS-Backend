import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is making the current API request, so database writes can be
 * attributed in the audit log (migration 0027) without every route passing
 * it along. Each request gets its own context object (withRequestContext);
 * the sign-in check fills it in. A context is never shared between requests.
 */
type RequestContext = { actorAuthUserId: string | null; actorLabel: string | null; propertyId: string | null };

const storage = new AsyncLocalStorage<RequestContext>();

type Handler<A extends unknown[]> = (request: Request, ...args: A) => Promise<Response>;

export function withRequestContext<A extends unknown[]>(handler: Handler<A>): Handler<A> {
  return (request, ...args) => storage.run({ actorAuthUserId: null, actorLabel: null, propertyId: null }, () => handler(request, ...args));
}

/** Called by the sign-in check (or a system task) for the current request. */
export function setRequestActor(actor: { authUserId?: string | null; label?: string | null; propertyId?: string | null }) {
  const context = storage.getStore();
  if (!context) return;
  if (actor.authUserId !== undefined) context.actorAuthUserId = actor.authUserId;
  if (actor.label !== undefined) context.actorLabel = actor.label;
  if (actor.propertyId !== undefined) context.propertyId = actor.propertyId;
}

export function currentRequestActor(): RequestContext | undefined {
  return storage.getStore();
}
