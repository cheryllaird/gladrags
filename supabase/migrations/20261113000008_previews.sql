-- Milestone 5 round 2: generated outfit previews ("wearing it" images).
-- docs/SPEC.md "Generated outfit preview"; docs/CONTRACTS.md section 12.
--
-- 1. user_settings.model_preset_id: the model figure, null until picked.
-- 2. outfit_previews: one stored image per user and look (cache_key),
--    shared by every outfit with that look. Server writes; users read own.
-- 3. outfits.preview_id, pending_preview_id (a refresh in progress) and
--    preview_outdated, with triggers: a picked or cleared shop product
--    marks the preview outdated; a preview is deleted when no outfit shows
--    it or waits for it any more (race-safe: release_outfit_preview).
-- 4. items: deleting an item, or replacing its photo, deletes the previews
--    that show it (a new cut-out doesn't).
-- 5. claim_outfit_preview(), finish_outfit_preview() and
--    sweep_unused_outfit_previews(): link an outfit to its look's preview
--    (reusing one where it can), finish a generation (switching a refresh
--    over), and the daily sweep of unused rows. Server only.
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
  -- When generation was last claimed: a pending row older than the stale
  -- time, or an ai_failed or internal one older than the retry window, may
  -- be claimed again.
  attempted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- For a table made by an earlier draft of this migration, before
-- attempted_at existed ("create table if not exists" skips it there).
alter table public.outfit_previews add column if not exists attempted_at timestamptz not null default now();

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

-- 3. outfits.preview_id, pending_preview_id and preview_outdated -----------------

alter table public.outfits add column if not exists preview_id uuid references public.outfit_previews (id) on delete set null;
-- A refresh ("Update preview") in progress: the new look's preview, while
-- preview_id keeps showing the old picture until the new one is ready.
alter table public.outfits add column if not exists pending_preview_id uuid references public.outfit_previews (id) on delete set null;
alter table public.outfits add column if not exists preview_outdated boolean not null default false;
create index if not exists outfits_preview_id_idx on public.outfits (preview_id) where preview_id is not null;
create index if not exists outfits_pending_preview_id_idx on public.outfits (pending_preview_id) where pending_preview_id is not null;

comment on column public.outfits.preview_id is 'The outfit_previews row whose image this outfit shows; null for no preview yet. Server writes only.';
comment on column public.outfits.pending_preview_id is 'A refresh in progress: the new look''s outfit_previews row. finish_outfit_preview switches preview_id to it once ready, or clears it. Server writes only.';
comment on column public.outfits.preview_outdated is 'True when a gap''s picked shop product changed after the preview was linked. Set by a trigger; cleared by a claim on the look the picture shows, or a new picture.';

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

-- Previews must be the owner's; linking a new picture clears "outdated"; a
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
  if new.pending_preview_id is not null
    and (tg_op = 'INSERT' or new.pending_preview_id is distinct from old.pending_preview_id or new.user_id is distinct from old.user_id)
    and not exists (select 1 from public.outfit_previews p where p.id = new.pending_preview_id and p.user_id = new.user_id)
  then
    raise exception 'Pending preview does not exist or is not the owner''s' using errcode = 'check_violation';
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

-- Delete a preview no outfit shows or is waiting for, and return its image
-- key (to remove from storage), or null. Failed rows stay (they have no
-- image, and remember a failed look for the retry window); the daily
-- sweep removes them after an hour.
--
-- Race-safe: it locks the row first, then checks in a NEW statement, so it
-- sees every link committed by a transaction that held the row (a reuse
-- locks it before linking). Two outfits leaving one preview at the same
-- moment take turns on the lock, and the second one sees the first's
-- unlink and deletes it.
create or replace function public.release_outfit_preview(p_preview uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_preview is null then
    return null;
  end if;
  perform 1 from public.outfit_previews where id = p_preview for update;
  if not found then
    return null;
  end if;
  delete from public.outfit_previews p
  where p.id = p_preview
    and p.status <> 'failed'
    and not exists (select 1 from public.outfits o where o.preview_id = p.id or o.pending_preview_id = p.id)
  returning p.image_key into v_key;
  return v_key;
end;
$$;
revoke execute on function public.release_outfit_preview(uuid) from public, anon, authenticated;

-- When an outfit is deleted, or stops pointing at a preview (shown or
-- pending), that preview goes if nothing else uses it. The image is removed
-- from storage by the app (claim and finish return its key) or by the
-- daily cleanup.
create or replace function public.outfits_release_preview()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.release_outfit_preview(old.preview_id);
    if old.pending_preview_id is distinct from old.preview_id then
      perform public.release_outfit_preview(old.pending_preview_id);
    end if;
  else
    if old.preview_id is distinct from new.preview_id and old.preview_id is distinct from new.pending_preview_id then
      perform public.release_outfit_preview(old.preview_id);
    end if;
    if old.pending_preview_id is distinct from new.pending_preview_id and old.pending_preview_id is distinct from new.preview_id
      and old.pending_preview_id is distinct from old.preview_id
    then
      perform public.release_outfit_preview(old.pending_preview_id);
    end if;
  end if;
  return null;
end;
$$;
revoke execute on function public.outfits_release_preview() from public, anon, authenticated;

drop trigger if exists outfits_release_preview on public.outfits;
create trigger outfits_release_preview
  after delete or update of preview_id, pending_preview_id on public.outfits
  for each row execute function public.outfits_release_preview();

-- 4. items: previews showing a deleted item, or an item with a new photo -------

create or replace function public.items_drop_previews()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same lock order as claim_outfit_preview and finish_outfit_preview:
  -- the outfits showing or waiting for these previews (in id order), then
  -- the previews (in id order). Deleting a preview sets those outfits'
  -- preview_id or pending_preview_id to null, so without this a photo
  -- change could lock a preview, then wait on an outfit a claim holds
  -- while the claim waits on the preview.
  perform 1 from public.outfits o
  where o.user_id = old.user_id
    and (
      o.preview_id in (select p.id from public.outfit_previews p where p.user_id = old.user_id and old.id = any (p.item_ids))
      or o.pending_preview_id in (select p.id from public.outfit_previews p where p.user_id = old.user_id and old.id = any (p.item_ids))
    )
  order by o.id
  for update;
  perform 1 from public.outfit_previews p
  where p.user_id = old.user_id and old.id = any (p.item_ids)
  order by p.id
  for update;
  delete from public.outfit_previews p
  where p.user_id = old.user_id and old.id = any (p.item_ids);
  return null;
end;
$$;
revoke execute on function public.items_drop_previews() from public, anon, authenticated;

-- Deleting an item deletes the outfits that used it (migration 1). Redefined
-- here to lock those outfits in id order first, so the previews their
-- deletion releases are locked after them, as in claim and finish. Still
-- runs as the caller (RLS applies), as before.
create or replace function public.delete_outfits_using_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.outfits
  where user_id = old.user_id and old.id = any (item_ids)
  order by id
  for update;
  delete from public.outfits where user_id = old.user_id and old.id = any (item_ids);
  return old;
end;
$$;

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

-- 5. Claiming, finishing and sweeping previews -----------------------------------

-- Whether a preview row stands as it is (no new attempt): ready; pending
-- and claimed less than p_stale_seconds ago; or failed for good (blocked,
-- invalid_image), or failed for a passing reason (ai_failed, internal)
-- less than p_retry_seconds ago. Skipped rows never stand.
create or replace function public.preview_stands(
  p_status text, p_reason text, p_attempted_at timestamptz, p_stale_seconds int, p_retry_seconds int
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case p_status
    when 'ready' then true
    when 'pending' then p_attempted_at > now() - make_interval(secs => p_stale_seconds)
    when 'failed' then p_reason in ('blocked', 'invalid_image') or p_attempted_at > now() - make_interval(secs => p_retry_seconds)
    else false
  end;
$$;
revoke execute on function public.preview_stands(text, text, timestamptz, int, int) from public, anon, authenticated;

-- Called by POST /api/outfits/[id]/preview with the secret key, after the
-- app has worked out the look's cache key (previewCacheKey) with the
-- user's preset. In one step, under a lock per user and look:
--
-- 1. The look the outfit's picture already shows (and it stands): clears
--    "outdated" and any refresh in progress; 'existing'.
-- 2. Not a refresh, and the linked preview stands (perhaps outdated):
--    'existing', nothing changes.
-- 3. Otherwise the user's preview for this look:
--    - ready: link it, 'reused' (no cost, no cap);
--    - failed and standing: 'unavailable' during a refresh (the outfit
--      keeps its outdated picture), otherwise link it, 'reused';
--    - pending and fresh: 'wait' (another request is making it);
--    - none, skipped, stale pending or failed past the retry window:
--      claim it as pending, 'generate'.
--    During a refresh of a READY picture, the new preview goes in
--    pending_preview_id and the old picture stays until finish_outfit_preview
--    switches it; otherwise it goes straight into preview_id.
--
-- Returns jsonb { ok, reason?, action, preview_id, status, refreshing,
-- released_image_key }. released_image_key is the image of a preview the
-- outfit stopped showing that nothing uses any more: remove it from storage.
drop function if exists public.claim_outfit_preview(uuid, uuid, text, text, boolean, int);
create or replace function public.claim_outfit_preview(
  p_user uuid,
  p_outfit uuid,
  p_cache_key text,
  p_preset_id text,
  p_refresh boolean,
  p_stale_seconds int,
  p_retry_seconds int default 3600
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_items uuid[];
  v_gaps jsonb;
  v_linked uuid;
  v_pending uuid;
  v_outdated boolean;
  l_key text;
  l_status text;
  l_reason text;
  l_attempted timestamptz;
  l_image text;
  r_id uuid;
  r_status text;
  r_reason text;
  r_attempted timestamptz;
  v_keep_old boolean;
  v_action text;
  v_released text := null;
begin
  if p_user is null or p_outfit is null or p_cache_key is null or p_cache_key !~ '^[0-9a-f]{64}$'
    or p_preset_id is null or not public.is_model_preset_id(p_preset_id)
    or p_refresh is null or p_stale_seconds is null or p_stale_seconds <= 0
    or p_retry_seconds is null or p_retry_seconds <= 0
  then
    raise exception 'claim_outfit_preview: bad arguments' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('gladrags.preview:' || p_user::text || ':' || p_cache_key, 0));

  select o.item_ids, o.gaps, o.preview_id, o.pending_preview_id, o.preview_outdated
  into v_items, v_gaps, v_linked, v_pending, v_outdated
  from public.outfits o
  where o.id = p_outfit and o.user_id = p_user
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_linked is not null then
    select p.cache_key, p.status, p.failure_reason, p.attempted_at, p.image_key
    into l_key, l_status, l_reason, l_attempted, l_image
    from public.outfit_previews p where p.id = v_linked;
  end if;

  -- 1. Back on the look the picture shows.
  if v_linked is not null and l_key = p_cache_key
    and public.preview_stands(l_status, l_reason, l_attempted, p_stale_seconds, p_retry_seconds)
  then
    if v_outdated or v_pending is not null then
      update public.outfits set preview_outdated = false, pending_preview_id = null where id = p_outfit;
    end if;
    return jsonb_build_object('ok', true, 'action', 'existing', 'preview_id', v_linked, 'status', l_status,
      'refreshing', false, 'released_image_key', null);
  end if;

  -- 2. Not a refresh: what the outfit shows stands.
  if not p_refresh and v_linked is not null
    and public.preview_stands(l_status, l_reason, l_attempted, p_stale_seconds, p_retry_seconds)
  then
    return jsonb_build_object('ok', true, 'action', 'existing', 'preview_id', v_linked, 'status', l_status,
      'refreshing', v_pending is not null, 'released_image_key', null);
  end if;

  -- 3. This look's preview.
  v_keep_old := p_refresh and v_linked is not null and l_status = 'ready';

  select p.id, p.status, p.failure_reason, p.attempted_at into r_id, r_status, r_reason, r_attempted
  from public.outfit_previews p
  where p.user_id = p_user and p.cache_key = p_cache_key
  for update;

  if r_id is not null and r_status in ('ready', 'failed')
    and public.preview_stands(r_status, r_reason, r_attempted, p_stale_seconds, p_retry_seconds)
  then
    if r_status = 'failed' and v_keep_old then
      if v_pending is not null then
        update public.outfits set pending_preview_id = null where id = p_outfit;
      end if;
      return jsonb_build_object('ok', true, 'action', 'unavailable', 'preview_id', r_id, 'status', r_status,
        'refreshing', false, 'released_image_key', null);
    end if;
    v_action := 'reused';
    v_keep_old := false;
  elsif r_id is not null and r_status = 'pending'
    and public.preview_stands(r_status, r_reason, r_attempted, p_stale_seconds, p_retry_seconds)
  then
    v_action := 'wait';
  elsif r_id is not null then
    update public.outfit_previews
    set status = 'pending', failure_reason = null, image_key = null, preset_id = p_preset_id, attempted_at = now(),
        item_ids = v_items,
        suggested_slots = array(select g ->> 'category' from jsonb_array_elements(v_gaps) g)
    where id = r_id;
    v_action := 'generate';
  else
    insert into public.outfit_previews (user_id, cache_key, preset_id, item_ids, suggested_slots, status, attempted_at)
    values (p_user, p_cache_key, p_preset_id, v_items,
      array(select g ->> 'category' from jsonb_array_elements(v_gaps) g), 'pending', now())
    returning id into r_id;
    v_action := 'generate';
  end if;

  if v_keep_old then
    if v_pending is distinct from r_id then
      update public.outfits set pending_preview_id = r_id where id = p_outfit;
    end if;
  elsif v_linked is distinct from r_id or v_pending is not null then
    update public.outfits set preview_id = r_id, pending_preview_id = null where id = p_outfit;
    -- The release trigger deleted the old preview if nothing else uses it.
    if v_linked is not null and v_linked is distinct from r_id
      and not exists (select 1 from public.outfit_previews p where p.id = v_linked)
    then
      v_released := l_image;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'action', v_action, 'preview_id', r_id,
    'status', (select p.status from public.outfit_previews p where p.id = r_id),
    'refreshing', v_keep_old, 'released_image_key', v_released);
end;
$$;

revoke execute on function public.claim_outfit_preview(uuid, uuid, text, text, boolean, int, int) from public, anon, authenticated;
grant execute on function public.claim_outfit_preview(uuid, uuid, text, text, boolean, int, int) to service_role;

-- Finish a claimed (pending) preview: ready with its image, failed or
-- skipped with a reason. Outfits waiting for it as a refresh
-- (pending_preview_id) switch to it when ready, and their old pictures are
-- released; on failed or skipped their refresh ends and they keep the old
-- (still outdated) picture.
--
-- Returns jsonb { ok, released_image_keys }. ok is false when the row is
-- gone (an item it shows was deleted, or a new photo replaced one) or no
-- longer pending: the caller then deletes the image it made.
create or replace function public.finish_outfit_preview(
  p_user uuid,
  p_preview uuid,
  p_status text,
  p_image_key text,
  p_failure_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_outfit record;
  v_old_image text;
  v_released text[] := '{}';
begin
  if p_user is null or p_preview is null or p_status is null or p_status not in ('ready', 'failed', 'skipped') then
    raise exception 'finish_outfit_preview: bad arguments' using errcode = 'invalid_parameter_value';
  end if;

  select p.cache_key into v_key from public.outfit_previews p where p.id = p_preview and p.user_id = p_user;
  if v_key is null then
    return jsonb_build_object('ok', false, 'released_image_keys', '[]'::jsonb);
  end if;
  -- Same lock order as claim_outfit_preview: the look, then outfits, then the preview row.
  perform pg_advisory_xact_lock(hashtextextended('gladrags.preview:' || p_user::text || ':' || v_key, 0));
  perform 1 from public.outfits o
  where o.user_id = p_user and (o.pending_preview_id = p_preview or o.preview_id = p_preview)
  order by o.id
  for update;

  update public.outfit_previews
  set status = p_status,
      image_key = case when p_status = 'ready' then p_image_key else null end,
      failure_reason = case when p_status = 'ready' then null else p_failure_reason end
  where id = p_preview and user_id = p_user and status = 'pending';
  if not found then
    return jsonb_build_object('ok', false, 'released_image_keys', '[]'::jsonb);
  end if;

  if p_status = 'ready' then
    for v_outfit in
      select o.id, o.preview_id from public.outfits o
      where o.user_id = p_user and o.pending_preview_id = p_preview
      order by o.id
    loop
      select p.image_key into v_old_image from public.outfit_previews p where p.id = v_outfit.preview_id;
      update public.outfits set preview_id = p_preview, pending_preview_id = null where id = v_outfit.id;
      if v_outfit.preview_id is not null and v_old_image is not null
        and not exists (select 1 from public.outfit_previews p where p.id = v_outfit.preview_id)
      then
        v_released := v_released || v_old_image;
      end if;
    end loop;
  else
    update public.outfits set pending_preview_id = null where user_id = p_user and pending_preview_id = p_preview;
  end if;

  return jsonb_build_object('ok', true, 'released_image_keys', to_jsonb(v_released));
end;
$$;

revoke execute on function public.finish_outfit_preview(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.finish_outfit_preview(uuid, uuid, text, text, text) to service_role;

-- The daily cleanup: delete previews no outfit shows or waits for, last
-- changed more than p_older_than_seconds ago (failed rows kept for the
-- retry window, an abandoned refresh, anything a crash left). Each row is
-- locked (skipping rows in use right now) and re-checked in a new
-- statement, like release_outfit_preview.
-- Returns jsonb { deleted, image_keys } for the app to remove from storage.
create or replace function public.sweep_unused_outfit_previews(p_older_than_seconds int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_key text;
  v_deleted int := 0;
  v_keys text[] := '{}';
begin
  if p_older_than_seconds is null or p_older_than_seconds < 60 then
    raise exception 'sweep_unused_outfit_previews: bad age' using errcode = 'invalid_parameter_value';
  end if;
  for v_id in
    select p.id from public.outfit_previews p
    where p.updated_at < now() - make_interval(secs => p_older_than_seconds)
      and not exists (select 1 from public.outfits o where o.preview_id = p.id or o.pending_preview_id = p.id)
    for update skip locked
  loop
    delete from public.outfit_previews p
    where p.id = v_id
      and not exists (select 1 from public.outfits o where o.preview_id = p.id or o.pending_preview_id = p.id)
    returning p.image_key into v_key;
    if found then
      v_deleted := v_deleted + 1;
      if v_key is not null then
        v_keys := v_keys || v_key;
      end if;
    end if;
  end loop;
  return jsonb_build_object('deleted', v_deleted, 'image_keys', to_jsonb(v_keys));
end;
$$;

revoke execute on function public.sweep_unused_outfit_previews(int) from public, anon, authenticated;
grant execute on function public.sweep_unused_outfit_previews(int) to service_role;

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
    or (p_share_cap_pence is not null and (p_month_start is null or cardinality(p_share_kinds) = 0
        or p_share_cap_pence = 'NaN'::numeric or p_share_cap_pence < 0))
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
