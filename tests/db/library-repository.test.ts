import {
  AppSettingsRecord,
  createExpoSqliteAdapter,
  DatabaseAdapter,
  initializeDatabase,
  MediaItemRecord,
  UniTvLinkRecord,
  WatchHistoryRecord,
  WatchStatus,
} from '../../src/db/schema';
import { LibraryRepository } from '../../src/db/library-repository';
import { BackupService } from '../../src/db/backup-service';

type NodeSqliteStatement = {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => Record<string, unknown>[];
};

type NodeSqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => NodeSqliteStatement;
  close: () => void;
};

type NodeSqliteModule = {
  DatabaseSync: new (location: string) => NodeSqliteDatabase;
};

function createInMemorySqliteAdapter(): { adapter: DatabaseAdapter; close: () => void } {
  // Node 26 built-in SQLite runs real SQL DDL, foreign keys, and queries in-memory without native Android binaries.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as NodeSqliteModule;
  const sqlite = new DatabaseSync(':memory:');

  const normalizeParam = (value: unknown): string | number | null | Uint8Array => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    if (typeof value === 'number' || typeof value === 'string' || value instanceof Uint8Array) {
      return value;
    }
    return String(value);
  };

  const adapter: DatabaseAdapter = {
    async execute(sql: string, params?: unknown[]): Promise<void> {
      if (!params || params.length === 0) {
        sqlite.exec(sql);
        return;
      }
      sqlite.prepare(sql).run(...params.map(normalizeParam));
    },
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const bound = (params ?? []).map(normalizeParam);
      const rows = sqlite.prepare(sql).all(...bound);
      return rows.map((row) => ({ ...row }) as T);
    },
  };

  return {
    adapter,
    close: () => sqlite.close(),
  };
}

function makeMediaItem(overrides: Partial<MediaItemRecord> = {}): MediaItemRecord {
  const anilistId = overrides.anilistId ?? 151807;
  return {
    id: overrides.id ?? `anime-${anilistId}`,
    mediaType: overrides.mediaType ?? 'ANIME',
    anilistId,
    malId: overrides.malId ?? 52299,
    tmdbId: overrides.tmdbId ?? 127532,
    titleRomaji: overrides.titleRomaji ?? 'Ore dake Level Up na Ken',
    titleEnglish: overrides.titleEnglish ?? 'Solo Leveling',
    titlePt: overrides.titlePt ?? 'Solo Leveling',
    synopsis: overrides.synopsis ?? 'E-rank hunter awakens a mysterious system.',
    coverUrl: overrides.coverUrl ?? 'https://img.example.com/cover.jpg',
    bannerUrl: overrides.bannerUrl ?? 'https://img.example.com/banner.jpg',
    genresJson: overrides.genresJson ?? JSON.stringify(['Action', 'Adventure', 'Fantasy']),
    seasonYear: overrides.seasonYear ?? 2024,
    seasonName: overrides.seasonName ?? 'WINTER',
    episodesTotal: overrides.episodesTotal !== undefined ? overrides.episodesTotal : 12,
    statusAiring: overrides.statusAiring ?? 'FINISHED',
    nextAiringAt: overrides.nextAiringAt ?? null,
    nextAiringEp: overrides.nextAiringEp ?? null,
    relationsJson: overrides.relationsJson ?? '[]',
    cachedAt: overrides.cachedAt ?? '2026-11-16T10:00:00.000Z',
  };
}

describe('LibraryRepository & BackupService', () => {
  let adapter: DatabaseAdapter;
  let closeDb: () => void;
  let repo: LibraryRepository;
  let backup: BackupService;

  beforeEach(async () => {
    const mem = createInMemorySqliteAdapter();
    adapter = mem.adapter;
    closeDb = mem.close;
    await initializeDatabase(adapter);
    repo = new LibraryRepository(adapter);
    backup = new BackupService(adapter);
  });

  afterEach(() => {
    closeDb();
  });

  it('initializes default app_settings and supports partial settings updates', async () => {
    const defaults = await repo.getSettings();
    expect(defaults).toEqual<AppSettingsRecord>({
      unitvPortalUrl: 'https://www.uvwebs.info',
      preferMaxQuality: true,
      hideCompletedInExplore: false,
      tmdbApiKey: null,
      lastSyncAt: null,
    });

    const updated = await repo.saveSettings({
      unitvPortalUrl: 'https://mirror.uvwebs.example',
      hideCompletedInExplore: true,
      tmdbApiKey: 'tmdb-free-key',
    });

    expect(updated).toEqual<AppSettingsRecord>({
      unitvPortalUrl: 'https://mirror.uvwebs.example',
      preferMaxQuality: true,
      hideCompletedInExplore: true,
      tmdbApiKey: 'tmdb-free-key',
      lastSyncAt: null,
    });

    const clearedKey = await repo.saveSettings({ tmdbApiKey: null });
    expect(clearedKey.tmdbApiKey).toBeNull();
  });

  it('wraps expo-sqlite SQLiteDatabase cleanly via createExpoSqliteAdapter', async () => {
    const mockExpoDb = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
      getAllAsync: jest.fn(async () => [{ id: 'abc' }]),
    };

    const expoAdapter = createExpoSqliteAdapter(
      mockExpoDb as unknown as import('expo-sqlite').SQLiteDatabase
    );

    await expoAdapter.execute('CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)');
    expect(mockExpoDb.execAsync).toHaveBeenCalledWith(
      'CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)'
    );

    await expoAdapter.execute('INSERT INTO sample (id) VALUES (?)', ['abc']);
    expect(mockExpoDb.runAsync).toHaveBeenCalledWith('INSERT INTO sample (id) VALUES (?)', ['abc']);

    const rows = await expoAdapter.query<{ id: string }>('SELECT id FROM sample WHERE id = ?', ['abc']);
    expect(mockExpoDb.getAllAsync).toHaveBeenCalledWith('SELECT id FROM sample WHERE id = ?', ['abc']);
    expect(rows).toEqual([{ id: 'abc' }]);
  });

  it('upserts media items by id/anilistId and preserves existing id on catalog refresh', async () => {
    const initial = makeMediaItem({ id: 'stable-id', anilistId: 777, titleRomaji: 'Old Title' });
    await repo.upsertMediaItem(initial);

    expect(await repo.getMediaItemById('stable-id')).toMatchObject({
      id: 'stable-id',
      anilistId: 777,
      titleRomaji: 'Old Title',
    });
    expect(await repo.getMediaItemByAnilistId(777)).toMatchObject({ id: 'stable-id' });

    await repo.setLibraryStatus('stable-id', 'WATCHING');

    // Simulate catalog re-fetch supplying a different generated id for the same anilistId
    const refreshed = makeMediaItem({
      id: 'new-temp-id',
      anilistId: 777,
      titleRomaji: 'Updated Title',
    });
    await repo.upsertMediaItem(refreshed);

    const all = await repo.getAllMediaItems();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('stable-id');
    expect(all[0].titleRomaji).toBe('Updated Title');

    const watching = await repo.getLibraryByStatus('WATCHING');
    expect(watching).toHaveLength(1);
    expect(watching[0].media.titleRomaji).toBe('Updated Title');
  });

  it('supports all 6 WatchStatus categories, validates score 0..10, and persists notes', async () => {
    const item = makeMediaItem({ id: 'media-1', anilistId: 1001 });
    await repo.upsertMediaItem(item);

    const allStatuses: WatchStatus[] = [
      'WATCHING',
      'PLAN_TO_WATCH',
      'COMPLETED',
      'PAUSED',
      'DROPPED',
      'REWATCHING',
    ];

    for (const status of allStatuses) {
      const updated = await repo.setLibraryStatus(item.id, status);
      expect(updated.status).toBe(status);
      expect(updated.dirty).toBe(1);

      const byStatus = await repo.getLibraryByStatus(status);
      expect(byStatus).toHaveLength(1);
      expect(byStatus[0].media.anilistId).toBe(1001);
    }

    const entries = await repo.getAllLibraryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].rewatchCount).toBe(1);

    await repo.updatePersonalScore(item.id, 9.5);
    await repo.updateNotes(item.id, 'Amazing soundtrack and animation.');

    const updatedEntries = await repo.getAllLibraryEntries();
    expect(updatedEntries[0].personalScore).toBe(9.5);
    expect(updatedEntries[0].notes).toBe('Amazing soundtrack and animation.');

    await repo.updatePersonalScore(item.id, 0);
    await repo.updatePersonalScore(item.id, 10);
    await repo.updatePersonalScore(item.id, null);

    const afterNullScore = await repo.getAllLibraryEntries();
    expect(afterNullScore[0].personalScore).toBeNull();

    await expect(repo.updatePersonalScore(item.id, -1)).rejects.toThrow();
    await expect(repo.updatePersonalScore(item.id, 11)).rejects.toThrow();
    await expect(repo.updatePersonalScore(item.id, Number.NaN)).rejects.toThrow();
  });

  it('enforces the 85% completion boundary and never regresses currentEpisode on rewatch', async () => {
    const item = makeMediaItem({ id: 'media-solo', anilistId: 2002, episodesTotal: 12 });
    await repo.upsertMediaItem(item);
    await repo.setLibraryStatus(item.id, 'WATCHING');

    // Simulate user previously having progressed through episode 5
    await adapter.execute(
      'UPDATE library_entries SET current_episode = ? WHERE media_item_id = ?',
      [5, item.id]
    );

    const underThreshold = await repo.recordPlaybackProgress({
      mediaItemId: item.id,
      episodeNumber: 6,
      positionSeconds: 1223,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });

    expect(underThreshold).toEqual({
      episodeCompleted: false,
      seasonCompletedPrompt: false,
    });

    let progressList = await repo.getEpisodeProgressList(item.id);
    expect(progressList).toHaveLength(1);
    expect(progressList[0].episodeNumber).toBe(6);
    expect(progressList[0].isCompleted).toBe(false);
    expect(progressList[0].positionSeconds).toBe(1223);
    expect(progressList[0].dirty).toBe(1);

    let [entry] = await repo.getAllLibraryEntries();
    expect(entry.currentEpisode).toBe(5);

    // Exactly 85% (1224 / 1440 === 0.85)
    const atThreshold = await repo.recordPlaybackProgress({
      mediaItemId: item.id,
      episodeNumber: 6,
      positionSeconds: 1224,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });

    expect(atThreshold).toEqual({
      episodeCompleted: true,
      nextEpisodeSuggestion: 7,
      seasonCompletedPrompt: false,
    });

    progressList = await repo.getEpisodeProgressList(item.id);
    const ep6 = progressList.find((p) => p.episodeNumber === 6);
    expect(ep6?.isCompleted).toBe(true);

    [entry] = await repo.getAllLibraryEntries();
    expect(entry.currentEpisode).toBe(6);
    expect(entry.dirty).toBe(1);

    const historyRows = await adapter.query<{ action: string; episode_number: number }>(
      'SELECT action, episode_number FROM watch_history WHERE media_item_id = ?',
      [item.id]
    );
    expect(historyRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'COMPLETED', episode_number: 6 }),
      ])
    );

    // Rewatching an earlier episode must never regress currentEpisode below 6
    await repo.recordPlaybackProgress({
      mediaItemId: item.id,
      episodeNumber: 2,
      positionSeconds: 1440,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });

    [entry] = await repo.getAllLibraryEntries();
    expect(entry.currentEpisode).toBe(6);

    // Zero duration must safely evaluate as incomplete without NaN/Infinity issues
    const zeroDuration = await repo.recordPlaybackProgress({
      mediaItemId: item.id,
      episodeNumber: 7,
      positionSeconds: 100,
      durationSeconds: 0,
      watchedVia: 'APP_PLAYER',
    });
    expect(zeroDuration).toEqual({
      episodeCompleted: false,
      seasonCompletedPrompt: false,
    });
  });

  it('triggers seasonCompletedPrompt only when reaching episodesTotal', async () => {
    const finiteAnime = makeMediaItem({ id: 'finite', anilistId: 3001, episodesTotal: 12 });
    const ongoingAnime = makeMediaItem({ id: 'ongoing', anilistId: 3002, episodesTotal: null });
    await repo.upsertMediaItem(finiteAnime);
    await repo.upsertMediaItem(ongoingAnime);
    await repo.setLibraryStatus(finiteAnime.id, 'WATCHING');
    await repo.setLibraryStatus(ongoingAnime.id, 'WATCHING');

    const ep11 = await repo.recordPlaybackProgress({
      mediaItemId: finiteAnime.id,
      episodeNumber: 11,
      positionSeconds: 1300,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });
    expect(ep11.episodeCompleted).toBe(true);
    expect(ep11.seasonCompletedPrompt).toBe(false);
    expect(ep11.nextEpisodeSuggestion).toBe(12);

    const ep12 = await repo.recordPlaybackProgress({
      mediaItemId: finiteAnime.id,
      episodeNumber: 12,
      positionSeconds: 1300,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });
    expect(ep12.episodeCompleted).toBe(true);
    expect(ep12.seasonCompletedPrompt).toBe(true);
    expect(ep12.nextEpisodeSuggestion).toBeUndefined();

    const manualUnmark = await repo.toggleEpisodeManual(finiteAnime.id, 12, false);
    expect(manualUnmark).toEqual({ seasonCompletedPrompt: false });

    const manualComplete = await repo.toggleEpisodeManual(finiteAnime.id, 12, true);
    expect(manualComplete).toEqual({ seasonCompletedPrompt: true });

    const ongoingManual = await repo.toggleEpisodeManual(ongoingAnime.id, 12, true);
    expect(ongoingManual).toEqual({ seasonCompletedPrompt: false });

    const ongoingPlayback = await repo.recordPlaybackProgress({
      mediaItemId: ongoingAnime.id,
      episodeNumber: 13,
      positionSeconds: 1300,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });
    expect(ongoingPlayback.episodeCompleted).toBe(true);
    expect(ongoingPlayback.seasonCompletedPrompt).toBe(false);
    expect(ongoingPlayback.nextEpisodeSuggestion).toBe(14);
  });

  it('picks a random PLAN_TO_WATCH entry respecting genreFilter and returns null when empty', async () => {
    const actionItem = makeMediaItem({
      id: 'act',
      anilistId: 4001,
      genresJson: JSON.stringify(['Action', 'Sci-Fi']),
    });
    const sliceItem = makeMediaItem({
      id: 'sol',
      anilistId: 4002,
      genresJson: JSON.stringify(['Slice of Life', 'Comedy']),
    });
    await repo.upsertMediaItem(actionItem);
    await repo.upsertMediaItem(sliceItem);
    await repo.setLibraryStatus(actionItem.id, 'PLAN_TO_WATCH');
    await repo.setLibraryStatus(sliceItem.id, 'PLAN_TO_WATCH');

    const ptwEntries = await repo.getLibraryByStatus('PLAN_TO_WATCH');

    expect(repo.pickRandomPlanToWatch([])).toBeNull();
    expect(repo.pickRandomPlanToWatch(ptwEntries, 'Horror')).toBeNull();

    const pickedComedy = repo.pickRandomPlanToWatch(ptwEntries, 'comedy');
    expect(pickedComedy?.mediaItemId).toBe(sliceItem.id);

    const pickedAny = repo.pickRandomPlanToWatch(ptwEntries);
    expect(pickedAny).not.toBeNull();
  });

  it('exports and imports complete JSON backups without credentials and rejects invalid payloads', async () => {
    const item = makeMediaItem({ id: 'backup-anime', anilistId: 5001, episodesTotal: 24 });
    await repo.upsertMediaItem(item);
    await repo.setLibraryStatus(item.id, 'WATCHING');
    await repo.updatePersonalScore(item.id, 8.5);
    await repo.updateNotes(item.id, 'Save for weekend marathon');
    await repo.recordPlaybackProgress({
      mediaItemId: item.id,
      episodeNumber: 3,
      positionSeconds: 1300,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });

    const link: UniTvLinkRecord = {
      mediaItemId: item.id,
      unitvVodId: 'vod-9988',
      unitvTitle: 'Anime Dublado HD',
      unitvSeasonTag: 'S1',
      preferredAudioOrSub: 'SUB',
      lastVerifiedAt: '2026-11-16T11:00:00.000Z',
    };
    await repo.saveUniTvLink(link);

    await repo.saveSettings({
      unitvPortalUrl: 'https://custom.uvwebs.example',
      preferMaxQuality: false,
      hideCompletedInExplore: true,
      tmdbApiKey: 'optional-tmdb-key',
      lastSyncAt: '2026-11-16T11:30:00.000Z',
    });

    const exportedJson = await backup.exportBackupJson();
    const parsedExport = JSON.parse(exportedJson) as Record<string, unknown>;
    expect(parsedExport.version).toBe(1);
    expect(exportedJson).not.toContain('password');
    expect(exportedJson).not.toContain('unitvUsername');

    // Restore into a brand-new clean database
    const targetMem = createInMemorySqliteAdapter();
    try {
      await initializeDatabase(targetMem.adapter);
      const targetRepo = new LibraryRepository(targetMem.adapter);
      const targetBackup = new BackupService(targetMem.adapter);

      const summary = await targetBackup.importBackupJson(exportedJson);
      expect(summary).toEqual({
        importedEntries: 1,
        importedProgress: 1,
      });

      const restoredEntries = await targetRepo.getLibraryByStatus('WATCHING');
      expect(restoredEntries).toHaveLength(1);
      expect(restoredEntries[0].personalScore).toBe(8.5);
      expect(restoredEntries[0].notes).toBe('Save for weekend marathon');
      expect(restoredEntries[0].currentEpisode).toBe(3);

      const restoredProgress = await targetRepo.getEpisodeProgressList(item.id);
      expect(restoredProgress).toHaveLength(1);
      expect(restoredProgress[0].isCompleted).toBe(true);
      expect(restoredProgress[0].positionSeconds).toBe(1300);

      const restoredHistory = await targetMem.adapter.query<WatchHistoryRecord>(
        'SELECT id, media_item_id AS mediaItemId, episode_number AS episodeNumber, action, occurred_at AS occurredAt, dirty FROM watch_history WHERE media_item_id = ?',
        [item.id]
      );
      expect(restoredHistory.length).toBeGreaterThanOrEqual(2);

      const restoredLink = await targetRepo.getUniTvLink(item.id);
      expect(restoredLink).toEqual(link);

      const restoredSettings = await targetRepo.getSettings();
      expect(restoredSettings).toEqual<AppSettingsRecord>({
        unitvPortalUrl: 'https://custom.uvwebs.example',
        preferMaxQuality: false,
        hideCompletedInExplore: true,
        tmdbApiKey: 'optional-tmdb-key',
        lastSyncAt: '2026-11-16T11:30:00.000Z',
      });

      await expect(targetBackup.importBackupJson('{bad-json')).rejects.toThrow();
      await expect(
        targetBackup.importBackupJson(JSON.stringify({ libraryEntries: [] }))
      ).rejects.toThrow();
      await expect(
        targetBackup.importBackupJson(JSON.stringify({ ...parsedExport, version: 2 }))
      ).rejects.toThrow();
      await expect(
        targetBackup.importBackupJson(
          JSON.stringify({
            ...parsedExport,
            libraryEntries: [
              {
                ...(parsedExport.libraryEntries as Record<string, unknown>[])[0],
                personalScore: 99,
              },
            ],
          })
        )
      ).rejects.toThrow();

      // Even if stray credential keys appear in external backup JSON, they are never stored or re-exported
      const payloadWithStrayCredentials = JSON.stringify({
        ...parsedExport,
        settings: {
          ...(parsedExport.settings as Record<string, unknown>),
          unitvUsername: 'should-not-persist',
          unitvPassword: 'should-not-persist',
        },
      });
      await targetBackup.importBackupJson(payloadWithStrayCredentials);
      const reExported = await targetBackup.exportBackupJson();
      expect(reExported).not.toContain('should-not-persist');
      expect(reExported).not.toContain('unitvUsername');
      expect(reExported).not.toContain('unitvPassword');
    } finally {
      targetMem.close();
    }
  });
});
