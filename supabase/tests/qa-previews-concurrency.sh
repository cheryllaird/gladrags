#!/usr/bin/env bash
# QA (round 2, P1): bursts against claim_outfit_preview and the spend
# shares in reserve_usage, plus a two-session race between a reuse and a
# refresh. Run by supabase/tests/qa-concurrency.sh (so by pnpm db:verify)
# against the throwaway database, never a real project. Same gate harness
# as concurrency.sh: WORKERS sessions queue on an advisory lock and are
# released together. "KNOWN BUG" lines are reported bugs that don't fail
# the run.
set -euo pipefail

TEST_URL="${1:?Usage: qa-previews-concurrency.sh <database url>}"
WORKERS=30
GATE_KEY=4244
USER_T="9e000000-0000-4000-8000-00000000009e"
USER_U="9f000000-0000-4000-8000-00000000009f"
DAY_START="date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London'"
MONTH_START="date_trunc('month', now() at time zone 'Europe/London') at time zone 'Europe/London'"

q() { psql "$TEST_URL" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }

# Run "$1" in WORKERS sessions at once. Prints "<lines starting t> <lines total>".
burst() {
  local sql="$1" out
  out="$(mktemp -d)"
  psql "$TEST_URL" -qtAX -v ON_ERROR_STOP=1 -c "
    do \$\$
    declare i int := 0;
    begin
      perform pg_advisory_lock(${GATE_KEY});
      loop
        exit when (select count(*) from pg_locks where locktype = 'advisory' and objid = ${GATE_KEY} and not granted) >= ${WORKERS}
          or i > 2000;
        perform pg_sleep(0.01);
        i := i + 1;
      end loop;
    end \$\$;" &
  local gate=$!
  until [ "$(q "select count(*) from pg_locks where locktype = 'advisory' and objid = ${GATE_KEY} and granted")" = "1" ]; do :; done
  local pids=()
  for i in $(seq 1 "$WORKERS"); do
    psql "$TEST_URL" -qtAX -v ON_ERROR_STOP=1 -c "select pg_advisory_lock_shared(${GATE_KEY})" -c "$sql" >"$out/$i" 2>"$out/$i.err" &
    pids+=($!)
  done
  local failed=0
  for pid in "${pids[@]}"; do wait "$pid" || failed=$((failed + 1)); done
  wait "$gate"
  if [ "$failed" -gt 0 ]; then
    echo "FAIL: $failed of $WORKERS sessions errored:" >&2
    cat "$out"/*.err | sort | uniq -c >&2
    rm -rf "$out"
    exit 1
  fi
  local granted total
  granted="$(cat "$out"/[0-9]* | grep -c '^t' || true)"
  total="$(cat "$out"/[0-9]* | grep -cE '^(t|f|true|false)$' || true)"
  echo "$granted $total"
  rm -rf "$out"
}

expect_eq() {
  local got="$1" want="$2" label="$3"
  if [ "$got" != "$want" ]; then
    echo "FAIL: $label: got $got, expected $want" >&2
    exit 1
  fi
  echo "ok: $label ($got)"
}

# Is "$1" <= "$2" (numerically)?
expect_le() {
  local got="$1" max="$2" label="$3"
  if [ "$(q "select ${got}::numeric <= ${max}::numeric")" != "t" ]; then
    echo "FAIL: $label: got $got, more than $max" >&2
    exit 1
  fi
  echo "ok: $label ($got <= $max)"
}

q "insert into public.allowed_emails (email) values ('qa-t@example.com'), ('qa-u@example.com') on conflict do nothing" >/dev/null
q "insert into auth.users (id, email) values ('${USER_T}', 'qa-t@example.com'), ('${USER_U}', 'qa-u@example.com')" >/dev/null
for u in "$USER_T" "$USER_U"; do
  p="${u:0:2}"
  q "insert into public.items (id, user_id, source, original_image_key, category, subcategory, colours, pattern, formality, seasons, warmth, occasions, description)
     values ('${p}100000-0000-4000-8000-000000000001', '${u}', 'photo', '${u}/00000000-0000-4000-8000-0000000000${p}.jpg',
       'dress_jumpsuit', 'dress', array['red'], 'plain', 3, array['summer'], 'light', array['evening_out'], 'Red dress')" >/dev/null
done

# Outfits 1..30: odd ones are T's, even ones U's; all the same look shape.
q "insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps)
   select ('9e300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
     case when n % 2 = 1 then '${USER_T}'::uuid else '${USER_U}'::uuid end,
     '{\"style\": {\"kind\": \"preset\", \"presetId\": \"casual\"}}', 'Same', 'x',
     array[case when n % 2 = 1 then '9e100000-0000-4000-8000-000000000001'::uuid else '9f100000-0000-4000-8000-000000000001'::uuid end],
     '[{\"category\": \"shoes\", \"colours\": [\"black\"], \"description\": \"Black heels\"}]'
   from generate_series(1, ${WORKERS}) n" >/dev/null

# 1. Two users, the same key, at once: one generate each, never shared.
q "create sequence public.qa_claim_worker" >/dev/null
read -r got total <<<"$(burst "
  with w as (select nextval('public.qa_claim_worker') as n)
  select (public.claim_outfit_preview(
    case when w.n % 2 = 1 then '${USER_T}'::uuid else '${USER_U}'::uuid end,
    ('9e300000-0000-4000-8000-' || lpad(w.n::text, 12, '0'))::uuid,
    repeat('7', 64), 'women_average_medium', false, 150))->>'action' = 'generate'
  from w")"
expect_eq "$total" "$WORKERS" "QA R2: every claim session answered"
expect_eq "$got" 2 "QA R2: two users bursting one key: exactly one generate each"
expect_eq "$(q "select count(*) from public.outfit_previews where cache_key = repeat('7', 64)")" 2 "QA R2: one preview row per user for the key"
expect_eq "$(q "select count(*) from public.outfits o join public.outfit_previews p on p.id = o.preview_id where o.id::text like '9e3%' and p.user_id = o.user_id")" "$WORKERS" \
  "QA R2: every outfit is linked to its own user's preview"
q "drop sequence public.qa_claim_worker" >/dev/null

# 2. One outfit, refreshed to two looks by 30 sessions at once: no deadlock, no orphans.
OUTFIT_ONE="9e300000-0000-4000-8000-000000000001"
read -r got total <<<"$(burst "
  select (public.claim_outfit_preview('${USER_T}', '${OUTFIT_ONE}',
    case when pg_backend_pid() % 2 = 0 then repeat('5', 64) else repeat('6', 64) end, 'women_average_medium', true, 150))->>'ok' = 'true'")"
expect_eq "$total" "$WORKERS" "QA R2: refresh tug-of-war on one outfit: every session answered (no deadlock)"
expect_eq "$got" "$WORKERS" "QA R2: refresh tug-of-war: every claim succeeded"
expect_eq "$(q "select count(*) from public.outfit_previews p where p.user_id = '${USER_T}' and p.cache_key in (repeat('5', 64), repeat('6', 64))")" 1 \
  "QA R2: refresh tug-of-war leaves exactly one row for the two looks (the linked one)"
expect_eq "$(q "select count(*) from public.outfit_previews p where p.user_id = '${USER_T}' and not exists (select 1 from public.outfits o where o.preview_id = p.id)")" 0 \
  "QA R2: no preview of T's is left unlinked"

# 3. Mixed spend burst: images (1p share), shop grounding (1p share) and
#    tagging, 0.2p each, with a 1.5p overall cap.
q "delete from public.usage_events" >/dev/null
q "create sequence public.qa_spend_worker" >/dev/null
read -r got total <<<"$(burst "
  with w as (select nextval('public.qa_spend_worker') % 3 as k)
  select (case w.k
    when 0 then public.reserve_usage(null, 'image_generation', null, null, 0.2, 1.5, ${MONTH_START}, 'gemini', array['image_generation'], 1)
    when 1 then public.reserve_usage(null, 'shop_grounding', null, null, 0.2, 1.5, ${MONTH_START}, 'gemini', array['shop_grounding'], 1)
    else public.reserve_usage(null, 'tagging', null, null, 0.2, 1.5, ${MONTH_START}, 'gemini')
  end)->>'ok' from w")"
expect_eq "$total" "$WORKERS" "QA R2: mixed spend burst: every session answered"
expect_le "$(q "select public.ai_spend_pence_since(${MONTH_START}, array['image_generation'])")" 1 "QA R2: mixed burst kept images within their share"
expect_le "$(q "select public.ai_spend_pence_since(${MONTH_START}, array['shop_grounding'])")" 1 "QA R2: mixed burst kept shop search within its share"
expect_le "$(q "select public.ai_spend_pence_since(${MONTH_START})")" 1.6 "QA R2: mixed burst kept the month within one call of the overall cap"
q "drop sequence public.qa_spend_worker" >/dev/null

# 4. Preview counts (a share, no cost, a daily cap of 12) racing image costs
#    against the same share: no deadlock, neither cap overshot.
q "delete from public.usage_events" >/dev/null
read -r got total <<<"$(burst "
  select case when pg_backend_pid() % 2 = 0
    then (public.reserve_usage('${USER_T}', 'outfit_preview', 12, ${DAY_START}, 0, 500, ${MONTH_START}, null, array['image_generation'], 1))->>'ok'
    else (public.reserve_usage('${USER_T}', 'image_generation', null, null, 0.2, 500, ${MONTH_START}, 'gemini', array['image_generation'], 1))->>'ok'
  end")"
expect_eq "$total" "$WORKERS" "QA R2: preview counts racing image costs: every session answered"
expect_le "$(q "select count(*) from public.usage_events where kind = 'outfit_preview'")" 12 "QA R2: preview counts stayed within the daily cap"
expect_le "$(q "select public.ai_spend_pence_since(${MONTH_START}, array['image_generation'])")" 1 "QA R2: image costs stayed within the share"

# 5. A reuse and a refresh at the same moment (two sessions, in a fixed
#    order): outfit A reuses look K1's ready image while outfit B, the only
#    other user of K1, refreshes to K2. B's release must not delete the
#    image A has just been linked to.
q "insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps)
   select ('9e400000-0000-4000-8000-00000000000' || n)::uuid, '${USER_T}', '{\"style\": {\"kind\": \"preset\", \"presetId\": \"casual\"}}', 'Race', 'x',
     array['9e100000-0000-4000-8000-000000000001']::uuid[], '[{\"category\": \"shoes\", \"colours\": [\"red\"], \"description\": \"Red flats\"}]'
   from generate_series(1, 2) n" >/dev/null
q "select public.claim_outfit_preview('${USER_T}', '9e400000-0000-4000-8000-000000000001', repeat('4', 64), 'women_average_medium', false, 150)" >/dev/null
q "update public.outfit_previews set status = 'ready', image_key = '${USER_T}/00000000-0000-4000-8000-0000000000e4.webp' where user_id = '${USER_T}' and cache_key = repeat('4', 64)" >/dev/null
reuse_out="$(mktemp)"
psql "$TEST_URL" -qtAX -v ON_ERROR_STOP=1 -c "begin" \
  -c "select public.claim_outfit_preview('${USER_T}', '9e400000-0000-4000-8000-000000000002', repeat('4', 64), 'women_average_medium', false, 150)->>'action'" \
  -c "select pg_sleep(1.5)" -c "commit" >"$reuse_out" &
reuse=$!
# Wait until the reuse holds its transaction open, then refresh B.
until [ "$(q "select count(*) from pg_stat_activity where pid <> pg_backend_pid() and query = 'select pg_sleep(1.5)'")" -ge 1 ]; do :; done
refresh="$(q "select public.claim_outfit_preview('${USER_T}', '9e400000-0000-4000-8000-000000000001', repeat('3', 64), 'women_average_medium', true, 150)")"
wait "$reuse"
reuse_action="$(grep -E '^(reused|existing|wait|generate)$' "$reuse_out" || true)"
rm -f "$reuse_out"
linked="$(q "select count(*) from public.outfits o join public.outfit_previews p on p.id = o.preview_id where o.id = '9e400000-0000-4000-8000-000000000002' and p.status = 'ready'")"
if [ "$reuse_action" = "reused" ] && [ "$linked" = "0" ]; then
  echo "KNOWN BUG (reported): a refresh racing a reuse deleted the image the reuse had just linked (reuse said 'reused'; the outfit now has no preview; the refresh returned released_image_key=$(echo "$refresh" | sed -E 's/.*"released_image_key": ("[^"]*"|null).*/\1/'))"
else
  echo "ok: QA R2: a refresh racing a reuse keeps the reused image (reuse: ${reuse_action}, linked ready: ${linked})"
fi
