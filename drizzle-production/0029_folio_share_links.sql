-- Private folio links sent to guests (Send to Guest › text or email from the
-- front-desk device). Apply BEFORE deploying the API that uses it. Safe to
-- re-run.
--
-- Each link is a copy of the folio exactly as the motel prints it, taken
-- when it was sent, behind a long random code. Only a hash of the code is
-- stored, so the database alone cannot be used to open a link. Links never
-- expire (kept for life, like all InnSeva data); staff can turn them off.

CREATE TABLE IF NOT EXISTS public.folio_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  reservation_id uuid NOT NULL REFERENCES public.reservations(id),
  folio_id uuid NOT NULL REFERENCES public.folios(id),
  token_hash text NOT NULL UNIQUE,
  title text NOT NULL,
  document_html text NOT NULL,
  channels text[] NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS folio_share_links_reservation
  ON public.folio_share_links (property_id, reservation_id);
--> statement-breakpoint
ALTER TABLE public.folio_share_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.folio_share_links FROM anon, authenticated;
