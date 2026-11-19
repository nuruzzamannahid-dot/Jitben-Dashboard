-- ============================================================
--  Jitben Ops Dashboard — Supabase schema
--  Two tabs:  jitben_dod (one row per order) + a view for
--  customer details, matching the dashboard's two tabs.
-- ============================================================

create table if not exists public.jitben_dod (
  fid            text primary key,
  order_date     date        not null,
  status         text        not null,
  receiver_name  text,
  phone          text,
  address        text,
  city           text,
  merchant       text        default 'Jitben.com',
  amount         numeric(12,2),
  has_details     boolean     generated always as
                 (coalesce(nullif(receiver_name,''), nullif(address,'')) is not null) stored,
  updated_at     timestamptz default now()
);

create index if not exists idx_dod_date    on public.jitben_dod (order_date);
create index if not exists idx_dod_status  on public.jitben_dod (status);
create index if not exists idx_dod_name    on public.jitben_dod using gin (to_tsvector('simple', coalesce(receiver_name,'')));
create index if not exists idx_dod_fid_txt on public.jitben_dod (fid text_pattern_ops);

-- a phone is only real if it is not the shared merchant line and has 10-15 digits
create or replace function public.clean_phone(p text) returns text
language sql immutable as $$
  select case
    when p is null or btrim(p) = '' then null
    when regexp_replace(p,'\D','','g') ~ '^(88)?01701207943$' then null
    when length(regexp_replace(p,'\D','','g')) between 10 and 15 then p
    else null
  end
$$;

-- daily x status pivot used by the DOD tab
create or replace view public.dod_daily as
select order_date, status, count(*)::int as orders
from public.jitben_dod
group by order_date, status;

create or replace view public.dod_kpis as
select
  count(*)::int                                        as total,
  count(*) filter (where status = 'Delivered')::int     as delivered,
  count(*) filter (where status in ('Return','Paid Return'))::int as returned,
  count(*) filter (where status = 'Pickup Cancelled')::int        as cancelled,
  count(*) filter (where receiver_name is not null and receiver_name <> '')::int as with_name,
  count(*) filter (where phone is not null)::int        as with_phone,
  count(*) filter (where address is not null and address <> '')::int as with_address
from public.jitben_dod;

-- read-only public access (dashboard is static; swap to auth if it goes internal)
alter table public.jitben_dod enable row level security;

drop policy if exists "public read" on public.jitben_dod;
create policy "public read" on public.jitben_dod for select using (true);

grant select on public.jitben_dod, public.dod_daily, public.dod_kpis to anon, authenticated;
