import {
  AppSettingsRecord,
  DatabaseAdapter,
  DEFAULT_APP_SETTINGS,
  EpisodeProgressRecord,
  LibraryEntryRecord,
  MediaItemRecord,
  MediaType,
  UniTvLinkRecord,
  WATCH_STATUSES,
  WatchHistoryRecord,
  WatchStatus,
} from './schema';

const EPISODE_COMPLETION_THRESHOLD = 0.85;

let fallbackIdCounter = 0;

function generateId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  fallbackIdCounter += 1;
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  const seq = fallbackIdCounter.toString(16).padStart(8, '0');
  return `${Date.now().toString(16).padStart(12, '0').slice(-8)}-${seq.slice(0, 4)}-4${seq.slice(4, 7)}-8${rand.slice(0, 3)}-${rand}${seq.slice(0, 4)}`;
}

type RawRow = Record<string, unknown>;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function asNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? fallback);
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function mapMediaItemRow(row: RawRow, prefix = ''): MediaItemRecord {
  return {
    id: asString(row[`${prefix}id`]),
    mediaType: asString(row[`${prefix}media_type`], 'ANIME') as MediaType,
    anilistId: asNumber(row[`${prefix}anilist_id`]),
    malId: asNullableNumber(row[`${prefix}mal_id`]),
    tmdbId: asNullableNumber(row[`${prefix}tmdb_id`]),
    titleRomaji: asString(row[`${prefix}title_romaji`]),
    titleEnglish: asNullableString(row[`${prefix}title_english`]),
    titlePt: asNullableString(row[`${prefix}title_pt`]),
    synopsis: asNullableString(row[`${prefix}synopsis`]),
    coverUrl: asString(row[`${prefix}cover_url`]),
    bannerUrl: asNullableString(row[`${prefix}banner_url`]),
    genresJson: asString(row[`${prefix}genres_json`], '[]'),
    seasonYear: asNullableNumber(row[`${prefix}season_year`]),
    seasonName: asNullableString(row[`${prefix}season_name`]),
    episodesTotal: asNullableNumber(row[`${prefix}episodes_total`]),
    statusAiring: asString(row[`${prefix}status_airing`], 'UNKNOWN'),
    nextAiringAt: asNullableNumber(row[`${prefix}next_airing_at`]),
    nextAiringEp: asNullableNumber(row[`${prefix}next_airing_ep`]),
    relationsJson: asString(row[`${prefix}relations_json`], '[]'),
    cachedAt: asString(row[`${prefix}cached_at`]),
  };
}

function mapLibraryEntryRow(row: RawRow, prefix = ''): LibraryEntryRecord {
  return {
    id: asString(row[`${prefix}id`]),
    mediaItemId: asString(row[`${prefix}media_item_id`]),
    status: asString(row[`${prefix}status`]) as WatchStatus,
    personalScore: asNullableNumber(row[`${prefix}personal_score`]),
    currentEpisode: asNumber(row[`${prefix}current_episode`], 0),
    notes: asString(row[`${prefix}notes`], ''),
    rewatchCount: asNumber(row[`${prefix}rewatch_count`], 0),
    startedAt: asNullableString(row[`${prefix}started_at`]),
    completedAt: asNullableString(row[`${prefix}completed_at`]),
    updatedAt: asString(row[`${prefix}updated_at`]),
    dirty: asNumber(row[`${prefix}dirty`], 1),
  };
}

function mapEpisodeProgressRow(row: RawRow): EpisodeProgressRecord {
  return {
    id: asString(row.id),
    mediaItemId: asString(row.media_item_id),
    episodeNumber: asNumber(row.episode_number),
    positionSeconds: asNumber(row.position_seconds, 0),
    durationSeconds: asNumber(row.duration_seconds, 0),
    isCompleted: asBoolean(row.is_completed),
    watchedVia: asString(row.watched_via, 'APP_PLAYER') as 'APP_PLAYER' | 'MANUAL',
    updatedAt: asString(row.updated_at),
    dirty: asNumber(row.dirty, 1),
  };
}

function mapWatchHistoryRow(row: RawRow): WatchHistoryRecord {
  return {
    id: asString(row.id),
    mediaItemId: asString(row.media_item_id),
    episodeNumber: asNumber(row.episode_number),
    action: asString(row.action) as WatchHistoryRecord['action'],
    occurredAt: asString(row.occurred_at),
    dirty: asNumber(row.dirty, 1),
  };
}

function mapUniTvLinkRow(row: RawRow): UniTvLinkRecord {
  return {
    mediaItemId: asString(row.media_item_id),
    unitvVodId: asString(row.unitv_vod_id),
    unitvTitle: asString(row.unitv_title),
    unitvSeasonTag: asNullableString(row.unitv_season_tag),
    preferredAudioOrSub: asNullableString(row.preferred_audio_or_sub),
    lastVerifiedAt: asString(row.last_verified_at),
  };
}

function parseGenresSafe(genresJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(genresJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export class LibraryRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async upsertMediaItem(item: MediaItemRecord): Promise<void> {
    const existingByAnilist = await this.db.query<{ id: string }>(
      'SELECT id FROM media_items WHERE anilist_id = ? LIMIT 1',
      [item.anilistId]
    );
    const targetId = existingByAnilist.length > 0 ? existingByAnilist[0].id : item.id;

    await this.db.execute(
      `INSERT INTO media_items (
        id,
        media_type,
        anilist_id,
        mal_id,
        tmdb_id,
        title_romaji,
        title_english,
        title_pt,
        synopsis,
        cover_url,
        banner_url,
        genres_json,
        season_year,
        season_name,
        episodes_total,
        status_airing,
        next_airing_at,
        next_airing_ep,
        relations_json,
        cached_at
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
        item.mediaType,
        item.anilistId,
        item.malId,
        item.tmdbId,
        item.titleRomaji,
        item.titleEnglish,
        item.titlePt,
        item.synopsis,
        item.coverUrl,
        item.bannerUrl,
        item.genresJson,
        item.seasonYear,
        item.seasonName,
        item.episodesTotal,
        item.statusAiring,
        item.nextAiringAt,
        item.nextAiringEp,
        item.relationsJson,
        item.cachedAt,
      ]
    );
  }

  async getMediaItemById(id: string): Promise<MediaItemRecord | null> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM media_items WHERE id = ? LIMIT 1',
      [id]
    );
    return rows.length > 0 ? mapMediaItemRow(rows[0]) : null;
  }

  async getMediaItemByAnilistId(anilistId: number): Promise<MediaItemRecord | null> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM media_items WHERE anilist_id = ? LIMIT 1',
      [anilistId]
    );
    return rows.length > 0 ? mapMediaItemRow(rows[0]) : null;
  }

  async getAllMediaItems(): Promise<MediaItemRecord[]> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM media_items ORDER BY title_romaji ASC'
    );
    return rows.map((row) => mapMediaItemRow(row));
  }

  private async requireMediaItem(mediaItemId: string): Promise<MediaItemRecord> {
    const media = await this.getMediaItemById(mediaItemId);
    if (!media) {
      throw new Error(`Media item not found: ${mediaItemId}`);
    }
    return media;
  }

  private async getLibraryEntryByMediaId(mediaItemId: string): Promise<LibraryEntryRecord | null> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM library_entries WHERE media_item_id = ? LIMIT 1',
      [mediaItemId]
    );
    return rows.length > 0 ? mapLibraryEntryRow(rows[0]) : null;
  }

  private async ensureLibraryEntry(
    mediaItemId: string,
    defaultStatus: WatchStatus,
    now: string
  ): Promise<LibraryEntryRecord> {
    await this.requireMediaItem(mediaItemId);
    const existing = await this.getLibraryEntryByMediaId(mediaItemId);
    if (existing) {
      return existing;
    }

    const created: LibraryEntryRecord = {
      id: generateId(),
      mediaItemId,
      status: defaultStatus,
      personalScore: null,
      currentEpisode: 0,
      notes: '',
      rewatchCount: defaultStatus === 'REWATCHING' ? 1 : 0,
      startedAt:
        defaultStatus === 'WATCHING' ||
        defaultStatus === 'REWATCHING' ||
        defaultStatus === 'COMPLETED'
          ? now
          : null,
      completedAt: defaultStatus === 'COMPLETED' ? now : null,
      updatedAt: now,
      dirty: 1,
    };

    await this.db.execute(
      `INSERT INTO library_entries (
        id, media_item_id, status, personal_score, current_episode, notes,
        rewatch_count, started_at, completed_at, updated_at, dirty
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        created.id,
        created.mediaItemId,
        created.status,
        created.personalScore,
        created.currentEpisode,
        created.notes,
        created.rewatchCount,
        created.startedAt,
        created.completedAt,
        created.updatedAt,
        created.dirty,
      ]
    );

    return created;
  }

  private async recordWatchHistory(
    mediaItemId: string,
    episodeNumber: number,
    action: WatchHistoryRecord['action'],
    occurredAt: string
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO watch_history (id, media_item_id, episode_number, action, occurred_at, dirty)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [generateId(), mediaItemId, episodeNumber, action, occurredAt]
    );
  }

  async setLibraryStatus(mediaItemId: string, status: WatchStatus): Promise<LibraryEntryRecord> {
    if (!WATCH_STATUSES.includes(status)) {
      throw new Error(`Invalid watch status: ${String(status)}`);
    }

    await this.requireMediaItem(mediaItemId);
    const now = new Date().toISOString();
    const existing = await this.getLibraryEntryByMediaId(mediaItemId);

    if (!existing) {
      const entry = await this.ensureLibraryEntry(mediaItemId, status, now);
      await this.recordWatchHistory(mediaItemId, entry.currentEpisode, 'STATUS_CHANGED', now);
      return entry;
    }

    const startedAt =
      existing.startedAt ??
      (status === 'WATCHING' || status === 'REWATCHING' || status === 'COMPLETED' ? now : null);
    const completedAt =
      status === 'COMPLETED'
        ? existing.completedAt ?? now
        : status === 'REWATCHING'
          ? existing.completedAt
          : null;
    const rewatchCount =
      existing.status !== 'REWATCHING' && status === 'REWATCHING'
        ? existing.rewatchCount + 1
        : existing.rewatchCount;

    await this.db.execute(
      `UPDATE library_entries
       SET status = ?, rewatch_count = ?, started_at = ?, completed_at = ?, updated_at = ?, dirty = 1
       WHERE media_item_id = ?`,
      [status, rewatchCount, startedAt, completedAt, now, mediaItemId]
    );

    if (existing.status !== status) {
      await this.recordWatchHistory(mediaItemId, existing.currentEpisode, 'STATUS_CHANGED', now);
    }

    return {
      ...existing,
      status,
      rewatchCount,
      startedAt,
      completedAt,
      updatedAt: now,
      dirty: 1,
    };
  }

  async updatePersonalScore(mediaItemId: string, score: number | null): Promise<void> {
    if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10)) {
      throw new Error('Personal score must be null or a finite number between 0 and 10.');
    }

    const now = new Date().toISOString();
    await this.ensureLibraryEntry(mediaItemId, 'PLAN_TO_WATCH', now);

    await this.db.execute(
      `UPDATE library_entries
       SET personal_score = ?, updated_at = ?, dirty = 1
       WHERE media_item_id = ?`,
      [score, now, mediaItemId]
    );
  }

  async updateNotes(mediaItemId: string, notes: string): Promise<void> {
    const now = new Date().toISOString();
    await this.ensureLibraryEntry(mediaItemId, 'PLAN_TO_WATCH', now);

    await this.db.execute(
      `UPDATE library_entries
       SET notes = ?, updated_at = ?, dirty = 1
       WHERE media_item_id = ?`,
      [notes, now, mediaItemId]
    );
  }

  private async upsertEpisodeProgress(params: {
    mediaItemId: string;
    episodeNumber: number;
    positionSeconds: number;
    durationSeconds: number;
    isCompleted: boolean;
    watchedVia: 'APP_PLAYER' | 'MANUAL';
    updatedAt: string;
    existingId?: string;
  }): Promise<void> {
    const id = params.existingId ?? generateId();
    await this.db.execute(
      `INSERT INTO episode_progress (
        id, media_item_id, episode_number, position_seconds, duration_seconds,
        is_completed, watched_via, updated_at, dirty
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(media_item_id, episode_number) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        is_completed = excluded.is_completed,
        watched_via = excluded.watched_via,
        updated_at = excluded.updated_at,
        dirty = 1`,
      [
        id,
        params.mediaItemId,
        params.episodeNumber,
        params.positionSeconds,
        params.durationSeconds,
        params.isCompleted ? 1 : 0,
        params.watchedVia,
        params.updatedAt,
      ]
    );
  }

  private async getSingleEpisodeProgress(
    mediaItemId: string,
    episodeNumber: number
  ): Promise<EpisodeProgressRecord | null> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM episode_progress WHERE media_item_id = ? AND episode_number = ? LIMIT 1',
      [mediaItemId, episodeNumber]
    );
    return rows.length > 0 ? mapEpisodeProgressRow(rows[0]) : null;
  }

  async recordPlaybackProgress(input: {
    mediaItemId: string;
    episodeNumber: number;
    positionSeconds: number;
    durationSeconds: number;
    watchedVia: 'APP_PLAYER' | 'MANUAL';
  }): Promise<{
    episodeCompleted: boolean;
    nextEpisodeSuggestion?: number;
    seasonCompletedPrompt: boolean;
  }> {
    if (!Number.isInteger(input.episodeNumber) || input.episodeNumber < 1) {
      throw new Error(`Invalid episodeNumber: ${input.episodeNumber}`);
    }
    if (input.positionSeconds < 0 || input.durationSeconds < 0) {
      throw new Error('Playback position and duration must be non-negative.');
    }

    const media = await this.requireMediaItem(input.mediaItemId);
    const now = new Date().toISOString();
    const existingProgress = await this.getSingleEpisodeProgress(
      input.mediaItemId,
      input.episodeNumber
    );

    const episodeCompleted =
      input.durationSeconds > 0 &&
      input.positionSeconds / input.durationSeconds >= EPISODE_COMPLETION_THRESHOLD;
    const nextIsCompleted = Boolean(existingProgress?.isCompleted) || episodeCompleted;

    await this.upsertEpisodeProgress({
      mediaItemId: input.mediaItemId,
      episodeNumber: input.episodeNumber,
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds,
      isCompleted: nextIsCompleted,
      watchedVia: input.watchedVia,
      updatedAt: now,
      existingId: existingProgress?.id,
    });

    if (!existingProgress && !episodeCompleted && input.positionSeconds > 0) {
      await this.recordWatchHistory(input.mediaItemId, input.episodeNumber, 'STARTED', now);
    } else if (episodeCompleted && !existingProgress?.isCompleted) {
      await this.recordWatchHistory(input.mediaItemId, input.episodeNumber, 'COMPLETED', now);
    }

    const entry = await this.ensureLibraryEntry(input.mediaItemId, 'WATCHING', now);
    const nextCurrentEpisode = episodeCompleted
      ? Math.max(entry.currentEpisode, input.episodeNumber)
      : entry.currentEpisode;

    await this.db.execute(
      `UPDATE library_entries
       SET current_episode = ?, updated_at = ?, dirty = 1
       WHERE media_item_id = ?`,
      [nextCurrentEpisode, now, input.mediaItemId]
    );

    const seasonCompletedPrompt =
      episodeCompleted &&
      media.episodesTotal !== null &&
      input.episodeNumber >= media.episodesTotal;

    if (episodeCompleted && !seasonCompletedPrompt) {
      return {
        episodeCompleted: true,
        nextEpisodeSuggestion: input.episodeNumber + 1,
        seasonCompletedPrompt: false,
      };
    }

    return {
      episodeCompleted,
      seasonCompletedPrompt,
    };
  }

  async toggleEpisodeManual(
    mediaItemId: string,
    episodeNumber: number,
    completed: boolean
  ): Promise<{ seasonCompletedPrompt: boolean }> {
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
      throw new Error(`Invalid episodeNumber: ${episodeNumber}`);
    }

    const media = await this.requireMediaItem(mediaItemId);
    const now = new Date().toISOString();
    const existingProgress = await this.getSingleEpisodeProgress(mediaItemId, episodeNumber);

    await this.upsertEpisodeProgress({
      mediaItemId,
      episodeNumber,
      positionSeconds: existingProgress?.positionSeconds ?? 0,
      durationSeconds: existingProgress?.durationSeconds ?? 0,
      isCompleted: completed,
      watchedVia: 'MANUAL',
      updatedAt: now,
      existingId: existingProgress?.id,
    });

    if (completed && !existingProgress?.isCompleted) {
      await this.recordWatchHistory(mediaItemId, episodeNumber, 'COMPLETED', now);
    }

    const entry = await this.ensureLibraryEntry(mediaItemId, 'WATCHING', now);
    let nextCurrentEpisode = entry.currentEpisode;

    if (completed) {
      nextCurrentEpisode = Math.max(entry.currentEpisode, episodeNumber);
    } else if (entry.currentEpisode === episodeNumber) {
      const maxRows = await this.db.query<{ maxEp: number | null }>(
        'SELECT MAX(episode_number) AS maxEp FROM episode_progress WHERE media_item_id = ? AND is_completed = 1',
        [mediaItemId]
      );
      const maxCompleted = maxRows[0]?.maxEp ?? null;
      nextCurrentEpisode =
        maxCompleted !== null ? maxCompleted : Math.max(0, episodeNumber - 1);
    }

    await this.db.execute(
      `UPDATE library_entries
       SET current_episode = ?, updated_at = ?, dirty = 1
       WHERE media_item_id = ?`,
      [nextCurrentEpisode, now, mediaItemId]
    );

    const seasonCompletedPrompt =
      completed && media.episodesTotal !== null && episodeNumber >= media.episodesTotal;

    return { seasonCompletedPrompt };
  }

  async getLibraryByStatus(
    status: WatchStatus
  ): Promise<Array<LibraryEntryRecord & { media: MediaItemRecord }>> {
    const rows = await this.db.query<RawRow>(
      `SELECT
        le.id AS entry_id,
        le.media_item_id AS entry_media_item_id,
        le.status AS entry_status,
        le.personal_score AS entry_personal_score,
        le.current_episode AS entry_current_episode,
        le.notes AS entry_notes,
        le.rewatch_count AS entry_rewatch_count,
        le.started_at AS entry_started_at,
        le.completed_at AS entry_completed_at,
        le.updated_at AS entry_updated_at,
        le.dirty AS entry_dirty,
        m.id AS media_id,
        m.media_type AS media_media_type,
        m.anilist_id AS media_anilist_id,
        m.mal_id AS media_mal_id,
        m.tmdb_id AS media_tmdb_id,
        m.title_romaji AS media_title_romaji,
        m.title_english AS media_title_english,
        m.title_pt AS media_title_pt,
        m.synopsis AS media_synopsis,
        m.cover_url AS media_cover_url,
        m.banner_url AS media_banner_url,
        m.genres_json AS media_genres_json,
        m.season_year AS media_season_year,
        m.season_name AS media_season_name,
        m.episodes_total AS media_episodes_total,
        m.status_airing AS media_status_airing,
        m.next_airing_at AS media_next_airing_at,
        m.next_airing_ep AS media_next_airing_ep,
        m.relations_json AS media_relations_json,
        m.cached_at AS media_cached_at
      FROM library_entries le
      INNER JOIN media_items m ON m.id = le.media_item_id
      WHERE le.status = ?
      ORDER BY le.updated_at DESC`,
      [status]
    );

    return rows.map((row) => ({
      ...mapLibraryEntryRow(row, 'entry_'),
      media: mapMediaItemRow(row, 'media_'),
    }));
  }

  async getAllLibraryEntries(): Promise<LibraryEntryRecord[]> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM library_entries ORDER BY updated_at DESC'
    );
    return rows.map((row) => mapLibraryEntryRow(row));
  }

  async getEpisodeProgressList(mediaItemId: string): Promise<EpisodeProgressRecord[]> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM episode_progress WHERE media_item_id = ? ORDER BY episode_number ASC',
      [mediaItemId]
    );
    return rows.map(mapEpisodeProgressRow);
  }

  async getAllEpisodeProgress(): Promise<EpisodeProgressRecord[]> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM episode_progress ORDER BY media_item_id ASC, episode_number ASC'
    );
    return rows.map(mapEpisodeProgressRow);
  }

  async getAllUniTvLinks(): Promise<UniTvLinkRecord[]> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM unitv_links ORDER BY media_item_id ASC'
    );
    return rows.map(mapUniTvLinkRow);
  }

  async getWatchHistory(mediaItemId?: string): Promise<WatchHistoryRecord[]> {
    const rows = mediaItemId
      ? await this.db.query<RawRow>(
          'SELECT * FROM watch_history WHERE media_item_id = ? ORDER BY occurred_at DESC',
          [mediaItemId]
        )
      : await this.db.query<RawRow>('SELECT * FROM watch_history ORDER BY occurred_at DESC');
    return rows.map(mapWatchHistoryRow);
  }

  pickRandomPlanToWatch(
    entries: Array<LibraryEntryRecord & { media: MediaItemRecord }>,
    genreFilter?: string
  ): (LibraryEntryRecord & { media: MediaItemRecord }) | null {
    const normalizedGenre = genreFilter?.trim().toLowerCase() ?? '';
    const candidates = entries.filter((entry) => {
      if (entry.status !== 'PLAN_TO_WATCH') {
        return false;
      }
      if (!normalizedGenre) {
        return true;
      }
      const genres = parseGenresSafe(entry.media.genresJson);
      return genres.some((genre) => genre.trim().toLowerCase() === normalizedGenre);
    });

    if (candidates.length === 0) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * candidates.length);
    return candidates[randomIndex];
  }

  async getSettings(): Promise<AppSettingsRecord> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM app_settings WHERE id = 1 LIMIT 1'
    );
    if (rows.length === 0) {
      return { ...DEFAULT_APP_SETTINGS };
    }

    const row = rows[0];
    return {
      unitvPortalUrl: asString(row.unitv_portal_url, DEFAULT_APP_SETTINGS.unitvPortalUrl),
      preferMaxQuality: asBoolean(row.prefer_max_quality),
      hideCompletedInExplore: asBoolean(row.hide_completed_in_explore),
      tmdbApiKey: asNullableString(row.tmdb_api_key),
      lastSyncAt: asNullableString(row.last_sync_at),
    };
  }

  async saveSettings(patch: Partial<AppSettingsRecord>): Promise<AppSettingsRecord> {
    const current = await this.getSettings();
    const nextUrl =
      patch.unitvPortalUrl !== undefined ? patch.unitvPortalUrl.trim() : current.unitvPortalUrl;
    if (!nextUrl) {
      throw new Error('unitvPortalUrl cannot be empty.');
    }

    const merged: AppSettingsRecord = {
      unitvPortalUrl: nextUrl,
      preferMaxQuality: patch.preferMaxQuality ?? current.preferMaxQuality,
      hideCompletedInExplore:
        patch.hideCompletedInExplore ?? current.hideCompletedInExplore,
      tmdbApiKey: patch.tmdbApiKey !== undefined ? patch.tmdbApiKey : current.tmdbApiKey,
      lastSyncAt: patch.lastSyncAt !== undefined ? patch.lastSyncAt : current.lastSyncAt,
    };

    await this.db.execute(
      `INSERT INTO app_settings (
        id, unitv_portal_url, prefer_max_quality, hide_completed_in_explore, tmdb_api_key, last_sync_at
      ) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        unitv_portal_url = excluded.unitv_portal_url,
        prefer_max_quality = excluded.prefer_max_quality,
        hide_completed_in_explore = excluded.hide_completed_in_explore,
        tmdb_api_key = excluded.tmdb_api_key,
        last_sync_at = excluded.last_sync_at`,
      [
        merged.unitvPortalUrl,
        merged.preferMaxQuality ? 1 : 0,
        merged.hideCompletedInExplore ? 1 : 0,
        merged.tmdbApiKey,
        merged.lastSyncAt,
      ]
    );

    return merged;
  }

  async saveUniTvLink(link: UniTvLinkRecord): Promise<void> {
    await this.requireMediaItem(link.mediaItemId);
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
        link.mediaItemId,
        link.unitvVodId,
        link.unitvTitle,
        link.unitvSeasonTag,
        link.preferredAudioOrSub,
        link.lastVerifiedAt,
      ]
    );
  }

  async getUniTvLink(mediaItemId: string): Promise<UniTvLinkRecord | null> {
    const rows = await this.db.query<RawRow>(
      'SELECT * FROM unitv_links WHERE media_item_id = ? LIMIT 1',
      [mediaItemId]
    );
    return rows.length > 0 ? mapUniTvLinkRow(rows[0]) : null;
  }
}
