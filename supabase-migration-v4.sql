-- ParkNear migration v4 (2026-10-20): guests identify by car instead of passcode.
-- Run once in Supabase: SQL Editor → New query → paste → Run.
alter table claims add column if not exists car_color text;
alter table claims add column if not exists car_model text;
