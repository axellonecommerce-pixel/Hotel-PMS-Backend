-- Run after the Drizzle production migrations. Every application table is
-- denied by default and scoped to the authenticated employee's one hotel.

alter table public.property_memberships enable row level security;
alter table public.properties enable row level security;

create or replace function public.current_property_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select property_id
  from public.property_memberships
  where auth_user_id = auth.uid() and active = true
$$;

revoke all on function public.current_property_ids() from public;
grant execute on function public.current_property_ids() to authenticated;

drop policy if exists "employees read own membership" on public.property_memberships;
create policy "employees read own membership"
on public.property_memberships for select to authenticated
using (auth_user_id = auth.uid());

drop policy if exists "employees read own property" on public.properties;
create policy "employees read own property"
on public.properties for select to authenticated
using (id in (select public.current_property_ids()));

do $$
declare
  table_name text;
begin
  for table_name in
    select c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'property_id'
      and c.table_name <> 'property_memberships'
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists "hotel data isolation" on public.%I', table_name);
    execute format(
      'create policy "hotel data isolation" on public.%I for all to authenticated using (property_id in (select public.current_property_ids())) with check (property_id in (select public.current_property_ids()))',
      table_name
    );
  end loop;
end $$;

-- Product-team provisioning and owner/manager user administration must use a
-- trusted server role. Never expose the service-role key to the browser.
