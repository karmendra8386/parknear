-- ParkNear migration v2 (2026-10-20): mandatory emails + verification mode.
-- Run once in Supabase: SQL Editor → New query → paste → Run.
alter table events add column if not exists email text;
alter table events add column if not exists verification text default 'both';
alter table offers add column if not exists email text;
alter table claims add column if not exists email text;
alter table claims add column if not exists phone text;
