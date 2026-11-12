-- Change history for money and staff records. Apply after 0026. Safe to re-run.
--
-- Every insert, change and delete on the tables below is written to
-- audit_log by a trigger: the full row before and after, when, and who (the
-- signed-in person the API sets for each transaction, or a system label
-- such as "Booking email import" or "Night audit (scheduled)"). Because it
-- is a trigger, no route can forget to record. A deleted payment, paid-out,
-- expense or invoice keeps its full row here, with who deleted it and when.
-- Audit rows cannot be edited or deleted, except when the motel itself is
-- deleted from the Platform.

CREATE TABLE IF NOT EXISTS public.audit_log (
  id bigserial PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  actor_auth_user_id uuid,
  actor_label text,
  action text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  table_name text NOT NULL,
  row_id text,
  before jsonb,
  after jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_property_time ON public.audit_log (property_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_property_row ON public.audit_log (property_id, table_name, row_id);
--> statement-breakpoint
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.audit_log FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE public.audit_log_id_seq FROM anon, authenticated;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.innseva_audit_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  old_row jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  property uuid := coalesce(new_row->>'property_id', old_row->>'property_id')::uuid;
  actor text := nullif(current_setting('innseva.actor', true), '');
BEGIN
  -- Only staff access is audited among the settings rows.
  IF TG_TABLE_NAME = 'property_settings' AND coalesce(new_row->>'key', old_row->>'key') <> 'staff_access' THEN RETURN NULL; END IF;
  -- Nothing actually changed.
  IF TG_OP = 'UPDATE' AND (old_row - 'updated_at') = (new_row - 'updated_at') THEN RETURN NULL; END IF;
  -- The motel itself is being deleted (cascade): nothing to keep.
  IF property IS NULL OR NOT EXISTS (SELECT 1 FROM properties WHERE id = property) THEN RETURN NULL; END IF;
  INSERT INTO audit_log (property_id, actor_auth_user_id, actor_label, action, table_name, row_id, before, after)
  VALUES (
    property,
    CASE WHEN actor ~* '^[0-9a-f-]{36}$' THEN actor::uuid END,
    nullif(current_setting('innseva.actor_label', true), ''),
    lower(TG_OP), TG_TABLE_NAME,
    coalesce(new_row->>'id', old_row->>'id'),
    old_row, new_row
  );
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.innseva_audit_row() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint

-- Audit rows are append-only.
CREATE OR REPLACE FUNCTION public.innseva_audit_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Allowed only while the motel itself is being deleted (cascade).
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM properties WHERE id = OLD.property_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Audit history cannot be changed or deleted.';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.innseva_audit_append_only() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_append_only ON public.audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.innseva_audit_append_only();
--> statement-breakpoint

DO $$
DECLARE
  audited text;
BEGIN
  FOREACH audited IN ARRAY ARRAY[
    'payments', 'refunds', 'payment_allocations', 'charges', 'nightly_rates', 'folio_transfers',
    'security_deposits', 'deposit_transactions',
    'paid_outs', 'cash_shifts', 'cash_drops', 'cash_movements', 'bank_accounts', 'card_settlements',
    'expenses', 'recurring_expenses',
    'payroll_entries', 'time_entries',
    'invoices', 'invoice_payment_allocations', 'company_credits', 'house_account_charges',
    'dnr_overrides', 'property_memberships', 'property_settings'
  ] LOOP
    IF to_regclass('public.' || audited) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', audited || '_audit', audited);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.innseva_audit_row()', audited || '_audit', audited);
  END LOOP;
END $$;
