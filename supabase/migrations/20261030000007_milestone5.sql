-- Milestone 5: changes from Cheryl's test (docs/SPEC.md, "Changes from
-- Cheryl's test"; docs/CONTRACTS.md sections 2 and 5).
--
-- 1. items: source 'email', needs_review ("to review" after a batch add),
--    needs_photo (an email item saved without a usable picture).
-- 2. outfits: gaps (jsonb) and 1 to 4 owned items, 2 to 4 slots in all.
-- 3. user_settings: favourite shops and the forwarding token, one row per
--    user, plus reset_forwarding_token().
-- 4. email_imports: one row per forwarded email (never the email itself).
-- 5. usage_events: kinds for forwarded emails and shop searches.
--
-- SAFE TO RUN TWICE. Cheryl applies migrations by hand in the Supabase SQL
-- editor, so everything here is idempotent: "if not exists", "create or
-- replace", and drop-then-create for constraints, policies and triggers.
-- scripts/verify-migrations.sh applies it twice to prove it. It runs in one
-- transaction, so a failure part-way changes nothing.

begin;
-- "already exists, skipping" notices on a second run are expected; hide them.
set local client_min_messages = warning;

-- 1. items ------------------------------------------------------------------------

alter table public.items drop constraint if exists items_source_check;
alter table public.items add constraint items_source_check check (source in ('photo', 'link', 'email'));

alter table public.items add column if not exists needs_review boolean not null default false;
alter table public.items add column if not exists needs_photo boolean not null default false;

comment on column public.items.needs_review is 'True for batch-added items (several photos or links, or an order email) the user has not confirmed yet.';
comment on column public.items.needs_photo is 'True for an order-email item saved without a usable picture: its original is a placeholder until the user adds a photo.';
comment on column public.items.cutout_image_key is 'Made on the phone the first time a collage uses the item (milestone 5); null until then, or if removal failed.';

-- The "Review N new items" banner counts these.
create index if not exists items_user_needs_review_idx on public.items (user_id) where needs_review;

-- 2. outfits ----------------------------------------------------------------------
-- Gaps: slots the wardrobe doesn't fill, described by the model:
-- [{ category, subcategory, colours, description, shopResults, searchedAt,
-- shopProduct }], validated by OutfitGapsSchema in src/contracts/outfit.ts.
-- Every outfit keeps at least one owned item.

alter table public.outfits add column if not exists gaps jsonb not null default '[]'::jsonb;

alter table public.outfits drop constraint if exists outfits_item_ids_check;
alter table public.outfits add constraint outfits_item_ids_check check (cardinality(item_ids) between 1 and 4);

-- jsonb_array_length fails on a non-array, and AND doesn't guarantee the
-- order its sides are checked in, so CASE checks the type first.
alter table public.outfits drop constraint if exists outfits_gaps_shape;
alter table public.outfits add constraint outfits_gaps_shape check (
  case
    when jsonb_typeof(gaps) = 'array' then
      jsonb_array_length(gaps) <= 3
      and cardinality(item_ids) + jsonb_array_length(gaps) between 2 and 4
    else false
  end
);

comment on column public.outfits.gaps is 'Slots the wardrobe does not fill (described by the model), with any shop search results and the chosen product. [] for a complete outfit.';
comment on column public.outfits.request is '{ style, guidance, anchorItemId, includeShopItems }: validated by StoredOutfitRequestSchema in src/contracts/outfit.ts.';

-- 3. user_settings ----------------------------------------------------------------
-- One row per user, created with their profile. Favourite shops are IDs from
-- SHOPS in src/contracts/shops.ts. The forwarding token is the private part
-- of their order-email forwarding address: 32 hex digits (122 random bits).

create table if not exists public.user_settings (
  user_id uuid primary key references public.users (id) on delete cascade,
  favourite_shop_ids text[] not null default array['next', 'marks_and_spencer', 'new_look']::text[],
  forwarding_token text not null default replace(gen_random_uuid()::text, '-', ''),
  updated_at timestamptz not null default now()
);

alter table public.user_settings drop constraint if exists user_settings_favourite_shops_check;
alter table public.user_settings add constraint user_settings_favourite_shops_check check (
  cardinality(favourite_shop_ids) between 1 and 12
  and favourite_shop_ids <@ array[
    'next', 'marks_and_spencer', 'new_look', 'john_lewis', 'river_island', 'zara',
    'hm', 'uniqlo', 'asos', 'mango', 'matalan', 'fatface'
  ]::text[]
);
alter table public.user_settings drop constraint if exists user_settings_forwarding_token_check;
alter table public.user_settings add constraint user_settings_forwarding_token_check check (forwarding_token ~ '^[0-9a-f]{32}$');

-- The inbound webhook finds the user by token.
create unique index if not exists user_settings_forwarding_token_key on public.user_settings (forwarding_token);

comment on table public.user_settings is 'Favourite shops and the order-email forwarding token. Users read their own row and may change favourite_shop_ids only.';

alter table public.user_settings enable row level security;
revoke all on public.user_settings from anon;
revoke insert, update, delete on public.user_settings from authenticated;
grant select on public.user_settings to authenticated;
grant update (favourite_shop_ids) on public.user_settings to authenticated;

drop policy if exists "user_settings: read own" on public.user_settings;
create policy "user_settings: read own" on public.user_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "user_settings: update own" on public.user_settings;
create policy "user_settings: update own" on public.user_settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_settings_touch_updated_at on public.user_settings;
create trigger user_settings_touch_updated_at
  before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- Every new profile gets a settings row (defaults: Next, M&S, New Look,
-- and a fresh token).
create or replace function public.create_user_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_settings (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke execute on function public.create_user_settings() from public, anon, authenticated;

drop trigger if exists users_create_settings on public.users;
create trigger users_create_settings
  after insert on public.users
  for each row execute function public.create_user_settings();

-- Existing users (Cheryl) get theirs now.
insert into public.user_settings (user_id)
select id from public.users
on conflict (user_id) do nothing;

-- Reset the signed-in user's forwarding token; the old address stops
-- working at once. Returns the new token.
create or replace function public.reset_forwarding_token()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if auth.uid() is null then
    raise exception 'reset_forwarding_token: not signed in' using errcode = 'insufficient_privilege';
  end if;
  update public.user_settings
  set forwarding_token = replace(gen_random_uuid()::text, '-', '')
  where user_id = auth.uid()
  returning forwarding_token into v_token;
  if v_token is null then
    raise exception 'reset_forwarding_token: no settings row' using errcode = 'no_data_found';
  end if;
  return v_token;
end;
$$;
revoke execute on function public.reset_forwarding_token() from public, anon;
grant execute on function public.reset_forwarding_token() to authenticated, service_role;

-- 4. email_imports ----------------------------------------------------------------
-- One row per forwarded email that reached a user's token. Never the email
-- itself (no sender, subject, body or addresses): only what the user sees,
-- plus a hash of the provider's message ID so a redelivered webhook isn't
-- imported twice. Written by the server (secret key) only; users can read
-- their own.

create table if not exists public.email_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  message_hash text not null,
  received_at timestamptz not null,
  shop_name text,
  order_date date,
  status text not null default 'processing',
  item_count int not null default 0,
  skipped_count int not null default 0,
  error text,
  created_at timestamptz not null default now()
);

alter table public.email_imports drop constraint if exists email_imports_message_hash_check;
alter table public.email_imports add constraint email_imports_message_hash_check check (message_hash ~ '^[0-9a-f]{64}$');
alter table public.email_imports drop constraint if exists email_imports_shop_name_check;
alter table public.email_imports add constraint email_imports_shop_name_check check (char_length(shop_name) between 1 and 80);
alter table public.email_imports drop constraint if exists email_imports_status_check;
alter table public.email_imports add constraint email_imports_status_check check (status in ('processing', 'done', 'failed'));
alter table public.email_imports drop constraint if exists email_imports_counts_check;
alter table public.email_imports add constraint email_imports_counts_check check (item_count between 0 and 100 and skipped_count between 0 and 100);
alter table public.email_imports drop constraint if exists email_imports_error_check;
alter table public.email_imports add constraint email_imports_error_check check (
  error in ('sender_not_allowed', 'failed_checks', 'no_items_found', 'daily_cap_reached', 'ai_paused', 'ai_failed', 'internal')
);
alter table public.email_imports drop constraint if exists email_imports_failed_has_error;
alter table public.email_imports add constraint email_imports_failed_has_error check (status <> 'failed' or error is not null);

create unique index if not exists email_imports_user_message_key on public.email_imports (user_id, message_hash);
create index if not exists email_imports_user_received_idx on public.email_imports (user_id, received_at desc);

comment on table public.email_imports is 'Forwarded order emails and what came of them. Never stores the email itself. Server writes; users read their own.';

alter table public.email_imports enable row level security;
revoke all on public.email_imports from anon;
revoke insert, update, delete on public.email_imports from authenticated;
grant select on public.email_imports to authenticated;

drop policy if exists "email_imports: read own" on public.email_imports;
create policy "email_imports: read own" on public.email_imports
  for select to authenticated
  using (user_id = (select auth.uid()));

-- 5. usage_events -----------------------------------------------------------------

alter table public.usage_events drop constraint if exists usage_events_kind_check;
alter table public.usage_events add constraint usage_events_kind_check check (
  kind in (
    'item_ingest', 'outfit_request', 'link_fetch', 'email_import', 'shop_search',
    'tagging', 'ranking_shortlist', 'ranking_final', 'email_extraction', 'shop_grounding'
  )
);

commit;
