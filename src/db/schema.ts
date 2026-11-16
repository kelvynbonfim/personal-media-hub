export type MediaType = 'ANIME' | 'MOVIE' | 'SERIES';

export type WatchStatus =
  | 'WATCHING'
  | 'PLAN_TO_WATCH'
  | 'COMPLETED'
  | 'PAUSED'
  | 'DROPPED'
  | 'REWATCHING';

export const WATCH_STATUSES: readonly WatchStatus[] = [
  'WATCHING',
  'PLAN_TO_WATCH',
  'COMPLETED',
  'PAUSED',
  'DROPPED',
  'REWATCHING',
] as const;

export const DEFAULT_UNITV_PORTAL_URL = 'https://www.unitvwebs.com';

export interface MediaItemRecord {
  id: string;
  mediaType: MediaType;
  anilistId: number;
  malId: number | null;
  tmdbId: number | null;
  titleRomaji: string;
  titleEnglish: string | null;
  titlePt: string | null;
  synopsis: string | null;
  coverUrl: string;
  bannerUrl: string | null;
  genresJson: string;
  seasonYear: number | null;
  seasonName: string | null;
  episodesTotal: number | null;
  statusAiring: string;
  nextAiringAt: number | null;
  nextAiringEp: number | null;
  relationsJson: string;
  cachedAt: string;
}

export interface LibraryEntryRecord {
  id: string;
  mediaItemId: string;
  status: WatchStatus;
  personalScore: number | null;
  currentEpisode: number;
  notes: string;
  rewatchCount: number;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  dirty: number;
}

export interface EpisodeProgressRecord {
  id: string;
  mediaItemId: string;
  episodeNumber: number;
  positionSeconds: number;
  durationSeconds: number;
  isCompleted: boolean;
  watchedVia: 'APP_PLAYER' | 'MANUAL';
  updatedAt: string;
  dirty: number;
}

export interface WatchHistoryRecord {
  id: string;
  mediaItemId: string;
  episodeNumber: number;
  action: 'STARTED' | 'COMPLETED' | 'STATUS_CHANGED';
  occurredAt: string;
  dirty: number;
}

export interface UniTvLinkRecord {
  mediaItemId: string;
  unitvVodId: string;
  unitvTitle: string;
  unitvSeasonTag: string | null;
  preferredAudioOrSub: string | null;
  lastVerifiedAt: string;
}

export interface AppSettingsRecord {
  unitvPortalUrl: string;
  preferMaxQuality: boolean;
  hideCompletedInExplore: boolean;
  tmdbApiKey: string | null;
  lastSyncAt: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettingsRecord = {
  unitvPortalUrl: DEFAULT_UNITV_PORTAL_URL,
  preferMaxQuality: true,
  hideCompletedInExplore: false,
  tmdbApiKey: null,
  lastSyncAt: null,
};

export interface DatabaseAdapter {
  execute(sql: string, params?: unknown[]): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

const SCHEMA_STATEMENTS: readonly string[] = [
  'PRAGMA foreign_keys = ON;',
  `CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY,
    media_type TEXT NOT NULL DEFAULT 'ANIME' CHECK (media_type IN ('ANIME', 'MOVIE', 'SERIES')),
    anilist_id INTEGER NOT NULL UNIQUE,
    mal_id INTEGER,
    tmdb_id INTEGER,
    title_romaji TEXT NOT NULL,
    title_english TEXT,
    title_pt TEXT,
    synopsis TEXT,
    cover_url TEXT NOT NULL,
    banner_url TEXT,
    genres_json TEXT NOT NULL DEFAULT '[]',
    season_year INTEGER,
    season_name TEXT,
    episodes_total INTEGER,
    status_airing TEXT NOT NULL DEFAULT 'UNKNOWN',
    next_airing_at INTEGER,
    next_airing_ep INTEGER,
    relations_json TEXT NOT NULL DEFAULT '[]',
    cached_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS library_entries (
    id TEXT PRIMARY KEY,
    media_item_id TEXT NOT NULL UNIQUE REFERENCES media_items(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('WATCHING', 'PLAN_TO_WATCH', 'COMPLETED', 'PAUSED', 'DROPPED', 'REWATCHING')),
    personal_score REAL CHECK (personal_score IS NULL OR (personal_score >= 0 AND personal_score <= 10)),
    current_episode INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    rewatch_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1
  );`,
  `CREATE TABLE IF NOT EXISTS episode_progress (
    id TEXT PRIMARY KEY,
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    position_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 0,
    is_completed INTEGER NOT NULL DEFAULT 0,
    watched_via TEXT NOT NULL CHECK (watched_via IN ('APP_PLAYER', 'MANUAL')),
    updated_at TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1,
    UNIQUE (media_item_id, episode_number)
  );`,
  `CREATE TABLE IF NOT EXISTS watch_history (
    id TEXT PRIMARY KEY,
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('STARTED', 'COMPLETED', 'STATUS_CHANGED')),
    occurred_at TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1
  );`,
  `CREATE TABLE IF NOT EXISTS unitv_links (
    media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
    unitv_vod_id TEXT NOT NULL,
    unitv_title TEXT NOT NULL,
    unitv_season_tag TEXT,
    preferred_audio_or_sub TEXT,
    last_verified_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    unitv_portal_url TEXT NOT NULL DEFAULT 'https://www.unitvwebs.com',
    prefer_max_quality INTEGER NOT NULL DEFAULT 1,
    hide_completed_in_explore INTEGER NOT NULL DEFAULT 0,
    tmdb_api_key TEXT,
    last_sync_at TEXT
  );`,
  'CREATE INDEX IF NOT EXISTS idx_media_items_anilist_id ON media_items(anilist_id);',
  'CREATE INDEX IF NOT EXISTS idx_library_entries_status ON library_entries(status);',
  'CREATE INDEX IF NOT EXISTS idx_library_entries_dirty ON library_entries(dirty);',
  'CREATE INDEX IF NOT EXISTS idx_episode_progress_media ON episode_progress(media_item_id, episode_number);',
  'CREATE INDEX IF NOT EXISTS idx_episode_progress_dirty ON episode_progress(dirty);',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_media ON watch_history(media_item_id, occurred_at);',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_dirty ON watch_history(dirty);',
  `INSERT OR IGNORE INTO app_settings (
    id,
    unitv_portal_url,
    prefer_max_quality,
    hide_completed_in_explore,
    tmdb_api_key,
    last_sync_at
  ) VALUES (1, 'https://www.unitvwebs.com', 1, 0, NULL, NULL);`,
  `UPDATE app_settings
     SET unitv_portal_url = 'https://www.unitvwebs.com'
   WHERE LOWER(unitv_portal_url) LIKE '%uvwebs.info%';`,
];

export async function initializeDatabase(db: DatabaseAdapter): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.execute(statement);
  }
}

type ExpoBindValue = import('expo-sqlite').SQLiteBindValue;

function toExpoBindValue(value: unknown): ExpoBindValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return String(value);
}

export function createExpoSqliteAdapter(
  db: import('expo-sqlite').SQLiteDatabase
): DatabaseAdapter {
  return {
    async execute(sql: string, params?: unknown[]): Promise<void> {
      if (!params || params.length === 0) {
        await db.execAsync(sql);
        return;
      }
      await db.runAsync(sql, params.map(toExpoBindValue));
    },
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const boundParams = (params ?? []).map(toExpoBindValue);
      return db.getAllAsync<T>(sql, boundParams);
    },
  };
}
