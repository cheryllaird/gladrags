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
