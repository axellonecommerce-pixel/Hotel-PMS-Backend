-- A Platform Admin may permanently remove a motel. Every table in this PMS is
-- tenant-scoped by property_id, so its direct property foreign key must cascade.
-- This preserves the integrity of reservations, billing, housekeeping, and
-- operational records while deleting the complete tenant in one transaction.
DO $$
DECLARE
  item RECORD;
  definition text;
BEGIN
  FOR item IN
    SELECT c.conname, c.conrelid::regclass AS table_name, c.oid
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.properties'::regclass
  LOOP
    definition := pg_get_constraintdef(item.oid);
    definition := regexp_replace(
      definition,
      'ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)',
      'ON DELETE CASCADE'
    );
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.table_name, item.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', item.table_name, item.conname, definition);
  END LOOP;
END $$;
