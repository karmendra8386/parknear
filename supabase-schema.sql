-- ParkNear — Supabase schema (Live Mode). Run once in Supabase: SQL Editor → New query → paste → Run.
create table if not exists events (
  id text primary key,
  host_name text not null,
  address text not null,
  lat double precision,
  lng double precision,
  party_date date,
  needed int,
  time_from text,
  time_to text,
  phone text,
  email text,
  verification text default 'both',
  notes text,
  created_at timestamptz default now()
);
create table if not exists offers (
  id text primary key,
  event_id text references events(id) on delete cascade,
  neighbor_name text not null,
  address text not null,
  lat double precision,
  lng double precision,
  spots int default 1,
  phone text,
  email text,
  notes text,
  status text default 'offered',  -- offered | locked
  code text,
  created_at timestamptz default now()
);
create table if not exists claims (
  id text primary key,
  event_id text references events(id) on delete cascade,
  guest_name text not null,
  email text,
  phone text,
  address text,
  spot_label text,
  code text,
  created_at timestamptz default now()
);
alter table events enable row level security;
alter table offers enable row level security;
alter table claims enable row level security;
-- Neighborhood-trust model: anyone with the link can read/write.
-- (No accounts by design — the unguessable event id in the link is the key.)
create policy "public events" on events for all using (true) with check (true);
create policy "public offers" on offers for all using (true) with check (true);
create policy "public claims" on claims for all using (true) with check (true);
