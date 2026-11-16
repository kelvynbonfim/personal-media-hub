import { LibraryRepository } from './library-repository';
import {
  AppSettingsRecord,
  DatabaseAdapter,
  DEFAULT_APP_SETTINGS,
  EpisodeProgressRecord,
  LibraryEntryRecord,
  MediaItemRecord,
  UniTvLinkRecord,
  WATCH_STATUSES,
  WatchHistoryRecord,
  WatchStatus,
} from './schema';

export interface BackupPayloadV1 {
  version: 1;
  exportedAt: string;
  mediaItems: MediaItemRecord[];
  libraryEntries: LibraryEntryRecord[];
  episodeProgress: EpisodeProgressRecord[];
  watchHistory: WatchHistoryRecord[];
  unitvLinks: UniTvLinkRecord[];
  settings: AppSettingsRecord;
}

const VALID_HISTORY_ACTIONS = new Set<WatchHistoryRecord['action']>([
  'STARTED',
  'COMPLETED',
  'STATUS_CHANGED',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid backup field "${fieldName}": expected non-empty string.`);
  }
  return value;
}

function parseNullableFiniteNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid backup field "${fieldName}": expected null or a finite number.`);
  }
  return value;
}

function parseNonNegativeFiniteNumber(
  value: unknown,
  fieldName: string,
  defaultValue: number
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid backup field "${fieldName}": expected a finite non-negative number.`
    );
  }
  return value;
}

function parseNonNegativeInteger(
  value: unknown,
  fieldName: string,
  defaultValue: number
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid backup field "${fieldName}": expected a non-negative integer.`);
  }
  return value;
}

function parseDirtyFlag(value: unknown, fieldName: string): number {
  if (value === undefined) {
    return 1;
  }
  if (value !== 0 && value !== 1) {
    throw new Error(`Invalid backup field "${fieldName}": expected 0 or 1.`);
  }
  return value;
}

function parsePersonalScore(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
    throw new Error(`Invalid backup payload: ${fieldName} must be null or a number in 0..10.`);
  }
  return value;
}

function parseArrayField<T>(
  raw: unknown,
  fieldName: string,
  itemParser: (item: Record<string, unknown>, idx: number) => T
): T[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid backup payload: "${fieldName}" must be an array.`);
  }
  return raw.map((item, idx) => {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid backup payload: ${fieldName}[${idx}] must be an object.`);
    }
    return itemParser(item, idx);
  });
}

function parseBackupSettings(rawSettings: unknown): AppSettingsRecord {
  if (!isPlainObject(rawSettings)) {
    throw new Error('Invalid backup payload: "settings" must be an object.');
  }
  if (typeof rawSettings.preferMaxQuality !== 'boolean') {
    throw new Error('Invalid backup payload: settings.preferMaxQuality must be boolean.');
  }
  if (typeof rawSettings.hideCompletedInExplore !== 'boolean') {
    throw new Error('Invalid backup payload: settings.hideCompletedInExplore must be boolean.');
  }

  const unitvPortalUrl =
    typeof rawSettings.unitvPortalUrl === 'string' && rawSettings.unitvPortalUrl.trim().length > 0
      ? rawSettings.unitvPortalUrl.trim()
      : DEFAULT_APP_SETTINGS.unitvPortalUrl;

  return {
    unitvPortalUrl,
    preferMaxQuality: rawSettings.preferMaxQuality,
    hideCompletedInExplore: rawSettings.hideCompletedInExplore,
    tmdbApiKey: typeof rawSettings.tmdbApiKey === 'string' ? rawSettings.tmdbApiKey : null,
    lastSyncAt: typeof rawSettings.lastSyncAt === 'string' ? rawSettings.lastSyncAt : null,
  };
}

function parseBackupMediaItem(item: Record<string, unknown>, idx: number): MediaItemRecord {
  const id = assertNonEmptyString(item.id, `mediaItems[${idx}].id`);
  if (typeof item.anilistId !== 'number' || !Number.isInteger(item.anilistId)) {
    throw new Error(`Invalid backup payload: mediaItems[${idx}].anilistId must be an integer.`);
  }
  const titleRomaji = assertNonEmptyString(item.titleRomaji, `mediaItems[${idx}].titleRomaji`);
  const mediaType =
    item.mediaType === 'MOVIE' || item.mediaType === 'SERIES' ? item.mediaType : 'ANIME';

  return {
    id,
    mediaType,
    anilistId: item.anilistId,
    malId: parseNullableFiniteNumber(item.malId, `mediaItems[${idx}].malId`),
    tmdbId: parseNullableFiniteNumber(item.tmdbId, `mediaItems[${idx}].tmdbId`),
    titleRomaji,
    titleEnglish: typeof item.titleEnglish === 'string' ? item.titleEnglish : null,
    titlePt: typeof item.titlePt === 'string' ? item.titlePt : null,
    synopsis: typeof item.synopsis === 'string' ? item.synopsis : null,
    coverUrl: typeof item.coverUrl === 'string' ? item.coverUrl : '',
    bannerUrl: typeof item.bannerUrl === 'string' ? item.bannerUrl : null,
    genresJson: typeof item.genresJson === 'string' ? item.genresJson : '[]',
    seasonYear: parseNullableFiniteNumber(item.seasonYear, `mediaItems[${idx}].seasonYear`),
    seasonName: typeof item.seasonName === 'string' ? item.seasonName : null,
    episodesTotal: parseNullableFiniteNumber(item.episodesTotal, `mediaItems[${idx}].episodesTotal`),
    statusAiring: typeof item.statusAiring === 'string' ? item.statusAiring : 'UNKNOWN',
    nextAiringAt: parseNullableFiniteNumber(item.nextAiringAt, `mediaItems[${idx}].nextAiringAt`),
    nextAiringEp: parseNullableFiniteNumber(item.nextAiringEp, `mediaItems[${idx}].nextAiringEp`),
    relationsJson: typeof item.relationsJson === 'string' ? item.relationsJson : '[]',
    cachedAt: typeof item.cachedAt === 'string' ? item.cachedAt : new Date().toISOString(),
  };
}

function parseBackupLibraryEntry(entry: Record<string, unknown>, idx: number): LibraryEntryRecord {
  const id = assertNonEmptyString(entry.id, `libraryEntries[${idx}].id`);
  const mediaItemId = assertNonEmptyString(
    entry.mediaItemId,
    `libraryEntries[${idx}].mediaItemId`
  );
  if (typeof entry.status !== 'string' || !WATCH_STATUSES.includes(entry.status as WatchStatus)) {
    throw new Error(`Invalid backup payload: libraryEntries[${idx}].status is invalid.`);
  }

  return {
    id,
    mediaItemId,
    status: entry.status as WatchStatus,
    personalScore: parsePersonalScore(entry.personalScore, `libraryEntries[${idx}].personalScore`),
    currentEpisode: parseNonNegativeInteger(
      entry.currentEpisode,
      `libraryEntries[${idx}].currentEpisode`,
      0
    ),
    notes: typeof entry.notes === 'string' ? entry.notes : '',
    rewatchCount: parseNonNegativeInteger(
      entry.rewatchCount,
      `libraryEntries[${idx}].rewatchCount`,
      0
    ),
    startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : null,
    completedAt: typeof entry.completedAt === 'string' ? entry.completedAt : null,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
    dirty: parseDirtyFlag(entry.dirty, `libraryEntries[${idx}].dirty`),
  };
}

function parseBackupEpisodeProgress(
  prog: Record<string, unknown>,
  idx: number
): EpisodeProgressRecord {
  const id = assertNonEmptyString(prog.id, `episodeProgress[${idx}].id`);
  const mediaItemId = assertNonEmptyString(
    prog.mediaItemId,
    `episodeProgress[${idx}].mediaItemId`
  );
  if (
    typeof prog.episodeNumber !== 'number' ||
    !Number.isInteger(prog.episodeNumber) ||
    prog.episodeNumber < 1
  ) {
    throw new Error(
      `Invalid backup payload: episodeProgress[${idx}].episodeNumber must be a positive integer.`
    );
  }

  return {
    id,
    mediaItemId,
    episodeNumber: prog.episodeNumber,
    positionSeconds: parseNonNegativeFiniteNumber(
      prog.positionSeconds,
      `episodeProgress[${idx}].positionSeconds`,
      0
    ),
    durationSeconds: parseNonNegativeFiniteNumber(
      prog.durationSeconds,
      `episodeProgress[${idx}].durationSeconds`,
      0
    ),
    isCompleted: Boolean(prog.isCompleted),
    watchedVia: prog.watchedVia === 'MANUAL' ? 'MANUAL' : 'APP_PLAYER',
    updatedAt: typeof prog.updatedAt === 'string' ? prog.updatedAt : new Date().toISOString(),
    dirty: parseDirtyFlag(prog.dirty, `episodeProgress[${idx}].dirty`),
  };
}

function parseBackupWatchHistory(item: Record<string, unknown>, idx: number): WatchHistoryRecord {
  const id = assertNonEmptyString(item.id, `watchHistory[${idx}].id`);
  const mediaItemId = assertNonEmptyString(item.mediaItemId, `watchHistory[${idx}].mediaItemId`);
  if (
    typeof item.action !== 'string' ||
    !VALID_HISTORY_ACTIONS.has(item.action as WatchHistoryRecord['action'])
  ) {
    throw new Error(`Invalid backup payload: watchHistory[${idx}].action is invalid.`);
  }

  return {
    id,
    mediaItemId,
    episodeNumber: parseNonNegativeInteger(
      item.episodeNumber,
      `watchHistory[${idx}].episodeNumber`,
      0
    ),
    action: item.action as WatchHistoryRecord['action'],
    occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : new Date().toISOString(),
    dirty: parseDirtyFlag(item.dirty, `watchHistory[${idx}].dirty`),
  };
}

function parseBackupUniTvLink(link: Record<string, unknown>, idx: number): UniTvLinkRecord {
  return {
    mediaItemId: assertNonEmptyString(link.mediaItemId, `unitvLinks[${idx}].mediaItemId`),
    unitvVodId: assertNonEmptyString(link.unitvVodId, `unitvLinks[${idx}].unitvVodId`),
    unitvTitle: assertNonEmptyString(link.unitvTitle, `unitvLinks[${idx}].unitvTitle`),
    unitvSeasonTag: typeof link.unitvSeasonTag === 'string' ? link.unitvSeasonTag : null,
    preferredAudioOrSub:
      typeof link.preferredAudioOrSub === 'string' ? link.preferredAudioOrSub : null,
    lastVerifiedAt:
      typeof link.lastVerifiedAt === 'string' ? link.lastVerifiedAt : new Date().toISOString(),
  };
}

function validateAndNormalizePayload(rawJson: string): BackupPayloadV1 {
  if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
    throw new Error('Invalid backup JSON payload: empty input.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid backup JSON payload: malformed JSON.');
  }

  if (!isPlainObject(parsed)) {
    throw new Error('Invalid backup JSON payload: root must be a JSON object.');
  }

  if (parsed.version !== 1) {
    throw new Error('Invalid backup payload: missing or unsupported "version" (expected 1).');
  }

  return {
    version: 1,
    exportedAt:
      typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
    mediaItems: parseArrayField(parsed.mediaItems, 'mediaItems', parseBackupMediaItem),
    libraryEntries: parseArrayField(
      parsed.libraryEntries,
      'libraryEntries',
      parseBackupLibraryEntry
    ),
    episodeProgress: parseArrayField(
      parsed.episodeProgress,
      'episodeProgress',
      parseBackupEpisodeProgress
    ),
    watchHistory: parseArrayField(parsed.watchHistory, 'watchHistory', parseBackupWatchHistory),
    unitvLinks: parseArrayField(parsed.unitvLinks, 'unitvLinks', parseBackupUniTvLink),
    settings: parseBackupSettings(parsed.settings),
  };
}

export class BackupService {
  private readonly repo: LibraryRepository;

  constructor(private readonly db: DatabaseAdapter) {
    this.repo = new LibraryRepository(db);
  }

  private async verifyReferentialIntegrity(payload: BackupPayloadV1): Promise<void> {
    const payloadMediaIds = new Set(payload.mediaItems.map((item) => item.id));
    const referencedIds = [
      ...payload.libraryEntries.map((e) => e.mediaItemId),
      ...payload.episodeProgress.map((p) => p.mediaItemId),
      ...payload.watchHistory.map((h) => h.mediaItemId),
      ...payload.unitvLinks.map((l) => l.mediaItemId),
    ];

    const missingInPayload = Array.from(
      new Set(referencedIds.filter((id) => !payloadMediaIds.has(id)))
    );

    if (missingInPayload.length === 0) {
      return;
    }

    const existingMedia = await this.repo.getAllMediaItems();
    const existingIds = new Set(existingMedia.map((item) => item.id));

    const danglingId = missingInPayload.find((id) => !existingIds.has(id));
    if (danglingId) {
      throw new Error(
        `Invalid backup payload: dangling mediaItemId reference "${danglingId}" not found in mediaItems or database.`
      );
    }
  }

  async exportBackupJson(): Promise<string> {
    const [mediaItems, libraryEntries, episodeProgress, watchHistory, unitvLinks, currentSettings] =
      await Promise.all([
        this.repo.getAllMediaItems(),
        this.repo.getAllLibraryEntries(),
        this.repo.getAllEpisodeProgress(),
        this.repo.getWatchHistory(),
        this.repo.getAllUniTvLinks(),
        this.repo.getSettings(),
      ]);

    // Strictly project only safe AppSettingsRecord fields — UniTV credentials are never stored or exported.
    const settings: AppSettingsRecord = {
      unitvPortalUrl: currentSettings.unitvPortalUrl,
      preferMaxQuality: currentSettings.preferMaxQuality,
      hideCompletedInExplore: currentSettings.hideCompletedInExplore,
      tmdbApiKey: currentSettings.tmdbApiKey,
      lastSyncAt: currentSettings.lastSyncAt,
    };

    const payload: BackupPayloadV1 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      mediaItems,
      libraryEntries,
      episodeProgress,
      watchHistory,
      unitvLinks,
      settings,
    };

    return JSON.stringify(payload, null, 2);
  }

  async importBackupJson(
    jsonPayload: string
  ): Promise<{ importedEntries: number; importedProgress: number }> {
    const payload = validateAndNormalizePayload(jsonPayload);
    await this.verifyReferentialIntegrity(payload);

    const mediaIdMap = new Map<string, string>();

    await this.db.execute('BEGIN TRANSACTION');
    try {
      for (const item of payload.mediaItems) {
        await this.repo.upsertMediaItem(item);
        const stored = await this.repo.getMediaItemByAnilistId(item.anilistId);
        mediaIdMap.set(item.id, stored ? stored.id : item.id);
      }

      for (const entry of payload.libraryEntries) {
        const resolvedMediaId = mediaIdMap.get(entry.mediaItemId) ?? entry.mediaItemId;
        await this.db.execute(
          `INSERT INTO library_entries (
            id, media_item_id, status, personal_score, current_episode, notes,
            rewatch_count, started_at, completed_at, updated_at, dirty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(media_item_id) DO UPDATE SET
            status = excluded.status,
            personal_score = excluded.personal_score,
            current_episode = excluded.current_episode,
            notes = excluded.notes,
            rewatch_count = excluded.rewatch_count,
            started_at = excluded.started_at,
            completed_at = excluded.completed_at,
            updated_at = excluded.updated_at,
            dirty = excluded.dirty`,
          [
            entry.id,
            resolvedMediaId,
            entry.status,
            entry.personalScore,
            entry.currentEpisode,
            entry.notes,
            entry.rewatchCount,
            entry.startedAt,
            entry.completedAt,
            entry.updatedAt,
            entry.dirty,
          ]
        );
      }

      for (const prog of payload.episodeProgress) {
        const resolvedMediaId = mediaIdMap.get(prog.mediaItemId) ?? prog.mediaItemId;
        await this.db.execute(
          `INSERT INTO episode_progress (
            id, media_item_id, episode_number, position_seconds, duration_seconds,
            is_completed, watched_via, updated_at, dirty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(media_item_id, episode_number) DO UPDATE SET
            position_seconds = excluded.position_seconds,
            duration_seconds = excluded.duration_seconds,
            is_completed = excluded.is_completed,
            watched_via = excluded.watched_via,
            updated_at = excluded.updated_at,
            dirty = excluded.dirty`,
          [
            prog.id,
            resolvedMediaId,
            prog.episodeNumber,
            prog.positionSeconds,
            prog.durationSeconds,
            prog.isCompleted ? 1 : 0,
            prog.watchedVia,
            prog.updatedAt,
            prog.dirty,
          ]
        );
      }

      for (const event of payload.watchHistory) {
        const resolvedMediaId = mediaIdMap.get(event.mediaItemId) ?? event.mediaItemId;
        await this.db.execute(
          `INSERT INTO watch_history (
            id, media_item_id, episode_number, action, occurred_at, dirty
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            media_item_id = excluded.media_item_id,
            episode_number = excluded.episode_number,
            action = excluded.action,
            occurred_at = excluded.occurred_at,
            dirty = excluded.dirty`,
          [
            event.id,
            resolvedMediaId,
            event.episodeNumber,
            event.action,
            event.occurredAt,
            event.dirty,
          ]
        );
      }

      for (const link of payload.unitvLinks) {
        const resolvedMediaId = mediaIdMap.get(link.mediaItemId) ?? link.mediaItemId;
        await this.repo.saveUniTvLink({
          ...link,
          mediaItemId: resolvedMediaId,
        });
      }

      await this.repo.saveSettings(payload.settings);
      await this.db.execute('COMMIT');
    } catch (error) {
      try {
        await this.db.execute('ROLLBACK');
      } catch {
        // Ignore rollback failure so the original import error is preserved.
      }
      throw error;
    }

    return {
      importedEntries: payload.libraryEntries.length,
      importedProgress: payload.episodeProgress.length,
    };
  }
}
