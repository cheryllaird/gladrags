-- QA (round 2, P1): adversarial checks on migration 8 beyond rls.test.sql.
-- Run by supabase/tests/qa-concurrency.sh (so by pnpm db:verify) against
-- the throwaway database, never a real project. Any failure raises an
-- error. (The two "KNOWN BUG" lines are now assertions: both bugs are fixed.)
--
-- Users: R (9c...) and S (9d...).

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

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

insert into public.allowed_emails (email) values ('qa-r@example.com'), ('qa-s@example.com') on conflict do nothing;
insert into auth.users (id, email) values
  ('9c000000-0000-4000-8000-00000000009c', 'qa-r@example.com'),
  ('9d000000-0000-4000-8000-00000000009d', 'qa-s@example.com');

-- R: tee (1), jeans (2), trainers (3), coat (4). S: dress (1), heels (2).
insert into public.items (id, user_id, source, original_image_key, category, subcategory, colours, pattern, formality, seasons, warmth, occasions, description)
select v.id::uuid, v.u::uuid, 'photo', v.u || '/00000000-0000-4000-8000-0000000000' || v.n || '.jpg', v.cat, v.sub, array[v.col], 'plain', 2, array['summer'], 'light', array['casual'], v.d
from (values
  ('9c100000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-00000000009c', '01', 'top', 't_shirt', 'white', 'Tee'),
  ('9c100000-0000-4000-8000-000000000002', '9c000000-0000-4000-8000-00000000009c', '02', 'bottom', 'jeans', 'blue', 'Jeans'),
  ('9c100000-0000-4000-8000-000000000003', '9c000000-0000-4000-8000-00000000009c', '03', 'shoes', 'trainers', 'white', 'Trainers'),
  ('9c100000-0000-4000-8000-000000000004', '9c000000-0000-4000-8000-00000000009c', '04', 'outerwear', 'coat', 'brown', 'Coat'),
  ('9d100000-0000-4000-8000-000000000001', '9d000000-0000-4000-8000-00000000009d', '05', 'dress_jumpsuit', 'dress', 'red', 'Dress'),
  ('9d100000-0000-4000-8000-000000000002', '9d000000-0000-4000-8000-00000000009d', '06', 'shoes', 'heels', 'black', 'Heels')
) as v (id, u, n, cat, sub, col, d);

-- R's outfits 1-4: tee + jeans + a shoes gap (one look). 5: tee + jeans + trainers.
-- 6: tee + jeans + coat + trainers. S's outfit 1: dress + heels.
insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps)
select ('9c200000-0000-4000-8000-00000000000' || n)::uuid, '9c000000-0000-4000-8000-00000000009c', '{"style": {"kind": "preset", "presetId": "casual"}}', 'Gap', 'x',
  array['9c100000-0000-4000-8000-000000000001', '9c100000-0000-4000-8000-000000000002']::uuid[],
  '[{"category": "shoes", "subcategory": "trainers", "colours": ["white"], "description": "White trainers"}]'
from generate_series(1, 4) n;
insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps) values
  ('9c200000-0000-4000-8000-000000000005', '9c000000-0000-4000-8000-00000000009c', '{"style": {"kind": "preset", "presetId": "casual"}}', 'Full', 'x',
   array['9c100000-0000-4000-8000-000000000001', '9c100000-0000-4000-8000-000000000002', '9c100000-0000-4000-8000-000000000003']::uuid[], '[]'),
  ('9c200000-0000-4000-8000-000000000006', '9c000000-0000-4000-8000-00000000009c', '{"style": {"kind": "preset", "presetId": "casual"}}', 'Coat', 'x',
   array['9c100000-0000-4000-8000-000000000001', '9c100000-0000-4000-8000-000000000002', '9c100000-0000-4000-8000-000000000004', '9c100000-0000-4000-8000-000000000003']::uuid[], '[]'),
  ('9d200000-0000-4000-8000-000000000001', '9d000000-0000-4000-8000-00000000009d', '{"style": {"kind": "preset", "presetId": "evening_out"}}', 'Red', 'x',
   array['9d100000-0000-4000-8000-000000000001', '9d100000-0000-4000-8000-000000000002']::uuid[], '[]');

-- 1. Another user's look is never reused -------------------------------------------

do $$
declare
  r_user constant uuid := '9c000000-0000-4000-8000-00000000009c';
  s_user constant uuid := '9d000000-0000-4000-8000-00000000009d';
  k constant text := repeat('e', 64);
  res jsonb;
  s_id uuid;
begin
  res := public.claim_outfit_preview(s_user, '9d200000-0000-4000-8000-000000000001', k, 'women_plus_deep', false, 150);
  s_id := (res ->> 'preview_id')::uuid;
  update public.outfit_previews set status = 'ready', image_key = s_user || '/00000000-0000-4000-8000-0000000000e1.webp' where id = s_id;

  -- R's outfit with the very same key and preset must get R's own preview.
  res := public.claim_outfit_preview(r_user, '9c200000-0000-4000-8000-000000000005', k, 'women_plus_deep', false, 150);
  if res ->> 'action' <> 'generate' or (res ->> 'preview_id')::uuid = s_id then
    raise exception 'FAIL: R reused S''s preview for the same key: %', res;
  end if;
  if (select user_id from public.outfit_previews where id = (res ->> 'preview_id')::uuid) <> r_user then
    raise exception 'FAIL: R''s new preview isn''t R''s';
  end if;
  raise notice 'ok: QA R2: the same key for another user is never reused (generate, own row)';

  -- And a pending one of S's isn't waited on either.
  res := public.claim_outfit_preview(s_user, '9d200000-0000-4000-8000-000000000001', repeat('f', 64), 'women_plus_deep', true, 150);
  res := public.claim_outfit_preview(r_user, '9c200000-0000-4000-8000-000000000006', repeat('f', 64), 'women_plus_deep', false, 150);
  if res ->> 'action' <> 'generate' then raise exception 'FAIL: R waited on S''s pending preview: %', res; end if;
  raise notice 'ok: QA R2: another user''s pending preview is never waited on';

  -- S claiming R's outfit, with R's key: not_found, nothing linked.
  res := public.claim_outfit_preview(s_user, '9c200000-0000-4000-8000-000000000001', repeat('f', 64), 'women_plus_deep', false, 150);
  if res ->> 'reason' <> 'not_found' then raise exception 'FAIL: S claimed R''s outfit: %', res; end if;
  if (select preview_id from public.outfits where id = '9c200000-0000-4000-8000-000000000001') is not null then
    raise exception 'FAIL: S''s claim linked R''s outfit';
  end if;
  raise notice 'ok: QA R2: a claim on another user''s outfit links nothing';
end;
$$;

-- Clean up for the next sections: unlink outfits 5 and 6 (their previews go).
update public.outfits set preview_id = null where id in ('9c200000-0000-4000-8000-000000000005', '9c200000-0000-4000-8000-000000000006');
select pg_temp.expect_count(
  'select 1 from public.outfit_previews where user_id = ''9c000000-0000-4000-8000-00000000009c''', 0,
  'QA R2: unlinking the only outfit using a preview deletes it');

-- 2. Bad arguments -----------------------------------------------------------------

select pg_temp.expect_error($$select public.claim_outfit_preview(null, '9c200000-0000-4000-8000-000000000001', repeat('a', 64), 'women_slim_light', false, 150)$$, 'QA R2: claim with no user');
select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', null, repeat('a', 64), 'women_slim_light', false, 150)$$, 'QA R2: claim with no outfit');
select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000001', repeat('A', 64), 'women_slim_light', false, 150)$$, 'QA R2: claim with an upper-case key');
select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000001', repeat('a', 63), 'women_slim_light', false, 150)$$, 'QA R2: claim with a short key');
select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000001', repeat('a', 64) || E'\n', 'women_slim_light', false, 150)$$, 'QA R2: claim with a key and a trailing newline');
select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000001', repeat('a', 64), null, false, 150)$$, 'QA R2: claim with no preset');
select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000001', repeat('a', 64), 'women_slim_light', null, 150)$$, 'QA R2: claim with a null refresh');
select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000001', repeat('a', 64), 'women_slim_light', false, 0)$$, 'QA R2: claim with a zero stale time');
select pg_temp.expect_count(
  'select 1 from public.outfits where id::text like ''9c2%'' and preview_id is not null', 0,
  'QA R2: refused claims linked nothing');

-- 3. Outfit deletion releases the image only when unused -----------------------------

do $$
declare
  r_user constant uuid := '9c000000-0000-4000-8000-00000000009c';
  k constant text := repeat('d', 64);
  res jsonb;
  pid uuid;
  i int;
begin
  for i in 1..4 loop
    res := public.claim_outfit_preview(r_user, ('9c200000-0000-4000-8000-00000000000' || i)::uuid, k, 'men_slim_deep', false, 150);
    if i = 1 then
      pid := (res ->> 'preview_id')::uuid;
      update public.outfit_previews set status = 'ready', image_key = r_user || '/00000000-0000-4000-8000-0000000000d1.webp' where id = pid;
    elsif res ->> 'action' <> 'reused' then
      raise exception 'FAIL: outfit % didn''t reuse the ready look: %', i, res;
    end if;
  end loop;
  raise notice 'ok: QA R2: four outfits with one look share one ready preview';

  delete from public.outfits where id = '9c200000-0000-4000-8000-000000000004';
  delete from public.outfits where id = '9c200000-0000-4000-8000-000000000003';
  delete from public.outfits where id = '9c200000-0000-4000-8000-000000000002';
  if not exists (select 1 from public.outfit_previews where id = pid) then
    raise exception 'FAIL: the preview went while outfit 1 still uses it';
  end if;
  raise notice 'ok: QA R2: deleting three of four sharers keeps the preview';

  -- A deletion of several sharers in one statement, leaving none: gone.
  insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps)
  values ('9c200000-0000-4000-8000-000000000007', r_user, '{"style": {"kind": "preset", "presetId": "casual"}}', 'Gap', 'x',
    array['9c100000-0000-4000-8000-000000000001', '9c100000-0000-4000-8000-000000000002']::uuid[],
    '[{"category": "shoes", "subcategory": "trainers", "colours": ["white"], "description": "White trainers"}]');
  res := public.claim_outfit_preview(r_user, '9c200000-0000-4000-8000-000000000007', k, 'men_slim_deep', false, 150);
  if res ->> 'action' <> 'reused' then raise exception 'FAIL: outfit 7 reuse: %', res; end if;
  delete from public.outfits where id in ('9c200000-0000-4000-8000-000000000001', '9c200000-0000-4000-8000-000000000007');
  if exists (select 1 from public.outfit_previews where id = pid) then
    raise exception 'FAIL: the preview stayed after its last outfits were deleted in one statement';
  end if;
  raise notice 'ok: QA R2: deleting the last sharers (in one statement) deletes the preview';
end;
$$;

-- A preview no outfit links (a crash between claim and link can't happen, but
-- a row could be left by hand) is unaffected by unrelated outfit deletes.
insert into public.outfit_previews (user_id, cache_key, preset_id, item_ids, status, failure_reason)
values ('9c000000-0000-4000-8000-00000000009c', repeat('c', 64), 'men_slim_deep', array['9c100000-0000-4000-8000-000000000003']::uuid[], 'failed', 'blocked');
delete from public.outfits where id = '9c200000-0000-4000-8000-000000000006';
select pg_temp.expect_count('select 1 from public.outfit_previews where user_id = ''9c000000-0000-4000-8000-00000000009c'' and cache_key = repeat(''c'', 64)', 1,
  'QA R2: deleting an unrelated outfit leaves other previews alone');

-- 4. Item deletion and photo replacement ------------------------------------------------

do $$
declare
  r_user constant uuid := '9c000000-0000-4000-8000-00000000009c';
  s_user constant uuid := '9d000000-0000-4000-8000-00000000009d';
  res jsonb;
  pid uuid;
begin
  res := public.claim_outfit_preview(r_user, '9c200000-0000-4000-8000-000000000005', repeat('b', 64), 'men_slim_deep', false, 150);
  pid := (res ->> 'preview_id')::uuid;
  update public.outfit_previews set status = 'ready', image_key = r_user || '/00000000-0000-4000-8000-0000000000b1.webp' where id = pid;

  -- S's photo change can't touch R's previews, even naming R's item id in S's own row.
  update public.items set original_image_key = s_user || '/00000000-0000-4000-8000-0000000000b9.jpg'
  where id = '9d100000-0000-4000-8000-000000000001';
  if not exists (select 1 from public.outfit_previews where id = pid) then raise exception 'FAIL: S''s new photo deleted R''s preview'; end if;

  -- Editing tags or the cut-out keeps it; the same original key written again keeps it.
  update public.items set description = 'Plain white tee', cutout_image_key = r_user || '/00000000-0000-4000-8000-0000000000b2.png'
  where id = '9c100000-0000-4000-8000-000000000003';
  update public.items set original_image_key = original_image_key where id = '9c100000-0000-4000-8000-000000000003';
  if not exists (select 1 from public.outfit_previews where id = pid) then raise exception 'FAIL: a tag, cut-out or no-op photo write deleted the preview'; end if;
  raise notice 'ok: QA R2: tags, a cut-out, a rewrite of the same photo and another user''s photo keep the preview';

  update public.items set original_image_key = r_user || '/00000000-0000-4000-8000-0000000000b3.jpg' where id = '9c100000-0000-4000-8000-000000000003';
  if exists (select 1 from public.outfit_previews where id = pid) then raise exception 'FAIL: a new photo kept the preview'; end if;
  if (select preview_id from public.outfits where id = '9c200000-0000-4000-8000-000000000005') is not null then
    raise exception 'FAIL: the outfit still links the deleted preview';
  end if;
  if (select preview_outdated from public.outfits where id = '9c200000-0000-4000-8000-000000000005') then
    raise exception 'FAIL: the unlinked outfit reads outdated';
  end if;
  raise notice 'ok: QA R2: a new photo deletes the preview and the outfit reads none (not outdated)';

  -- Reclaiming after the photo change makes a new one.
  res := public.claim_outfit_preview(r_user, '9c200000-0000-4000-8000-000000000005', repeat('b', 64), 'men_slim_deep', false, 150);
  if res ->> 'action' <> 'generate' then raise exception 'FAIL: claim after a new photo: %', res; end if;
  raise notice 'ok: QA R2: the next claim after a new photo generates again';
end;
$$;

-- The unlinked 'c' preview shows trainers (item 3): deleting the item takes it too.
delete from public.items where id = '9c100000-0000-4000-8000-000000000003';
select pg_temp.expect_count('select 1 from public.outfit_previews where user_id = ''9c000000-0000-4000-8000-00000000009c''', 0,
  'QA R2: deleting an item deletes every preview showing it, linked or not');

-- 5. What users can't write or call ----------------------------------------------------

-- An outfit for R with a preview, for the checks below.
insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps) values
  ('9c200000-0000-4000-8000-000000000008', '9c000000-0000-4000-8000-00000000009c', '{"style": {"kind": "preset", "presetId": "casual"}}', 'Gap', 'x',
   array['9c100000-0000-4000-8000-000000000001', '9c100000-0000-4000-8000-000000000002']::uuid[],
   '[{"category": "shoes", "subcategory": "trainers", "colours": ["white"], "description": "White trainers"}]');
select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000008', repeat('8', 64), 'men_slim_deep', false, 150);
insert into storage.objects (bucket_id, name) values
  ('previews', '9c000000-0000-4000-8000-00000000009c/00000000-0000-4000-8000-0000000000a1.webp'),
  ('previews', '9d000000-0000-4000-8000-00000000009d/00000000-0000-4000-8000-0000000000a2.webp');

set role authenticated;
select set_config('request.jwt.claim.sub', '9c000000-0000-4000-8000-00000000009c', false);

select pg_temp.expect_error($$
  insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps, preview_id)
  values (gen_random_uuid(), '9c000000-0000-4000-8000-00000000009c', '{"style": {"kind": "preset", "presetId": "casual"}}', 'x', 'x',
    array['9c100000-0000-4000-8000-000000000001', '9c100000-0000-4000-8000-000000000002']::uuid[], '[]',
    (select preview_id from public.outfits where id = '9c200000-0000-4000-8000-000000000008'))
$$, 'QA R2: R inserting an outfit with a preview_id (a free reuse)');
select pg_temp.expect_error($$
  insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps, preview_outdated)
  values (gen_random_uuid(), '9c000000-0000-4000-8000-00000000009c', '{"style": {"kind": "preset", "presetId": "casual"}}', 'x', 'x',
    array['9c100000-0000-4000-8000-000000000001', '9c100000-0000-4000-8000-000000000002']::uuid[], '[]', true)
$$, 'QA R2: R inserting an outfit with preview_outdated');
select pg_temp.expect_error(
  $$update public.outfits set preview_outdated = false where id = '9c200000-0000-4000-8000-000000000008'$$,
  'QA R2: R clearing preview_outdated');
select pg_temp.expect_error(
  $$update public.outfits set preview_id = gen_random_uuid() where id = '9c200000-0000-4000-8000-000000000008'$$,
  'QA R2: R pointing an outfit at another preview');
select pg_temp.expect_rows(
  $$update public.outfits set name = 'Renamed' where id = '9c200000-0000-4000-8000-000000000008'$$, 1,
  'QA R2: R can still rename their outfit');
select pg_temp.expect_error($$delete from public.outfit_previews$$, 'QA R2: R deleting previews');
select pg_temp.expect_error($$update public.outfit_previews set status = 'skipped', failure_reason = 'ai_paused'$$, 'QA R2: R updating previews');
select pg_temp.expect_error($$truncate public.outfit_previews$$, 'QA R2: R truncating previews');
select pg_temp.expect_error($$update public.user_settings set forwarding_token = repeat('a', 32)$$, 'QA R2: R still can''t set the forwarding token');

select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000008', repeat('9', 64), 'men_slim_deep', true, 150)$$, 'QA R2: R calling claim_outfit_preview');
select pg_temp.expect_error($$select public.reserve_usage(null, 'image_generation', null, null, 0, 500, now(), null, null, null)$$, 'QA R2: R calling reserve_usage (10 args)');
select pg_temp.expect_error($$select public.reserve_usage(null, 'tagging', null, null, 0, 500, now(), null)$$, 'QA R2: R calling reserve_usage the old way (8 args)');
select pg_temp.expect_error($$select public.reserve_usage(p_user => null, p_kind => 'tagging', p_daily_limit => null, p_day_start => null, p_cost_pence => 0, p_monthly_cap_pence => null, p_month_start => null)$$, 'QA R2: R calling reserve_usage with named arguments');
select pg_temp.expect_error($$select public.ai_spend_pence_since(now() - interval '1 day')$$, 'QA R2: R calling ai_spend_pence_since (1 arg)');
select pg_temp.expect_error($$select public.ai_spend_pence_since(now() - interval '1 day', array['image_generation'])$$, 'QA R2: R calling ai_spend_pence_since (2 args)');
select pg_temp.expect_error($$select public.outfits_release_preview()$$, 'QA R2: R calling the release trigger function');
select pg_temp.expect_error($$select public.items_drop_previews()$$, 'QA R2: R calling the item trigger function');
select pg_temp.expect_error($$select public.outfits_preview_before_write()$$, 'QA R2: R calling the outfit trigger function');

-- Storage, as R.
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('previews', '9c000000-0000-4000-8000-00000000009c/00000000-0000-4000-8000-0000000000a3.webp')$$,
  'QA R2: R uploading into their own previews folder (server only)');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('previews', '9d000000-0000-4000-8000-00000000009d/00000000-0000-4000-8000-0000000000a4.webp')$$,
  'QA R2: R uploading into S''s previews folder');
select pg_temp.expect_rows($$update storage.objects set name = '9c000000-0000-4000-8000-00000000009c/x.webp' where bucket_id = 'previews'$$, 0,
  'QA R2: R renaming preview images changes nothing');
select pg_temp.expect_count($$select 1 from storage.objects where bucket_id = 'previews' and name like '9d%'$$, 0, 'QA R2: R can''t list S''s preview images');
select pg_temp.expect_count($$select 1 from storage.objects where bucket_id = 'previews' and name like '9c%'$$, 1, 'QA R2: R lists their own preview image');
select pg_temp.expect_rows($$delete from storage.objects where bucket_id = 'previews' and name like '9d%'$$, 0, 'QA R2: R deleting S''s preview image changes nothing');
-- The originals/cutouts policies don't open the previews bucket, nor the reverse.
select pg_temp.expect_rows($$update storage.objects set bucket_id = 'originals' where bucket_id = 'previews'$$, 0,
  'QA R2: R moving a preview into originals changes nothing');
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.expect_count($$select 1 from storage.objects where bucket_id = 'previews'$$, 0, 'QA R2: anon sees no preview images');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('previews', 'x/y.webp')$$, 'QA R2: anon uploading a preview');
select pg_temp.expect_error($$select public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000008', repeat('9', 64), 'men_slim_deep', true, 150)$$, 'QA R2: anon calling claim_outfit_preview');
select pg_temp.expect_error($$select public.reserve_usage(null, 'tagging', null, null, 0, 500, now(), null, null, null)$$, 'QA R2: anon calling reserve_usage');
reset role;

select pg_temp.expect_count(
  $$select 1 from storage.buckets where id = 'previews' and public = false and file_size_limit = 1572864 and allowed_mime_types = array['image/webp']$$, 1,
  'QA R2: the previews bucket is private, WebP only, 1.5 MB at most (PREVIEW_STORED_MAX_BYTES)');

-- The server (service_role) can still do its part.
set role service_role;
do $$
begin
  perform public.claim_outfit_preview('9c000000-0000-4000-8000-00000000009c', '9c200000-0000-4000-8000-000000000008', repeat('8', 64), 'men_slim_deep', false, 150);
  perform public.reserve_usage(null, 'tagging', null, null, 0, 500, now() - interval '1 day', null);
  raise notice 'ok: QA R2: service_role can claim previews and reserve usage';
end;
$$;
reset role;

-- 6. The monthly shares in reserve_usage ------------------------------------------------

delete from public.usage_events;
do $$
declare
  month_start timestamptz := date_trunc('month', now() at time zone 'Europe/London') at time zone 'Europe/London';
  day_start timestamptz := date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London';
  img constant text[] := array['image_generation'];
  shop constant text[] := array['shop_grounding'];
  r_user constant uuid := '9c000000-0000-4000-8000-00000000009c';
  res jsonb;
begin
  -- Images at 199.99p of 200p: one more is allowed, then images pause.
  insert into public.usage_events (user_id, kind, cost_pence) values (null, 'image_generation', 199.99);
  res := public.reserve_usage(null, 'image_generation', null, null, 4, 500, month_start, 'gemini', img, 200);
  if not (res ->> 'ok')::boolean then raise exception 'FAIL: image refused below its share: %', res; end if;
  res := public.reserve_usage(null, 'image_generation', null, null, 4, 500, month_start, 'gemini', img, 200);
  if res ->> 'denied' <> 'share_spend' then raise exception 'FAIL: image allowed at its share: %', res; end if;
  res := public.reserve_usage(r_user, 'outfit_preview', 12, day_start, 0, 500, month_start, null, img, 200);
  if res ->> 'denied' <> 'share_spend' then raise exception 'FAIL: preview action allowed with the images share spent: %', res; end if;
  raise notice 'ok: QA R2: images pause at 200p (199.99p still allows one more)';

  -- Everything else still works, shop search included.
  res := public.reserve_usage(null, 'shop_grounding', null, null, 3, 500, month_start, 'gemini', shop, 200);
  if not (res ->> 'ok')::boolean then raise exception 'FAIL: shop search paused by the images share: %', res; end if;
  res := public.reserve_usage(r_user, 'shop_search', 10, day_start, 0, 500, month_start, null, shop, 200);
  if not (res ->> 'ok')::boolean then raise exception 'FAIL: shop search action paused by the images share: %', res; end if;
  res := public.reserve_usage(null, 'tagging', null, null, 0.2, 500, month_start, 'gemini');
  if not (res ->> 'ok')::boolean then raise exception 'FAIL: tagging paused by the images share: %', res; end if;
  res := public.reserve_usage(r_user, 'item_ingest', 40, day_start, 0, 500, month_start);
  if not (res ->> 'ok')::boolean then raise exception 'FAIL: item ingest paused by the images share: %', res; end if;
  raise notice 'ok: QA R2: with the images share spent, shop search, tagging and items carry on';

  -- Shop search at its share: shop pauses, images (already paused) aside, tagging carries on.
  insert into public.usage_events (user_id, kind, cost_pence) values (null, 'shop_grounding', 197);
  res := public.reserve_usage(null, 'shop_grounding', null, null, 3, 500, month_start, 'gemini', shop, 200);
  if res ->> 'denied' <> 'share_spend' then raise exception 'FAIL: shop allowed at its share: %', res; end if;
  res := public.reserve_usage(r_user, 'shop_search', 10, day_start, 0, 500, month_start, null, shop, 200);
  if res ->> 'denied' <> 'share_spend' then raise exception 'FAIL: shop action allowed at its share: %', res; end if;
  res := public.reserve_usage(null, 'ranking_final', null, null, 0.5, 500, month_start, 'gemini');
  if not (res ->> 'ok')::boolean then raise exception 'FAIL: ranking paused by the shop share: %', res; end if;
  raise notice 'ok: QA R2: shop search pauses at its own share; ranking carries on';

  -- The overall £5 pauses everything, and is reported first.
  insert into public.usage_events (user_id, kind, cost_pence) values (null, 'tagging', 500);
  res := public.reserve_usage(null, 'tagging', null, null, 0.2, 500, month_start, 'gemini');
  if res ->> 'denied' <> 'monthly_spend' then raise exception 'FAIL: tagging allowed over £5: %', res; end if;
  res := public.reserve_usage(null, 'image_generation', null, null, 4, 500, month_start, 'gemini', img, 200);
  if res ->> 'denied' <> 'monthly_spend' then raise exception 'FAIL: over £5 with the share spent, reported %', res; end if;
  raise notice 'ok: QA R2: the overall £5 pauses everything and is reported before a share';
end;
$$;

delete from public.usage_events;
do $$
declare
  month_start timestamptz := date_trunc('month', now() at time zone 'Europe/London') at time zone 'Europe/London';
  day_start timestamptz := date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London';
  r_user constant uuid := '9c000000-0000-4000-8000-00000000009c';
  res jsonb;
  i int;
begin
  -- The overall cap with an unspent share: images refused as monthly_spend.
  insert into public.usage_events (user_id, kind, cost_pence) values (null, 'ranking_final', 500);
  res := public.reserve_usage(null, 'image_generation', null, null, 4, 500, month_start, 'gemini', array['image_generation'], 200);
  if res ->> 'denied' <> 'monthly_spend' then raise exception 'FAIL: images over £5 with the share unspent: %', res; end if;
  raise notice 'ok: QA R2: over £5 with the images share unspent, images still pause (monthly_spend)';
  delete from public.usage_events;

  -- Old callers: 8 positional arguments, and named ones without the share,
  -- behave as before (daily cap, monthly cap, no share).
  for i in 1..3 loop
    res := public.reserve_usage(r_user, 'item_ingest', 3, day_start, 0, 500, month_start, null);
    if not (res ->> 'ok')::boolean then raise exception 'FAIL: old caller refused under its cap: %', res; end if;
  end loop;
  res := public.reserve_usage(r_user, 'item_ingest', 3, day_start, 0, 500, month_start, null);
  if res ->> 'denied' <> 'daily_cap' then raise exception 'FAIL: old caller over its daily cap: %', res; end if;
  res := public.reserve_usage(p_user => null, p_kind => 'image_generation', p_daily_limit => null, p_day_start => null,
    p_cost_pence => 300, p_monthly_cap_pence => 500, p_month_start => month_start, p_provider => 'gemini');
  if not (res ->> 'ok')::boolean then raise exception 'FAIL: an old-style image reservation (no share) refused: %', res; end if;
  res := public.reserve_usage(p_user => null, p_kind => 'tagging', p_daily_limit => null, p_day_start => null,
    p_cost_pence => 0.2, p_monthly_cap_pence => 500, p_month_start => month_start);
  if not (res ->> 'ok')::boolean then raise exception 'FAIL: named old caller refused: %', res; end if;
  insert into public.usage_events (user_id, kind, cost_pence) values (null, 'tagging', 200);
  res := public.reserve_usage(null, 'tagging', null, null, 0.2, 500, month_start, 'gemini');
  if res ->> 'denied' <> 'monthly_spend' then raise exception 'FAIL: old caller over the monthly cap: %', res; end if;
  -- Only one reserve_usage exists (the old 8-argument one was replaced, not overloaded).
  if (select count(*) from pg_proc where proname = 'reserve_usage' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'FAIL: more than one reserve_usage';
  end if;
  if (select count(*) from pg_proc where proname = 'ai_spend_pence_since' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'FAIL: more than one ai_spend_pence_since';
  end if;
  raise notice 'ok: QA R2: old callers (8 args, or named without a share) are unchanged; one function each';
end;
$$;

select pg_temp.expect_error($$select public.reserve_usage(null, 'image_generation', null, null, 4, 500, now() - interval '1 day', null, array['image_generation'], 'NaN')$$,
  'QA R2: a NaN share cap');
select pg_temp.expect_error($$select public.reserve_usage(null, 'image_generation', null, null, 4, 500, now() - interval '1 day', null, '{}'::text[], 200)$$,
  'QA R2: a share with no kinds');
select pg_temp.expect_error($$select public.reserve_usage(null, 'image_generation', null, null, 4, null, null, null, array['image_generation'], 200)$$,
  'QA R2: a share with no month start');
select pg_temp.expect_error($$select public.reserve_usage(null, 'image_generation', null, null, 4, 500, now() - interval '40 days', null, array['image_generation'], 200)$$,
  'QA R2: a share with a month start from last month');

-- Was a NOTE (a negative share cap was accepted as an argument): refused since the review fixes.
select pg_temp.expect_error($$select public.reserve_usage(null, 'image_generation', null, null, 4, 500, now() - interval '1 day', null, array['image_generation'], -1)$$,
  'QA R2: a negative share cap');

-- 7. Was a known bug: "Update preview" stuck after a product is picked then cleared ------

do $$
declare
  r_user constant uuid := '9c000000-0000-4000-8000-00000000009c';
  o constant uuid := '9c200000-0000-4000-8000-000000000008';
  res jsonb;
begin
  update public.outfit_previews set status = 'ready', image_key = r_user || '/00000000-0000-4000-8000-0000000000a1.webp'
  where cache_key = repeat('8', 64) and user_id = r_user;
  update public.outfits set gaps = jsonb_set(gaps, '{0,shopProduct}', '{"url": "https://www.next.co.uk/p/1"}') where id = o;
  if not (select preview_outdated from public.outfits where id = o) then raise exception 'FAIL: a pick didn''t mark the preview outdated'; end if;
  update public.outfits set gaps = jsonb_set(gaps, '{0,shopProduct}', 'null') where id = o;
  -- Back to the look the picture shows; "Update preview" (refresh, same key):
  res := public.claim_outfit_preview(r_user, o, repeat('8', 64), 'men_slim_deep', true, 150);
  if (select preview_outdated from public.outfits where id = o) then
    raise exception 'FAIL: picking then clearing a product leaves preview_outdated true after a refresh (%)', res ->> 'action';
  end if;
  raise notice 'ok: QA R2: a refresh on the look the picture shows clears outdated';
end;
$$;
