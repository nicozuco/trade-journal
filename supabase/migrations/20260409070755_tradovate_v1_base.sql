create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.tradovate_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  environment text not null check (environment in ('demo', 'live')),
  auth_mode text not null default 'api_key_credentials',
  tradovate_username text,
  encrypted_password text,
  access_token text,
  access_token_expires_at timestamptz,
  tradovate_user_id bigint,
  has_live boolean not null default false,
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connected', 'expired', 'error', 'syncing')),
  last_error text,
  last_connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tradovate_account_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tradovate_connection_id uuid not null references public.tradovate_connections(id) on delete cascade,
  tradovate_account_id bigint not null,
  tradovate_account_name text,
  local_account_id uuid not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.tradovate_account_links.local_account_id is
  'Expected to reference public.accounts(id). Foreign key is added conditionally only if public.accounts exists at migration time.';

create table if not exists public.tradovate_sync_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tradovate_connection_id uuid not null references public.tradovate_connections(id) on delete cascade,
  tradovate_account_link_id uuid not null references public.tradovate_account_links(id) on delete cascade,
  last_fill_pair_id bigint,
  last_fill_id bigint,
  last_synced_at timestamptz,
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'syncing', 'ok', 'error')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'accounts'
  ) then
    if not exists (
      select 1
      from pg_constraint
      where conname = 'tradovate_account_links_local_account_id_fkey'
    ) then
      alter table public.tradovate_account_links
        add constraint tradovate_account_links_local_account_id_fkey
        foreign key (local_account_id)
        references public.accounts(id)
        on delete cascade;
    end if;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'trades'
  ) then
    alter table public.trades
      add column if not exists broker_source text,
      add column if not exists broker_account_id text,
      add column if not exists external_fill_pair_id bigint,
      add column if not exists external_fill_ids jsonb,
      add column if not exists imported_at timestamptz,
      add column if not exists raw_broker_payload jsonb;
  end if;
end
$$;

create index if not exists tradovate_connections_user_id_idx
  on public.tradovate_connections(user_id);

create index if not exists tradovate_connections_status_idx
  on public.tradovate_connections(status);

create index if not exists tradovate_account_links_user_id_idx
  on public.tradovate_account_links(user_id);

create index if not exists tradovate_account_links_connection_id_idx
  on public.tradovate_account_links(tradovate_connection_id);

create index if not exists tradovate_account_links_tradovate_account_id_idx
  on public.tradovate_account_links(tradovate_account_id);

create unique index if not exists tradovate_account_links_unique_active_idx
  on public.tradovate_account_links(user_id, tradovate_connection_id, tradovate_account_id, local_account_id);

create index if not exists tradovate_sync_state_user_id_idx
  on public.tradovate_sync_state(user_id);

create index if not exists tradovate_sync_state_connection_id_idx
  on public.tradovate_sync_state(tradovate_connection_id);

create index if not exists tradovate_sync_state_account_link_id_idx
  on public.tradovate_sync_state(tradovate_account_link_id);

create unique index if not exists tradovate_sync_state_unique_link_idx
  on public.tradovate_sync_state(tradovate_account_link_id);

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'trades'
  ) then
    create index if not exists trades_broker_source_idx
      on public.trades(broker_source);

    create index if not exists trades_external_fill_pair_id_idx
      on public.trades(external_fill_pair_id);

    create index if not exists trades_user_broker_fillpair_idx
      on public.trades(user_id, broker_source, external_fill_pair_id);

    if not exists (
      select 1
      from pg_constraint
      where conname = 'trades_user_id_broker_source_external_fill_pair_id_key'
    ) then
      alter table public.trades
        add constraint trades_user_id_broker_source_external_fill_pair_id_key
        unique (user_id, broker_source, external_fill_pair_id);
    end if;
  end if;
end
$$;

alter table public.tradovate_connections enable row level security;
alter table public.tradovate_account_links enable row level security;
alter table public.tradovate_sync_state enable row level security;

drop policy if exists tradovate_connections_select_own on public.tradovate_connections;
drop policy if exists tradovate_connections_insert_own on public.tradovate_connections;
drop policy if exists tradovate_connections_update_own on public.tradovate_connections;
drop policy if exists tradovate_connections_delete_own on public.tradovate_connections;

create policy tradovate_connections_select_own
on public.tradovate_connections
for select
to authenticated
using (auth.uid() = user_id);

create policy tradovate_connections_insert_own
on public.tradovate_connections
for insert
to authenticated
with check (auth.uid() = user_id);

create policy tradovate_connections_update_own
on public.tradovate_connections
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy tradovate_connections_delete_own
on public.tradovate_connections
for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists tradovate_account_links_select_own on public.tradovate_account_links;
drop policy if exists tradovate_account_links_insert_own on public.tradovate_account_links;
drop policy if exists tradovate_account_links_update_own on public.tradovate_account_links;
drop policy if exists tradovate_account_links_delete_own on public.tradovate_account_links;

create policy tradovate_account_links_select_own
on public.tradovate_account_links
for select
to authenticated
using (auth.uid() = user_id);

create policy tradovate_account_links_insert_own
on public.tradovate_account_links
for insert
to authenticated
with check (auth.uid() = user_id);

create policy tradovate_account_links_update_own
on public.tradovate_account_links
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy tradovate_account_links_delete_own
on public.tradovate_account_links
for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists tradovate_sync_state_select_own on public.tradovate_sync_state;
drop policy if exists tradovate_sync_state_insert_own on public.tradovate_sync_state;
drop policy if exists tradovate_sync_state_update_own on public.tradovate_sync_state;
drop policy if exists tradovate_sync_state_delete_own on public.tradovate_sync_state;

create policy tradovate_sync_state_select_own
on public.tradovate_sync_state
for select
to authenticated
using (auth.uid() = user_id);

create policy tradovate_sync_state_insert_own
on public.tradovate_sync_state
for insert
to authenticated
with check (auth.uid() = user_id);

create policy tradovate_sync_state_update_own
on public.tradovate_sync_state
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy tradovate_sync_state_delete_own
on public.tradovate_sync_state
for delete
to authenticated
using (auth.uid() = user_id);

drop trigger if exists set_tradovate_connections_updated_at on public.tradovate_connections;
create trigger set_tradovate_connections_updated_at
before update on public.tradovate_connections
for each row
execute function public.set_updated_at();

drop trigger if exists set_tradovate_account_links_updated_at on public.tradovate_account_links;
create trigger set_tradovate_account_links_updated_at
before update on public.tradovate_account_links
for each row
execute function public.set_updated_at();

drop trigger if exists set_tradovate_sync_state_updated_at on public.tradovate_sync_state;
create trigger set_tradovate_sync_state_updated_at
before update on public.tradovate_sync_state
for each row
execute function public.set_updated_at();
