-- Cash sources and accounting.
--
-- Cash lives in three places: the front-desk drawer (the Cash Drop shift),
-- the safe, and the bank. Every movement between them (a cash drop into the
-- safe, a bank deposit, an expense or wage paid in cash from the drawer or
-- the safe, a safe count) is one row here. The safe and bank balances are the
-- sum of these rows; the drawer stays reconciled by its shift.
--
-- Safe to re-run: every statement is idempotent.

CREATE TABLE IF NOT EXISTS cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  -- NULL from_location: money came from outside (owner, opening balance).
  -- NULL to_location: money left the business (paid to a vendor or employee).
  from_location text CHECK (from_location IS NULL OR from_location IN ('drawer', 'safe', 'bank')),
  to_location text CHECK (to_location IS NULL OR to_location IN ('drawer', 'safe', 'bank')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  kind text NOT NULL CHECK (kind IN ('cash_drop', 'bank_deposit', 'bank_withdrawal', 'expense', 'payroll', 'safe_count', 'owner_contribution', 'owner_withdrawal', 'reversal')),
  resource_type text,
  resource_id uuid,
  description text NOT NULL,
  reference text,
  note text,
  created_by_auth_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CHECK (from_location IS DISTINCT FROM to_location)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cash_movements_property_date ON cash_movements(property_id, business_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cash_movements_resource ON cash_movements(property_id, resource_type, resource_id);
--> statement-breakpoint
-- A paid out created by an expense or a wage paid from the drawer. It lowers
-- the shift's expected cash, but the expense or wage is what the P&L counts.
ALTER TABLE paid_outs ADD COLUMN IF NOT EXISTS source_type text;
--> statement-breakpoint
ALTER TABLE paid_outs ADD COLUMN IF NOT EXISTS source_id uuid;
--> statement-breakpoint
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cash_source text CHECK (cash_source IS NULL OR cash_source IN ('drawer', 'safe'));
--> statement-breakpoint
ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS cash_source text CHECK (cash_source IS NULL OR cash_source IN ('drawer', 'safe'));
--> statement-breakpoint
-- Existing cash drops went into the safe. Record them once so the safe has a
-- history; a Safe Count afterwards sets the real balance.
INSERT INTO cash_movements (property_id, business_date, from_location, to_location, amount_cents, kind, resource_type, resource_id, description, created_at)
SELECT cd.property_id, bd.business_date, 'drawer', 'safe', cd.amount_cents, 'cash_drop', 'cash-drop', cd.id,
  'Cash drop from ' || coalesce(e.name, 'shift'), cd.created_at
FROM cash_drops cd
JOIN cash_shifts cs ON cs.id = cd.cash_shift_id
JOIN business_days bd ON bd.id = cs.business_day_id
LEFT JOIN employees e ON e.id = cs.employee_id
WHERE cd.amount_cents > 0
  AND NOT EXISTS (SELECT 1 FROM cash_movements m WHERE m.resource_type = 'cash-drop' AND m.resource_id = cd.id);
--> statement-breakpoint
INSERT INTO ledger_entries (property_id, business_date, account, debit_cents, credit_cents, resource_type, resource_id, description)
SELECT m.property_id, m.business_date, x.account, x.debit, x.credit, 'cash-drop', m.resource_id, m.description
FROM cash_movements m
CROSS JOIN LATERAL (VALUES ('Cash - Safe', m.amount_cents, 0), ('Cash', 0, m.amount_cents)) AS x(account, debit, credit)
WHERE m.kind = 'cash_drop'
  AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.resource_type = 'cash-drop' AND le.resource_id = m.resource_id);
--> statement-breakpoint
-- Wages paid before this change were never posted to the ledger. Post them
-- (on their paid date) so the trial balance includes payroll. The cash source
-- of these older payments is unknown.
INSERT INTO ledger_entries (property_id, business_date, account, debit_cents, credit_cents, resource_type, resource_id, description)
SELECT pe.property_id, pe.paid_on, x.account, x.debit, x.credit, 'payroll', pe.id, 'Wages paid (' || coalesce(pe.payment_method, 'Cash') || ')'
FROM payroll_entries pe
CROSS JOIN LATERAL (
  SELECT (pe.gross_pay_cents + coalesce(CASE WHEN pe.description ~ '^\s*\{' THEN (pe.description::jsonb->>'adjustmentCents')::int END, 0)) AS amount
) amt
CROSS JOIN LATERAL (VALUES
  ('Payroll Expense', amt.amount, 0),
  (CASE WHEN coalesce(pe.payment_method, 'Cash') = 'Cash' THEN 'Cash - Unspecified' WHEN pe.payment_method IN ('Check', 'Direct deposit') THEN 'Bank' ELSE 'Accounts Payable' END, 0, amt.amount)
) AS x(account, debit, credit)
WHERE pe.paid AND pe.paid_on IS NOT NULL AND amt.amount > 0
  AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.resource_type = 'payroll' AND le.resource_id = pe.id);
--> statement-breakpoint
-- Guest, house-account and company payments were never posted to the
-- ledger, so Guest Receivable never went down and cash/card receipts never
-- showed. Post every past payment and refund once, on its own date. Same
-- rules as src/server/finance/payment-ledger.ts.
INSERT INTO ledger_entries (property_id, business_date, account, debit_cents, credit_cents, resource_type, resource_id, description)
SELECT p.property_id, p.effective_date, x.account, x.debit, x.credit, 'payment', p.id,
  CASE WHEN upper(p.method) = 'DIRECT BILL' THEN 'Balance moved to the company invoice' ELSE 'Payment received · ' || p.method END
FROM payments p
CROSS JOIN LATERAL (VALUES
  (CASE WHEN upper(p.method) = 'DIRECT BILL' THEN 'Company Receivable' WHEN lower(trim(p.method)) = 'cash' THEN 'Cash' ELSE 'Card & Check Receipts' END, p.amount_cents, 0),
  (CASE WHEN upper(p.method) = 'DIRECT BILL' THEN 'Guest Receivable' WHEN p.house_account_id IS NOT NULL THEN 'House Account Receivable'
        WHEN p.reservation_id IS NOT NULL THEN 'Guest Receivable' WHEN p.company_id IS NOT NULL THEN 'Company Receivable' ELSE 'Guest Receivable' END, 0, p.amount_cents)
) AS x(account, debit, credit)
WHERE upper(p.method) NOT IN ('BAD DEBT', 'OTA COMMISSION') AND p.amount_cents > 0
  AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.resource_type = 'payment' AND le.resource_id = p.id);
--> statement-breakpoint
INSERT INTO ledger_entries (property_id, business_date, account, debit_cents, credit_cents, resource_type, resource_id, description)
SELECT r.property_id, r.effective_date, x.account, x.debit, x.credit, 'refund', r.id, 'Refund · ' || p.method
FROM refunds r JOIN payments p ON p.id = r.payment_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN p.house_account_id IS NOT NULL THEN 'House Account Receivable' WHEN p.reservation_id IS NOT NULL THEN 'Guest Receivable'
        WHEN p.company_id IS NOT NULL THEN 'Company Receivable' ELSE 'Guest Receivable' END, r.amount_cents, 0),
  (CASE WHEN lower(trim(p.method)) = 'cash' THEN 'Cash' ELSE 'Card & Check Receipts' END, 0, r.amount_cents)
) AS x(account, debit, credit)
WHERE upper(p.method) NOT IN ('BAD DEBT', 'OTA COMMISSION', 'DIRECT BILL') AND r.amount_cents > 0
  AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.resource_type = 'refund' AND le.resource_id = r.id);
--> statement-breakpoint
-- Tenant isolation (same policy as supabase/rls.sql) for the new table.
ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "hotel data isolation" ON cash_movements;
--> statement-breakpoint
CREATE POLICY "hotel data isolation" ON cash_movements FOR ALL TO authenticated
  USING (property_id IN (SELECT public.current_property_ids()))
  WITH CHECK (property_id IN (SELECT public.current_property_ids()));
