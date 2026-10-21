-- Usage tracking for the cost controls (spec: "Cost controls").
-- This table is an addition to the spec's four.
--
-- One row per capped action or AI call:
-- - item_ingest, outfit_request: counted per user per UK day for the daily caps
-- - tagging, ranking_shortlist, ranking_final: Gemini calls, each carrying an
--   estimated cost, summed across ALL users per calendar month for the
--   £5/month cap (background removal runs on the phone and costs nothing)
--
-- Only the server (service role) writes here, so users can't reset their own
-- counters. Users may read their own rows.

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  -- Set null (not cascade) when an account is deleted: the money was still
  -- spent this month, and the row holds no personal data once unlinked.
  user_id uuid references public.users (id) on delete set null,
  kind text not null check (
    kind in ('item_ingest', 'outfit_request', 'tagging', 'ranking_shortlist', 'ranking_final')
  ),
  cost_pence numeric(12, 4) not null default 0 check (cost_pence >= 0),
  provider text check (char_length(provider) <= 40),
  created_at timestamptz not null default now()
);

create index usage_events_user_kind_created_idx on public.usage_events (user_id, kind, created_at);
create index usage_events_created_idx on public.usage_events (created_at);

alter table public.usage_events enable row level security;
revoke all on public.usage_events from anon;
revoke insert, update, delete on public.usage_events from authenticated;

create policy "usage_events: read own" on public.usage_events
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Total estimated AI spend since a point in time (the start of the month),
-- across all users. PostgREST doesn't expose SUM, so this is an RPC.
create function public.ai_spend_pence_since(p_since timestamptz)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(cost_pence), 0)
  from public.usage_events
  where created_at >= p_since;
$$;

revoke execute on function public.ai_spend_pence_since(timestamptz) from public, anon, authenticated;
grant execute on function public.ai_spend_pence_since(timestamptz) to service_role;
