-- Server-side Night Audit scheduler: runs at each hotel's saved time even
-- when no PMS screen is open. pg_cron checks every minute (in SQL) whether an
-- audit is due and only then asks the API to run it (pg_net).
CREATE EXTENSION IF NOT EXISTS pg_cron;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_net;
--> statement-breakpoint
-- Token the scheduler sends to the API; not readable through the Data API (RLS, no policies).
CREATE TABLE IF NOT EXISTS "scheduler_secrets" (
  "name" text PRIMARY KEY,
  "secret" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "scheduler_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "scheduler_secrets" ("name", "secret")
VALUES ('night-audit', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
-- True when any hotel's scheduled audit is due: a morning time (before noon)
-- belongs to the next calendar day, an evening time to the business day.
CREATE OR REPLACE FUNCTION public.night_audit_due() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM business_days b
    JOIN properties p ON p.id = b.property_id
    JOIN property_settings ps ON ps.property_id = p.id AND ps.key = 'night_audit_schedule'
    WHERE b.status = 'open'
      AND coalesce((ps.value->>'enabled')::boolean, false)
      AND ps.value->>'time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND (now() AT TIME ZONE p.timezone) >=
        (b.business_date + CASE WHEN ps.value->>'time' < '12:00' THEN 1 ELSE 0 END) + (ps.value->>'time')::time
  )
$$;
--> statement-breakpoint
SELECT cron.unschedule('night-audit-tick') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'night-audit-tick');
--> statement-breakpoint
SELECT cron.schedule('night-audit-tick', '* * * * *', $job$
  SELECT net.http_post(
    url := 'https://hotel-pms-backend-xi.vercel.app/api/jobs/night-audit',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Scheduler-Token', (SELECT secret FROM public.scheduler_secrets WHERE name = 'night-audit')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  WHERE public.night_audit_due();
$job$);
