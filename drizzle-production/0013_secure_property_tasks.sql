-- `property_tasks` was added after the initial tenant-isolation script.
-- Enable the same property-scoped policy used by every operational table.
ALTER TABLE public.property_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS property_tasks_tenant_isolation ON public.property_tasks;
--> statement-breakpoint
CREATE POLICY property_tasks_tenant_isolation
  ON public.property_tasks
  FOR ALL
  TO authenticated
  USING (property_id IN (SELECT public.current_property_ids()))
  WITH CHECK (property_id IN (SELECT public.current_property_ids()));
