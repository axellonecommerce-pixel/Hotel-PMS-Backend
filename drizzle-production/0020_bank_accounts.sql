-- Bank accounts. Each motel keeps one or more named bank accounts; every
-- bank deposit, withdrawal, and expense or wage paid by check, debit card,
-- transfer or direct deposit moves money in or out of a chosen account.
-- Every motel always has a default account ("Main Bank Account"), so a bank
-- payment can never go unrecorded. Apply after 0019. Safe to re-run.

CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  bank_name text,
  account_last4 text CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9]{4}$'),
  account_type text NOT NULL DEFAULT 'checking' CHECK (account_type IN ('checking', 'savings')),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_property_name ON bank_accounts(property_id, lower(name));
--> statement-breakpoint
-- At most one default account per motel.
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_one_default ON bank_accounts(property_id) WHERE is_default;
--> statement-breakpoint
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_kind_check;
--> statement-breakpoint
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_check CHECK (kind IN (
  'cash_drop', 'bank_deposit', 'bank_withdrawal', 'expense', 'payroll', 'safe_count',
  'owner_contribution', 'owner_withdrawal', 'reversal', 'opening_balance', 'bank_reconcile'));
--> statement-breakpoint
-- Every motel gets a default bank account.
INSERT INTO bank_accounts (property_id, name, is_default)
SELECT p.id, 'Main Bank Account', true FROM properties p
WHERE NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.property_id = p.id);
--> statement-breakpoint
-- Bank movements recorded before accounts existed belong to the default account.
UPDATE cash_movements m SET bank_account_id = b.id
FROM bank_accounts b
WHERE b.property_id = m.property_id AND b.is_default AND m.bank_account_id IS NULL
  AND (m.from_location = 'bank' OR m.to_location = 'bank');
--> statement-breakpoint
-- The ledger keeps one account per bank account ("Bank - <name>"); the old
-- single "Bank" account moves to the default account's name.
UPDATE ledger_entries le SET account = 'Bank - ' || b.name
FROM bank_accounts b
WHERE b.property_id = le.property_id AND b.is_default AND le.account = 'Bank';
--> statement-breakpoint
-- A bank movement must say which bank account.
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_bank_account_required;
--> statement-breakpoint
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_bank_account_required
  CHECK ((from_location = 'bank' OR to_location = 'bank') IS NOT TRUE OR bank_account_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "hotel data isolation" ON bank_accounts;
--> statement-breakpoint
CREATE POLICY "hotel data isolation" ON bank_accounts FOR ALL TO authenticated
  USING (property_id IN (SELECT public.current_property_ids()))
  WITH CHECK (property_id IN (SELECT public.current_property_ids()));
