-- Checks for the migrations: allowlist, RLS isolation between two users,
-- constraints, triggers and cascades. Run by scripts/verify-migrations.sh
-- after supabase-stub.sql and the migrations. Any failure raises an error.

\set ON_ERROR_STOP on
\set QUIET on
-- Discard query results; the checks report through NOTICEs (stderr).
\o /dev/null

-- Helpers ------------------------------------------------------------------

create function pg_temp.expect_error(stmt text, label text)
returns void
language plpgsql
as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'ok: % (refused: %)', label, sqlerrm;
    return;
  end;
  raise exception 'FAIL: % was allowed but should have been refused', label;
end;
$$;

create function pg_temp.expect_rows(stmt text, expected int, label text)
returns void
language plpgsql
as $$
declare
  n int;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n <> expected then
    raise exception 'FAIL: % affected % row(s), expected %', label, n, expected;
  end if;
  raise notice 'ok: %', label;
end;
$$;

create function pg_temp.expect_count(query text, expected bigint, label text)
returns void
language plpgsql
as $$
declare
  n bigint;
begin
  execute 'select count(*) from (' || query || ') q' into n;
  if n <> expected then
    raise exception 'FAIL: % returned % row(s), expected %', label, n, expected;
  end if;
  raise notice 'ok: %', label;
end;
$$;

grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Fixture IDs
-- user A: aaaaaaaa-...  user B: bbbbbbbb-...

-- Allowlist ----------------------------------------------------------------

insert into public.allowed_emails (email) values ('a@example.com'), ('b@example.com');

insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A@Example.com'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b@example.com');

select pg_temp.expect_count(
  'select 1 from public.users where email in (''a@example.com'', ''b@example.com'')', 2,
  'auth trigger creates a profile (lower-cased email) for allowlisted users');

select pg_temp.expect_error(
  'insert into auth.users (email) values (''stranger@example.com'')',
  'sign-up for an email not on the allowlist');

select pg_temp.expect_error(
  'insert into auth.users (email) values (null)',
  'sign-up with no email');

-- Fixture data (as the database owner, like the service role) ---------------

insert into public.items (id, user_id, source, source_url, original_image_key, cutout_image_key,
  category, subcategory, colours, pattern, formality, seasons, warmth, occasions, fabric, description)
values
  ('a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'photo', null,
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000001.jpg',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000002.png',
   'top', 'shirt', array['white'], 'plain', 3, array['spring', 'summer'], 'light', array['work', 'smart_casual'], 'cotton', 'White oxford shirt'),
  ('a0000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'link', 'https://shop.example.com/chinos',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000003.jpg',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000004.png',
   'bottom', 'chinos', array['navy'], 'plain', 3, array['spring', 'summer', 'autumn', 'winter'], 'medium', array['work'], null, 'Navy chinos'),
  ('a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'photo', null,
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000005.jpg',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000006.png',
   'shoes', 'loafers', array['tan'], 'plain', 3, array['spring', 'summer', 'autumn'], 'medium', array['work', 'smart_casual'], 'leather', 'Tan suede loafers'),
  ('b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'photo', null,
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000001.jpg',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000002.png',
   'dress_jumpsuit', 'dress', array['green'], 'floral', 4, array['summer'], 'light', array['wedding_guest'], null, 'Green floral midi dress'),
  ('b0000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'photo', null,
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000003.jpg',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000004.png',
   'shoes', 'heels', array['gold'], 'plain', 4, array['summer'], 'light', array['wedding_guest'], null, 'Gold block heels');

insert into public.outfits (id, user_id, request, name, reason, item_ids)
values ('b1000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '{"style": {"kind": "preset", "presetId": "wedding_guest"}, "guidance": null, "anchorItemId": null}',
  'Garden party', 'Gold lifts the green print', array['b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002']::uuid[]);

insert into public.usage_events (user_id, kind, cost_pence, provider) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'item_ingest', 0, null),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tagging', 0.12, 'gemini'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'ranking_final', 0.4, 'gemini');

insert into storage.objects (bucket_id, name) values
  ('cutouts', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000002.png');

-- Constraints ----------------------------------------------------------------

select pg_temp.expect_rows($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'photo',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000020.jpg', null,
    'top', 'blouse', array['cream'], 'plain', 3, array['spring'], 'light', array['work'], 'Cream blouse, no cut-out')
$$, 1, 'item without a cut-out (background removal failed on the phone)');

select pg_temp.expect_error(
  'insert into public.usage_events (kind, cost_pence) values (''background_removal'', 1)',
  'usage kind for background removal (now free, on the phone)');

select pg_temp.expect_error($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'photo',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000009.jpg',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000010.png',
    'top', 'jeans', array['blue'], 'plain', 2, array['spring'], 'medium', array['casual'], 'Jeans as a top')
$$, 'subcategory that does not belong to the category');

select pg_temp.expect_error($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'photo',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000009.jpg',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000010.png',
    'top', 'shirt', array['dusty heather'], 'plain', 2, array['spring'], 'medium', array['casual'], 'Odd colour')
$$, 'colour outside the palette');

select pg_temp.expect_error($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'photo',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000009.jpg',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000010.png',
    'top', 'shirt', array['white'], 'plain', 6, array['spring'], 'medium', array['casual'], 'Too formal')
$$, 'formality above 5');

select pg_temp.expect_error($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'photo',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000009.jpg',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000010.png',
    'top', 'shirt', array['white'], 'plain', 2, array['spring'], 'medium', array['casual'], 'Wrong folder')
$$, 'image key in another user''s folder');

select pg_temp.expect_error($$
  insert into public.items (user_id, source, source_url, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'link', null,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000009.jpg',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000010.png',
    'top', 'shirt', array['white'], 'plain', 2, array['spring'], 'medium', array['casual'], 'No link')
$$, 'link item without a source URL');

select pg_temp.expect_error($$
  insert into public.outfit_feedback (outfit_id, user_id, kind, detail)
  values ('b1000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'swap', null)
$$, 'swap feedback without detail');

-- Signed out (anon) -----------------------------------------------------------

set role anon;
select set_config('request.jwt.claim.sub', '', false);

select pg_temp.expect_error('select * from public.items', 'anon reading items');
select pg_temp.expect_error('select * from public.users', 'anon reading users');
select pg_temp.expect_error('select * from public.allowed_emails', 'anon reading the allowlist');
select pg_temp.expect_error('select public.is_email_allowed(''a@example.com'')', 'anon probing the allowlist');

reset role;

-- Signed in as user A ---------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false);

select pg_temp.expect_count('select * from public.users', 1, 'A sees only their own profile');
select pg_temp.expect_count('select * from public.items', 3, 'A sees only their own items');
select pg_temp.expect_count('select * from public.outfits', 0, 'A cannot see B''s outfits');
select pg_temp.expect_count('select * from public.usage_events', 2, 'A sees only their own usage');
select pg_temp.expect_count('select * from storage.objects', 0, 'A cannot see B''s images');

select pg_temp.expect_error('select * from public.allowed_emails', 'A reading the allowlist');
select pg_temp.expect_error('select public.ai_spend_pence_since(now())', 'A reading total AI spend');
select pg_temp.expect_error(
  'insert into public.usage_events (user_id, kind) values (''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'', ''tagging'')',
  'A writing usage events');
select pg_temp.expect_error('delete from public.usage_events', 'A deleting usage events (resetting caps)');

select pg_temp.expect_rows(
  'update public.users set display_name = ''Ay'' where id = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''', 1,
  'A can change their display name');
select pg_temp.expect_error(
  'update public.users set email = ''x@example.com'' where id = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''',
  'A changing their email column');

select pg_temp.expect_rows(
  'update public.items set description = ''Hacked'' where user_id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''', 0,
  'A updating B''s items changes nothing');
select pg_temp.expect_rows(
  'delete from public.items where user_id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''', 0,
  'A deleting B''s items changes nothing');
select pg_temp.expect_error(
  'update public.items set user_id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'' where id = ''a0000000-0000-4000-8000-000000000001''',
  'A giving an item to B');

select pg_temp.expect_error($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'photo',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000009.jpg',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000010.png',
    'top', 'shirt', array['white'], 'plain', 2, array['spring'], 'medium', array['casual'], 'Planted item')
$$, 'A inserting an item as B');

select pg_temp.expect_error($$
  insert into public.outfits (user_id, request, name, reason, item_ids)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"style": {"kind": "preset", "presetId": "work"}}', 'Borrowed', 'Uses B''s dress',
    array['b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003']::uuid[])
$$, 'A building an outfit with B''s item');

select pg_temp.expect_error($$
  insert into public.outfits (user_id, request, name, reason, item_ids, parent_outfit_id)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"style": {"kind": "preset", "presetId": "work"}}', 'Child', 'Refines B''s outfit',
    array['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003']::uuid[],
    'b1000000-0000-4000-8000-000000000001')
$$, 'A refining B''s outfit');

select pg_temp.expect_rows($$
  insert into public.outfits (id, user_id, request, name, reason, item_ids)
  values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '{"style": {"kind": "preset", "presetId": "work"}, "guidance": null, "anchorItemId": null}',
    'Office classic', 'Navy and tan keep this smart without being stiff',
    array['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003']::uuid[])
$$, 1, 'A creates an outfit from their own items');

select pg_temp.expect_rows($$
  insert into public.outfits (id, user_id, request, name, reason, item_ids, parent_outfit_id)
  values ('a1000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '{"style": {"kind": "preset", "presetId": "work"}, "guidance": "warmer", "anchorItemId": null}',
    'Office, warmer', 'Same idea for colder days',
    array['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003']::uuid[],
    'a1000000-0000-4000-8000-000000000001')
$$, 1, 'A refines their own outfit (composition is the app''s job, not the DB''s)');

select pg_temp.expect_rows($$
  insert into public.outfit_feedback (outfit_id, user_id, kind, detail)
  values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'guidance', 'warmer')
$$, 1, 'A leaves feedback on their own outfit');

select pg_temp.expect_error($$
  insert into public.outfit_feedback (outfit_id, user_id, kind, detail)
  values ('b1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'reject', null)
$$, 'A leaving feedback on B''s outfit');

select pg_temp.expect_error(
  'update public.outfit_feedback set detail = ''edited''',
  'A editing feedback (append-only)');

select pg_temp.expect_rows(
  'update public.outfits set status = ''saved'' where id = ''a1000000-0000-4000-8000-000000000001''', 1,
  'A saves their outfit');
select pg_temp.expect_error(
  'update public.outfits set status = ''loved'' where id = ''a1000000-0000-4000-8000-000000000001''',
  'unknown outfit status');

select pg_temp.expect_rows(
  'insert into storage.objects (bucket_id, name) values (''originals'', ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000001.jpg'')', 1,
  'A uploads into their own folder');
select pg_temp.expect_error(
  'insert into storage.objects (bucket_id, name) values (''originals'', ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/planted.jpg'')',
  'A uploading into B''s folder');
select pg_temp.expect_rows(
  'delete from storage.objects where bucket_id = ''cutouts''', 0,
  'A deleting B''s images changes nothing');

-- Deleting an item removes outfits that used it (and their children keep
-- existing with parent_outfit_id cleared, unless they used it too).
select pg_temp.expect_rows(
  'delete from public.items where id = ''a0000000-0000-4000-8000-000000000002''', 1,
  'A deletes their chinos');
select pg_temp.expect_count(
  'select * from public.outfits where id = ''a1000000-0000-4000-8000-000000000001''', 0,
  'outfit that used the deleted item is gone');
select pg_temp.expect_count(
  'select * from public.outfits where id = ''a1000000-0000-4000-8000-000000000002'' and parent_outfit_id is null', 1,
  'refined outfit without the item survives, unlinked from its parent');

reset role;

-- Buckets ---------------------------------------------------------------------

select pg_temp.expect_count(
  'select * from storage.buckets where id in (''originals'', ''cutouts'') and public = false', 2,
  'both image buckets exist and are private');

-- Account deletion --------------------------------------------------------------

select pg_temp.expect_rows(
  'delete from auth.users where id = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''', 1,
  'deleting A''s auth user succeeds');
select pg_temp.expect_count(
  'select * from public.items where user_id = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''', 0,
  'A''s items are deleted with the account');
select pg_temp.expect_count(
  'select * from public.outfits where user_id = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''', 0,
  'A''s outfits are deleted with the account');
select pg_temp.expect_count(
  'select * from public.usage_events where user_id is null and cost_pence > 0', 1,
  'A''s AI spend still counts towards the month, unlinked from them');
select pg_temp.expect_count('select * from public.items', 3, 'B''s items are untouched');

do $$
declare
  spend numeric;
begin
  select public.ai_spend_pence_since(now() - interval '1 day') into spend;
  if spend <> 0.52 then
    raise exception 'FAIL: monthly spend is %, expected 0.52', spend;
  end if;
  raise notice 'ok: ai_spend_pence_since sums every user''s costs';
end;
$$;

\o
\echo 'All migration checks passed.'
