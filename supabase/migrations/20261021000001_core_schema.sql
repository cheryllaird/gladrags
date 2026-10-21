-- GladRags core schema: the four tables from docs/SPEC.md "Data model".
--
-- Vocabularies (categories, colours, styles...) are text columns with CHECK
-- constraints rather than Postgres enums, so they are easy to change. They
-- must match src/contracts/item.ts and src/contracts/styles.ts; the test in
-- supabase/schema-vocab.test.ts fails if they drift apart.
--
-- Row-level security is on for every table. Policies use
-- (select auth.uid()) so Postgres evaluates it once per query.

-- ---------------------------------------------------------------------------
-- users: one row per signed-in person, created by a trigger on auth.users
-- (see 20261021000002_allowlist_and_auth.sql).
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique check (email = lower(email)),
  display_name text check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);

comment on table public.users is 'GladRags profile for each auth user. Deleting the auth user deletes everything they own.';

-- ---------------------------------------------------------------------------
-- items: one piece of clothing or pair of shoes, with its images and tags.
-- ---------------------------------------------------------------------------
create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,

  source text not null check (source in ('photo', 'link')),
  source_url text check (source_url is null or source_url ~ '^https?://'),

  -- Storage object keys: '<user id>/<uuid>.<ext>' in the originals and cutouts buckets.
  -- Background removal runs on the phone and can fail (old or low-memory
  -- devices), so the cut-out is optional: the app shows the original instead.
  original_image_key text not null,
  cutout_image_key text,

  category text not null check (category in ('top', 'bottom', 'dress_jumpsuit', 'outerwear', 'shoes')),
  subcategory text not null,
  -- colours[1] is the primary colour (Postgres arrays are 1-based).
  colours text[] not null check (
    cardinality(colours) between 1 and 3
    and colours <@ array[
      'black', 'white', 'cream', 'beige', 'tan', 'brown', 'grey', 'navy', 'blue', 'light_blue', 'teal',
      'green', 'olive', 'yellow', 'orange', 'red', 'burgundy', 'pink', 'purple', 'gold', 'silver'
    ]::text[]
  ),
  pattern text not null check (pattern in ('plain', 'stripe', 'floral', 'check', 'print')),
  formality smallint not null check (formality between 1 and 5),
  seasons text[] not null check (
    cardinality(seasons) between 1 and 4
    and seasons <@ array['spring', 'summer', 'autumn', 'winter']::text[]
  ),
  warmth text not null check (warmth in ('light', 'medium', 'warm')),
  occasions text[] not null check (
    cardinality(occasions) between 1 and 9
    and occasions <@ array[
      'comfy', 'active', 'casual', 'holiday', 'smart_casual', 'work', 'evening_out', 'wedding_guest', 'formal_event'
    ]::text[]
  ),
  fabric text check (char_length(fabric) between 1 and 40),
  description text not null check (char_length(description) between 1 and 120),
  tags_edited boolean not null default false,
  created_at timestamptz not null default now(),

  constraint items_link_has_url check (source <> 'link' or source_url is not null),
  constraint items_subcategory_matches_category check (
    (category = 'top' and subcategory in ('t_shirt', 'shirt', 'blouse', 'polo', 'jumper'))
    or (category = 'bottom' and subcategory in ('jeans', 'trousers', 'chinos', 'skirt', 'shorts'))
    or (category = 'dress_jumpsuit' and subcategory in ('dress', 'jumpsuit'))
    or (category = 'outerwear' and subcategory in ('jacket', 'blazer', 'coat'))
    or (category = 'shoes' and subcategory in ('trainers', 'boots', 'sandals', 'heels', 'flats', 'loafers', 'smart_shoes'))
  ),
  -- Images must live in the owner's own storage folder.
  constraint items_images_in_owner_folder check (
    original_image_key like user_id::text || '/%'
    and (cutout_image_key is null or cutout_image_key like user_id::text || '/%')
  )
);

create index items_user_created_idx on public.items (user_id, created_at desc);

comment on column public.items.tags_edited is 'True if the user changed any auto-filled tag. Used to measure tagging accuracy.';

-- ---------------------------------------------------------------------------
-- outfits: a suggested combination of items, and what the user thought of it.
-- ---------------------------------------------------------------------------
create table public.outfits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  -- { style, guidance, anchorItemId }: validated by StoredOutfitRequestSchema in src/contracts/outfit.ts.
  request jsonb not null check (jsonb_typeof(request) = 'object' and request ? 'style'),
  name text not null check (char_length(name) between 1 and 40),
  reason text not null check (char_length(reason) between 1 and 160),
  item_ids uuid[] not null check (cardinality(item_ids) between 2 and 4),
  status text not null default 'suggested' check (status in ('suggested', 'saved', 'liked', 'rejected')),
  parent_outfit_id uuid references public.outfits (id) on delete set null,
  created_at timestamptz not null default now()
);

create index outfits_user_status_created_idx on public.outfits (user_id, status, created_at desc);
create index outfits_item_ids_idx on public.outfits using gin (item_ids);

-- An outfit may only contain its owner's items, and refine its owner's outfits.
-- (item_ids is an array, so a foreign key can't do this.)
create function public.check_outfit_ownership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only check what changed. In particular, skip when a cascade just sets
  -- parent_outfit_id to null (that happens mid-way through account deletion,
  -- when the items may already be gone).
  if (tg_op = 'INSERT'
      or new.item_ids is distinct from old.item_ids
      or new.user_id is distinct from old.user_id)
    and exists (
      select 1
      from unnest(new.item_ids) as outfit_item (id)
      where not exists (
        select 1 from public.items i where i.id = outfit_item.id and i.user_id = new.user_id
      )
    )
  then
    raise exception 'Outfit contains an item that does not exist or is not the owner''s'
      using errcode = 'check_violation';
  end if;

  if new.parent_outfit_id is not null
    and (tg_op = 'INSERT'
         or new.parent_outfit_id is distinct from old.parent_outfit_id
         or new.user_id is distinct from old.user_id)
    and not exists (
      select 1 from public.outfits o where o.id = new.parent_outfit_id and o.user_id = new.user_id
    )
  then
    raise exception 'Parent outfit does not exist or is not the owner''s'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger outfits_check_ownership
  before insert or update of item_ids, user_id, parent_outfit_id on public.outfits
  for each row execute function public.check_outfit_ownership();

-- Deleting an item deletes the outfits that used it: they can no longer be shown.
create function public.delete_outfits_using_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.outfits where user_id = old.user_id and old.id = any (item_ids);
  return old;
end;
$$;

create trigger items_delete_outfits
  after delete on public.items
  for each row execute function public.delete_outfits_using_item();

-- ---------------------------------------------------------------------------
-- outfit_feedback: swaps, typed guidance and rejections. Rejections become
-- "avoid" hints on later requests.
-- ---------------------------------------------------------------------------
create table public.outfit_feedback (
  id uuid primary key default gen_random_uuid(),
  outfit_id uuid not null references public.outfits (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('swap', 'guidance', 'reject')),
  -- swap: item ID swapped out; guidance: the text; reject: optional reason.
  detail text check (char_length(detail) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint outfit_feedback_detail_required check (kind = 'reject' or detail is not null)
);

create index outfit_feedback_user_kind_idx on public.outfit_feedback (user_id, kind, created_at desc);
create index outfit_feedback_outfit_idx on public.outfit_feedback (outfit_id);

-- ---------------------------------------------------------------------------
-- Row-level security: each user sees and changes only their own rows.
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.items enable row level security;
alter table public.outfits enable row level security;
alter table public.outfit_feedback enable row level security;

-- Signed-out visitors get nothing.
revoke all on public.users, public.items, public.outfits, public.outfit_feedback from anon;

-- users: read your own profile; change only your display name.
-- Rows are created by the auth trigger and removed when the auth user is deleted.
create policy "users: read own" on public.users
  for select to authenticated
  using (id = (select auth.uid()));

create policy "users: update own" on public.users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

revoke insert, update, delete on public.users from authenticated;
grant update (display_name) on public.users to authenticated;

-- items
create policy "items: read own" on public.items
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "items: insert own" on public.items
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "items: update own" on public.items
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "items: delete own" on public.items
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- outfits
create policy "outfits: read own" on public.outfits
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "outfits: insert own" on public.outfits
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "outfits: update own" on public.outfits
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "outfits: delete own" on public.outfits
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- outfit_feedback: append-only for users; must point at one of your outfits.
create policy "outfit_feedback: read own" on public.outfit_feedback
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "outfit_feedback: insert own" on public.outfit_feedback
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.outfits o
      where o.id = outfit_id and o.user_id = (select auth.uid())
    )
  );

revoke update, delete on public.outfit_feedback from authenticated;
