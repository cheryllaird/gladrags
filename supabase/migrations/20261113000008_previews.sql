-- Milestone 5 round 2: generated outfit previews ("wearing it" images).
-- docs/SPEC.md "Generated outfit preview"; docs/CONTRACTS.md section 12.
--
-- 1. user_settings.model_preset_id: the model figure, null until picked.
-- 2. outfit_previews: one stored image per user and look (cache_key),
--    shared by every outfit with that look. Server writes; users read own.
-- 3. outfits.preview_id and preview_outdated, with triggers: a picked or
--    cleared shop product marks the preview outdated; an outfit's preview
--    is deleted when no outfit uses it any more.
-- 4. items: deleting an item, or replacing its photo, deletes the previews
--    that show it (a new cut-out doesn't).
-- 5. claim_outfit_preview(): link an outfit to its look's preview, reusing
--    an existing one, in one locked step. Server only.
-- 6. A private `previews` storage bucket with per-user folder policies.
-- 7. usage_events: the outfit_preview and image_generation kinds, and
--    per-feature monthly spend shares in reserve_usage.
-- 8. outfits: users may no longer write the preview columns (column
--    grants; everything they could write before is unchanged).
--
-- SAFE TO RUN TWICE, like migration 7: "if not exists", "create or
-- replace", and drop-then-create throughout, in one transaction.
-- Cheryl applies it by hand in the Supabase SQL editor, BEFORE deploying
-- this round's code (the code reads the new columns and calls the new
-- reserve_usage arguments).

begin;
set local client_min_messages = warning;

-- The 24 preset IDs (MODEL_PRESETS in src/contracts/previews.ts;
-- supabase/schema-vocab.test.ts checks they agree).
create or replace function public.is_model_preset_id(p_id text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_id = any (array[
    'women_slim_light', 'women_slim_medium', 'women_slim_deep',
    'women_average_light', 'women_average_medium', 'women_average_deep',
    'women_curvy_light', 'women_curvy_medium', 'women_curvy_deep',
    'women_plus_light', 'women_plus_medium', 'women_plus_deep',
    'men_slim_light', 'men_slim_medium', 'men_slim_deep',
    'men_average_light', 'men_average_medium', 'men_average_deep',
    'men_broad_light', 'men_broad_medium', 'men_broad_deep',
    'men_plus_light', 'men_plus_medium', 'men_plus_deep'
  ]::text[]);
$$;

-- 1. user_settings.model_preset_id ---------------------------------------------

alter table public.user_settings add column if not exists model_preset_id text;
alter table public.user_settings drop constraint if exists user_settings_model_preset_check;
alter table public.user_settings add constraint user_settings_model_preset_check check (
  model_preset_id is null or public.is_model_preset_id(model_preset_id)
);
comment on column public.user_settings.model_preset_id is 'The model figure outfit previews are made on (MODEL_PRESETS); null until the user picks one.';

revoke update on public.user_settings from authenticated;
grant update (favourite_shop_ids, model_preset_id) on public.user_settings to authenticated;

-- 2. outfit_previews ------------------------------------------------------------

create table if not exists public.outfit_previews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  -- SHA-256 hex of previewCacheKeySource (preset, items, gaps, picked products).
  cache_key text not null,
  preset_id text not null,
  -- The owned items the image shows, so deleting one (or replacing its
  -- photo) can delete the preview.
  item_ids uuid[] not null,
  -- The gap slots the image shows as suggested pieces.
  suggested_slots text[] not null default '{}'::text[],
  status text not null default 'pending',
  image_key text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.outfit_previews drop constraint if exists outfit_previews_cache_key_check;
alter table public.outfit_previews add constraint outfit_previews_cache_key_check check (cache_key ~ '^[0-9a-f]{64}$');
alter table public.outfit_previews drop constraint if exists outfit_previews_preset_check;
alter table public.outfit_previews add constraint outfit_previews_preset_check check (public.is_model_preset_id(preset_id));
alter table public.outfit_previews drop constraint if exists outfit_previews_item_ids_check;
alter table public.outfit_previews add constraint outfit_previews_item_ids_check check (
  array_ndims(item_ids) = 1 and cardinality(item_ids) between 1 and 4
);
alter table public.outfit_previews drop constraint if exists outfit_previews_slots_check;
alter table public.outfit_previews add constraint outfit_previews_slots_check check (
  cardinality(suggested_slots) <= 3
  and suggested_slots <@ array['top', 'bottom', 'dress_jumpsuit', 'outerwear', 'shoes']::text[]
);
alter table public.outfit_previews drop constraint if exists outfit_previews_status_check;
alter table public.outfit_previews add constraint outfit_previews_status_check check (status in ('pending', 'ready', 'failed', 'skipped'));
-- An image with a ready preview, and only then. Previews are stored as
-- WebP in the owner's own folder of the previews bucket.
alter table public.outfit_previews drop constraint if exists outfit_previews_image_check;
alter table public.outfit_previews add constraint outfit_previews_image_check check (
  case
    when status = 'ready' then
      image_key is not null
      and image_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
      and split_part(image_key, '/', 1) = user_id::text
    else image_key is null
  end
);
-- failed: ai_failed, blocked, invalid_image or internal (final for the
-- look). skipped: daily_cap_reached or ai_paused (tried again later).
alter table public.outfit_previews drop constraint if exists outfit_previews_failure_check;
alter table public.outfit_previews add constraint outfit_previews_failure_check check (
  case status
    when 'failed' then failure_reason is not null and failure_reason in ('ai_failed', 'blocked', 'invalid_image', 'internal')
    when 'skipped' then failure_reason is not null and failure_reason in ('daily_cap_reached', 'ai_paused')
    else failure_reason is null
  end
);

create unique index if not exists outfit_previews_user_cache_key on public.outfit_previews (user_id, cache_key);
create unique index if not exists outfit_previews_image_key_unique on public.outfit_previews (image_key) where image_key is not null;
create index if not exists outfit_previews_item_ids_idx on public.outfit_previews using gin (item_ids);

comment on table public.outfit_previews is 'Generated outfit previews, one per user and look (cache_key), shared by outfits with that look. Server writes; users read their own.';

alter table public.outfit_previews enable row level security;
revoke all on public.outfit_previews from anon;
revoke insert, update, delete, truncate, references, trigger on public.outfit_previews from authenticated;
grant select on public.outfit_previews to authenticated;

drop policy if exists "outfit_previews: read own" on public.outfit_previews;
create policy "outfit_previews: read own" on public.outfit_previews
  for select to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists outfit_previews_touch_updated_at on public.outfit_previews;
create trigger outfit_previews_touch_updated_at
  before update on public.outfit_previews
  for each row execute function public.touch_updated_at();

-- 3. outfits.preview_id and preview_outdated -------------------------------------

alter table public.outfits add column if not exists preview_id uuid references public.outfit_previews (id) on delete set null;
alter table public.outfits add column if not exists preview_outdated boolean not null default false;
create index if not exists outfits_preview_id_idx on public.outfits (preview_id) where preview_id is not null;

comment on column public.outfits.preview_id is 'The outfit_previews row whose image this outfit shows; null for no preview yet. Server writes only.';
comment on column public.outfits.preview_outdated is 'True when a gap''s picked shop product changed after the preview was linked. Set by a trigger.';

-- Users keep writing what they could before (the outfit engine still
-- saves outfits with the signed-in client), but not the preview columns.
revoke insert, update on public.outfits from authenticated;
grant insert (id, user_id, request, name, reason, item_ids, gaps, status, parent_outfit_id) on public.outfits to authenticated;
grant update (user_id, request, name, reason, item_ids, gaps, status, parent_outfit_id) on public.outfits to authenticated;

-- The picked product of each gap, by slot, for comparing two gap lists.
create or replace function public.gap_product_urls(p_gaps jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(g -> 'shopProduct' -> 'url' order by g ->> 'category'), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_gaps) = 'array' then p_gaps else '[]'::jsonb end) as g;
$$;

-- A preview must be the owner's; linking a new one clears "outdated"; a
-- changed product on a linked outfit sets it.
create or replace function public.outfits_preview_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.preview_id is not null
    and (tg_op = 'INSERT' or new.preview_id is distinct from old.preview_id or new.user_id is distinct from old.user_id)
    and not exists (select 1 from public.outfit_previews p where p.id = new.preview_id and p.user_id = new.user_id)
  then
    raise exception 'Preview does not exist or is not the owner''s' using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    new.preview_outdated := false;
  elsif new.preview_id is distinct from old.preview_id then
    new.preview_outdated := false;
  elsif new.preview_id is not null and public.gap_product_urls(new.gaps) is distinct from public.gap_product_urls(old.gaps) then
    new.preview_outdated := true;
  end if;
  return new;
end;
$$;
revoke execute on function public.outfits_preview_before_write() from public, anon, authenticated;

drop trigger if exists outfits_preview_before_write on public.outfits;
create trigger outfits_preview_before_write
  before insert or update on public.outfits
  for each row execute function public.outfits_preview_before_write();

-- When an outfit is deleted, or moves to another preview, its old preview
-- goes if no other outfit uses it. The image itself is removed from
-- storage by the app (claim_outfit_preview returns it) or by the daily
-- orphaned-image cleanup, which counts outfit_previews.image_key as in use.
create or replace function public.outfits_release_preview()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.preview_id is not null
    and (tg_op = 'DELETE' or new.preview_id is distinct from old.preview_id)
  then
    delete from public.outfit_previews p
    where p.id = old.preview_id
      and not exists (select 1 from public.outfits o where o.preview_id = p.id);
  end if;
  return null;
end;
$$;
revoke execute on function public.outfits_release_preview() from public, anon, authenticated;

drop trigger if exists outfits_release_preview on public.outfits;
create trigger outfits_release_preview
  after delete or update of preview_id on public.outfits
  for each row execute function public.outfits_release_preview();

-- 4. items: previews showing a deleted item, or an item with a new photo -------

create or replace function public.items_drop_previews()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.outfit_previews p
  where p.user_id = old.user_id and old.id = any (p.item_ids);
  return null;
end;
$$;
revoke execute on function public.items_drop_previews() from public, anon, authenticated;

drop trigger if exists items_drop_previews_on_delete on public.items;
create trigger items_drop_previews_on_delete
  after delete on public.items
  for each row execute function public.items_drop_previews();

-- A replaced photo makes the image stale; a new cut-out (made from the same
-- photo) doesn't.
drop trigger if exists items_drop_previews_on_photo on public.items;
create trigger items_drop_previews_on_photo
  after update of original_image_key on public.items
  for each row
  when (old.original_image_key is distinct from new.original_image_key)
  execute function public.items_drop_previews();

-- 5. claim_outfit_preview ----------------------------------------------------------
-- Called by POST /api/outfits/[id]/preview with the secret key, after the
-- app has worked out the look's cache key (previewCacheKey) with the user's
-- preset. In one step, under a lock per user and look:
--
-- - The outfit (the user's own) already shows a ready or failed preview,
--   or one pending for less than p_stale_seconds: 'existing', unless
--   p_refresh asks for a different look.
-- - The user has a ready or failed preview with this key: link it,
--   'reused' (no cost, no cap).
-- - Pending in another request (fresh): link it, 'wait'.
-- - Otherwise (none, skipped, or abandoned pending): create or reclaim it
--   as pending, link it, 'generate': the caller generates and then sets it
--   ready, failed or skipped with "... where id = $1 and status = 'pending'"
--   (0 rows means an item went meanwhile: discard the image).
--
-- Returns jsonb { ok, reason?, action, preview_id, status,
-- released_image_key }. released_image_key is the image of the preview
-- this outfit stopped using, when nothing uses it any more: the caller
-- removes it from storage.
create or replace function public.claim_outfit_preview(
  p_user uuid,
  p_outfit uuid,
  p_cache_key text,
  p_preset_id text,
  p_refresh boolean,
  p_stale_seconds int
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_outfit record;
  v_current record;
  v_row record;
  v_action text;
  v_old_key text;
  v_released text := null;
  v_fresh_after timestamptz := now() - make_interval(secs => p_stale_seconds);
begin
  if p_user is null or p_outfit is null or p_cache_key is null or p_cache_key !~ '^[0-9a-f]{64}$'
    or p_preset_id is null or not public.is_model_preset_id(p_preset_id)
    or p_refresh is null or p_stale_seconds is null or p_stale_seconds <= 0
  then
    raise exception 'claim_outfit_preview: bad arguments' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('gladrags.preview:' || p_user::text || ':' || p_cache_key, 0));

  select o.id, o.item_ids, o.gaps, o.preview_id into v_outfit
  from public.outfits o
  where o.id = p_outfit and o.user_id = p_user
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_outfit.preview_id is not null then
    select p.id, p.cache_key, p.status, p.updated_at, p.image_key into v_current
    from public.outfit_previews p where p.id = v_outfit.preview_id;
    if found
      and (v_current.status in ('ready', 'failed') or (v_current.status = 'pending' and v_current.updated_at > v_fresh_after))
      and (not p_refresh or v_current.cache_key = p_cache_key)
    then
      return jsonb_build_object('ok', true, 'action', 'existing', 'preview_id', v_current.id,
        'status', v_current.status, 'released_image_key', null);
    end if;
    v_old_key := v_current.image_key;
  end if;

  select p.id, p.status, p.updated_at into v_row
  from public.outfit_previews p
  where p.user_id = p_user and p.cache_key = p_cache_key
  for update;

  if found and v_row.status in ('ready', 'failed') then
    v_action := 'reused';
  elsif found and v_row.status = 'pending' and v_row.updated_at > v_fresh_after then
    v_action := 'wait';
  elsif found then
    update public.outfit_previews
    set status = 'pending', failure_reason = null, preset_id = p_preset_id,
        item_ids = v_outfit.item_ids,
        suggested_slots = array(select g ->> 'category' from jsonb_array_elements(v_outfit.gaps) g)
    where id = v_row.id
    returning id, status into v_row;
    v_action := 'generate';
  else
    insert into public.outfit_previews (user_id, cache_key, preset_id, item_ids, suggested_slots, status)
    values (p_user, p_cache_key, p_preset_id, v_outfit.item_ids,
      array(select g ->> 'category' from jsonb_array_elements(v_outfit.gaps) g), 'pending')
    returning id, status into v_row;
    v_action := 'generate';
  end if;

  if v_outfit.preview_id is distinct from v_row.id then
    update public.outfits set preview_id = v_row.id where id = p_outfit;
    -- The release trigger deleted the old preview if nothing else uses it.
    if v_outfit.preview_id is not null
      and not exists (select 1 from public.outfit_previews p where p.id = v_outfit.preview_id)
    then
      v_released := v_old_key;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'action', v_action, 'preview_id', v_row.id,
    'status', (select p.status from public.outfit_previews p where p.id = v_row.id),
    'released_image_key', v_released);
end;
$$;

revoke execute on function public.claim_outfit_preview(uuid, uuid, text, text, boolean, int) from public, anon, authenticated;
grant execute on function public.claim_outfit_preview(uuid, uuid, text, text, boolean, int) to service_role;

-- 6. Storage: the private previews bucket ------------------------------------------
-- Keys '<user id>/<uuid>.webp' (PREVIEW_STORED_* in src/contracts/previews.ts).
-- Only the server uploads. Users can read and delete their own folder,
-- like the other buckets.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('previews', 'previews', false, 1572864, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "previews: read own" on storage.objects;
create policy "previews: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'previews' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "previews: delete own" on storage.objects;
create policy "previews: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'previews' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 7. Usage: new kinds and monthly spend shares -------------------------------------

alter table public.usage_events drop constraint if exists usage_events_kind_check;
alter table public.usage_events add constraint usage_events_kind_check check (
  kind in (
    'item_ingest', 'outfit_request', 'link_fetch', 'email_import', 'shop_search', 'outfit_preview',
    'tagging', 'ranking_shortlist', 'ranking_final', 'email_extraction', 'shop_grounding', 'image_generation'
  )
);

-- Spend since a time, of every kind or only of p_kinds.
drop function if exists public.ai_spend_pence_since(timestamptz);
create or replace function public.ai_spend_pence_since(p_since timestamptz, p_kinds text[] default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(cost_pence), 0)
  from public.usage_events
  where created_at >= p_since and (p_kinds is null or kind = any (p_kinds));
$$;
revoke execute on function public.ai_spend_pence_since(timestamptz, text[]) from public, anon, authenticated;
grant execute on function public.ai_spend_pence_since(timestamptz, text[]) to service_role;

-- reserve_usage, as in migration 6, plus a share: with p_share_cap_pence,
-- refuse ('share_spend') if everyone's spend on p_share_kinds since
-- p_month_start has reached it. Checked after the overall cap and before
-- the daily cap, under the same locks.
drop function if exists public.reserve_usage(uuid, text, int, timestamptz, numeric, numeric, timestamptz, text);
create or replace function public.reserve_usage(
  p_user uuid,
  p_kind text,
  p_daily_limit int,
  p_day_start timestamptz,
  p_cost_pence numeric,
  p_monthly_cap_pence numeric,
  p_month_start timestamptz,
  p_provider text default null,
  p_share_kinds text[] default null,
  p_share_cap_pence numeric default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_used int := 0;
  v_spent numeric := 0;
  v_share_spent numeric := 0;
  v_id uuid;
begin
  if p_cost_pence is null or p_cost_pence < 0 or p_cost_pence = 'NaN'::numeric then
    raise exception 'reserve_usage: cost must be zero or more' using errcode = 'invalid_parameter_value';
  end if;
  if p_daily_limit is not null and (p_user is null or p_day_start is null) then
    raise exception 'reserve_usage: a daily limit needs a user and a day start' using errcode = 'invalid_parameter_value';
  end if;
  if p_monthly_cap_pence is not null and p_month_start is null then
    raise exception 'reserve_usage: a monthly cap needs a month start' using errcode = 'invalid_parameter_value';
  end if;
  if (p_share_cap_pence is null) <> (p_share_kinds is null)
    or (p_share_cap_pence is not null and (p_month_start is null or cardinality(p_share_kinds) = 0 or p_share_cap_pence = 'NaN'::numeric))
  then
    raise exception 'reserve_usage: a share needs kinds, a cap and a month start' using errcode = 'invalid_parameter_value';
  end if;
  if p_day_start is not null and (p_day_start > now() + interval '1 minute' or p_day_start < now() - interval '25 hours 1 minute') then
    raise exception 'reserve_usage: day start % is not today', p_day_start using errcode = 'invalid_parameter_value';
  end if;
  if p_month_start is not null and (p_month_start > now() + interval '1 minute' or p_month_start < now() - interval '31 days 1 hour 1 minute') then
    raise exception 'reserve_usage: month start % is not this month', p_month_start using errcode = 'invalid_parameter_value';
  end if;

  -- Locks in a fixed order (user, then spend), so calls can't deadlock.
  if p_user is not null and p_daily_limit is not null then
    perform pg_advisory_xact_lock(hashtextextended('gladrags.usage.user:' || p_user::text, 0));
  end if;
  if (p_monthly_cap_pence is not null or p_share_cap_pence is not null) and p_cost_pence > 0 then
    perform pg_advisory_xact_lock(hashtextextended('gladrags.usage.spend', 0));
  end if;

  if p_monthly_cap_pence is not null then
    select coalesce(sum(cost_pence), 0) into v_spent
    from public.usage_events
    where created_at >= p_month_start;
    if v_spent >= p_monthly_cap_pence then
      return jsonb_build_object('ok', false, 'denied', 'monthly_spend', 'event_id', null, 'used', null, 'spent_pence', v_spent);
    end if;
  end if;

  if p_share_cap_pence is not null then
    select coalesce(sum(cost_pence), 0) into v_share_spent
    from public.usage_events
    where created_at >= p_month_start and kind = any (p_share_kinds);
    if v_share_spent >= p_share_cap_pence then
      return jsonb_build_object('ok', false, 'denied', 'share_spend', 'event_id', null, 'used', null,
        'spent_pence', v_spent, 'share_spent_pence', v_share_spent);
    end if;
  end if;

  if p_daily_limit is not null then
    select count(*) into v_used
    from public.usage_events
    where user_id = p_user and kind = p_kind and created_at >= p_day_start;
    if v_used >= p_daily_limit then
      return jsonb_build_object('ok', false, 'denied', 'daily_cap', 'event_id', null, 'used', v_used, 'spent_pence', v_spent);
    end if;
  end if;

  insert into public.usage_events (user_id, kind, cost_pence, provider)
  values (p_user, p_kind, p_cost_pence, p_provider)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'denied', null, 'event_id', v_id, 'used', v_used, 'spent_pence', v_spent,
    'share_spent_pence', v_share_spent);
end;
$$;

revoke execute on function public.reserve_usage(uuid, text, int, timestamptz, numeric, numeric, timestamptz, text, text[], numeric)
  from public, anon, authenticated;
grant execute on function public.reserve_usage(uuid, text, int, timestamptz, numeric, numeric, timestamptz, text, text[], numeric)
  to service_role;

commit;
