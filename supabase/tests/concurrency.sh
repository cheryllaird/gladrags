#!/usr/bin/env bash
# Proves the reservation functions can't be overshot by calls at the same
# moment. Run by scripts/verify-migrations.sh after rls.test.sql, against
# the throwaway database (never a real project).
#
# How: a "gate" session holds an advisory lock; WORKERS sessions each queue
# on it, and the gate lets go only once all of them are waiting, so they
# all call the function together. Each burst checks the number of granted
# reservations is exactly what one-at-a-time calls would give.
#
# A control burst runs a naive copy (check, pause, insert, no lock) under
# the same harness and must overshoot, which shows the harness really
# makes the calls overlap.
set -euo pipefail

TEST_URL="${1:?Usage: concurrency.sh <database url>}"
WORKERS=30
GATE_KEY=4242
USER_C="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
DAY_START="date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London'"
MONTH_START="date_trunc('month', now() at time zone 'Europe/London') at time zone 'Europe/London'"

q() { psql "$TEST_URL" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }

# Run "$1" (a SELECT returning one line) in WORKERS sessions at once and
# print how many printed "true".
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
    psql "$TEST_URL" -qtAX -v ON_ERROR_STOP=1 -c "select pg_advisory_lock_shared(${GATE_KEY})" -c "$sql" >"$out/$i" &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do wait "$pid"; done
  wait "$gate"
  cat "$out"/* | grep -c '^t' || true
  rm -rf "$out"
}

expect() {
  local got="$1" want="$2" label="$3"
  if [ "$got" != "$want" ]; then
    echo "FAIL: $label: $got granted, expected $want" >&2
    exit 1
  fi
  echo "ok: $label ($got of $WORKERS granted)"
}

q "insert into public.allowed_emails (email) values ('c@example.com') on conflict do nothing" >/dev/null
q "insert into auth.users (id, email) values ('${USER_C}', 'c@example.com')" >/dev/null
q "delete from public.usage_events" >/dev/null

# Control: a naive check-then-insert with a short pause overshoots.
q "create function public.naive_reserve(p_user uuid, p_limit int) returns boolean language plpgsql as \$\$
   begin
     if (select count(*) from public.usage_events where user_id = p_user and kind = 'outfit_request') >= p_limit then return false; end if;
     perform pg_sleep(0.05);
     insert into public.usage_events (user_id, kind) values (p_user, 'outfit_request');
     return true;
   end \$\$" >/dev/null
naive="$(burst "select public.naive_reserve('${USER_C}', 5)")"
if [ "$naive" -le 5 ]; then
  echo "FAIL: the control burst didn't overshoot ($naive granted), so the calls didn't overlap" >&2
  exit 1
fi
echo "ok: control: a naive check-then-insert overshoots a limit of 5 ($naive granted), so the bursts really overlap"
q "drop function public.naive_reserve(uuid, int)" >/dev/null

# Daily cap: limit 5.
got="$(burst "select (public.reserve_usage('${USER_C}', 'item_ingest', 5, ${DAY_START}, 0, 500, ${MONTH_START}))->>'ok'")"
expect "$got" 5 "parallel item reservations stop at the daily limit of 5"
expect "$(q "select count(*) from public.usage_events where user_id = '${USER_C}' and kind = 'item_ingest'")" 5 "exactly 5 item rows recorded"

# Monthly spend: cap 1p, 0.2p per call. Reached (not approached): 5 calls.
q "delete from public.usage_events" >/dev/null
got="$(burst "select (public.reserve_usage('${USER_C}', 'tagging', null, null, 0.2, 1, ${MONTH_START}, 'gemini'))->>'ok'")"
expect "$got" 5 "parallel AI reservations stop at the monthly cap (1p at 0.2p each)"
spend="$(q "select public.ai_spend_pence_since(${MONTH_START})")"
if [ "$spend" != "1.0000" ]; then
  echo "FAIL: parallel AI reservations spent ${spend}p, more than the 1p cap" >&2
  exit 1
fi
echo "ok: the month's spend is exactly the cap (${spend}p), not over it"

# Sign-in: 5 per email.
got="$(burst "select (public.reserve_sign_in_attempt('magic_link', repeat('d', 64), repeat('e', 64), 5, 1000, 900))->>'ok'")"
expect "$got" 5 "parallel sign-in attempts for one email stop at 5"

# Round 2 (migration 8): a spend share, 1p at 0.2p a call, with the overall
# cap far above it: exactly 5 image calls, and the share's spend is the cap.
q "delete from public.usage_events" >/dev/null
got="$(burst "select (public.reserve_usage(null, 'image_generation', null, null, 0.2, 500, ${MONTH_START}, 'gemini', array['image_generation'], 1))->>'ok'")"
expect "$got" 5 "parallel image reservations stop at the images share (1p at 0.2p each)"
spend="$(q "select public.ai_spend_pence_since(${MONTH_START}, array['image_generation'])")"
if [ "$spend" != "1.0000" ]; then
  echo "FAIL: parallel image reservations spent ${spend}p, more than the 1p share" >&2
  exit 1
fi
echo "ok: the images share's spend is exactly its cap (${spend}p), not over it"

# Round 2: 30 outfits with the same look claim their preview at once:
# exactly one request generates; the others wait for it.
q "insert into public.items (id, user_id, source, original_image_key, category, subcategory, colours, pattern, formality, seasons, warmth, occasions, description)
   values ('c8000000-0000-4000-8000-000000000001', '${USER_C}', 'photo', '${USER_C}/00000000-0000-4000-8000-0000000000c8.jpg',
     'dress_jumpsuit', 'dress', array['red'], 'plain', 3, array['summer'], 'light', array['evening_out'], 'Red dress')" >/dev/null
q "insert into public.outfits (id, user_id, request, name, reason, item_ids, gaps)
   select ('c8100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '${USER_C}', '{\"style\": {\"kind\": \"preset\", \"presetId\": \"casual\"}}',
     'Same', 'x', array['c8000000-0000-4000-8000-000000000001']::uuid[], '[{\"category\": \"shoes\", \"colours\": [\"black\"], \"description\": \"Black heels\"}]'
   from generate_series(1, ${WORKERS}) n" >/dev/null
q "create sequence public.claim_worker" >/dev/null
got="$(burst "select (public.claim_outfit_preview('${USER_C}', ('c8100000-0000-4000-8000-' || lpad(nextval('public.claim_worker')::text, 12, '0'))::uuid, repeat('c', 64), 'women_average_medium', false, 150))->>'action' = 'generate'")"
expect "$got" 1 "30 outfits with one look claiming at once: exactly one generates"
rows="$(q "select count(*) from public.outfit_previews where user_id = '${USER_C}'")"
linked="$(q "select count(*) from public.outfits where user_id = '${USER_C}' and preview_id is not null")"
if [ "$rows" != "1" ] || [ "$linked" != "$WORKERS" ]; then
  echo "FAIL: after the claim burst: ${rows} preview rows (expected 1), ${linked} outfits linked (expected ${WORKERS})" >&2
  exit 1
fi
echo "ok: one preview row for the look, and all ${linked} outfits linked to it"
q "drop sequence public.claim_worker" >/dev/null
