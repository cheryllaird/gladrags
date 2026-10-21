-- Invite-only sign-up (spec: "Privacy and security").
--
-- The allowlist lives in a table rather than an env var so the database
-- itself refuses to create an account for any other email, even if someone
-- calls the Supabase auth API directly with the public (publishable) key. The
-- /api/auth/magic-link route also checks it first, to give a friendly
-- "not invited" message instead of a generic auth error.
--
-- Add testers with (in the Supabase SQL editor):
--   insert into public.allowed_emails (email, note) values ('someone@example.com', 'tester');

create table public.allowed_emails (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  note text,
  created_at timestamptz not null default now()
);

comment on table public.allowed_emails is 'Tester allowlist. Only these emails can create a GladRags account. Service role only.';

-- RLS on with no policies: only the service role can read or change it.
alter table public.allowed_emails enable row level security;
revoke all on public.allowed_emails from anon, authenticated;

create function public.is_email_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.allowed_emails where email = lower(trim(p_email))
  );
$$;

revoke execute on function public.is_email_allowed(text) from public, anon, authenticated;
grant execute on function public.is_email_allowed(text) to service_role;

-- Before an auth user is created, or changes their email: refuse emails
-- that aren't on the allowlist.
create function public.enforce_email_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or not public.is_email_allowed(new.email) then
    raise exception 'This email is not on the GladRags tester list'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger enforce_email_allowlist
  before insert or update of email on auth.users
  for each row execute function public.enforce_email_allowlist();

-- After an auth user is created: create their GladRags profile.
create function public.create_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, lower(new.email), split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger create_user_profile
  after insert on auth.users
  for each row execute function public.create_user_profile();

-- After an (allowed) email change: keep the profile's copy in step.
create function public.sync_user_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.users set email = lower(new.email) where id = new.id;
  return new;
end;
$$;

create trigger sync_user_email
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function public.sync_user_email();

revoke execute on function public.enforce_email_allowlist() from public, anon, authenticated;
revoke execute on function public.create_user_profile() from public, anon, authenticated;
revoke execute on function public.sync_user_email() from public, anon, authenticated;
