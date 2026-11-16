import {
  DatabaseAdapter,
  DEFAULT_UNITV_PORTAL_URL,
  EpisodeProgressRecord,
  LibraryEntryRecord,
  MediaItemRecord,
  MediaType,
  UniTvLinkRecord,
  WATCH_STATUSES,
  WatchHistoryRecord,
  WatchStatus,
} from '../db/schema';

/** Outcome returned by {@link SupabaseSyncEngine.syncNow}. */
export interface SyncResult {
  status: 'SYNCED' | 'DEFERRED_OFFLINE_OR_PAUSED';
  pushedCount: number;
  pulledCount: number;
  errorMessage?: string;
}

export interface SupabaseSyncError {
  message: string;
  status?: number;
  code?: string;
}

/** Minimal transport abstraction over Supabase PostgREST queries for sync. */
export interface SupabaseSyncClient {
  upsert(
    table: string,
    rows: Record<string, unknown>[]
  ): Promise<{ error: SupabaseSyncError | null }>;
  selectUpdatedSince(
    table: string,
    userId: string,
    sinceIso: string | null
  ): Promise<{
    data: Record<string, unknown>[] | null;
    error: SupabaseSyncError | null;
  }>;
}

const BATCH_SIZE = 200;

const TABLE_ON_CONFLICT: Readonly<Record<string, string>> = {
  media_items: 'user_id,anilist_id',
  library_entries: 'user_id,media_item_id',
  episode_progress: 'user_id,media_item_id,episode_number',
  watch_history: 'user_id,id',
  unitv_links: 'user_id,media_item_id',
};

const VALID_MEDIA_TYPES = new Set<MediaType>(['ANIME', 'MOVIE', 'SERIES']);
const VALID_WATCHED_VIA = new Set<EpisodeProgressRecord['watchedVia']>([
  'APP_PLAYER',
  'MANUAL',
]);
const VALID_HISTORY_ACTIONS = new Set<WatchHistoryRecord['action']>([
  'STARTED',
  'COMPLETED',
  'STATUS_CHANGED',
]);

type RawRow = Record<string, unknown>;

interface DirtyPushBundle {
  mediaToPush: MediaItemRecord[];
  dirtyEntries: LibraryEntryRecord[];
  dirtyProgress: EpisodeProgressRecord[];
  dirtyHistory: WatchHistoryRecord[];
  linksToPush: UniTvLinkRecord[];
}

interface RemotePullBundle {
  remoteMediaItems: Array<{ record: MediaItemRecord; remoteUpdatedAt: string | null }>;
  remoteEntries: LibraryEntryRecord[];
  remoteProgress: EpisodeProgressRecord[];
  remoteHistory: Array<{ record: WatchHistoryRecord; remoteUpdatedAt: string | null }>;
  remoteLinks: Array<{ record: UniTvLinkRecord; remoteUpdatedAt: string | null }>;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function sanitizeScore(value: unknown): number | null {
  const num = asNullableNumber(value);
  if (num === null || num < 0 || num > 10) {
    return null;
  }
  return num;
}

function formatErrorMessage(error: SupabaseSyncError): string {
  const parts: string[] = [];
  if (typeof error.status === 'number') {
    parts.push(`HTTP ${error.status}`);
  }
  if (error.code) {
    parts.push(error.code);
  }
  const prefix = parts.length > 0 ? `[${parts.join(' / ')}] ` : '';
  return `${prefix}${error.message || 'Supabase sync error'}`;
}

function extractUnknownErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function toSyncError(
  error: { message?: string; code?: string; status?: number },
  responseStatus?: number
): SupabaseSyncError {
  const status =
    typeof responseStatus === 'number'
      ? responseStatus
      : typeof error.status === 'number'
        ? error.status
        : undefined;
  return {
    message: error.message ?? 'Unknown Supabase error',
    ...(status !== undefined ? { status } : {}),
    ...(error.code ? { code: error.code } : {}),
  };
}

/** Wraps an official `@supabase/supabase-js` client in {@link SupabaseSyncClient}. */
export function createSupabaseSyncClient(
  client: import('@supabase/supabase-js').SupabaseClient
): SupabaseSyncClient {
  return {
    async upsert(table, rows) {
      if (rows.length === 0) {
        return { error: null };
      }

      try {
        const onConflict = TABLE_ON_CONFLICT[table];
        const query = client.from(table);
        const response = onConflict
          ? await query.upsert(rows, { onConflict })
          : await query.upsert(rows);

        if (response.error) {
          return {
            error: toSyncError(response.error, response.status),
          };
        }
        return { error: null };
      } catch (err) {
        return {
          error: { message: extractUnknownErrorMessage(err) },
        };
      }
    },

    async selectUpdatedSince(table, userId, sinceIso) {
      try {
        let query = client.from(table).select('*').eq('user_id', userId);
        if (sinceIso !== null) {
          query = query.gt('updated_at', sinceIso);
        }
        const response = await query;

        if (response.error) {
          return {
            data: null,
            error: toSyncError(response.error, response.status),
          };
        }

        return {
          data: (Array.isArray(response.data) ? response.data : []) as Record<string, unknown>[],
          error: null,
        };
      } catch (err) {
        return {
          data: null,
          error: { message: extractUnknownErrorMessage(err) },
        };
      }
    },
  };
}

/**
 * Last-Write-Wins conflict resolver comparing ISO timestamps numerically so
 * timezone offset variants (`.000Z` vs `+00:00`) resolve accurately; ties keep `local`.
 */
export function resolveConflictByUpdatedAt<T extends { updatedAt: string }>(
  local: T,
  remote: T
): T {
  const localMs = Date.parse(local.updatedAt);
  const remoteMs = Date.parse(remote.updatedAt);

  if (Number.isFinite(localMs) && Number.isFinite(remoteMs)) {
    return remoteMs > localMs ? remote : local;
  }
  if (Number.isFinite(remoteMs) && !Number.isFinite(localMs)) {
    return remote;
  }
  if (Number.isFinite(localMs) && !Number.isFinite(remoteMs)) {
    return local;
  }
  return remote.updatedAt > local.updatedAt ? remote : local;
}

function mapMediaItemRow(row: RawRow): MediaItemRecord | null {
  const id = asNonEmptyString(row.id);
  const anilistId = asNullableNumber(row.anilist_id);
  const titleRomaji = asNonEmptyString(row.title_romaji);
  if (!id || anilistId === null || !Number.isInteger(anilistId) || !titleRomaji) {
    return null;
  }
  const rawType = asString(row.media_type, 'ANIME') as MediaType;
  const mediaType: MediaType = VALID_MEDIA_TYPES.has(rawType) ? rawType : 'ANIME';
  const cachedAt = asNonEmptyString(row.cached_at) ?? asNonEmptyString(row.updated_at);
  if (!cachedAt) {
    return null;
  }

  return {
    id,
    mediaType,
    anilistId,
    malId: asNullableNumber(row.mal_id),
    tmdbId: asNullableNumber(row.tmdb_id),
    titleRomaji,
    titleEnglish: asNullableString(row.title_english),
    titlePt: asNullableString(row.title_pt),
    synopsis: asNullableString(row.synopsis),
    coverUrl: asString(row.cover_url, ''),
    bannerUrl: asNullableString(row.banner_url),
    genresJson: asString(row.genres_json, '[]'),
    seasonYear: asNullableNumber(row.season_year),
    seasonName: asNullableString(row.season_name),
    episodesTotal: asNullableNumber(row.episodes_total),
    statusAiring: asString(row.status_airing, 'UNKNOWN'),
    nextAiringAt: asNullableNumber(row.next_airing_at),
    nextAiringEp: asNullableNumber(row.next_airing_ep),
    relationsJson: asString(row.relations_json, '[]'),
    cachedAt,
  };
}

function mapLibraryEntryRow(row: RawRow, forcedDirty?: number): LibraryEntryRecord | null {
  const id = asNonEmptyString(row.id);
  const mediaItemId = asNonEmptyString(row.media_item_id);
  const status = asString(row.status) as WatchStatus;
  const updatedAt = asNonEmptyString(row.updated_at);
  if (!id || !mediaItemId || !WATCH_STATUSES.includes(status) || !updatedAt) {
    return null;
  }

  return {
    id,
    mediaItemId,
    status,
    personalScore: sanitizeScore(row.personal_score),
    currentEpisode: Math.max(0, Math.trunc(asNumber(row.current_episode, 0))),
    notes: asString(row.notes, ''),
    rewatchCount: Math.max(0, Math.trunc(asNumber(row.rewatch_count, 0))),
    startedAt: asNullableString(row.started_at),
    completedAt: asNullableString(row.completed_at),
    updatedAt,
    dirty: forcedDirty ?? asNumber(row.dirty, 1),
  };
}

function mapEpisodeProgressRow(row: RawRow, forcedDirty?: number): EpisodeProgressRecord | null {
  const id = asNonEmptyString(row.id);
  const mediaItemId = asNonEmptyString(row.media_item_id);
  const episodeNumber = asNullableNumber(row.episode_number);
  const updatedAt = asNonEmptyString(row.updated_at);
  const rawWatchedVia = asString(row.watched_via, 'APP_PLAYER') as EpisodeProgressRecord['watchedVia'];
  if (
    !id ||
    !mediaItemId ||
    episodeNumber === null ||
    !Number.isInteger(episodeNumber) ||
    episodeNumber < 1 ||
    !updatedAt
  ) {
    return null;
  }

  return {
    id,
    mediaItemId,
    episodeNumber,
    positionSeconds: Math.max(0, asNumber(row.position_seconds, 0)),
    durationSeconds: Math.max(0, asNumber(row.duration_seconds, 0)),
    isCompleted: asBoolean(row.is_completed),
    watchedVia: VALID_WATCHED_VIA.has(rawWatchedVia) ? rawWatchedVia : 'APP_PLAYER',
    updatedAt,
    dirty: forcedDirty ?? asNumber(row.dirty, 1),
  };
}

function mapWatchHistoryRow(row: RawRow, forcedDirty?: number): WatchHistoryRecord | null {
  const id = asNonEmptyString(row.id);
  const mediaItemId = asNonEmptyString(row.media_item_id);
  const action = asString(row.action) as WatchHistoryRecord['action'];
  const occurredAt = asNonEmptyString(row.occurred_at);
  if (!id || !mediaItemId || !VALID_HISTORY_ACTIONS.has(action) || !occurredAt) {
    return null;
  }

  return {
    id,
    mediaItemId,
    episodeNumber: Math.max(0, Math.trunc(asNumber(row.episode_number, 0))),
    action,
    occurredAt,
    dirty: forcedDirty ?? asNumber(row.dirty, 1),
  };
}

function mapUniTvLinkRow(row: RawRow): UniTvLinkRecord | null {
  const mediaItemId = asNonEmptyString(row.media_item_id);
  const unitvVodId = asNonEmptyString(row.unitv_vod_id);
  const unitvTitle = asNonEmptyString(row.unitv_title);
  const lastVerifiedAt = asNonEmptyString(row.last_verified_at);
  if (!mediaItemId || !unitvVodId || !unitvTitle || !lastVerifiedAt) {
    return null;
  }

  return {
    mediaItemId,
    unitvVodId,
    unitvTitle,
    unitvSeasonTag: asNullableString(row.unitv_season_tag),
    preferredAudioOrSub: asNullableString(row.preferred_audio_or_sub),
    lastVerifiedAt,
  };
}

function toRemoteMediaItem(item: MediaItemRecord, userId: string): Record<string, unknown> {
  return {
    user_id: userId,
    id: item.id,
    media_type: item.mediaType,
    anilist_id: item.anilistId,
    mal_id: item.malId,
    tmdb_id: item.tmdbId,
    title_romaji: item.titleRomaji,
    title_english: item.titleEnglish,
    title_pt: item.titlePt,
    synopsis: item.synopsis,
    cover_url: item.coverUrl,
    banner_url: item.bannerUrl,
    genres_json: item.genresJson,
    season_year: item.seasonYear,
    season_name: item.seasonName,
    episodes_total: item.episodesTotal,
    status_airing: item.statusAiring,
    next_airing_at: item.nextAiringAt,
    next_airing_ep: item.nextAiringEp,
    relations_json: item.relationsJson,
    cached_at: item.cachedAt,
    updated_at: item.cachedAt,
  };
}

function toRemoteLibraryEntry(entry: LibraryEntryRecord, userId: string): Record<string, unknown> {
  return {
    user_id: userId,
    id: entry.id,
    media_item_id: entry.mediaItemId,
    status: entry.status,
    personal_score: entry.personalScore,
    current_episode: entry.currentEpisode,
    notes: entry.notes,
    rewatch_count: entry.rewatchCount,
    started_at: entry.startedAt,
    completed_at: entry.completedAt,
    updated_at: entry.updatedAt,
  };
}

function toRemoteEpisodeProgress(
  prog: EpisodeProgressRecord,
  userId: string
): Record<string, unknown> {
  return {
    user_id: userId,
    id: prog.id,
    media_item_id: prog.mediaItemId,
    episode_number: prog.episodeNumber,
    position_seconds: prog.positionSeconds,
    duration_seconds: prog.durationSeconds,
    is_completed: prog.isCompleted,
    watched_via: prog.watchedVia,
    updated_at: prog.updatedAt,
  };
}

function toRemoteWatchHistory(
  event: WatchHistoryRecord,
  userId: string
): Record<string, unknown> {
  return {
    user_id: userId,
    id: event.id,
    media_item_id: event.mediaItemId,
    episode_number: event.episodeNumber,
    action: event.action,
    occurred_at: event.occurredAt,
    updated_at: event.occurredAt,
  };
}

function toRemoteUniTvLink(link: UniTvLinkRecord, userId: string): Record<string, unknown> {
  return {
    user_id: userId,
    media_item_id: link.mediaItemId,
    unitv_vod_id: link.unitvVodId,
    unitv_title: link.unitvTitle,
    unitv_season_tag: link.unitvSeasonTag,
    preferred_audio_or_sub: link.preferredAudioOrSub,
    last_verified_at: link.lastVerifiedAt,
    updated_at: link.lastVerifiedAt,
  };
}

function isTimestampNewer(candidateIso: string, sinceIso: string | null): boolean {
  if (sinceIso === null) {
    return true;
  }
  const candidateMs = Date.parse(candidateIso);
  const sinceMs = Date.parse(sinceIso);
  if (Number.isFinite(candidateMs) && Number.isFinite(sinceMs)) {
    return candidateMs > sinceMs;
  }
  return candidateIso > sinceIso;
}

async function withTransaction<T>(db: DatabaseAdapter, work: () => Promise<T>): Promise<T> {
  await db.execute('BEGIN TRANSACTION');
  try {
    const result = await work();
    await db.execute('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.execute('ROLLBACK');
    } catch {
      // Preserve the primary transaction error.
    }
    throw error;
  }
}

/**
 * Local-First cloud sync engine for Supabase Free Tier.
 * Pushes dirty local records without blocking offline use or losing `dirty = 1`
 * markers when Supabase is paused (HTTP 503/540) or unreachable.
 */
export class SupabaseSyncEngine {
  private syncQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly client: SupabaseSyncClient
  ) {}

  async getDirtyCount(): Promise<number> {
    const rows = await this.db.query<{ total: number }>(
      `SELECT (
        (SELECT COUNT(*) FROM library_entries WHERE dirty = 1) +
        (SELECT COUNT(*) FROM episode_progress WHERE dirty = 1) +
        (SELECT COUNT(*) FROM watch_history WHERE dirty = 1)
      ) AS total`
    );
    return asNumber(rows[0]?.total, 0);
  }

  syncNow(userId: string): Promise<SyncResult> {
    if (!userId || userId.trim().length === 0) {
      return Promise.reject(new Error('userId is required for cloud sync.'));
    }

    const next = this.syncQueue.then(
      () => this.executeSync(userId.trim()),
      () => this.executeSync(userId.trim())
    );
    this.syncQueue = next;
    return next;
  }

  private async safeUpsert(table: string, rows: Record<string, unknown>[]): Promise<string | null> {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      try {
        const { error } = await this.client.upsert(table, batch);
        if (error) {
          return formatErrorMessage(error);
        }
      } catch (err) {
        return extractUnknownErrorMessage(err);
      }
    }
    return null;
  }

  private async safeSelectUpdatedSince(
    table: string,
    userId: string,
    sinceIso: string | null
  ): Promise<{ rows: RawRow[]; errorMessage: string | null }> {
    try {
      const { data, error } = await this.client.selectUpdatedSince(table, userId, sinceIso);
      if (error) {
        return { rows: [], errorMessage: formatErrorMessage(error) };
      }
      return { rows: Array.isArray(data) ? data : [], errorMessage: null };
    } catch (err) {
      return { rows: [], errorMessage: extractUnknownErrorMessage(err) };
    }
  }

  private async loadLastSyncAt(): Promise<string | null> {
    const rows = await this.db.query<{ last_sync_at: string | null }>(
      'SELECT last_sync_at FROM app_settings WHERE id = 1 LIMIT 1'
    );
    return rows.length > 0 ? asNullableString(rows[0].last_sync_at) : null;
  }

  private async loadMediaItemsByIds(mediaIds: string[]): Promise<MediaItemRecord[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    const collected: MediaItemRecord[] = [];
    for (let i = 0; i < mediaIds.length; i += BATCH_SIZE) {
      const chunk = mediaIds.slice(i, i + BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await this.db.query<RawRow>(
        `SELECT * FROM media_items WHERE id IN (${placeholders})`,
        chunk
      );
      for (const row of rows) {
        const mapped = mapMediaItemRow(row);
        if (mapped) {
          collected.push(mapped);
        }
      }
    }
    return collected;
  }

  private async collectDirtyPushBundle(lastSyncAt: string | null): Promise<DirtyPushBundle> {
    const [dirtyEntryRows, dirtyProgressRows, dirtyHistoryRows, allLinkRows] = await Promise.all([
      this.db.query<RawRow>('SELECT * FROM library_entries WHERE dirty = 1'),
      this.db.query<RawRow>('SELECT * FROM episode_progress WHERE dirty = 1'),
      this.db.query<RawRow>('SELECT * FROM watch_history WHERE dirty = 1'),
      this.db.query<RawRow>('SELECT * FROM unitv_links'),
    ]);

    const dirtyEntries = dirtyEntryRows
      .map((row) => mapLibraryEntryRow(row))
      .filter((row): row is LibraryEntryRecord => row !== null);
    const dirtyProgress = dirtyProgressRows
      .map((row) => mapEpisodeProgressRow(row))
      .filter((row): row is EpisodeProgressRecord => row !== null);
    const dirtyHistory = dirtyHistoryRows
      .map((row) => mapWatchHistoryRow(row))
      .filter((row): row is WatchHistoryRecord => row !== null);
    const linksToPush = allLinkRows
      .map(mapUniTvLinkRow)
      .filter((row): row is UniTvLinkRecord => row !== null)
      .filter((link) => isTimestampNewer(link.lastVerifiedAt, lastSyncAt));

    const referencedMediaIds = Array.from(
      new Set([
        ...dirtyEntries.map((e) => e.mediaItemId),
        ...dirtyProgress.map((p) => p.mediaItemId),
        ...dirtyHistory.map((h) => h.mediaItemId),
        ...linksToPush.map((l) => l.mediaItemId),
      ])
    );

    const mediaToPush = await this.loadMediaItemsByIds(referencedMediaIds);
    return { mediaToPush, dirtyEntries, dirtyProgress, dirtyHistory, linksToPush };
  }

  private async clearDirtyFlagsInTransaction(bundle: DirtyPushBundle): Promise<void> {
    // Match updated_at so edits written locally while push was in flight stay dirty = 1.
    for (const entry of bundle.dirtyEntries) {
      await this.db.execute(
        'UPDATE library_entries SET dirty = 0 WHERE id = ? AND updated_at = ?',
        [entry.id, entry.updatedAt]
      );
    }
    for (const prog of bundle.dirtyProgress) {
      await this.db.execute(
        'UPDATE episode_progress SET dirty = 0 WHERE id = ? AND updated_at = ?',
        [prog.id, prog.updatedAt]
      );
    }
    for (const event of bundle.dirtyHistory) {
      await this.db.execute('UPDATE watch_history SET dirty = 0 WHERE id = ?', [event.id]);
    }
  }

  private async fetchRemoteBundle(
    userId: string,
    lastSyncAt: string | null
  ): Promise<{ bundle?: RemotePullBundle; errorMessage?: string }> {
    const [mediaRes, entriesRes, progressRes, historyRes, linksRes] = await Promise.all([
      this.safeSelectUpdatedSince('media_items', userId, lastSyncAt),
      this.safeSelectUpdatedSince('library_entries', userId, lastSyncAt),
      this.safeSelectUpdatedSince('episode_progress', userId, lastSyncAt),
      this.safeSelectUpdatedSince('watch_history', userId, lastSyncAt),
      this.safeSelectUpdatedSince('unitv_links', userId, lastSyncAt),
    ]);

    const pullError =
      mediaRes.errorMessage ??
      entriesRes.errorMessage ??
      progressRes.errorMessage ??
      historyRes.errorMessage ??
      linksRes.errorMessage;
    if (pullError) {
      return { errorMessage: pullError };
    }

    const parseMediaRows = (rows: RawRow[]) =>
      rows
        .map((row) => ({
          record: mapMediaItemRow(row),
          remoteUpdatedAt: asNonEmptyString(row.updated_at),
        }))
        .filter((item): item is { record: MediaItemRecord; remoteUpdatedAt: string | null } =>
          item.record !== null
        );

    let remoteMediaItems = parseMediaRows(mediaRes.rows);
    const remoteEntries = entriesRes.rows
      .map((row) => mapLibraryEntryRow(row, 0))
      .filter((row): row is LibraryEntryRecord => row !== null);
    const remoteProgress = progressRes.rows
      .map((row) => mapEpisodeProgressRow(row, 0))
      .filter((row): row is EpisodeProgressRecord => row !== null);
    const remoteHistory = historyRes.rows
      .map((row) => ({
        record: mapWatchHistoryRow(row, 0),
        remoteUpdatedAt: asNonEmptyString(row.updated_at),
      }))
      .filter((item): item is { record: WatchHistoryRecord; remoteUpdatedAt: string | null } =>
        item.record !== null
      );
    const remoteLinks = linksRes.rows
      .map((row) => ({
        record: mapUniTvLinkRow(row),
        remoteUpdatedAt: asNonEmptyString(row.updated_at),
      }))
      .filter((item): item is { record: UniTvLinkRecord; remoteUpdatedAt: string | null } =>
        item.record !== null
      );

    // Hydrate missing parent media_items once if incremental child rows arrive without cached parents.
    if (lastSyncAt !== null) {
      const childMediaIds = Array.from(
        new Set([
          ...remoteEntries.map((e) => e.mediaItemId),
          ...remoteProgress.map((p) => p.mediaItemId),
          ...remoteHistory.map((h) => h.record.mediaItemId),
          ...remoteLinks.map((l) => l.record.mediaItemId),
        ])
      );
      const pulledIds = new Set(remoteMediaItems.map((m) => m.record.id));
      const unpulledIds = childMediaIds.filter((id) => !pulledIds.has(id));
      if (unpulledIds.length > 0) {
        const localMatches = await this.loadMediaItemsByIds(unpulledIds);
        const localMatchIds = new Set(localMatches.map((m) => m.id));
        if (unpulledIds.some((id) => !localMatchIds.has(id))) {
          const fallbackRes = await this.safeSelectUpdatedSince('media_items', userId, null);
          if (fallbackRes.errorMessage) {
            return { errorMessage: fallbackRes.errorMessage };
          }
          remoteMediaItems = parseMediaRows(fallbackRes.rows);
        }
      }
    }

    return {
      bundle: {
        remoteMediaItems,
        remoteEntries,
        remoteProgress,
        remoteHistory,
        remoteLinks,
      },
    };
  }

  private async hasLocalMediaItem(mediaItemId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      'SELECT id FROM media_items WHERE id = ? LIMIT 1',
      [mediaItemId]
    );
    return rows.length > 0;
  }

  private async resolveLocalMediaMatch(
    remoteItem: MediaItemRecord
  ): Promise<{ existing: MediaItemRecord | null; targetId: string }> {
    // Match by anilist_id first so local media_items.id is preserved across devices.
    const byAnilistRows = await this.db.query<RawRow>(
      'SELECT * FROM media_items WHERE anilist_id = ? LIMIT 1',
      [remoteItem.anilistId]
    );
    const byAnilist = byAnilistRows.length > 0 ? mapMediaItemRow(byAnilistRows[0]) : null;
    if (byAnilist) {
      return { existing: byAnilist, targetId: byAnilist.id };
    }

    const byIdRows = await this.db.query<RawRow>(
      'SELECT * FROM media_items WHERE id = ? LIMIT 1',
      [remoteItem.id]
    );
    const idMatch = byIdRows.length > 0 ? mapMediaItemRow(byIdRows[0]) : null;
    if (idMatch) {
      if (idMatch.anilistId === remoteItem.anilistId) {
        return { existing: idMatch, targetId: idMatch.id };
      }
      return { existing: null, targetId: `anilist:${remoteItem.anilistId}` };
    }

    return { existing: null, targetId: remoteItem.id };
  }

  private async mergeRemoteMediaItem(
    remoteItem: MediaItemRecord,
    remoteUpdatedAt: string | null,
    remoteToLocalMediaId: Map<string, string>
  ): Promise<boolean> {
    const { existing, targetId } = await this.resolveLocalMediaMatch(remoteItem);
    remoteToLocalMediaId.set(remoteItem.id, targetId);

    if (existing) {
      const localComparable = { ...existing, updatedAt: existing.cachedAt };
      const remoteComparable = {
        ...remoteItem,
        id: targetId,
        updatedAt: remoteUpdatedAt ?? remoteItem.cachedAt,
      };
      if (resolveConflictByUpdatedAt(localComparable, remoteComparable) !== remoteComparable) {
        return false;
      }
    }

    await this.db.execute(
      `INSERT INTO media_items (
        id, media_type, anilist_id, mal_id, tmdb_id, title_romaji, title_english, title_pt,
        synopsis, cover_url, banner_url, genres_json, season_year, season_name, episodes_total,
        status_airing, next_airing_at, next_airing_ep, relations_json, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        media_type = excluded.media_type,
        anilist_id = excluded.anilist_id,
        mal_id = excluded.mal_id,
        tmdb_id = excluded.tmdb_id,
        title_romaji = excluded.title_romaji,
        title_english = excluded.title_english,
        title_pt = excluded.title_pt,
        synopsis = excluded.synopsis,
        cover_url = excluded.cover_url,
        banner_url = excluded.banner_url,
        genres_json = excluded.genres_json,
        season_year = excluded.season_year,
        season_name = excluded.season_name,
        episodes_total = excluded.episodes_total,
        status_airing = excluded.status_airing,
        next_airing_at = excluded.next_airing_at,
        next_airing_ep = excluded.next_airing_ep,
        relations_json = excluded.relations_json,
        cached_at = excluded.cached_at`,
      [
        targetId,
        remoteItem.mediaType,
        remoteItem.anilistId,
        remoteItem.malId,
        remoteItem.tmdbId,
        remoteItem.titleRomaji,
        remoteItem.titleEnglish,
        remoteItem.titlePt,
        remoteItem.synopsis,
        remoteItem.coverUrl,
        remoteItem.bannerUrl,
        remoteItem.genresJson,
        remoteItem.seasonYear,
        remoteItem.seasonName,
        remoteItem.episodesTotal,
        remoteItem.statusAiring,
        remoteItem.nextAiringAt,
        remoteItem.nextAiringEp,
        remoteItem.relationsJson,
        remoteItem.cachedAt,
      ]
    );
    return true;
  }

  private async mergeRemoteLibraryEntry(
    remoteEntry: LibraryEntryRecord,
    resolvedMediaId: string
  ): Promise<boolean> {
    const normalized: LibraryEntryRecord = {
      ...remoteEntry,
      mediaItemId: resolvedMediaId,
      dirty: 0,
    };
    const existingRows = await this.db.query<RawRow>(
      'SELECT * FROM library_entries WHERE media_item_id = ? LIMIT 1',
      [resolvedMediaId]
    );
    const existing = existingRows.length > 0 ? mapLibraryEntryRow(existingRows[0]) : null;
    if (existing && resolveConflictByUpdatedAt(existing, normalized) !== normalized) {
      return false;
    }
    const targetId = existing ? existing.id : normalized.id;

    await this.db.execute(
      `INSERT INTO library_entries (
        id, media_item_id, status, personal_score, current_episode, notes,
        rewatch_count, started_at, completed_at, updated_at, dirty
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(media_item_id) DO UPDATE SET
        status = excluded.status,
        personal_score = excluded.personal_score,
        current_episode = excluded.current_episode,
        notes = excluded.notes,
        rewatch_count = excluded.rewatch_count,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at,
        dirty = 0`,
      [
        targetId,
        normalized.mediaItemId,
        normalized.status,
        normalized.personalScore,
        normalized.currentEpisode,
        normalized.notes,
        normalized.rewatchCount,
        normalized.startedAt,
        normalized.completedAt,
        normalized.updatedAt,
      ]
    );
    return true;
  }

  private async mergeRemoteEpisodeProgress(
    remoteProg: EpisodeProgressRecord,
    resolvedMediaId: string
  ): Promise<boolean> {
    const normalized: EpisodeProgressRecord = {
      ...remoteProg,
      mediaItemId: resolvedMediaId,
      dirty: 0,
    };
    const existingRows = await this.db.query<RawRow>(
      'SELECT * FROM episode_progress WHERE media_item_id = ? AND episode_number = ? LIMIT 1',
      [resolvedMediaId, normalized.episodeNumber]
    );
    const existing = existingRows.length > 0 ? mapEpisodeProgressRow(existingRows[0]) : null;
    if (existing && resolveConflictByUpdatedAt(existing, normalized) !== normalized) {
      return false;
    }
    const targetId = existing ? existing.id : normalized.id;

    await this.db.execute(
      `INSERT INTO episode_progress (
        id, media_item_id, episode_number, position_seconds, duration_seconds,
        is_completed, watched_via, updated_at, dirty
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(media_item_id, episode_number) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        is_completed = excluded.is_completed,
        watched_via = excluded.watched_via,
        updated_at = excluded.updated_at,
        dirty = 0`,
      [
        targetId,
        normalized.mediaItemId,
        normalized.episodeNumber,
        normalized.positionSeconds,
        normalized.durationSeconds,
        normalized.isCompleted ? 1 : 0,
        normalized.watchedVia,
        normalized.updatedAt,
      ]
    );
    return true;
  }

  private async mergeRemoteWatchHistory(
    remoteEvent: WatchHistoryRecord,
    remoteUpdatedAt: string | null,
    resolvedMediaId: string
  ): Promise<boolean> {
    const normalized: WatchHistoryRecord = {
      ...remoteEvent,
      mediaItemId: resolvedMediaId,
      dirty: 0,
    };
    const existingRows = await this.db.query<RawRow>(
      'SELECT * FROM watch_history WHERE id = ? LIMIT 1',
      [normalized.id]
    );
    const existing = existingRows.length > 0 ? mapWatchHistoryRow(existingRows[0]) : null;
    if (existing) {
      const localComparable = { ...existing, updatedAt: existing.occurredAt };
      const remoteComparable = {
        ...normalized,
        updatedAt: remoteUpdatedAt ?? normalized.occurredAt,
      };
      if (resolveConflictByUpdatedAt(localComparable, remoteComparable) !== remoteComparable) {
        return false;
      }
    }

    await this.db.execute(
      `INSERT INTO watch_history (
        id, media_item_id, episode_number, action, occurred_at, dirty
      ) VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        media_item_id = excluded.media_item_id,
        episode_number = excluded.episode_number,
        action = excluded.action,
        occurred_at = excluded.occurred_at,
        dirty = 0`,
      [
        normalized.id,
        normalized.mediaItemId,
        normalized.episodeNumber,
        normalized.action,
        normalized.occurredAt,
      ]
    );
    return true;
  }

  private async mergeRemoteUniTvLink(
    remoteLink: UniTvLinkRecord,
    remoteUpdatedAt: string | null,
    resolvedMediaId: string
  ): Promise<boolean> {
    const normalized: UniTvLinkRecord = { ...remoteLink, mediaItemId: resolvedMediaId };
    const existingRows = await this.db.query<RawRow>(
      'SELECT * FROM unitv_links WHERE media_item_id = ? LIMIT 1',
      [resolvedMediaId]
    );
    const existing = existingRows.length > 0 ? mapUniTvLinkRow(existingRows[0]) : null;
    if (existing) {
      const localComparable = { ...existing, updatedAt: existing.lastVerifiedAt };
      const remoteComparable = {
        ...normalized,
        updatedAt: remoteUpdatedAt ?? normalized.lastVerifiedAt,
      };
      if (resolveConflictByUpdatedAt(localComparable, remoteComparable) !== remoteComparable) {
        return false;
      }
    }

    await this.db.execute(
      `INSERT INTO unitv_links (
        media_item_id, unitv_vod_id, unitv_title, unitv_season_tag, preferred_audio_or_sub, last_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_item_id) DO UPDATE SET
        unitv_vod_id = excluded.unitv_vod_id,
        unitv_title = excluded.unitv_title,
        unitv_season_tag = excluded.unitv_season_tag,
        preferred_audio_or_sub = excluded.preferred_audio_or_sub,
        last_verified_at = excluded.last_verified_at`,
      [
        normalized.mediaItemId,
        normalized.unitvVodId,
        normalized.unitvTitle,
        normalized.unitvSeasonTag,
        normalized.preferredAudioOrSub,
        normalized.lastVerifiedAt,
      ]
    );
    return true;
  }

  private async resolveWinningPushBundle(
    localBundle: DirtyPushBundle,
    remoteBundle: RemotePullBundle
  ): Promise<DirtyPushBundle> {
    const remoteToLocalMediaId = new Map<string, string>();
    const remoteMediaByLocalId = new Map<
      string,
      { record: MediaItemRecord; remoteUpdatedAt: string | null }
    >();

    for (const item of remoteBundle.remoteMediaItems) {
      const { targetId } = await this.resolveLocalMediaMatch(item.record);
      remoteToLocalMediaId.set(item.record.id, targetId);
      remoteMediaByLocalId.set(targetId, item);
    }

    const resolveId = (rawMediaId: string) =>
      remoteToLocalMediaId.get(rawMediaId) ?? rawMediaId;

    const remoteEntriesByMediaId = new Map<string, LibraryEntryRecord>();
    for (const entry of remoteBundle.remoteEntries) {
      const localMediaId = resolveId(entry.mediaItemId);
      const normalized: LibraryEntryRecord = { ...entry, mediaItemId: localMediaId };
      const prev = remoteEntriesByMediaId.get(localMediaId);
      remoteEntriesByMediaId.set(
        localMediaId,
        prev ? resolveConflictByUpdatedAt(prev, normalized) : normalized
      );
    }

    const remoteProgressByKey = new Map<string, EpisodeProgressRecord>();
    for (const prog of remoteBundle.remoteProgress) {
      const localMediaId = resolveId(prog.mediaItemId);
      const normalized: EpisodeProgressRecord = { ...prog, mediaItemId: localMediaId };
      const key = `${localMediaId}::${prog.episodeNumber}`;
      const prev = remoteProgressByKey.get(key);
      remoteProgressByKey.set(
        key,
        prev ? resolveConflictByUpdatedAt(prev, normalized) : normalized
      );
    }

    const remoteHistoryById = new Map<
      string,
      { record: WatchHistoryRecord; remoteUpdatedAt: string | null }
    >();
    for (const item of remoteBundle.remoteHistory) {
      remoteHistoryById.set(item.record.id, item);
    }

    const remoteLinksByMediaId = new Map<
      string,
      { record: UniTvLinkRecord; remoteUpdatedAt: string | null }
    >();
    for (const item of remoteBundle.remoteLinks) {
      const localMediaId = resolveId(item.record.mediaItemId);
      remoteLinksByMediaId.set(localMediaId, item);
    }

    const dirtyEntries = localBundle.dirtyEntries.filter((localEntry) => {
      const remote = remoteEntriesByMediaId.get(localEntry.mediaItemId);
      return !remote || resolveConflictByUpdatedAt(localEntry, remote) === localEntry;
    });

    const dirtyProgress = localBundle.dirtyProgress.filter((localProg) => {
      const remote = remoteProgressByKey.get(
        `${localProg.mediaItemId}::${localProg.episodeNumber}`
      );
      return !remote || resolveConflictByUpdatedAt(localProg, remote) === localProg;
    });

    const dirtyHistory = localBundle.dirtyHistory.filter((localEvent) => {
      const remote = remoteHistoryById.get(localEvent.id);
      if (!remote) {
        return true;
      }
      const localComparable = { ...localEvent, updatedAt: localEvent.occurredAt };
      const remoteComparable = {
        ...remote.record,
        updatedAt: remote.remoteUpdatedAt ?? remote.record.occurredAt,
      };
      return resolveConflictByUpdatedAt(localComparable, remoteComparable) === localComparable;
    });

    const linksToPush = localBundle.linksToPush.filter((localLink) => {
      const remote = remoteLinksByMediaId.get(localLink.mediaItemId);
      if (!remote) {
        return true;
      }
      const localComparable = { ...localLink, updatedAt: localLink.lastVerifiedAt };
      const remoteComparable = {
        ...remote.record,
        updatedAt: remote.remoteUpdatedAt ?? remote.record.lastVerifiedAt,
      };
      return resolveConflictByUpdatedAt(localComparable, remoteComparable) === localComparable;
    });

    const winningMediaIds = new Set([
      ...dirtyEntries.map((e) => e.mediaItemId),
      ...dirtyProgress.map((p) => p.mediaItemId),
      ...dirtyHistory.map((h) => h.mediaItemId),
      ...linksToPush.map((l) => l.mediaItemId),
    ]);

    const mediaToPush: MediaItemRecord[] = [];
    for (const localMedia of localBundle.mediaToPush) {
      if (!winningMediaIds.has(localMedia.id)) {
        continue;
      }
      const remote = remoteMediaByLocalId.get(localMedia.id);
      if (!remote) {
        mediaToPush.push(localMedia);
        continue;
      }
      const localComparable = { ...localMedia, updatedAt: localMedia.cachedAt };
      const remoteComparable = {
        ...remote.record,
        updatedAt: remote.remoteUpdatedAt ?? remote.record.cachedAt,
      };
      if (resolveConflictByUpdatedAt(localComparable, remoteComparable) === localComparable) {
        mediaToPush.push(localMedia);
      } else if (remote.record.id !== localMedia.id) {
        // Remote already holds newer metadata under a different id; ensure FK parent exists for local id.
        mediaToPush.push({ ...remote.record, id: localMedia.id });
      }
    }

    return { mediaToPush, dirtyEntries, dirtyProgress, dirtyHistory, linksToPush };
  }

  private async commitSyncState(
    pushedBundle: DirtyPushBundle,
    remoteBundle: RemotePullBundle,
    syncTimestamp: string
  ): Promise<number> {
    return withTransaction(this.db, async () => {
      await this.clearDirtyFlagsInTransaction(pushedBundle);

      let applied = 0;
      const remoteToLocalMediaId = new Map<string, string>();

      for (const { record, remoteUpdatedAt } of remoteBundle.remoteMediaItems) {
        if (await this.mergeRemoteMediaItem(record, remoteUpdatedAt, remoteToLocalMediaId)) {
          applied += 1;
        }
      }

      const resolveParentId = async (rawMediaId: string): Promise<string | null> => {
        const resolved = remoteToLocalMediaId.get(rawMediaId) ?? rawMediaId;
        return (await this.hasLocalMediaItem(resolved)) ? resolved : null;
      };

      for (const entry of remoteBundle.remoteEntries) {
        const resolvedMediaId = await resolveParentId(entry.mediaItemId);
        if (resolvedMediaId && (await this.mergeRemoteLibraryEntry(entry, resolvedMediaId))) {
          applied += 1;
        }
      }

      for (const prog of remoteBundle.remoteProgress) {
        const resolvedMediaId = await resolveParentId(prog.mediaItemId);
        if (resolvedMediaId && (await this.mergeRemoteEpisodeProgress(prog, resolvedMediaId))) {
          applied += 1;
        }
      }

      for (const { record, remoteUpdatedAt } of remoteBundle.remoteHistory) {
        const resolvedMediaId = await resolveParentId(record.mediaItemId);
        if (
          resolvedMediaId &&
          (await this.mergeRemoteWatchHistory(record, remoteUpdatedAt, resolvedMediaId))
        ) {
          applied += 1;
        }
      }

      for (const { record, remoteUpdatedAt } of remoteBundle.remoteLinks) {
        const resolvedMediaId = await resolveParentId(record.mediaItemId);
        if (
          resolvedMediaId &&
          (await this.mergeRemoteUniTvLink(record, remoteUpdatedAt, resolvedMediaId))
        ) {
          applied += 1;
        }
      }

      await this.db.execute(
        `INSERT INTO app_settings (
          id, unitv_portal_url, prefer_max_quality, hide_completed_in_explore, tmdb_api_key, last_sync_at
        ) VALUES (1, ?, 1, 0, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_sync_at = excluded.last_sync_at`,
        [DEFAULT_UNITV_PORTAL_URL, syncTimestamp]
      );

      return applied;
    });
  }

  private async executeSync(userId: string): Promise<SyncResult> {
    const syncTimestamp = new Date().toISOString();
    const lastSyncAt = await this.loadLastSyncAt();
    const localBundle = await this.collectDirtyPushBundle(lastSyncAt);

    // Pull first and resolve LWW conflicts before pushing so stale offline edits never overwrite newer remote state.
    const pullResult = await this.fetchRemoteBundle(userId, lastSyncAt);
    if (pullResult.errorMessage || !pullResult.bundle) {
      return {
        status: 'DEFERRED_OFFLINE_OR_PAUSED',
        pushedCount: 0,
        pulledCount: 0,
        errorMessage: pullResult.errorMessage ?? 'Failed to pull remote updates',
      };
    }

    const winningPushBundle = await this.resolveWinningPushBundle(
      localBundle,
      pullResult.bundle
    );

    // Push media_items first for FK integrity, followed by winning user-owned rows.
    const pushBatches: Array<{ table: string; rows: Record<string, unknown>[] }> = [
      {
        table: 'media_items',
        rows: winningPushBundle.mediaToPush.map((item) => toRemoteMediaItem(item, userId)),
      },
      {
        table: 'library_entries',
        rows: winningPushBundle.dirtyEntries.map((entry) =>
          toRemoteLibraryEntry(entry, userId)
        ),
      },
      {
        table: 'episode_progress',
        rows: winningPushBundle.dirtyProgress.map((prog) =>
          toRemoteEpisodeProgress(prog, userId)
        ),
      },
      {
        table: 'watch_history',
        rows: winningPushBundle.dirtyHistory.map((event) =>
          toRemoteWatchHistory(event, userId)
        ),
      },
      {
        table: 'unitv_links',
        rows: winningPushBundle.linksToPush.map((link) => toRemoteUniTvLink(link, userId)),
      },
    ];

    let pushedCount = 0;
    for (const batch of pushBatches) {
      const errorMessage = await this.safeUpsert(batch.table, batch.rows);
      if (errorMessage) {
        return {
          status: 'DEFERRED_OFFLINE_OR_PAUSED',
          pushedCount: 0,
          pulledCount: 0,
          errorMessage,
        };
      }
      pushedCount += batch.rows.length;
    }

    const pulledCount = await this.commitSyncState(
      winningPushBundle,
      pullResult.bundle,
      syncTimestamp
    );
    return {
      status: 'SYNCED',
      pushedCount,
      pulledCount,
    };
  }
}
