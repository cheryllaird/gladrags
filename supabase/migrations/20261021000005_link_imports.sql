-- Add-by-link is two requests (see docs/CONTRACTS.md, section 5). Step 1
-- stores the product image and records the import here; step 2 attaches
-- the phone-made cut-out and runs tagging. Keeping the import on the server
-- means:
-- - step 2 uses the source URL and product data the SERVER read, not
--   whatever the client sends back, and
-- - each import can be tagged once: step 2 claims it by setting tagged_at,
--   so replaying step 2 can't run (and pay for) Gemini again.
--
-- Step 2 claims an import in one atomic statement, e.g. with the secret key:
--   update public.link_imports set tagged_at = now()
--   where original_image_key = $key and user_id = $user
--     and tagged_at is null and created_at > now() - interval '1 hour'
--   returning source_url, product;
-- No row back means expired, already used, or not this user's: not_found.
-- (1 hour is LINK_IMPORT_TTL_SECONDS in src/contracts/api.ts.)

create table public.link_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  source_url text not null check (source_url ~ '^https?://'),
  original_image_key text not null unique,
  -- { title, brand, colour }: validated by LinkProductSchema.
  product jsonb not null default '{}'::jsonb check (jsonb_typeof(product) = 'object'),
  created_at timestamptz not null default now(),
  -- Set when step 2 runs. Never cleared.
  tagged_at timestamptz,
  constraint link_imports_image_in_owner_folder check (original_image_key like user_id::text || '/%')
);

create index link_imports_user_created_idx on public.link_imports (user_id, created_at desc);

comment on table public.link_imports is 'Add-by-link step 1 results awaiting step 2. Server (secret key) only.';

-- RLS on with no policies: only the server can read or write imports.
alter table public.link_imports enable row level security;
revoke all on public.link_imports from anon, authenticated;
