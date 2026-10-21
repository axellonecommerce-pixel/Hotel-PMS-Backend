-- PostgreSQL omits the default "ON DELETE NO ACTION" clause from
-- pg_get_constraintdef(). Migration 0010 therefore could re-add an unchanged
-- constraint. Make every direct tenant relationship explicitly cascade.
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
      AND c.confdeltype <> 'c'
  LOOP
    definition := pg_get_constraintdef(item.oid);
    IF definition ~ 'ON DELETE (NO ACTION|RESTRICT|SET NULL|SET DEFAULT)' THEN
      definition := regexp_replace(
        definition,
        'ON DELETE (NO ACTION|RESTRICT|SET NULL|SET DEFAULT)',
        'ON DELETE CASCADE'
      );
    ELSE
      definition := definition || ' ON DELETE CASCADE';
    END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.table_name, item.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', item.table_name, item.conname, definition);
  END LOOP;
END $$;
