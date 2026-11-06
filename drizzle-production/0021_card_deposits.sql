-- Card and check deposits. Guest card and check payments are held in
-- "Card & Check Receipts" until the processor (or the bank, for checks)
-- deposits them. A deposit moves the money into a bank account; what the
-- processor kept is posted as Card Processing Fees. Apply after 0020.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS card_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  -- The day the money reached the bank.
  deposit_date date NOT NULL,
  gross_cents integer NOT NULL,
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  net_cents integer NOT NULL,
  item_count integer NOT NULL CHECK (item_count > 0),
  reference text,
  note text,
  automatic boolean NOT NULL DEFAULT false,
  created_by_auth_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CHECK (net_cents = gross_cents - fee_cents)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS card_settlements_property_date ON card_settlements(property_id, deposit_date);
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settlement_id uuid REFERENCES card_settlements(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS settlement_id uuid REFERENCES card_settlements(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payments_unsettled ON payments(property_id) WHERE settlement_id IS NULL;
--> statement-breakpoint
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_kind_check;
--> statement-breakpoint
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_check CHECK (kind IN (
  'cash_drop', 'bank_deposit', 'bank_withdrawal', 'expense', 'payroll', 'safe_count',
  'owner_contribution', 'owner_withdrawal', 'reversal', 'opening_balance', 'bank_reconcile', 'card_settlement'));
--> statement-breakpoint
ALTER TABLE card_settlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "hotel data isolation" ON card_settlements;
--> statement-breakpoint
CREATE POLICY "hotel data isolation" ON card_settlements FOR ALL TO authenticated
  USING (property_id IN (SELECT public.current_property_ids()))
  WITH CHECK (property_id IN (SELECT public.current_property_ids()));
