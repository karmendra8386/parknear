-- ParkNextDoor migration v5: ONE host PIN per host (keyed by email), plus
-- email reset codes. Run in Supabase: SQL Editor -> New query -> paste -> Run.
create table if not exists hosts (
  email text primary key,
  pin_hash text not null,
  reset_hash text,
  reset_expires timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table hosts enable row level security;
drop policy if exists "public hosts" on hosts;
create policy "public hosts" on hosts for all using (true) with check (true);
-- Backfill: each host's most recent event PIN becomes their single host PIN.
insert into hosts (email, pin_hash)
select distinct on (lower(email)) lower(email), host_pin_hash
from events
where email is not null and host_pin_hash is not null
order by lower(email), created_at desc
on conflict (email) do nothing;
