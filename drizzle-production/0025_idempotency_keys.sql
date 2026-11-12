-- Retry protection for money actions (payments, refunds, charges, deposits,
-- transfers, checkout, paid-outs, cash drops, invoices, expenses, …). The
-- browser sends an Idempotency-Key header; the first request with a key does
-- the work and its answer is kept here; a repeat with the same key (a double
-- tap, or a retry after a lost reply) gets that answer instead of a second
-- payment. Apply after 0024. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  -- Who sent it and to which action: signed-in user, motel, path.
  scope text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  -- 0 while the first request is still running; then its HTTP status.
  status integer NOT NULL DEFAULT 0,
  body text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  PRIMARY KEY (scope, key)
);
--> statement-breakpoint
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.idempotency_keys FROM anon, authenticated;
