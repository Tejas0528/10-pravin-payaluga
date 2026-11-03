-- 10 Pravin Payaluga access control.
-- Run in Supabase SQL Editor as the project owner before publishing the app.
-- The five existing business tables are reused; no duplicate business tables are created.
-- Owner status is derived from the authenticated user's trusted auth.users email.

create table if not exists public.member_access_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  member_id uuid references public.members(id) on delete restrict,
  requested_at timestamptz not null default now(),
  constraint approved_access_requires_member
    check (status <> 'approved' or member_id is not null)
);

create unique index if not exists member_access_one_approved_user_per_member
  on public.member_access_requests (member_id)
  where status = 'approved' and member_id is not null;

create index if not exists member_access_requests_status_requested_at
  on public.member_access_requests (status, requested_at);

create or replace function public.is_room_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from auth.users as room_user
    where room_user.id = auth.uid()
      and lower(room_user.email) = 'ktejaskuppusamy@gmail.com'
  );
$$;

create or replace function public.current_room_member_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select access.member_id
  from public.member_access_requests as access
  where access.user_id = auth.uid()
    and access.status = 'approved'
  limit 1;
$$;

revoke all on function public.is_room_admin() from public, anon;
revoke all on function public.current_room_member_id() from public, anon;
grant execute on function public.is_room_admin() to authenticated;
grant execute on function public.current_room_member_id() to authenticated;

alter table public.member_access_requests enable row level security;
alter table public.members enable row level security;
alter table public.menu_items enable row level security;
alter table public.food_entries enable row level security;
alter table public.food_entry_items enable row level security;
alter table public.payments enable row level security;

revoke all on table public.member_access_requests from public, anon;
revoke all on table public.members from public, anon;
revoke all on table public.menu_items from public, anon;
revoke all on table public.food_entries from public, anon;
revoke all on table public.food_entry_items from public, anon;
revoke all on table public.payments from public, anon;

grant select, insert, update on table public.member_access_requests to authenticated;
grant select, update on table public.members to authenticated;
grant select, insert, update, delete on table public.menu_items to authenticated;
grant select, insert, update, delete on table public.food_entries to authenticated;
grant select, insert, update, delete on table public.food_entry_items to authenticated;
grant select, insert, update, delete on table public.payments to authenticated;

-- Remove older permissive policies so they cannot override these narrower rules.
do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename = any(array[
        'member_access_requests',
        'members',
        'menu_items',
        'food_entries',
        'food_entry_items',
        'payments'
      ])
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      existing_policy.policyname,
      existing_policy.tablename
    );
  end loop;
end
$$;

drop policy if exists "room access request read own or admin" on public.member_access_requests;
create policy "room access request read own or admin"
  on public.member_access_requests for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_room_admin()));

drop policy if exists "room access request self pending insert" on public.member_access_requests;
create policy "room access request self pending insert"
  on public.member_access_requests for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and member_id is null
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

drop policy if exists "room admin manages access requests" on public.member_access_requests;
create policy "room admin manages access requests"
  on public.member_access_requests for update to authenticated
  using ((select public.is_room_admin()))
  with check ((select public.is_room_admin()));

drop policy if exists "room members read own member row" on public.members;
create policy "room members read own member row"
  on public.members for select to authenticated
  using (id = (select public.current_room_member_id()));

drop policy if exists "room admin manages members" on public.members;
create policy "room admin manages members"
  on public.members for all to authenticated
  using ((select public.is_room_admin()))
  with check ((select public.is_room_admin()));

drop policy if exists "approved room members read menu" on public.menu_items;
create policy "approved room members read menu"
  on public.menu_items for select to authenticated
  using ((select public.current_room_member_id()) is not null);

drop policy if exists "room admin manages menu" on public.menu_items;
create policy "room admin manages menu"
  on public.menu_items for all to authenticated
  using ((select public.is_room_admin()))
  with check ((select public.is_room_admin()));

drop policy if exists "room members read own food entries" on public.food_entries;
create policy "room members read own food entries"
  on public.food_entries for select to authenticated
  using (member_id = (select public.current_room_member_id()));

drop policy if exists "room admin manages food entries" on public.food_entries;
create policy "room admin manages food entries"
  on public.food_entries for all to authenticated
  using ((select public.is_room_admin()))
  with check ((select public.is_room_admin()));

drop policy if exists "room members read own entry items" on public.food_entry_items;
create policy "room members read own entry items"
  on public.food_entry_items for select to authenticated
  using (
    exists (
      select 1
      from public.food_entries as entry
      where entry.id = food_entry_items.entry_id
        and entry.member_id = (select public.current_room_member_id())
    )
  );

drop policy if exists "room admin manages entry items" on public.food_entry_items;
create policy "room admin manages entry items"
  on public.food_entry_items for all to authenticated
  using ((select public.is_room_admin()))
  with check ((select public.is_room_admin()));

drop policy if exists "room members read own payments" on public.payments;
create policy "room members read own payments"
  on public.payments for select to authenticated
  using (member_id = (select public.current_room_member_id()));

drop policy if exists "room admin manages payments" on public.payments;
create policy "room admin manages payments"
  on public.payments for all to authenticated
  using ((select public.is_room_admin()))
  with check ((select public.is_room_admin()));
