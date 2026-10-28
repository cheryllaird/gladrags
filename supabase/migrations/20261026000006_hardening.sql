-- Pre-tester hardening (milestone 4, security review). See
-- docs/CONTRACTS.md sections 2 and 7.
--
-- 1. reserve_usage(): an atomic check-and-record for the daily caps and
--    the monthly AI spend cap, so requests sent at the same moment can't
--    all pass the check before any is recorded.
-- 2. A `link_fetch` usage kind: add-by-link step 1 counts every page fetch
--    attempt, fallbacks included.
-- 3. Unique image keys on items, so one draft can't be saved twice.
-- 4. The allowlist trigger on auth.users only fires when the email changes.
-- 5. sign_in_attempts + reserve_sign_in_attempt(): rate limits on the
--    sign-in routes, per email and per IP address.

-- 1 and 2. Usage reservations ---------------------------------------------------

alter table public.usage_events drop constraint usage_events_kind_check;
alter table public.usage_events add constraint usage_events_kind_check check (
  kind in ('item_ingest', 'outfit_request', 'link_fetch', 'tagging', 'ranking_shortlist', 'ranking_final')
);
-- numeric accepts 'NaN', and Postgres sorts it above every number, so
-- "cost_pence >= 0" lets it through; a NaN would break the month's sum.
alter table public.usage_events add constraint usage_events_cost_not_nan check (cost_pence <> 'NaN'::numeric);

-- Reserve one usage event, or refuse it, in one transaction.
--
-- - p_daily_limit (with p_user): refuse if the user already has this many
--   events of p_kind since p_day_start.
-- - p_monthly_cap_pence: refuse if everyone's spend since p_month_start
--   has reached the cap ("reached, not approached", like the app's
--   isAiPaused). Daily actions that use AI pass it too, so a paused month
--   is refused atomically as well.
-- - Otherwise insert the event (with p_cost_pence, the estimate for an AI
--   call; the server corrects it afterwards if the real cost is known).
--
-- The app passes the UK day and month starts in (src/lib/usage/time.ts
-- handles British Summer Time), so this counts exactly the window the
-- in-memory store and GET /api/usage count. They're sanity-checked here.
--
-- Concurrency: transaction-level advisory locks serialise the check and
-- the insert. One lock per user (taken first) covers the daily caps; one
-- global lock covers spend, taken only when the event adds spend. The
-- locks are always taken in that order, so two reservations can't
-- deadlock. Under READ COMMITTED each statement below takes a fresh
-- snapshot, so once a lock is held the counts include every reservation
-- committed before it.
--
-- Returns jsonb: { ok, denied ('daily_cap' | 'monthly_spend' | null),
-- event_id (null when denied), used (today's count before this one),
-- spent_pence (the month's spend before this one) }.
create function public.reserve_usage(
  p_user uuid,
  p_kind text,
  p_daily_limit int,
  p_day_start timestamptz,
  p_cost_pence numeric,
  p_monthly_cap_pence numeric,
  p_month_start timestamptz,
  p_provider text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_used int := 0;
  v_spent numeric := 0;
  v_id uuid;
begin
  if p_cost_pence is null or p_cost_pence < 0 or p_cost_pence = 'NaN'::numeric then
    raise exception 'reserve_usage: cost must be zero or more' using errcode = 'invalid_parameter_value';
  end if;
  if p_daily_limit is not null and (p_user is null or p_day_start is null) then
    raise exception 'reserve_usage: a daily limit needs a user and a day start' using errcode = 'invalid_parameter_value';
  end if;
  if p_monthly_cap_pence is not null and p_month_start is null then
    raise exception 'reserve_usage: a monthly cap needs a month start' using errcode = 'invalid_parameter_value';
  end if;
  -- A UK day is at most 25 hours long and a month at most 31 days (plus an
  -- hour for BST). Anything else is a bug in the caller.
  if p_day_start is not null and (p_day_start > now() + interval '1 minute' or p_day_start < now() - interval '25 hours 1 minute') then
    raise exception 'reserve_usage: day start % is not today', p_day_start using errcode = 'invalid_parameter_value';
  end if;
  if p_month_start is not null and (p_month_start > now() + interval '1 minute' or p_month_start < now() - interval '31 days 1 hour 1 minute') then
    raise exception 'reserve_usage: month start % is not this month', p_month_start using errcode = 'invalid_parameter_value';
  end if;

  if p_user is not null and p_daily_limit is not null then
    perform pg_advisory_xact_lock(hashtextextended('gladrags.usage.user:' || p_user::text, 0));
  end if;
  if p_monthly_cap_pence is not null and p_cost_pence > 0 then
    perform pg_advisory_xact_lock(hashtextextended('gladrags.usage.spend', 0));
  end if;

  if p_monthly_cap_pence is not null then
    select coalesce(sum(cost_pence), 0) into v_spent
    from public.usage_events
    where created_at >= p_month_start;
    if v_spent >= p_monthly_cap_pence then
      return jsonb_build_object('ok', false, 'denied', 'monthly_spend', 'event_id', null, 'used', null, 'spent_pence', v_spent);
    end if;
  end if;

  if p_daily_limit is not null then
    select count(*) into v_used
    from public.usage_events
    where user_id = p_user and kind = p_kind and created_at >= p_day_start;
    if v_used >= p_daily_limit then
      return jsonb_build_object('ok', false, 'denied', 'daily_cap', 'event_id', null, 'used', v_used, 'spent_pence', v_spent);
    end if;
  end if;

  insert into public.usage_events (user_id, kind, cost_pence, provider)
  values (p_user, p_kind, p_cost_pence, p_provider)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'denied', null, 'event_id', v_id, 'used', v_used, 'spent_pence', v_spent);
end;
$$;

revoke execute on function public.reserve_usage(uuid, text, int, timestamptz, numeric, numeric, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.reserve_usage(uuid, text, int, timestamptz, numeric, numeric, timestamptz, text)
  to service_role;

-- 3. Unique image keys ------------------------------------------------------------
-- Two simultaneous saves of one draft would otherwise make two items
-- sharing (and, on delete, both removing) the same images. The app turns
-- a violation into bad_request.

create unique index items_original_image_key_unique on public.items (original_image_key)
  where original_image_key is not null;
create unique index items_cutout_image_key_unique on public.items (cutout_image_key)
  where cutout_image_key is not null;

-- 4. Allowlist trigger: only when the email really changes --------------------
-- Supabase's auth server may include email in routine updates of
-- auth.users, and "update of email" fires whenever email is in the SET
-- list, changed or not. The check only matters when the address actually
-- changes; firing otherwise would make unrelated updates fail for anyone
-- whose allowlist row was removed. (To remove a tester, delete or ban
-- their auth user: see CONTRACTS.md section 9.) A WHEN clause can't
-- mention OLD on an insert trigger, so insert and update are two triggers.

drop trigger enforce_email_allowlist on auth.users;

create trigger enforce_email_allowlist_on_insert
  before insert on auth.users
  for each row execute function public.enforce_email_allowlist();

create trigger enforce_email_allowlist_on_email_change
  before update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.enforce_email_allowlist();

-- 5. Sign-in rate limits ----------------------------------------------------------
-- One row per accepted sign-in request (magic link or code check), per
-- email and per IP address. Keys are HMAC-SHA-256 hashes made by the
-- server with a key the database never sees (SIGN_IN_HASH_KEY), so the
-- table is pseudonymous: it stores no email or IP address, and its rows
-- can't be matched to one without that key. Server only; the daily cleanup
-- job deletes rows over a day old.

create table public.sign_in_attempts (
  id bigint generated always as identity primary key,
  action text not null check (action in ('magic_link', 'verify_code')),
  key_kind text not null check (key_kind in ('email', 'ip')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index sign_in_attempts_lookup_idx on public.sign_in_attempts (action, key_kind, key_hash, created_at);
create index sign_in_attempts_created_idx on public.sign_in_attempts (created_at);

comment on table public.sign_in_attempts is 'Sign-in rate limiting (pseudonymous HMAC keys for emails and IPs). Server (secret key) only.';

alter table public.sign_in_attempts enable row level security;
revoke all on public.sign_in_attempts from anon, authenticated;

-- Record one sign-in attempt for this email (and IP, if known), or refuse
-- it if either has reached its limit inside the window. Locks the email
-- key first, then the IP key, so concurrent calls can't deadlock.
--
-- Returns jsonb: { ok, denied ('email' | 'ip' | null), retry_at (when the
-- oldest counted attempt leaves the window, if denied) }.
create function public.reserve_sign_in_attempt(
  p_action text,
  p_email_hash text,
  p_ip_hash text,
  p_email_limit int,
  p_ip_limit int,
  p_window_seconds int
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := now() - make_interval(secs => p_window_seconds);
  v_count int;
  v_oldest timestamptz;
begin
  if p_email_hash is null or p_email_limit is null or p_ip_limit is null or p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'reserve_sign_in_attempt: missing arguments' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('gladrags.sign_in.email:' || p_email_hash, 0));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('gladrags.sign_in.ip:' || p_ip_hash, 0));
  end if;

  select count(*), min(created_at) into v_count, v_oldest
  from public.sign_in_attempts
  where action = p_action and key_kind = 'email' and key_hash = p_email_hash and created_at >= v_since;
  if v_count >= p_email_limit then
    return jsonb_build_object('ok', false, 'denied', 'email', 'retry_at', v_oldest + make_interval(secs => p_window_seconds));
  end if;

  if p_ip_hash is not null then
    select count(*), min(created_at) into v_count, v_oldest
    from public.sign_in_attempts
    where action = p_action and key_kind = 'ip' and key_hash = p_ip_hash and created_at >= v_since;
    if v_count >= p_ip_limit then
      return jsonb_build_object('ok', false, 'denied', 'ip', 'retry_at', v_oldest + make_interval(secs => p_window_seconds));
    end if;
  end if;

  insert into public.sign_in_attempts (action, key_kind, key_hash) values (p_action, 'email', p_email_hash);
  if p_ip_hash is not null then
    insert into public.sign_in_attempts (action, key_kind, key_hash) values (p_action, 'ip', p_ip_hash);
  end if;

  return jsonb_build_object('ok', true, 'denied', null, 'retry_at', null);
end;
$$;

revoke execute on function public.reserve_sign_in_attempt(text, text, text, int, int, int) from public, anon, authenticated;
grant execute on function public.reserve_sign_in_attempt(text, text, text, int, int, int) to service_role;
