-- Personal Media Hub - Supabase Postgres Schema (Free Tier Compatible)
-- Strictly excludes credentials, UniTV secrets, and device-local app_settings.
-- Enforces per-user isolation via composite keys and Row-Level Security (auth.uid() = user_id).

create table if not exists public.media_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  media_type text not null default 'ANIME' check (media_type in ('ANIME', 'MOVIE', 'SERIES')),
  anilist_id integer not null,
  mal_id integer,
  tmdb_id integer,
  title_romaji text not null,
  title_english text,
  title_pt text,
  synopsis text,
  cover_url text not null,
  banner_url text,
  genres_json text not null default '[]',
  season_year integer,
  season_name text,
  episodes_total integer,
  status_airing text not null default 'UNKNOWN',
  next_airing_at bigint,
  next_airing_ep integer,
  relations_json text not null default '[]',
  cached_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, anilist_id)
);

create table if not exists public.library_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  media_item_id text not null,
  status text not null check (
    status in ('WATCHING', 'PLAN_TO_WATCH', 'COMPLETED', 'PAUSED', 'DROPPED', 'REWATCHING')
  ),
  personal_score double precision check (
    personal_score is null or (personal_score >= 0 and personal_score <= 10)
  ),
  current_episode integer not null default 0,
  notes text not null default '',
  rewatch_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null,
  primary key (user_id, id),
  unique (user_id, media_item_id),
  foreign key (user_id, media_item_id)
    references public.media_items(user_id, id)
    on delete cascade
    on update cascade
);

create table if not exists public.episode_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  media_item_id text not null,
  episode_number integer not null check (episode_number >= 1),
  position_seconds double precision not null default 0,
  duration_seconds double precision not null default 0,
  is_completed boolean not null default false,
  watched_via text not null check (watched_via in ('APP_PLAYER', 'MANUAL')),
  updated_at timestamptz not null,
  primary key (user_id, id),
  unique (user_id, media_item_id, episode_number),
  foreign key (user_id, media_item_id)
    references public.media_items(user_id, id)
    on delete cascade
    on update cascade
);

create table if not exists public.watch_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  media_item_id text not null,
  episode_number integer not null,
  action text not null check (action in ('STARTED', 'COMPLETED', 'STATUS_CHANGED')),
  occurred_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, media_item_id)
    references public.media_items(user_id, id)
    on delete cascade
    on update cascade
);

create table if not exists public.unitv_links (
  user_id uuid not null references auth.users(id) on delete cascade,
  media_item_id text not null,
  unitv_vod_id text not null,
  unitv_title text not null,
  unitv_season_tag text,
  preferred_audio_or_sub text,
  last_verified_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, media_item_id),
  foreign key (user_id, media_item_id)
    references public.media_items(user_id, id)
    on delete cascade
    on update cascade
);

create index if not exists idx_media_items_user_updated
  on public.media_items (user_id, updated_at);
create index if not exists idx_library_entries_user_updated
  on public.library_entries (user_id, updated_at);
create index if not exists idx_episode_progress_user_updated
  on public.episode_progress (user_id, updated_at);
create index if not exists idx_watch_history_user_updated
  on public.watch_history (user_id, updated_at);
create index if not exists idx_unitv_links_user_updated
  on public.unitv_links (user_id, updated_at);

-- Row-Level Security (RLS)
alter table public.media_items enable row level security;
alter table public.library_entries enable row level security;
alter table public.episode_progress enable row level security;
alter table public.watch_history enable row level security;
alter table public.unitv_links enable row level security;

-- media_items policies
drop policy if exists "media_items_select_own" on public.media_items;
create policy "media_items_select_own"
  on public.media_items for select
  using (auth.uid() = user_id);

drop policy if exists "media_items_insert_own" on public.media_items;
create policy "media_items_insert_own"
  on public.media_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "media_items_update_own" on public.media_items;
create policy "media_items_update_own"
  on public.media_items for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "media_items_delete_own" on public.media_items;
create policy "media_items_delete_own"
  on public.media_items for delete
  using (auth.uid() = user_id);

-- library_entries policies
drop policy if exists "library_entries_select_own" on public.library_entries;
create policy "library_entries_select_own"
  on public.library_entries for select
  using (auth.uid() = user_id);

drop policy if exists "library_entries_insert_own" on public.library_entries;
create policy "library_entries_insert_own"
  on public.library_entries for insert
  with check (auth.uid() = user_id);

drop policy if exists "library_entries_update_own" on public.library_entries;
create policy "library_entries_update_own"
  on public.library_entries for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "library_entries_delete_own" on public.library_entries;
create policy "library_entries_delete_own"
  on public.library_entries for delete
  using (auth.uid() = user_id);

-- episode_progress policies
drop policy if exists "episode_progress_select_own" on public.episode_progress;
create policy "episode_progress_select_own"
  on public.episode_progress for select
  using (auth.uid() = user_id);

drop policy if exists "episode_progress_insert_own" on public.episode_progress;
create policy "episode_progress_insert_own"
  on public.episode_progress for insert
  with check (auth.uid() = user_id);

drop policy if exists "episode_progress_update_own" on public.episode_progress;
create policy "episode_progress_update_own"
  on public.episode_progress for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "episode_progress_delete_own" on public.episode_progress;
create policy "episode_progress_delete_own"
  on public.episode_progress for delete
  using (auth.uid() = user_id);

-- watch_history policies
drop policy if exists "watch_history_select_own" on public.watch_history;
create policy "watch_history_select_own"
  on public.watch_history for select
  using (auth.uid() = user_id);

drop policy if exists "watch_history_insert_own" on public.watch_history;
create policy "watch_history_insert_own"
  on public.watch_history for insert
  with check (auth.uid() = user_id);

drop policy if exists "watch_history_update_own" on public.watch_history;
create policy "watch_history_update_own"
  on public.watch_history for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "watch_history_delete_own" on public.watch_history;
create policy "watch_history_delete_own"
  on public.watch_history for delete
  using (auth.uid() = user_id);

-- unitv_links policies
drop policy if exists "unitv_links_select_own" on public.unitv_links;
create policy "unitv_links_select_own"
  on public.unitv_links for select
  using (auth.uid() = user_id);

drop policy if exists "unitv_links_insert_own" on public.unitv_links;
create policy "unitv_links_insert_own"
  on public.unitv_links for insert
  with check (auth.uid() = user_id);

drop policy if exists "unitv_links_update_own" on public.unitv_links;
create policy "unitv_links_update_own"
  on public.unitv_links for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "unitv_links_delete_own" on public.unitv_links;
create policy "unitv_links_delete_own"
  on public.unitv_links for delete
  using (auth.uid() = user_id);
