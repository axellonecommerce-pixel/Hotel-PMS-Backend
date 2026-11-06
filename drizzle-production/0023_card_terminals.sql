-- Card terminals of any brand (Chase, Clover, Square, Worldpay, Fiserv,
-- Heartland, Stripe, other). A standalone terminal runs the card itself; the
-- front desk records which terminal took each card payment (with its
-- approval code), and the processor's deposit report is imported on Cash &
-- Bank to deposit each batch with its exact fees. Direct (integrated)
-- drivers, such as Stripe Terminal, are optional extras. Apply after 0022.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS card_terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  provider text NOT NULL DEFAULT 'other' CHECK (provider IN ('chase', 'clover', 'square', 'worldpay', 'fiserv', 'heartland', 'elavon', 'stripe', 'other')),
  -- The processor's terminal / merchant id printed on the receipt (helps match reports).
  terminal_code text,
  deposit_bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  -- Days from the batch (the day the cards were taken) to the bank deposit.
  deposit_delay_days integer NOT NULL DEFAULT 1 CHECK (deposit_delay_days BETWEEN 0 AND 14),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  -- Remembered column mapping for this processor's deposit report (CSV).
  report_mapping jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS card_terminals_property_name ON card_terminals(property_id, lower(name));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS card_terminals_one_default ON card_terminals(property_id) WHERE is_default AND active;
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_terminal_id uuid REFERENCES card_terminals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE card_terminals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "hotel data isolation" ON card_terminals;
--> statement-breakpoint
CREATE POLICY "hotel data isolation" ON card_terminals FOR ALL TO authenticated
  USING (property_id IN (SELECT public.current_property_ids()))
  WITH CHECK (property_id IN (SELECT public.current_property_ids()));
