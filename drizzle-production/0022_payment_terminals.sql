-- Card terminal connection (Settings › Payment Terminal). Without a
-- connection, card payments are keyed in and deposits are recorded on Cash &
-- Bank (by hand or estimated automatically). With one, the front desk sends
-- charges to the card reader, approved charges post to the folio, refunds go
-- back to the card, and deposits with exact fees come from the processor's
-- payouts. Apply after 0021. Safe to re-run.

CREATE TABLE IF NOT EXISTS payment_terminal_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
  account_id text,
  account_name text,
  livemode boolean NOT NULL DEFAULT false,
  location_id text,
  deposit_bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  last_payout_sync_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The processor key, encrypted by the API. No property_id column and RLS with
-- no policies: no staff login can ever read it, only the server.
CREATE TABLE IF NOT EXISTS payment_terminal_secrets (
  connection_id uuid PRIMARY KEY REFERENCES payment_terminal_connections(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE payment_terminal_secrets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS terminal_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES payment_terminal_connections(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  folio_id uuid REFERENCES folios(id) ON DELETE SET NULL,
  reader_id text NOT NULL,
  reader_label text,
  provider_payment_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed', 'canceled')),
  -- The posted payment (payments.terminal_payment_id links back). Not a
  -- foreign key, so backups can restore the two tables in order.
  payment_id uuid,
  error text,
  created_by_auth_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS terminal_payments_provider_id ON terminal_payments(property_id, provider_payment_id);
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terminal_payment_id uuid REFERENCES terminal_payments(id) ON DELETE SET NULL;
--> statement-breakpoint
-- The processor's refund id, so a payout's refunds match the PMS refunds.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS external_reference text;
--> statement-breakpoint
-- A processor payout becomes one deposit, once.
ALTER TABLE card_settlements ADD COLUMN IF NOT EXISTS external_id text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS card_settlements_external_id ON card_settlements(property_id, external_id) WHERE external_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE payment_terminal_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "hotel data isolation" ON payment_terminal_connections;
--> statement-breakpoint
CREATE POLICY "hotel data isolation" ON payment_terminal_connections FOR ALL TO authenticated
  USING (property_id IN (SELECT public.current_property_ids()))
  WITH CHECK (property_id IN (SELECT public.current_property_ids()));
--> statement-breakpoint
ALTER TABLE terminal_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "hotel data isolation" ON terminal_payments;
--> statement-breakpoint
CREATE POLICY "hotel data isolation" ON terminal_payments FOR ALL TO authenticated
  USING (property_id IN (SELECT public.current_property_ids()))
  WITH CHECK (property_id IN (SELECT public.current_property_ids()));
