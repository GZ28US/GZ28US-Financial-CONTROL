-- Track when a client was last edited, so the clients list can sort "last edited first".
-- Set explicitly by the app on every client update (edit page + self-service form);
-- new rows default to now(). Existing rows are backfilled from created_at.
alter table public.clients add column if not exists updated_at timestamptz default now();
update public.clients set updated_at = created_at where created_at is not null;
