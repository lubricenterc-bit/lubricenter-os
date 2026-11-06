create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists http with schema extensions;
create table if not exists public._norte_bootstrap (i int primary key, ph text, p int, sql text, done boolean default false, err text);
alter table public._norte_bootstrap enable row level security;
revoke all on public._norte_bootstrap from anon, authenticated;