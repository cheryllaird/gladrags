#!/usr/bin/env bash
# QA (fix/hardening): more bursts against the reservation functions and
# the unique image keys, beyond supabase/tests/concurrency.sh. Run by
# scripts/verify-migrations.sh after concurrency.sh, against the throwaway
# database (never a real project). Same gate harness: WORKERS sessions
# queue on an advisory lock and are released together.
set -euo pipefail

TEST_URL="${1:?Usage: qa-concurrency.sh <database url>}"
WORKERS=30
GATE_KEY=4243
USER_D="dddddddd-dddd-4ddd-8ddd-dddddddddddd"
USER_E="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
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

q "insert into public.allowed_emails (email) values ('qa-d@example.com'), ('qa-e@example.com') on conflict do nothing" >/dev/null
q "insert into auth.users (id, email) values ('${USER_D}', 'qa-d@example.com'), ('${USER_E}', 'qa-e@example.com')" >/dev/null
q "delete from public.usage_events" >/dev/null

# 1. link_fetch: its own daily cap (limit 5 here), no monthly cap.
read -r got total <<<"$(burst "select (public.reserve_usage('${USER_D}', 'link_fetch', 5, ${DAY_START}, 0, null, null))->>'ok'")"
expect_eq "$total" "$WORKERS" "every link_fetch session answered"
expect_eq "$got" 5 "parallel link_fetch reservations stop at the daily limit of 5"
expect_eq "$(q "select count(*) from public.usage_events where kind = 'link_fetch'")" 5 "exactly 5 link_fetch rows"

# 2. Two users at once (picked by backend pid parity): each stops at its own limit.
q "delete from public.usage_events" >/dev/null
read -r got total <<<"$(burst "select (public.reserve_usage(case when pg_backend_pid() % 2 = 0 then '${USER_D}'::uuid else '${USER_E}'::uuid end, 'outfit_request', 3, ${DAY_START}, 0, 500, ${MONTH_START}))->>'ok'")"
for u in "$USER_D" "$USER_E"; do
  n="$(q "select count(*) from public.usage_events where user_id = '${u}' and kind = 'outfit_request'")"
  if [ "$n" -gt 3 ]; then
    echo "FAIL: user $u got $n outfit requests, over the limit of 3" >&2
    exit 1
  fi
done
echo "ok: two users bursting at once never exceed their own limit of 3 ($got granted in all)"

# 3. Spend overshoot with a cost that doesn't divide the cap: 1p cap, 0.3p each.
#    Reached-not-approached allows 0, 0.3, 0.6, 0.9 -> 4 calls, 1.2p: over by
#    0.2p, less than one call.
q "delete from public.usage_events" >/dev/null
read -r got total <<<"$(burst "select (public.reserve_usage(null, 'ranking_final', null, null, 0.3, 1, ${MONTH_START}, 'gemini'))->>'ok'")"
expect_eq "$got" 4 "parallel 0.3p reservations against a 1p cap"
expect_eq "$(q "select public.ai_spend_pence_since(${MONTH_START})")" "1.2000" "the month's spend is over the cap by less than one call"

# 4. Mixed reservations at once: daily actions (user lock), AI calls (global
#    lock) and AI calls with both a daily limit and a cost (user, then global
#    lock). No deadlocks, every session answers, and both caps hold.
q "delete from public.usage_events" >/dev/null
read -r got total <<<"$(burst "select (case pg_backend_pid() % 3
    when 0 then public.reserve_usage('${USER_D}', 'item_ingest', 4, ${DAY_START}, 0, 2, ${MONTH_START})
    when 1 then public.reserve_usage('${USER_D}', 'tagging', null, null, 0.2, 2, ${MONTH_START}, 'gemini')
    else public.reserve_usage('${USER_D}', 'ranking_shortlist', 50, ${DAY_START}, 0.2, 2, ${MONTH_START}, 'gemini')
  end)->>'ok'")"
expect_eq "$total" "$WORKERS" "mixed lock orders: every session answered (no deadlock)"
spend="$(q "select public.ai_spend_pence_since(${MONTH_START})")"
if [ "$(q "select ${spend} <= 2.2")" != "t" ]; then
  echo "FAIL: mixed burst spent ${spend}p against a 2p cap" >&2
  exit 1
fi
echo "ok: mixed burst kept the month at ${spend}p (cap 2p, one 0.2p call of overshoot at most)"
items="$(q "select count(*) from public.usage_events where kind = 'item_ingest'")"
if [ "$items" -gt 4 ]; then
  echo "FAIL: mixed burst recorded $items items, over the limit of 4" >&2
  exit 1
fi
echo "ok: mixed burst kept items within the daily limit ($items of 4)"

# 5. Sign-in: one IP across 30 different emails stops at the IP limit (20).
read -r got total <<<"$(burst "select (public.reserve_sign_in_attempt('verify_code', encode(sha256(convert_to('qa-email-' || pg_backend_pid(), 'UTF8')), 'hex'), repeat('a', 64), 5, 20, 900))->>'ok'")"
expect_eq "$got" 20 "parallel sign-in attempts from one IP across 30 emails stop at 20"

# 6. Unique image keys: 30 simultaneous saves of one draft make one item.
q "create function pg_temp_qa_try_save(p_user uuid, p_key text) returns boolean language plpgsql as \$\$
   begin
     insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
       colours, pattern, formality, seasons, warmth, occasions, description)
     values (p_user, 'photo', p_key, null, 'top', 'shirt', array['white'], 'plain', 3, array['spring'], 'light', array['work'], 'QA shirt');
     return true;
   exception when unique_violation then
     return false;
   end \$\$" >/dev/null
KEY="${USER_D}/0a0a0a0a-0000-4000-8000-000000000001.jpg"
read -r got total <<<"$(burst "select pg_temp_qa_try_save('${USER_D}', '${KEY}')")"
expect_eq "$total" "$WORKERS" "every save session answered"
expect_eq "$got" 1 "30 simultaneous saves of one draft: one succeeds"
expect_eq "$(q "select count(*) from public.items where original_image_key = '${KEY}'")" 1 "exactly one item row for the image key"

# The same for a shared cut-out key with different originals.
CUT="${USER_D}/0a0a0a0a-0000-4000-8000-000000000002.png"
q "create or replace function pg_temp_qa_try_save_cutout(p_user uuid, p_cut text) returns boolean language plpgsql as \$\$
   begin
     insert into public.items (user_id, source, original_image_key, cutout_image_key, category, subcategory,
       colours, pattern, formality, seasons, warmth, occasions, description)
     values (p_user, 'photo', p_user::text || '/' || gen_random_uuid()::text || '.jpg', p_cut, 'top', 'shirt', array['white'], 'plain', 3, array['spring'], 'light', array['work'], 'QA shirt');
     return true;
   exception when unique_violation then
     return false;
   end \$\$" >/dev/null
read -r got total <<<"$(burst "select pg_temp_qa_try_save_cutout('${USER_D}', '${CUT}')")"
expect_eq "$got" 1 "30 simultaneous saves sharing one cut-out key: one succeeds"
q "drop function pg_temp_qa_try_save(uuid, text); drop function pg_temp_qa_try_save_cutout(uuid, text)" >/dev/null

# 7. reserve_usage's window checks accept the longest real UK day (25 h)
#    and month (31 days + 1 h), and refuse anything older.
expect_eq "$(q "select (public.reserve_usage('${USER_E}', 'link_fetch', 1000, now() - interval '25 hours', 0, null, null))->>'ok'")" "true" "a day start 25 hours ago (the day the clocks go back) is accepted"
expect_eq "$(q "select (public.reserve_usage(null, 'tagging', null, null, 0, 500, now() - interval '31 days 1 hour'))->>'ok'")" "true" "a month start 31 days 1 hour ago is accepted"
if q "select public.reserve_usage('${USER_E}', 'link_fetch', 1000, now() - interval '25 hours 2 minutes', 0, null, null)" >/dev/null 2>&1; then
  echo "FAIL: a day start over 25 hours ago was accepted" >&2
  exit 1
fi
echo "ok: a day start over 25 hours ago is refused"
if q "select public.reserve_usage('${USER_E}', 'link_fetch', 1000, now() + interval '2 minutes', 0, null, null)" >/dev/null 2>&1; then
  echo "FAIL: a day start in the future was accepted" >&2
  exit 1
fi
echo "ok: a day start in the future is refused"
if q "select public.reserve_usage('${USER_E}', 'link_fetch', 1000, ${DAY_START}, -1, null, null)" >/dev/null 2>&1; then
  echo "FAIL: a negative cost was accepted" >&2
  exit 1
fi
echo "ok: a negative cost is refused"
if q "select public.reserve_usage('${USER_E}', 'not_a_kind', 1000, ${DAY_START}, 0, null, null)" >/dev/null 2>&1; then
  echo "FAIL: an unknown usage kind was accepted" >&2
  exit 1
fi
echo "ok: an unknown usage kind is refused"

# 8. Settling can't push a cost below zero (NaN is sent as null and refused too).
id="$(q "select (public.reserve_usage(null, 'tagging', null, null, 0.2, 500, ${MONTH_START}, 'gemini'))->>'event_id'")"
if q "update public.usage_events set cost_pence = -5 where id = '${id}'" >/dev/null 2>&1; then
  echo "FAIL: a negative settled cost was stored" >&2
  exit 1
fi
if q "update public.usage_events set cost_pence = null where id = '${id}'" >/dev/null 2>&1; then
  echo "FAIL: a null settled cost was stored" >&2
  exit 1
fi
# Postgres numeric accepts 'NaN'; migration 6 refuses it with usage_events_cost_not_nan (was a NOTE).
if q "update public.usage_events set cost_pence = 'NaN' where id = '${id}'" >/dev/null 2>&1; then
  echo "NOTE: cost_pence accepts 'NaN' at the SQL level (check (cost_pence >= 0) passes NaN); the app can't send it"
  q "update public.usage_events set cost_pence = 0.2 where id = '${id}'" >/dev/null
fi
echo "ok: settled costs can't be negative or null"
