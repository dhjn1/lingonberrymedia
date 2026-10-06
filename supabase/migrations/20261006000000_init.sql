-- lingonberrymedia: initial schema
-- Every table is locked behind Row Level Security. Only signed-in users
-- (public sign-up is disabled, so just the two of you) can read or write.

-- ---------------------------------------------------------------------------
-- Nights: one row per planned evening
-- ---------------------------------------------------------------------------
create table public.nights (
  id          uuid primary key default gen_random_uuid(),
  night_date  date not null unique,
  start_time  time,                      -- null = not decided yet
  version     integer not null default 1, -- bumps on every save (conflict check)
  watched_at  timestamptz,               -- set when the night is marked watched
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- ---------------------------------------------------------------------------
-- Lineup items: ordered things to watch on a night
-- ---------------------------------------------------------------------------
create table public.lineup_items (
  id             uuid primary key default gen_random_uuid(),
  night_id       uuid not null references public.nights(id) on delete cascade,
  position       integer not null,
  kind           text not null check (kind in ('movie', 'episode', 'custom')),
  tmdb_id        integer,          -- movie id or episode id
  show_tmdb_id   integer,          -- for episodes
  season         integer,
  episode        integer,
  title          text not null,    -- movie title, show name, or custom label
  subtitle       text,             -- episode name, matchup, etc.
  poster_path    text,             -- TMDB image path, e.g. /abc.jpg
  runtime_min    integer not null check (runtime_min > 0),
  runtime_source text not null default 'tmdb'
                 check (runtime_source in ('tmdb', 'season_median', 'show_typical',
                                           'default', 'manual', 'custom_estimate')),
  anchor_time    time,             -- fixed start (NFL kickoff); null = flows
  note           text,             -- footnote text for custom estimates
  added_by       uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  unique (night_id, position)
);
create index lineup_items_night_idx on public.lineup_items (night_id, position);

-- ---------------------------------------------------------------------------
-- Queue: shared "want to watch" list (movies and shows)
-- ---------------------------------------------------------------------------
create table public.queue_items (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('movie', 'tv')),
  tmdb_id      integer not null,
  title        text not null,
  year         text,
  poster_path  text,
  added_by     uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (kind, tmdb_id)
);

-- ---------------------------------------------------------------------------
-- Show progress: last episode watched per show
-- ---------------------------------------------------------------------------
create table public.show_progress (
  show_tmdb_id integer primary key,
  show_name    text not null,
  last_season  integer not null,
  last_episode integer not null,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- History: what was actually watched
-- ---------------------------------------------------------------------------
create table public.history (
  id           uuid primary key default gen_random_uuid(),
  watched_on   date not null,
  kind         text not null,
  tmdb_id      integer,
  show_tmdb_id integer,
  season       integer,
  episode      integer,
  title        text not null,
  subtitle     text,
  runtime_min  integer,
  created_at   timestamptz not null default now()
);
create index history_watched_on_idx on public.history (watched_on desc);

-- ---------------------------------------------------------------------------
-- TMDB cache: only the Edge Function (service role) touches this
-- ---------------------------------------------------------------------------
create table public.tmdb_cache (
  path        text primary key,
  body        jsonb not null,
  fetched_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.nights        enable row level security;
alter table public.lineup_items  enable row level security;
alter table public.queue_items   enable row level security;
alter table public.show_progress enable row level security;
alter table public.history       enable row level security;
alter table public.tmdb_cache    enable row level security;  -- no policies: service role only

create policy "signed-in users" on public.nights
  for all to authenticated using (true) with check (true);
create policy "signed-in users" on public.lineup_items
  for all to authenticated using (true) with check (true);
create policy "signed-in users" on public.queue_items
  for all to authenticated using (true) with check (true);
create policy "signed-in users" on public.show_progress
  for all to authenticated using (true) with check (true);
create policy "signed-in users" on public.history
  for all to authenticated using (true) with check (true);

revoke all on public.tmdb_cache from anon, authenticated;

-- ---------------------------------------------------------------------------
-- save_lineup: replace a night's lineup atomically, with a stale-write check.
-- The client sends the version it loaded; if someone saved in between, this
-- raises 'stale_lineup' and the client reloads instead of overwriting.
-- ---------------------------------------------------------------------------
create or replace function public.save_lineup(
  p_night_date       date,
  p_expected_version integer,
  p_start_time       time,
  p_items            jsonb
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_night public.nights%rowtype;
  v_new_version integer;
begin
  select * into v_night from public.nights
   where night_date = p_night_date
   for update;

  if not found then
    if coalesce(p_expected_version, 0) <> 0 then
      raise exception 'stale_lineup' using errcode = 'P0001';
    end if;
    insert into public.nights (night_date, start_time, version)
    values (p_night_date, p_start_time, 1)
    returning * into v_night;
    v_new_version := 1;
  else
    if v_night.version <> p_expected_version then
      raise exception 'stale_lineup' using errcode = 'P0001';
    end if;
    update public.nights
       set start_time = p_start_time,
           version    = version + 1,
           updated_at = now(),
           updated_by = auth.uid()
     where id = v_night.id
    returning version into v_new_version;
  end if;

  delete from public.lineup_items where night_id = v_night.id;

  insert into public.lineup_items (
    night_id, position, kind, tmdb_id, show_tmdb_id, season, episode,
    title, subtitle, poster_path, runtime_min, runtime_source,
    anchor_time, note, added_by
  )
  select v_night.id,
         (t.ord - 1)::integer,
         t.item->>'kind',
         (t.item->>'tmdb_id')::integer,
         (t.item->>'show_tmdb_id')::integer,
         (t.item->>'season')::integer,
         (t.item->>'episode')::integer,
         t.item->>'title',
         t.item->>'subtitle',
         t.item->>'poster_path',
         (t.item->>'runtime_min')::integer,
         coalesce(t.item->>'runtime_source', 'tmdb'),
         (t.item->>'anchor_time')::time,
         t.item->>'note',
         coalesce((t.item->>'added_by')::uuid, auth.uid())
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
         with ordinality as t(item, ord);

  return v_new_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_night_watched: log the lineup to history and advance show progress
-- ---------------------------------------------------------------------------
create or replace function public.mark_night_watched(p_night_date date)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_night public.nights%rowtype;
  v_count integer;
begin
  select * into v_night from public.nights
   where night_date = p_night_date
   for update;

  if not found then
    raise exception 'no_lineup' using errcode = 'P0001';
  end if;
  if v_night.watched_at is not null then
    raise exception 'already_marked' using errcode = 'P0001';
  end if;

  insert into public.history (watched_on, kind, tmdb_id, show_tmdb_id, season,
                              episode, title, subtitle, runtime_min)
  select p_night_date, kind, tmdb_id, show_tmdb_id, season, episode,
         title, subtitle, runtime_min
    from public.lineup_items
   where night_id = v_night.id
   order by position;
  get diagnostics v_count = row_count;

  -- Advance each show to the furthest episode in tonight's lineup,
  -- never moving progress backwards.
  insert into public.show_progress (show_tmdb_id, show_name, last_season, last_episode)
  select distinct on (show_tmdb_id)
         show_tmdb_id, title, season, episode
    from public.lineup_items
   where night_id = v_night.id
     and kind = 'episode'
     and show_tmdb_id is not null
   order by show_tmdb_id, season desc, episode desc
  on conflict (show_tmdb_id) do update
     set last_season  = excluded.last_season,
         last_episode = excluded.last_episode,
         show_name    = excluded.show_name,
         updated_at   = now()
   where (excluded.last_season, excluded.last_episode)
       > (show_progress.last_season, show_progress.last_episode);

  update public.nights
     set watched_at = now(),
         version    = version + 1,
         updated_at = now(),
         updated_by = auth.uid()
   where id = v_night.id;

  return v_count;
end;
$$;

revoke execute on function public.save_lineup(date, integer, time, jsonb) from public, anon;
revoke execute on function public.mark_night_watched(date) from public, anon;
grant execute on function public.save_lineup(date, integer, time, jsonb) to authenticated;
grant execute on function public.mark_night_watched(date) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: lets one of you see the other's edits without refreshing
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.nights;
alter publication supabase_realtime add table public.queue_items;
