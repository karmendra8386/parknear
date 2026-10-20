-- ParkNear migration v3 (2026-10-20): per-event host PIN (stored as SHA-256 hash).
-- Run once in Supabase: SQL Editor → New query → paste → Run.
alter table events add column if not exists host_pin_hash text;
