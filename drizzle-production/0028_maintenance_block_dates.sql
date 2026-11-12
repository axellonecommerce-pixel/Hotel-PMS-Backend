-- Out-of-order dates for maintenance blocks as real date columns. Apply
-- after 0027, BEFORE deploying the API that reads them. Safe to re-run.
--
-- The block dates are kept in maintenance_orders.notes (JSON text:
-- {"blockFrom":"2026-11-20","blockTo":"2026-11-22",…}) and every
-- availability check, booking and room move parsed them from text. These
-- columns are filled by the database from the notes on every save, so the
-- code that writes notes keeps working, and lookups can use an index. Notes
-- that are not JSON or have no valid dates simply leave the columns empty.

CREATE OR REPLACE FUNCTION public.innseva_note_date(notes text, field text) RETURNS date
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  value text;
BEGIN
  IF notes IS NULL OR left(ltrim(notes), 1) <> '{' THEN RETURN NULL; END IF;
  value := (notes::jsonb) ->> field;
  IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN make_date(substr(value, 1, 4)::int, substr(value, 6, 2)::int, substr(value, 9, 2)::int);
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.innseva_note_date(text, text) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.maintenance_orders
  ADD COLUMN IF NOT EXISTS block_from date GENERATED ALWAYS AS (public.innseva_note_date(notes, 'blockFrom')) STORED;
--> statement-breakpoint
ALTER TABLE public.maintenance_orders
  ADD COLUMN IF NOT EXISTS block_to date GENERATED ALWAYS AS (public.innseva_note_date(notes, 'blockTo')) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS maintenance_orders_room_block
  ON public.maintenance_orders (room_id, block_from, block_to)
  WHERE rentable = false;
