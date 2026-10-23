CREATE TABLE IF NOT EXISTS property_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  text text NOT NULL,
  area text NOT NULL,
  completed boolean DEFAULT false NOT NULL,
  completed_at timestamp with time zone,
  created_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS property_tasks_property_completed
  ON property_tasks(property_id, completed);
