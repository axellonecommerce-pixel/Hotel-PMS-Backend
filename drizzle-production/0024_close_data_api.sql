-- Close Supabase's automatic data API (PostgREST / GraphQL) for InnSeva's
-- tables. Apply after 0023. Safe to re-run.
--
-- Why: Supabase publishes the "public" schema as a REST API reachable with
-- the public (publishable) key plus a signed-in user's token. supabase/rls.sql
-- lets any active member read and write their motel's rows there, which
-- bypasses the PMS API's permission checks (Users & Roles). InnSeva's
-- browser app never uses that API: it signs in with Supabase Auth and calls
-- the PMS API, which connects as the database owner (unaffected by any of
-- this). So the "anon" and "authenticated" roles get no rights at all.
--
-- After applying, also open Supabase › Project Settings › Data API and
-- remove "public" from Exposed schemas (or turn the Data API off).
-- Check with: bun run test:rls

-- 1. Row level security on every table in public: with no policy for a role,
--    that role sees nothing. The PMS API (table owner) is not affected.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. No table, sequence or function rights for the data API's roles.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
--> statement-breakpoint
-- Functions are callable by everyone ("PUBLIC") by default. Take that away
-- only from InnSeva's own functions (night_audit_due, current_property_ids);
-- an extension's functions in public are left alone so nothing else breaks.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
  END LOOP;
END $$;
--> statement-breakpoint

-- 3. Tables, sequences and functions created later get no rights either,
--    whoever creates them (the migration user, or the Supabase dashboard).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
--> statement-breakpoint
DO $$
DECLARE owner_role text;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
    BEGIN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated', owner_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated', owner_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated', owner_role);
    EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
      -- Not allowed for this role on this plan: the explicit REVOKEs above
      -- and the check in scripts/verify-rls.ts still cover it.
      RAISE NOTICE 'Default privileges for % left unchanged (%).', owner_role, SQLERRM;
    END;
  END LOOP;
END $$;
