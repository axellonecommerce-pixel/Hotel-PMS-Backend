-- What each night audit did (steps with counts), shown on the Night Audit page.
ALTER TABLE "night_audit_runs" ADD COLUMN IF NOT EXISTS "summary" jsonb NOT NULL DEFAULT '[]'::jsonb;
