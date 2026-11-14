-- Request limits for the endpoints anyone can reach without signing in
-- (guest folio links, the Gmail booking import). Apply BEFORE deploying the
-- API that uses it. Safe to re-run.
--
-- One row per caller per minute window; the daily job deletes old windows.

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
--> statement-breakpoint
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.api_rate_limits FROM anon, authenticated;
