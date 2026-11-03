-- Atomic owner-only food-entry operations and duplicate menu-name protection.
-- Run in the Supabase SQL Editor after supabase/security.sql.
-- This migration does not create, drop, or delete business tables or records.

create or replace function public.add_food_entry_item(
  p_member_id uuid,
  p_entry_date date,
  p_meal text,
  p_menu_item_id uuid,
  p_quantity integer
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_entry_id uuid;
  v_item_id uuid;
  v_item_name text;
  v_price_paise public.menu_items.price_paise%type;
  v_is_active boolean;
begin
  if public.is_room_admin() is not true then
    raise exception 'Only the owner can add food entries.' using errcode = '42501';
  end if;
  if p_member_id is null or p_entry_date is null or p_meal is null or p_menu_item_id is null
      or p_quantity is null or p_quantity < 1
      or p_meal not in ('Morning', 'Afternoon', 'Night') then
    raise exception 'A valid member, date, meal, menu item and positive quantity are required.'
      using errcode = '22023';
  end if;

  select item.name, item.price_paise, item.is_active
    into v_item_name, v_price_paise, v_is_active
    from public.menu_items as item
    where item.id = p_menu_item_id
    for share;
  if not found or v_is_active is not true then
    raise exception 'Select an active menu item.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws('|', p_member_id::text, p_entry_date::text, p_meal), 0
  ));
  select entry.id into v_entry_id
    from public.food_entries as entry
    where entry.member_id = p_member_id
      and entry.entry_date = p_entry_date
      and entry.meal = p_meal
    order by entry.id
    limit 1
    for update;
  if v_entry_id is null then
    insert into public.food_entries (member_id, entry_date, meal)
      values (p_member_id, p_entry_date, p_meal)
      returning id into v_entry_id;
  end if;

  select item.id into v_item_id
    from public.food_entry_items as item
    where item.entry_id = v_entry_id
      and item.item_name = v_item_name
      and item.menu_item_id = p_menu_item_id
      and item.quantity = p_quantity
      and item.unit_price_paise = v_price_paise
    limit 1;
  if v_item_id is not null then
    return jsonb_build_object('id', v_item_id, 'inserted', false);
  end if;

  insert into public.food_entry_items (
    entry_id, item_name, menu_item_id, quantity, unit_price_paise
  ) values (
    v_entry_id, v_item_name, p_menu_item_id, p_quantity, v_price_paise
  ) returning id into v_item_id;

  return jsonb_build_object('id', v_item_id, 'inserted', true);
end;
$$;

create or replace function public.update_food_entry_item(
  p_item_id uuid,
  p_member_id uuid,
  p_entry_date date,
  p_meal text,
  p_menu_item_id uuid,
  p_quantity integer
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_old_entry_id uuid;
  v_target_entry_id uuid;
  v_old_member_id uuid;
  v_old_date date;
  v_old_meal text;
  v_old_menu_item_id uuid;
  v_item_name text;
  v_price_paise public.menu_items.price_paise%type;
  v_menu_name text;
  v_menu_price public.menu_items.price_paise%type;
  v_menu_active boolean;
  v_lock_key text;
  v_lock_keys text[];
begin
  if public.is_room_admin() is not true then
    raise exception 'Only the owner can edit food entries.' using errcode = '42501';
  end if;
  if p_member_id is null or p_entry_date is null or p_meal is null or p_menu_item_id is null
      or p_quantity is null or p_quantity < 1
      or p_meal not in ('Morning', 'Afternoon', 'Night') then
    raise exception 'A valid member, date, meal, menu item and positive quantity are required.'
      using errcode = '22023';
  end if;

  select item.entry_id, item.menu_item_id, item.item_name, item.unit_price_paise
    into v_old_entry_id, v_old_menu_item_id, v_item_name, v_price_paise
    from public.food_entry_items as item
    where item.id = p_item_id
    for update;
  if not found then
    raise exception 'This food item no longer exists.' using errcode = 'P0002';
  end if;
  select entry.member_id, entry.entry_date, entry.meal
    into v_old_member_id, v_old_date, v_old_meal
    from public.food_entries as entry
    where entry.id = v_old_entry_id
    for update;
  if not found then
    raise exception 'The parent food entry no longer exists.' using errcode = 'P0002';
  end if;

  select array_agg(lock_key order by lock_key)
    into v_lock_keys
    from (
      select distinct lock_key
      from unnest(array[
        concat_ws('|', v_old_member_id::text, v_old_date::text, v_old_meal),
        concat_ws('|', p_member_id::text, p_entry_date::text, p_meal)
      ]) as lock_keys(lock_key)
    ) as ordered_keys;
  foreach v_lock_key in array v_lock_keys loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  if p_menu_item_id is distinct from v_old_menu_item_id then
    select item.name, item.price_paise, item.is_active
      into v_menu_name, v_menu_price, v_menu_active
      from public.menu_items as item
      where item.id = p_menu_item_id
      for share;
    if not found or v_menu_active is not true then
      raise exception 'Select an active menu item.' using errcode = '22023';
    end if;
    v_item_name := v_menu_name;
    v_price_paise := v_menu_price;
  end if;

  select entry.id into v_target_entry_id
    from public.food_entries as entry
    where entry.member_id = p_member_id
      and entry.entry_date = p_entry_date
      and entry.meal = p_meal
    order by entry.id
    limit 1
    for update;
  if v_target_entry_id is null then
    insert into public.food_entries (member_id, entry_date, meal)
      values (p_member_id, p_entry_date, p_meal)
      returning id into v_target_entry_id;
  end if;

  update public.food_entry_items
    set entry_id = v_target_entry_id,
        item_name = v_item_name,
        menu_item_id = p_menu_item_id,
        quantity = p_quantity,
        unit_price_paise = v_price_paise
    where id = p_item_id;

  if v_old_entry_id <> v_target_entry_id then
    delete from public.food_entries as entry
      where entry.id = v_old_entry_id
        and not exists (
          select 1
          from public.food_entry_items as item
          where item.entry_id = v_old_entry_id
        );
  end if;
  return p_item_id;
end;
$$;

create or replace function public.delete_food_entry_item(p_item_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_entry_id uuid;
begin
  if public.is_room_admin() is not true then
    raise exception 'Only the owner can delete food entries.' using errcode = '42501';
  end if;
  delete from public.food_entry_items
    where id = p_item_id
    returning entry_id into v_entry_id;
  if v_entry_id is null then
    return false;
  end if;
  delete from public.food_entries as entry
    where entry.id = v_entry_id
      and not exists (
        select 1
        from public.food_entry_items as item
        where item.entry_id = v_entry_id
      );
  return true;
end;
$$;

create or replace function public.delete_food_entry(p_entry_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if public.is_room_admin() is not true then
    raise exception 'Only the owner can delete food entries.' using errcode = '42501';
  end if;
  perform 1
    from public.food_entries as entry
    where entry.id = p_entry_id
    for update;
  if not found then
    return false;
  end if;
  delete from public.food_entry_items where entry_id = p_entry_id;
  delete from public.food_entries where id = p_entry_id;
  return true;
end;
$$;

revoke all on function public.add_food_entry_item(uuid, date, text, uuid, integer) from public, anon;
revoke all on function public.update_food_entry_item(uuid, uuid, date, text, uuid, integer) from public, anon;
revoke all on function public.delete_food_entry_item(uuid) from public, anon;
revoke all on function public.delete_food_entry(uuid) from public, anon;
grant execute on function public.add_food_entry_item(uuid, date, text, uuid, integer) to authenticated;
grant execute on function public.update_food_entry_item(uuid, uuid, date, text, uuid, integer) to authenticated;
grant execute on function public.delete_food_entry_item(uuid) to authenticated;
grant execute on function public.delete_food_entry(uuid) to authenticated;

create or replace function public.prevent_duplicate_menu_item_name()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_normalized_name text := lower(btrim(new.name));
begin
  if tg_op = 'UPDATE' then
    if lower(btrim(old.name)) = v_normalized_name then
      return new;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_normalized_name, 1));
  if exists (
    select 1
    from public.menu_items as item
    where lower(btrim(item.name)) = v_normalized_name
      and item.id is distinct from new.id
  ) then
    raise exception 'A menu item with this name already exists.' using errcode = '23505';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_duplicate_menu_item_name() from public, anon, authenticated;
drop trigger if exists prevent_duplicate_menu_item_name on public.menu_items;
create trigger prevent_duplicate_menu_item_name
  before insert or update on public.menu_items
  for each row execute function public.prevent_duplicate_menu_item_name();
