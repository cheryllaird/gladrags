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

-- Images are written by the server (secret key), never by users.
insert into storage.objects (bucket_id, name) values
  ('cutouts', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000002.png'),
  ('originals', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000001.jpg'),
  ('originals', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000003.jpg');

insert into public.link_imports (original_image_key, user_id, source_url, product, created_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000030.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'https://shop.example.com/p/1', '{"title": "Linen shirt", "brand": "Example", "colour": "Navy"}', now()),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000031.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'https://shop.example.com/p/2', '{}', now() - interval '2 hours');

-- Extra two-user checks (security review, milestone 4) ---------------------
-- A also has one outfit of their own from here on.

insert into public.outfit_feedback (outfit_id, user_id, kind, detail)
values ('b1000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'reject', 'B private reason');
insert into public.outfits (id, user_id, request, name, reason, item_ids)
values ('a1000000-0000-4000-8000-0000000000aa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '{"style": {"kind": "preset", "presetId": "work"}}', 'A own', 'A reason',
  array['a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000003']::uuid[]);

set role anon;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.expect_error('select * from public.outfits', 'X anon reading outfits');
select pg_temp.expect_error('select * from public.outfit_feedback', 'X anon reading feedback');
select pg_temp.expect_error('select * from public.usage_events', 'X anon reading usage');
select pg_temp.expect_error('select * from public.link_imports', 'X anon reading link imports');
select pg_temp.expect_count('select * from storage.objects', 0, 'X anon sees no storage objects');
select pg_temp.expect_error('select public.ai_spend_pence_since(now())', 'X anon calling spend RPC');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false);
select pg_temp.expect_count('select * from public.outfit_feedback', 0, 'X A cannot read B''s feedback');
select pg_temp.expect_count('select * from public.users where id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''', 0, 'X A cannot read B''s profile/email');
select pg_temp.expect_count('select * from storage.objects where name like ''bbbbbbbb%''', 0, 'X A cannot list B''s images');
select pg_temp.expect_rows('update public.users set display_name = ''pwned'' where id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''', 0, 'X A renaming B changes nothing');
select pg_temp.expect_rows('update public.outfits set status = ''rejected'' where id = ''b1000000-0000-4000-8000-000000000001''', 0, 'X A updating B''s outfit changes nothing');
select pg_temp.expect_rows('delete from public.outfits where id = ''b1000000-0000-4000-8000-000000000001''', 0, 'X A deleting B''s outfit changes nothing');
select pg_temp.expect_error('delete from public.outfit_feedback', 'X A deleting feedback');
select pg_temp.expect_error('update public.outfits set user_id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'' where id = ''a1000000-0000-4000-8000-0000000000aa''', 'X A giving an outfit to B');
select pg_temp.expect_error('update public.outfits set item_ids = array[''b0000000-0000-4000-8000-000000000001'',''a0000000-0000-4000-8000-000000000003'']::uuid[] where id = ''a1000000-0000-4000-8000-0000000000aa''', 'X A swapping B''s item into own outfit');
select pg_temp.expect_error('update public.outfits set parent_outfit_id = ''b1000000-0000-4000-8000-000000000001'' where id = ''a1000000-0000-4000-8000-0000000000aa''', 'X A pointing own outfit at B''s as parent');
select pg_temp.expect_error($$insert into public.outfit_feedback (outfit_id, user_id, kind, detail) values ('a1000000-0000-4000-8000-0000000000aa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'guidance', 'forged')$$, 'X A writing feedback as B');
select pg_temp.expect_error('update public.items set original_image_key = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000001.jpg'' where id = ''a0000000-0000-4000-8000-000000000001''', 'X A pointing own item at B''s image key');
select pg_temp.expect_error('select public.is_email_allowed(''b@example.com'')', 'X A probing the allowlist');
select pg_temp.expect_error('select public.enforce_email_allowlist()', 'X A calling trigger fn');
select pg_temp.expect_error('select public.create_user_profile()', 'X A calling profile trigger fn');
select pg_temp.expect_error('update storage.buckets set public = true', 'X A making a bucket public');
select pg_temp.expect_error('insert into public.users (id, email) values (gen_random_uuid(), ''x@example.com'')', 'X A inserting a profile');
select pg_temp.expect_error('delete from public.users where id = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''', 'X A deleting own profile directly');
select pg_temp.expect_error('update public.usage_events set cost_pence = 0', 'X A zeroing usage');
reset role;

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
select pg_temp.expect_count('select * from public.outfits', 1, 'A sees only their own outfit, not B''s');
select pg_temp.expect_count('select * from public.usage_events', 2, 'A sees only their own usage');
select pg_temp.expect_count('select * from storage.objects', 2, 'A sees only their own images');
select pg_temp.expect_error('select * from public.link_imports', 'A reading link imports (server only)');

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

select pg_temp.expect_error(
  'insert into storage.objects (bucket_id, name) values (''originals'', ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000009.jpg'')',
  'A uploading straight to storage, even into their own folder (skips EXIF stripping)');
select pg_temp.expect_error(
  'insert into storage.objects (bucket_id, name) values (''originals'', ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/planted.jpg'')',
  'A uploading into B''s folder');
select pg_temp.expect_rows(
  'update storage.objects set name = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/renamed.jpg'' where bucket_id = ''originals''', 0,
  'A changing their own images changes nothing (no update policy)');
select pg_temp.expect_rows(
  'delete from storage.objects where bucket_id = ''cutouts''', 0,
  'A deleting B''s images changes nothing');
select pg_temp.expect_rows(
  'delete from storage.objects where name = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000003.jpg''', 1,
  'A deletes one of their own images');

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

-- Link imports: step 2 claims an import once (as the server, with the secret key)

select pg_temp.expect_rows($$
  update public.link_imports set tagged_at = now()
  where original_image_key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000030.jpg'
    and user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and tagged_at is null and created_at > now() - interval '1 hour'
$$, 1, 'step 2 claims a fresh import');
select pg_temp.expect_rows($$
  update public.link_imports set tagged_at = now()
  where original_image_key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000030.jpg'
    and user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and tagged_at is null and created_at > now() - interval '1 hour'
$$, 0, 'replaying step 2 claims nothing (single use)');
select pg_temp.expect_rows($$
  update public.link_imports set tagged_at = now()
  where original_image_key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000031.jpg'
    and user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and tagged_at is null and created_at > now() - interval '1 hour'
$$, 0, 'an expired import can''t be claimed');
select pg_temp.expect_rows($$
  update public.link_imports set tagged_at = now()
  where original_image_key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/00000000-0000-4000-8000-000000000031.jpg'
    and user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and tagged_at is null
$$, 0, 'B can''t claim A''s import');
select pg_temp.expect_error($$
  insert into public.link_imports (original_image_key, user_id, source_url)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000040.jpg', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'https://x.example.com')
$$, 'link import whose image is in another user''s folder');

-- Email changes go through the allowlist too ----------------------------------

select pg_temp.expect_error(
  'update auth.users set email = ''stranger@example.com'' where id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''',
  'changing an account''s email to one not on the allowlist');
insert into public.allowed_emails (email) values ('b.new@example.com');
select pg_temp.expect_rows(
  'update auth.users set email = ''B.New@example.com'' where id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''', 1,
  'changing an account''s email to an allowlisted one');
select pg_temp.expect_count(
  'select * from public.users where id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'' and email = ''b.new@example.com''', 1,
  'the profile''s email follows the change');

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

-- Hardening (migration 6) ------------------------------------------------------

-- Unique image keys: one draft can't become two items.
select pg_temp.expect_error($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'photo',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000001.jpg', null,
    'top', 'blouse', array['cream'], 'plain', 3, array['spring'], 'light', array['work'], 'Same original twice')
$$, 'a second item with an original image key already in use');
select pg_temp.expect_error($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'photo',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000050.jpg',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000002.png',
    'top', 'blouse', array['cream'], 'plain', 3, array['spring'], 'light', array['work'], 'Same cut-out twice')
$$, 'a second item with a cut-out key already in use');
select pg_temp.expect_rows($$
  insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
    colours, pattern, formality, seasons, warmth, occasions, description)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'photo',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/00000000-0000-4000-8000-000000000051.jpg', null,
    'top', 'polo', array['white'], 'plain', 2, array['summer'], 'light', array['casual'], 'Another item without a cut-out')
$$, 1, 'several items may have no cut-out (the unique index ignores nulls)');

-- Allowlist trigger only fires when the email changes.
delete from public.allowed_emails where email = 'b.new@example.com';
select pg_temp.expect_rows(
  'update auth.users set email = email where id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''', 1,
  'a routine auth.users update with the email unchanged works even after the allowlist row is gone');
select pg_temp.expect_error(
  'update auth.users set email = ''elsewhere@example.com'' where id = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''',
  'an actual email change is still checked');
insert into public.allowed_emails (email) values ('b.new@example.com');

-- link_fetch is a usage kind.
select pg_temp.expect_rows(
  'insert into public.usage_events (user_id, kind) values (''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'', ''link_fetch'')', 1,
  'link_fetch usage events are allowed');

-- reserve_usage and reserve_sign_in_attempt are server-only.
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.expect_error(
  'select public.reserve_usage(null, ''tagging'', null, null, 0, null, null)', 'anon calling reserve_usage');
select pg_temp.expect_error(
  'select public.reserve_sign_in_attempt(''magic_link'', repeat(''a'', 64), null, 5, 20, 900)', 'anon calling reserve_sign_in_attempt');
select pg_temp.expect_error('select * from public.sign_in_attempts', 'anon reading sign-in attempts');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false);
select pg_temp.expect_error(
  'select public.reserve_usage(''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'', ''item_ingest'', 1000, now() - interval ''1 hour'', 0, null, null)',
  'a user reserving their own usage directly');
select pg_temp.expect_error(
  'select public.reserve_sign_in_attempt(''magic_link'', repeat(''a'', 64), null, 5, 20, 900)', 'a user calling reserve_sign_in_attempt');
select pg_temp.expect_error('select * from public.sign_in_attempts', 'a user reading sign-in attempts');
select pg_temp.expect_error('delete from public.sign_in_attempts', 'a user clearing sign-in attempts');
reset role;

-- reserve_usage, one call at a time (supabase/tests/concurrency.sh covers
-- calls at the same moment).
do $$
declare
  b constant uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  day_start constant timestamptz := date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London';
  month_start constant timestamptz := date_trunc('month', now() at time zone 'Europe/London') at time zone 'Europe/London';
  r jsonb;
  ok_count int := 0;
begin
  for i in 1..3 loop
    r := public.reserve_usage(b, 'outfit_request', 2, day_start, 0, 1000000, month_start);
    if (r->>'ok')::boolean then ok_count := ok_count + 1; end if;
  end loop;
  if ok_count <> 2 or r->>'denied' <> 'daily_cap' or (r->>'used')::int <> 2 or r->>'event_id' is not null then
    raise exception 'FAIL: daily limit 2 gave % reservations, last %', ok_count, r;
  end if;
  raise notice 'ok: reserve_usage allows the daily limit, then refuses with daily_cap';

  if (select count(*) from public.usage_events where user_id = b and kind = 'outfit_request') <> 2 then
    raise exception 'FAIL: a refused reservation inserted a row';
  end if;
  raise notice 'ok: a refused reservation records nothing';

  begin
    r := public.reserve_usage(b, 'outfit_request', 2, day_start - interval '2 days', 0, null, null);
    raise exception 'FAIL: a day start from two days ago was accepted: %', r;
  exception when invalid_parameter_value then
    raise notice 'ok: reserve_usage refuses a day start that is not today';
  end;
end;
$$;

do $$
declare
  b constant uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  month_start constant timestamptz := date_trunc('month', now() at time zone 'Europe/London') at time zone 'Europe/London';
  spent numeric := public.ai_spend_pence_since(month_start);
  r jsonb;
begin
  -- Cap = spend so far + 0.3p: a 0.2p call fits, the next takes the month
  -- to 0.4p over (allowed: the cap is reached, not approached), then it's paused.
  r := public.reserve_usage(b, 'tagging', null, null, 0.2, spent + 0.3, month_start, 'gemini');
  if not (r->>'ok')::boolean then raise exception 'FAIL: first AI reservation refused: %', r; end if;
  r := public.reserve_usage(b, 'tagging', null, null, 0.2, spent + 0.3, month_start, 'gemini');
  if not (r->>'ok')::boolean then raise exception 'FAIL: second AI reservation refused: %', r; end if;
  r := public.reserve_usage(b, 'tagging', null, null, 0.2, spent + 0.3, month_start, 'gemini');
  if (r->>'ok')::boolean or r->>'denied' <> 'monthly_spend' then raise exception 'FAIL: third AI reservation allowed: %', r; end if;
  raise notice 'ok: reserve_usage refuses AI calls once the month''s spend reaches the cap';

  r := public.reserve_usage(b, 'item_ingest', 1000, now() - interval '1 hour', 0, spent + 0.3, month_start);
  if (r->>'ok')::boolean or r->>'denied' <> 'monthly_spend' then raise exception 'FAIL: daily action allowed while paused: %', r; end if;
  raise notice 'ok: a daily action that uses AI is refused while AI is paused';

  r := public.reserve_usage(b, 'link_fetch', 1000, now() - interval '1 hour', 0, null, null);
  if not (r->>'ok')::boolean then raise exception 'FAIL: link fetch refused: %', r; end if;
  raise notice 'ok: link fetches (no AI) are not affected by the AI pause';

  if (select count(*) from public.usage_events where kind = 'tagging' and user_id = b and provider = 'gemini') <> 2 then
    raise exception 'FAIL: reserved AI calls not recorded with their provider';
  end if;
  raise notice 'ok: reserved AI calls are recorded with their provider';
  delete from public.usage_events where user_id = b and kind = 'tagging';
end;
$$;

-- reserve_sign_in_attempt, one call at a time.
do $$
declare
  email_a constant text := repeat('a', 64);
  email_b constant text := repeat('b', 64);
  ip constant text := repeat('c', 64);
  r jsonb;
begin
  for i in 1..5 loop
    r := public.reserve_sign_in_attempt('magic_link', email_a, ip, 5, 7, 900);
    if not (r->>'ok')::boolean then raise exception 'FAIL: attempt % refused: %', i, r; end if;
  end loop;
  r := public.reserve_sign_in_attempt('magic_link', email_a, ip, 5, 7, 900);
  if (r->>'ok')::boolean or r->>'denied' <> 'email' or r->>'retry_at' is null then
    raise exception 'FAIL: sixth attempt for one email: %', r;
  end if;
  raise notice 'ok: sign-in attempts are limited per email, with a retry time';

  r := public.reserve_sign_in_attempt('verify_code', email_a, ip, 5, 7, 900);
  if not (r->>'ok')::boolean then raise exception 'FAIL: code checks share the link limit: %', r; end if;
  raise notice 'ok: magic-link and code-check limits are counted separately';

  r := public.reserve_sign_in_attempt('magic_link', email_b, ip, 5, 7, 900);
  r := public.reserve_sign_in_attempt('magic_link', email_b, ip, 5, 7, 900);
  if not (r->>'ok')::boolean then raise exception 'FAIL: IP refused too early: %', r; end if;
  r := public.reserve_sign_in_attempt('magic_link', email_b, ip, 5, 7, 900);
  if (r->>'ok')::boolean or r->>'denied' <> 'ip' then raise exception 'FAIL: IP limit not applied: %', r; end if;
  raise notice 'ok: sign-in attempts are limited per IP address across emails';

  r := public.reserve_sign_in_attempt('magic_link', email_b, null, 5, 7, 900);
  if not (r->>'ok')::boolean then raise exception 'FAIL: unknown IP should only use the email limit: %', r; end if;
  raise notice 'ok: with no known IP only the email limit applies';

  update public.sign_in_attempts set created_at = now() - interval '16 minutes' where key_hash = email_a;
  r := public.reserve_sign_in_attempt('magic_link', email_a, null, 5, 7, 900);
  if not (r->>'ok')::boolean then raise exception 'FAIL: window did not slide: %', r; end if;
  raise notice 'ok: attempts older than the window no longer count';

  begin
    perform public.reserve_sign_in_attempt('magic_link', 'not-a-hash', null, 5, 7, 900);
    raise exception 'FAIL: a raw (unhashed) key was stored';
  exception when check_violation then
    raise notice 'ok: only 64-hex-digit (HMAC-SHA-256) keys are stored, never raw emails or IPs';
  end;
end;
$$;

\o
\echo 'All migration checks passed.'
