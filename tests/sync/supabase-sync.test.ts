import { LibraryRepository } from '../../src/db/library-repository';
import {
  DatabaseAdapter,
  EpisodeProgressRecord,
  initializeDatabase,
  LibraryEntryRecord,
  MediaItemRecord,
  UniTvLinkRecord,
} from '../../src/db/schema';
import {
  createSupabaseSyncClient,
  resolveConflictByUpdatedAt,
  SupabaseSyncClient,
  SupabaseSyncEngine,
} from '../../src/sync/supabase-sync';

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
    id: overrides.id ?? `anilist:${anilistId}`,
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
    genresJson: overrides.genresJson ?? JSON.stringify(['Action', 'Adventure']),
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

describe('SupabaseSyncEngine', () => {
  let adapter: DatabaseAdapter;
  let closeDb: () => void;
  let repo: LibraryRepository;

  beforeEach(async () => {
    const mem = createInMemorySqliteAdapter();
    adapter = mem.adapter;
    closeDb = mem.close;
    await initializeDatabase(adapter);
    repo = new LibraryRepository(adapter);
  });

  afterEach(() => {
    closeDb();
  });

  describe('resolveConflictByUpdatedAt', () => {
    it('returns remote when remote updatedAt is newer, and local when local is newer or equal', () => {
      const localEntry: LibraryEntryRecord = {
        id: 'entry-1',
        mediaItemId: 'anilist:1',
        status: 'WATCHING',
        personalScore: 8,
        currentEpisode: 4,
        notes: 'Local note',
        rewatchCount: 0,
        startedAt: '2026-11-10T10:00:00.000Z',
        completedAt: null,
        updatedAt: '2026-11-16T12:00:00.000Z',
        dirty: 1,
      };

      const newerRemote: LibraryEntryRecord = {
        ...localEntry,
        currentEpisode: 7,
        notes: 'Remote newer note',
        updatedAt: '2026-11-16T12:05:00.000Z',
        dirty: 0,
      };

      const olderRemote: LibraryEntryRecord = {
        ...localEntry,
        currentEpisode: 2,
        updatedAt: '2026-11-16T11:30:00.000Z',
        dirty: 0,
      };

      const equalInstantRemote: LibraryEntryRecord = {
        ...localEntry,
        currentEpisode: 99,
        updatedAt: '2026-11-16T12:00:00+00:00',
        dirty: 0,
      };

      expect(resolveConflictByUpdatedAt(localEntry, newerRemote)).toBe(newerRemote);
      expect(resolveConflictByUpdatedAt(localEntry, olderRemote)).toBe(localEntry);
      expect(resolveConflictByUpdatedAt(localEntry, equalInstantRemote)).toBe(localEntry);
    });
  });

  describe('getDirtyCount', () => {
    it('counts dirty rows accurately across library_entries, episode_progress, and watch_history', async () => {
      const fakeClient: SupabaseSyncClient = {
        upsert: jest.fn(async () => ({ error: null })),
        selectUpdatedSince: jest.fn(async () => ({ data: [], error: null })),
      };
      const engine = new SupabaseSyncEngine(adapter, fakeClient);

      expect(await engine.getDirtyCount()).toBe(0);

      const item = makeMediaItem({ id: 'anilist:101', anilistId: 101 });
      await repo.upsertMediaItem(item);
      await repo.setLibraryStatus(item.id, 'WATCHING'); // +1 library_entries, +1 watch_history (STATUS_CHANGED)
      await repo.recordPlaybackProgress({
        mediaItemId: item.id,
        episodeNumber: 1,
        positionSeconds: 1300,
        durationSeconds: 1440,
        watchedVia: 'APP_PLAYER',
      }); // +1 episode_progress, +1 watch_history (COMPLETED)
      await repo.recordPlaybackProgress({
        mediaItemId: item.id,
        episodeNumber: 2,
        positionSeconds: 300,
        durationSeconds: 1440,
        watchedVia: 'APP_PLAYER',
      }); // +1 episode_progress, +1 watch_history (STARTED)

      // 1 library_entries + 2 episode_progress + 3 watch_history = 6
      expect(await engine.getDirtyCount()).toBe(6);

      // Mark one watch_history row clean manually and verify count decreases
      await adapter.execute(
        'UPDATE watch_history SET dirty = 0 WHERE id = (SELECT id FROM watch_history LIMIT 1)'
      );
      expect(await engine.getDirtyCount()).toBe(5);
    });
  });

  it('pushes dirty rows, clears dirty = 0 atomically, pulls newer remote updates without marking dirty, and updates lastSyncAt', async () => {
    const nowMs = Date.now();
    const isoAgo = (minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString();

    const localItem = makeMediaItem({
      id: 'anilist:151807',
      anilistId: 151807,
      cachedAt: isoAgo(360),
    });
    const localWinningItem = makeMediaItem({
      id: 'anilist:900',
      anilistId: 900,
      titleRomaji: 'Vinland Saga',
      cachedAt: isoAgo(30),
    });
    await repo.upsertMediaItem(localItem);
    await repo.upsertMediaItem(localWinningItem);
    await repo.setLibraryStatus(localItem.id, 'WATCHING');
    await repo.updatePersonalScore(localItem.id, 8);
    await repo.updateNotes(localItem.id, 'Local initial note');
    await repo.setLibraryStatus(localWinningItem.id, 'WATCHING');
    await repo.recordPlaybackProgress({
      mediaItemId: localItem.id,
      episodeNumber: 1,
      positionSeconds: 1300,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });

    const link: UniTvLinkRecord = {
      mediaItemId: localItem.id,
      unitvVodId: 'vod-555',
      unitvTitle: 'Solo Leveling S1',
      unitvSeasonTag: 'S1',
      preferredAudioOrSub: 'SUB',
      lastVerifiedAt: isoAgo(300),
    };
    await repo.saveUniTvLink(link);

    // Pin local timestamps cleanly relative to current clock for deterministic conflict comparison
    await adapter.execute(
      `UPDATE library_entries SET updated_at = ? WHERE media_item_id = ?`,
      [isoAgo(240), localItem.id]
    );
    await adapter.execute(
      `UPDATE library_entries SET updated_at = ? WHERE media_item_id = ?`,
      [isoAgo(20), localWinningItem.id]
    );
    await adapter.execute(
      `UPDATE episode_progress SET updated_at = ? WHERE media_item_id = ? AND episode_number = 1`,
      [isoAgo(60), localItem.id]
    );

    const pushCalls: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
    const selectCalls: Array<{ table: string; userId: string; sinceIso: string | null }> = [];

    const remoteNewItem = makeMediaItem({
      id: 'anilist:21',
      anilistId: 21,
      titleRomaji: 'One Piece',
      titleEnglish: 'One Piece',
      episodesTotal: null,
      cachedAt: isoAgo(180),
    });

    const fakeClient: SupabaseSyncClient = {
      upsert: jest.fn(async (table, rows) => {
        pushCalls.push({ table, rows });
        return { error: null };
      }),
      selectUpdatedSince: jest.fn(async (table, userId, sinceIso) => {
        selectCalls.push({ table, userId, sinceIso });
        if (table === 'media_items') {
          return {
            data: [
              {
                id: remoteNewItem.id,
                user_id: userId,
                media_type: remoteNewItem.mediaType,
                anilist_id: remoteNewItem.anilistId,
                mal_id: remoteNewItem.malId,
                tmdb_id: remoteNewItem.tmdbId,
                title_romaji: remoteNewItem.titleRomaji,
                title_english: remoteNewItem.titleEnglish,
                title_pt: remoteNewItem.titlePt,
                synopsis: remoteNewItem.synopsis,
                cover_url: remoteNewItem.coverUrl,
                banner_url: remoteNewItem.bannerUrl,
                genres_json: remoteNewItem.genresJson,
                season_year: remoteNewItem.seasonYear,
                season_name: remoteNewItem.seasonName,
                episodes_total: remoteNewItem.episodesTotal,
                status_airing: remoteNewItem.statusAiring,
                next_airing_at: remoteNewItem.nextAiringAt,
                next_airing_ep: remoteNewItem.nextAiringEp,
                relations_json: remoteNewItem.relationsJson,
                cached_at: remoteNewItem.cachedAt,
                updated_at: remoteNewItem.cachedAt,
              },
            ],
            error: null,
          };
        }
        if (table === 'library_entries') {
          return {
            data: [
              // Newer remote edit on existing local entry -> remote wins
              {
                id: 'remote-entry-overwrite',
                user_id: userId,
                media_item_id: localItem.id,
                status: 'COMPLETED',
                personal_score: 9.5,
                current_episode: 12,
                notes: 'Finished on tablet',
                rewatch_count: 1,
                started_at: isoAgo(480),
                completed_at: isoAgo(120),
                updated_at: isoAgo(120),
              },
              // Brand new remote entry
              {
                id: 'remote-entry-op',
                user_id: userId,
                media_item_id: remoteNewItem.id,
                status: 'WATCHING',
                personal_score: 10,
                current_episode: 1100,
                notes: 'Peak fiction',
                rewatch_count: 0,
                started_at: isoAgo(1440),
                completed_at: null,
                updated_at: isoAgo(150),
              },
            ],
            error: null,
          };
        }
        if (table === 'episode_progress') {
          return {
            data: [
              // Older remote progress on ep 1 -> local (60m ago) wins!
              {
                id: 'remote-ep-1-stale',
                user_id: userId,
                media_item_id: localItem.id,
                episode_number: 1,
                position_seconds: 100,
                duration_seconds: 1440,
                is_completed: false,
                watched_via: 'MANUAL',
                updated_at: isoAgo(300),
              },
              // New remote progress on ep 2 -> inserted with dirty = 0
              {
                id: 'remote-ep-2',
                user_id: userId,
                media_item_id: localItem.id,
                episode_number: 2,
                position_seconds: 1400,
                duration_seconds: 1440,
                is_completed: true,
                watched_via: 'APP_PLAYER',
                updated_at: isoAgo(30),
              },
            ],
            error: null,
          };
        }
        if (table === 'watch_history') {
          return {
            data: [
              {
                id: 'remote-hist-1',
                user_id: userId,
                media_item_id: remoteNewItem.id,
                episode_number: 1100,
                action: 'COMPLETED',
                occurred_at: isoAgo(150),
                updated_at: isoAgo(150),
              },
            ],
            error: null,
          };
        }
        if (table === 'unitv_links') {
          return {
            data: [
              {
                user_id: userId,
                media_item_id: remoteNewItem.id,
                unitv_vod_id: 'vod-op',
                unitv_title: 'One Piece HD',
                unitv_season_tag: null,
                preferred_audio_or_sub: 'SUB',
                last_verified_at: isoAgo(140),
                updated_at: isoAgo(140),
              },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      }),
    };

    const engine = new SupabaseSyncEngine(adapter, fakeClient);
    const result = await engine.syncNow('user-uuid-1');

    // media_items (2) + library_entries (1 winning: anilist:900; stale anilist:151807 skipped) + episode_progress (1) + watch_history (3) + unitv_links (1) = 8
    expect(result.status).toBe('SYNCED');
    expect(result.pushedCount).toBe(8);
    // pulled: media_items (1) + library_entries (2) + episode_progress (1 applied, 1 ignored) + watch_history (1) + unitv_links (1) = 6
    expect(result.pulledCount).toBe(6);

    // FK integrity: media_items must be pushed first, and stale local library_entry (anilist:151807) must not be pushed
    expect(pushCalls[0].table).toBe('media_items');
    expect(pushCalls.map((c) => c.table)).toEqual([
      'media_items',
      'library_entries',
      'episode_progress',
      'watch_history',
      'unitv_links',
    ]);
    const pushedEntryCall = pushCalls.find((c) => c.table === 'library_entries');
    expect(pushedEntryCall?.rows.map((r) => r.media_item_id)).toEqual([localWinningItem.id]);

    // Never leaks dirty flag or credentials/app_settings
    for (const call of pushCalls) {
      expect(call.table).not.toBe('app_settings');
      for (const row of call.rows) {
        expect(row.user_id).toBe('user-uuid-1');
        expect('dirty' in row).toBe(false);
        expect('tmdb_api_key' in row).toBe(false);
        expect('unitv_portal_url' in row).toBe(false);
      }
    }

    // Dirty queue cleared locally and pulled rows are NOT marked dirty
    expect(await engine.getDirtyCount()).toBe(0);

    const allEntries = await repo.getAllLibraryEntries();
    expect(allEntries).toHaveLength(3);
    const updatedSolo = allEntries.find((e) => e.mediaItemId === localItem.id);
    expect(updatedSolo).toMatchObject({
      status: 'COMPLETED',
      personalScore: 9.5,
      currentEpisode: 12,
      notes: 'Finished on tablet',
      dirty: 0,
    });
    const pulledOp = allEntries.find((e) => e.mediaItemId === remoteNewItem.id);
    expect(pulledOp).toMatchObject({
      status: 'WATCHING',
      currentEpisode: 1100,
      dirty: 0,
    });

    const epList = await repo.getEpisodeProgressList(localItem.id);
    expect(epList).toHaveLength(2);
    expect(epList.find((e) => e.episodeNumber === 1)).toMatchObject({
      positionSeconds: 1300,
      isCompleted: true,
      dirty: 0,
    });
    expect(epList.find((e) => e.episodeNumber === 2)).toMatchObject({
      positionSeconds: 1400,
      isCompleted: true,
      dirty: 0,
    });

    const pulledLink = await repo.getUniTvLink(remoteNewItem.id);
    expect(pulledLink?.unitvVodId).toBe('vod-op');

    const settings = await repo.getSettings();
    expect(settings.lastSyncAt).not.toBeNull();
    expect(Number.isFinite(Date.parse(settings.lastSyncAt as string))).toBe(true);

    // Second sync when nothing changed passes previous lastSyncAt and pushes 0 rows
    pushCalls.length = 0;
    selectCalls.length = 0;
    const secondClient: SupabaseSyncClient = {
      upsert: jest.fn(async (table, rows) => {
        pushCalls.push({ table, rows });
        return { error: null };
      }),
      selectUpdatedSince: jest.fn(async (table, userId, sinceIso) => {
        selectCalls.push({ table, userId, sinceIso });
        return { data: [], error: null };
      }),
    };
    const secondEngine = new SupabaseSyncEngine(adapter, secondClient);
    const secondResult = await secondEngine.syncNow('user-uuid-1');

    expect(secondResult).toEqual({
      status: 'SYNCED',
      pushedCount: 0,
      pulledCount: 0,
    });
    expect(pushCalls).toHaveLength(0);
    for (const call of selectCalls) {
      expect(call.sinceIso).toBe(settings.lastSyncAt);
    }
  });

  describe('paused Supabase project and offline resilience (Review Focus #1)', () => {
    it('returns DEFERRED_OFFLINE_OR_PAUSED without throwing and preserves dirty = 1 and lastSyncAt on HTTP 540 Project is paused', async () => {
      const item = makeMediaItem({ id: 'anilist:777', anilistId: 777 });
      await repo.upsertMediaItem(item);
      await repo.setLibraryStatus(item.id, 'WATCHING');
      await repo.recordPlaybackProgress({
        mediaItemId: item.id,
        episodeNumber: 1,
        positionSeconds: 600,
        durationSeconds: 1440,
        watchedVia: 'APP_PLAYER',
      });

      const previousSyncAt = '2026-11-15T20:00:00.000Z';
      await repo.saveSettings({ lastSyncAt: previousSyncAt });

      const pausedClient: SupabaseSyncClient = {
        upsert: jest.fn(async () => ({
          error: { message: 'Project is paused', status: 540, code: 'PROJECT_PAUSED' },
        })),
        selectUpdatedSince: jest.fn(async () => ({ data: [], error: null })),
      };

      const engine = new SupabaseSyncEngine(adapter, pausedClient);
      const initialDirty = await engine.getDirtyCount();
      expect(initialDirty).toBe(4);

      const result = await engine.syncNow('user-uuid-1');

      expect(result.status).toBe('DEFERRED_OFFLINE_OR_PAUSED');
      expect(result.pushedCount).toBe(0);
      expect(result.pulledCount).toBe(0);
      expect(result.errorMessage).toContain('Project is paused');

      // Local queue and lastSyncAt remain completely untouched
      expect(await engine.getDirtyCount()).toBe(initialDirty);
      expect((await repo.getSettings()).lastSyncAt).toBe(previousSyncAt);
    });

    it('returns DEFERRED_OFFLINE_OR_PAUSED and preserves dirty = 1 on HTTP 503 or thrown network error', async () => {
      const item = makeMediaItem({ id: 'anilist:888', anilistId: 888 });
      await repo.upsertMediaItem(item);
      await repo.setLibraryStatus(item.id, 'PLAN_TO_WATCH');

      const engine503 = new SupabaseSyncEngine(adapter, {
        upsert: jest.fn(async (table) => {
          // Simulate failure after media_items succeeds so atomicity is verified too
          if (table === 'library_entries') {
            return { error: { message: 'Service Unavailable (Project is paused)', status: 503 } };
          }
          return { error: null };
        }),
        selectUpdatedSince: jest.fn(async () => ({ data: [], error: null })),
      });

      const res503 = await engine503.syncNow('user-uuid-1');
      expect(res503.status).toBe('DEFERRED_OFFLINE_OR_PAUSED');
      expect(res503.pushedCount).toBe(0);
      expect(res503.pulledCount).toBe(0);
      expect(res503.errorMessage).toContain('503');
      expect(await engine503.getDirtyCount()).toBe(2);
      expect((await repo.getSettings()).lastSyncAt).toBeNull();

      const offlineEngine = new SupabaseSyncEngine(adapter, {
        upsert: jest.fn(async () => {
          throw new TypeError('Network request failed');
        }),
        selectUpdatedSince: jest.fn(async () => ({ data: [], error: null })),
      });

      const resOffline = await offlineEngine.syncNow('user-uuid-1');
      expect(resOffline.status).toBe('DEFERRED_OFFLINE_OR_PAUSED');
      expect(resOffline.pushedCount).toBe(0);
      expect(resOffline.pulledCount).toBe(0);
      expect(resOffline.errorMessage).toContain('Network request failed');
      expect(await offlineEngine.getDirtyCount()).toBe(2);
      expect((await repo.getSettings()).lastSyncAt).toBeNull();
    });

    it('aborts safely before pushing and preserves dirty = 1 and lastSyncAt when pull fails with 503', async () => {
      const item = makeMediaItem({ id: 'anilist:999', anilistId: 999 });
      await repo.upsertMediaItem(item);
      await repo.setLibraryStatus(item.id, 'WATCHING');

      const previousSyncAt = '2026-11-15T10:00:00.000Z';
      await repo.saveSettings({ lastSyncAt: previousSyncAt });

      const upsertSpy = jest.fn(async () => ({ error: null }));
      const engine = new SupabaseSyncEngine(adapter, {
        upsert: upsertSpy,
        selectUpdatedSince: jest.fn(async () => ({
          data: null,
          error: { message: 'Project is paused', status: 503 },
        })),
      });

      const result = await engine.syncNow('user-uuid-1');
      expect(result.status).toBe('DEFERRED_OFFLINE_OR_PAUSED');
      expect(result.pushedCount).toBe(0);
      expect(result.pulledCount).toBe(0);
      expect(result.errorMessage).toContain('Project is paused');
      // Pull ran first and failed, so upsert was never called, dirty = 1 rows and lastSyncAt stayed intact
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(await engine.getDirtyCount()).toBe(2);
      expect((await repo.getSettings()).lastSyncAt).toBe(previousSyncAt);
    });
  });

  describe('createSupabaseSyncClient', () => {
    it('delegates upsert and selectUpdatedSince to SupabaseClient and surfaces HTTP status', async () => {
      const gtMock = jest.fn(async () => ({
        data: [{ id: 'row-1' }],
        error: null,
        status: 200,
      }));
      const eqMock = jest.fn(() => ({
        gt: gtMock,
        then: (resolve: (val: unknown) => void) =>
          resolve({ data: [{ id: 'row-all' }], error: null, status: 200 }),
      }));
      const selectMock = jest.fn(() => ({ eq: eqMock }));
      const upsertMock = jest.fn(async () => ({
        data: null,
        error: { message: 'Project is paused', details: '', hint: '', code: '54000' },
        status: 540,
      }));
      const fromMock = jest.fn(() => ({
        upsert: upsertMock,
        select: selectMock,
      }));

      const fakeSupabaseClient = {
        from: fromMock,
      } as unknown as import('@supabase/supabase-js').SupabaseClient;

      const syncClient = createSupabaseSyncClient(fakeSupabaseClient);

      // Empty upsert short-circuits without calling Supabase
      expect(await syncClient.upsert('library_entries', [])).toEqual({ error: null });
      expect(fromMock).not.toHaveBeenCalled();

      const upsertRes = await syncClient.upsert('library_entries', [
        { id: 'e1', user_id: 'u1', media_item_id: 'm1' },
      ]);
      expect(fromMock).toHaveBeenCalledWith('library_entries');
      expect(upsertMock).toHaveBeenCalledWith(
        [{ id: 'e1', user_id: 'u1', media_item_id: 'm1' }],
        { onConflict: 'user_id,media_item_id' }
      );
      expect(upsertRes).toEqual({
        error: {
          message: 'Project is paused',
          status: 540,
          code: '54000',
        },
      });

      const sinceRes = await syncClient.selectUpdatedSince(
        'episode_progress',
        'u1',
        '2026-11-16T00:00:00.000Z'
      );
      expect(fromMock).toHaveBeenCalledWith('episode_progress');
      expect(selectMock).toHaveBeenCalledWith('*');
      expect(eqMock).toHaveBeenCalledWith('user_id', 'u1');
      expect(gtMock).toHaveBeenCalledWith('updated_at', '2026-11-16T00:00:00.000Z');
      expect(sinceRes).toEqual({ data: [{ id: 'row-1' }], error: null });

      const fullRes = await syncClient.selectUpdatedSince('episode_progress', 'u1', null);
      expect(fullRes).toEqual({ data: [{ id: 'row-all' }], error: null });
    });
  });

  it('hydrates missing parent media_items via fallback full fetch when child rows arrive incrementally', async () => {
    const missingParent = makeMediaItem({
      id: 'anilist:30276',
      anilistId: 30276,
      titleRomaji: 'One Punch Man',
      cachedAt: '2026-11-01T00:00:00.000Z',
    });

    await repo.saveSettings({ lastSyncAt: '2026-11-10T00:00:00.000Z' });

    const fakeClient: SupabaseSyncClient = {
      upsert: jest.fn(async () => ({ error: null })),
      selectUpdatedSince: jest.fn(async (table, userId, sinceIso) => {
        if (table === 'media_items' && sinceIso === null) {
          return {
            data: [
              {
                id: missingParent.id,
                user_id: userId,
                media_type: missingParent.mediaType,
                anilist_id: missingParent.anilistId,
                mal_id: missingParent.malId,
                tmdb_id: missingParent.tmdbId,
                title_romaji: missingParent.titleRomaji,
                title_english: missingParent.titleEnglish,
                title_pt: missingParent.titlePt,
                synopsis: missingParent.synopsis,
                cover_url: missingParent.coverUrl,
                banner_url: missingParent.bannerUrl,
                genres_json: missingParent.genresJson,
                season_year: missingParent.seasonYear,
                season_name: missingParent.seasonName,
                episodes_total: missingParent.episodesTotal,
                status_airing: missingParent.statusAiring,
                next_airing_at: missingParent.nextAiringAt,
                next_airing_ep: missingParent.nextAiringEp,
                relations_json: missingParent.relationsJson,
                cached_at: missingParent.cachedAt,
                updated_at: missingParent.cachedAt,
              },
            ],
            error: null,
          };
        }
        if (table === 'library_entries') {
          return {
            data: [
              {
                id: 'entry-opm',
                user_id: userId,
                media_item_id: missingParent.id,
                status: 'COMPLETED',
                personal_score: 9,
                current_episode: 12,
                notes: '',
                rewatch_count: 0,
                started_at: null,
                completed_at: '2026-11-15T10:00:00.000Z',
                updated_at: '2026-11-15T10:00:00.000Z',
              },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      }),
    };

    const engine = new SupabaseSyncEngine(adapter, fakeClient);
    const result = await engine.syncNow('user-uuid-1');

    expect(result.status).toBe('SYNCED');
    expect(result.pulledCount).toBe(2);
    expect(await repo.getMediaItemById(missingParent.id)).not.toBeNull();
    expect(await repo.getLibraryByStatus('COMPLETED')).toHaveLength(1);
  });

  it('serializes concurrent syncNow calls, rejects blank userId, and preserves newer local edits written mid-push', async () => {
    const item = makeMediaItem({ id: 'anilist:4242', anilistId: 4242 });
    await repo.upsertMediaItem(item);
    await repo.setLibraryStatus(item.id, 'WATCHING');
    await adapter.execute(
      'UPDATE library_entries SET updated_at = ? WHERE media_item_id = ?',
      [new Date(Date.now() - 120_000).toISOString(), item.id]
    );

    let editedDuringPush = false;
    const client: SupabaseSyncClient = {
      upsert: jest.fn(async (table) => {
        if (table === 'library_entries' && !editedDuringPush) {
          editedDuringPush = true;
          // Simulate a user changing score locally while the async push is in flight
          await repo.updatePersonalScore(item.id, 10);
        }
        return { error: null };
      }),
      selectUpdatedSince: jest.fn(async () => ({ data: [], error: null })),
    };

    const engine = new SupabaseSyncEngine(adapter, client);
    await expect(engine.syncNow('   ')).rejects.toThrow(/userId/i);

    const [first, second] = await Promise.all([
      engine.syncNow('user-uuid-1'),
      engine.syncNow('user-uuid-1'),
    ]);

    expect(first.status).toBe('SYNCED');
    expect(second.status).toBe('SYNCED');
    // The mid-flight edit stayed dirty during first sync and was cleanly pushed by the queued second sync
    expect(await engine.getDirtyCount()).toBe(0);
    const [entry] = await repo.getAllLibraryEntries();
    expect(entry.personalScore).toBe(10);
  });

  it('hydrates missing parent media_items when incremental pull delivers only watch_history and unitv_links', async () => {
    const nowMs = Date.now();
    const isoAgo = (minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString();

    await repo.saveSettings({ lastSyncAt: isoAgo(60) });

    const remoteMedia = makeMediaItem({
      id: 'anilist:9981',
      anilistId: 9981,
      titleRomaji: 'Frieren',
      cachedAt: isoAgo(180),
    });

    const fakeClient: SupabaseSyncClient = {
      upsert: jest.fn(async () => ({ error: null })),
      selectUpdatedSince: jest.fn(async (table, userId, sinceIso) => {
        if (table === 'media_items' && sinceIso === null) {
          return {
            data: [
              {
                id: remoteMedia.id,
                user_id: userId,
                media_type: remoteMedia.mediaType,
                anilist_id: remoteMedia.anilistId,
                mal_id: remoteMedia.malId,
                tmdb_id: remoteMedia.tmdbId,
                title_romaji: remoteMedia.titleRomaji,
                title_english: remoteMedia.titleEnglish,
                title_pt: remoteMedia.titlePt,
                synopsis: remoteMedia.synopsis,
                cover_url: remoteMedia.coverUrl,
                banner_url: remoteMedia.bannerUrl,
                genres_json: remoteMedia.genresJson,
                season_year: remoteMedia.seasonYear,
                season_name: remoteMedia.seasonName,
                episodes_total: remoteMedia.episodesTotal,
                status_airing: remoteMedia.statusAiring,
                next_airing_at: remoteMedia.nextAiringAt,
                next_airing_ep: remoteMedia.nextAiringEp,
                relations_json: remoteMedia.relationsJson,
                cached_at: remoteMedia.cachedAt,
                updated_at: remoteMedia.cachedAt,
              },
            ],
            error: null,
          };
        }
        if (table === 'watch_history') {
          return {
            data: [
              {
                id: 'hist-frieren-1',
                user_id: userId,
                media_item_id: remoteMedia.id,
                episode_number: 5,
                action: 'COMPLETED',
                occurred_at: isoAgo(15),
                updated_at: isoAgo(15),
              },
              // Orphaned row referencing nonexistent parent should be skipped safely without FK crash
              {
                id: 'hist-orphan',
                user_id: userId,
                media_item_id: 'nonexistent-media-id',
                episode_number: 1,
                action: 'STARTED',
                occurred_at: isoAgo(10),
                updated_at: isoAgo(10),
              },
            ],
            error: null,
          };
        }
        if (table === 'unitv_links') {
          return {
            data: [
              {
                user_id: userId,
                media_item_id: remoteMedia.id,
                unitv_vod_id: 'vod-frieren',
                unitv_title: 'Frieren Beyond Journey',
                unitv_season_tag: 'S1',
                preferred_audio_or_sub: 'SUB',
                last_verified_at: isoAgo(12),
                updated_at: isoAgo(12),
              },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      }),
    };

    const engine = new SupabaseSyncEngine(adapter, fakeClient);
    const result = await engine.syncNow('user-uuid-1');

    expect(result.status).toBe('SYNCED');
    expect(result.pulledCount).toBe(3); // 1 media_item + 1 watch_history + 1 unitv_link
    expect(await repo.getMediaItemById(remoteMedia.id)).not.toBeNull();
    expect(await repo.getWatchHistory(remoteMedia.id)).toHaveLength(1);
    expect((await repo.getUniTvLink(remoteMedia.id))?.unitvVodId).toBe('vod-frieren');
  });

  it('merges multi-device records for the same anilist_id and unique keys without overwriting local media_items.id or failing constraints', async () => {
    const nowMs = Date.now();
    const isoAgo = (minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString();

    // Unrelated local row whose id happens to match Device 1's legacy/temp id
    const unrelatedLocal = makeMediaItem({
      id: 'device1-media-uuid',
      anilistId: 100,
      titleRomaji: 'Other Anime',
      cachedAt: isoAgo(300),
    });
    await repo.upsertMediaItem(unrelatedLocal);

    // Local device already cached Solo Leveling under anilist:151807 and created local entry/progress
    const localMedia = makeMediaItem({
      id: 'anilist:151807',
      anilistId: 151807,
      titleRomaji: 'Ore dake Level Up na Ken',
      cachedAt: isoAgo(240),
    });
    await repo.upsertMediaItem(localMedia);
    await repo.setLibraryStatus(localMedia.id, 'PLAN_TO_WATCH');
    await repo.recordPlaybackProgress({
      mediaItemId: localMedia.id,
      episodeNumber: 1,
      positionSeconds: 120,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });

    await adapter.execute(
      'UPDATE library_entries SET id = ?, updated_at = ?, dirty = 0 WHERE media_item_id = ?',
      ['device2-entry-id', isoAgo(180), localMedia.id]
    );
    await adapter.execute(
      'UPDATE episode_progress SET id = ?, updated_at = ?, dirty = 0 WHERE media_item_id = ? AND episode_number = 1',
      ['device2-ep-id', isoAgo(180), localMedia.id]
    );
    await adapter.execute('UPDATE watch_history SET dirty = 0');

    const fakeClient: SupabaseSyncClient = {
      upsert: jest.fn(async () => ({ error: null })),
      selectUpdatedSince: jest.fn(async (table, userId) => {
        if (table === 'media_items') {
          return {
            data: [
              {
                id: 'device1-media-uuid',
                user_id: userId,
                media_type: 'ANIME',
                anilist_id: 151807,
                mal_id: 52299,
                tmdb_id: 127532,
                title_romaji: 'Ore dake Level Up na Ken',
                title_english: 'Solo Leveling',
                title_pt: 'Solo Leveling (Atualizado)',
                synopsis: 'Updated synopsis',
                cover_url: localMedia.coverUrl,
                banner_url: localMedia.bannerUrl,
                genres_json: localMedia.genresJson,
                season_year: 2024,
                season_name: 'WINTER',
                episodes_total: 12,
                status_airing: 'FINISHED',
                next_airing_at: null,
                next_airing_ep: null,
                relations_json: '[]',
                cached_at: isoAgo(30),
                updated_at: isoAgo(30),
              },
            ],
            error: null,
          };
        }
        if (table === 'library_entries') {
          return {
            data: [
              {
                id: 'device1-entry-uuid',
                user_id: userId,
                media_item_id: 'device1-media-uuid',
                status: 'WATCHING',
                personal_score: 9,
                current_episode: 1,
                notes: 'Synced from device 1',
                rewatch_count: 0,
                started_at: isoAgo(60),
                completed_at: null,
                updated_at: isoAgo(20),
              },
            ],
            error: null,
          };
        }
        if (table === 'episode_progress') {
          return {
            data: [
              {
                id: 'device1-ep-uuid',
                user_id: userId,
                media_item_id: 'device1-media-uuid',
                episode_number: 1,
                position_seconds: 1350,
                duration_seconds: 1440,
                is_completed: true,
                watched_via: 'APP_PLAYER',
                updated_at: isoAgo(20),
              },
            ],
            error: null,
          };
        }
        if (table === 'watch_history') {
          return {
            data: [
              {
                id: 'device1-hist-uuid',
                user_id: userId,
                media_item_id: 'device1-media-uuid',
                episode_number: 1,
                action: 'COMPLETED',
                occurred_at: isoAgo(20),
                updated_at: isoAgo(20),
              },
            ],
            error: null,
          };
        }
        if (table === 'unitv_links') {
          return {
            data: [
              {
                user_id: userId,
                media_item_id: 'device1-media-uuid',
                unitv_vod_id: 'vod-device1',
                unitv_title: 'Solo Leveling DUB',
                unitv_season_tag: 'S1',
                preferred_audio_or_sub: 'DUB',
                last_verified_at: isoAgo(20),
                updated_at: isoAgo(20),
              },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      }),
    };

    const engine = new SupabaseSyncEngine(adapter, fakeClient);
    const result = await engine.syncNow('user-uuid-1');

    expect(result.status).toBe('SYNCED');
    expect(result.pulledCount).toBe(5);

    // Local media_items.id preserved and unrelated row untouched
    const soloMedia = await repo.getMediaItemByAnilistId(151807);
    expect(soloMedia?.id).toBe('anilist:151807');
    expect(soloMedia?.titlePt).toBe('Solo Leveling (Atualizado)');
    expect((await repo.getMediaItemByAnilistId(100))?.id).toBe('device1-media-uuid');

    // Child tables updated/inserted under local media_items.id with dirty = 0
    const [entry] = await repo.getAllLibraryEntries();
    expect(entry).toMatchObject({
      id: 'device2-entry-id',
      mediaItemId: 'anilist:151807',
      status: 'WATCHING',
      personalScore: 9,
      notes: 'Synced from device 1',
      dirty: 0,
    });

    const [ep1] = await repo.getEpisodeProgressList('anilist:151807');
    expect(ep1).toMatchObject({
      id: 'device2-ep-id',
      mediaItemId: 'anilist:151807',
      episodeNumber: 1,
      positionSeconds: 1350,
      isCompleted: true,
      dirty: 0,
    });

    const history = await repo.getWatchHistory('anilist:151807');
    expect(history.some((h) => h.id === 'device1-hist-uuid' && h.dirty === 0)).toBe(true);
    expect((await repo.getUniTvLink('anilist:151807'))?.unitvVodId).toBe('vod-device1');
  });

  it('does not overwrite newer remote edits on a stateful server when syncing older offline dirty edits', async () => {
    const nowMs = Date.now();
    const isoAgo = (minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString();

    const sharedMedia = makeMediaItem({
      id: 'anilist:151807',
      anilistId: 151807,
      cachedAt: isoAgo(300),
    });
    const deviceAMedia = makeMediaItem({
      id: 'anilist:21',
      anilistId: 21,
      titleRomaji: 'One Piece',
      cachedAt: isoAgo(20),
    });

    // Stateful remote store that unconditionally overwrites on upsert (modeling PostgREST without triggers)
    const remoteStore: Record<string, Array<Record<string, unknown>>> = {
      media_items: [
        {
          id: sharedMedia.id,
          user_id: 'user-uuid-1',
          media_type: sharedMedia.mediaType,
          anilist_id: sharedMedia.anilistId,
          mal_id: sharedMedia.malId,
          tmdb_id: sharedMedia.tmdbId,
          title_romaji: sharedMedia.titleRomaji,
          title_english: sharedMedia.titleEnglish,
          title_pt: sharedMedia.titlePt,
          synopsis: sharedMedia.synopsis,
          cover_url: sharedMedia.coverUrl,
          banner_url: sharedMedia.bannerUrl,
          genres_json: sharedMedia.genresJson,
          season_year: sharedMedia.seasonYear,
          season_name: sharedMedia.seasonName,
          episodes_total: sharedMedia.episodesTotal,
          status_airing: sharedMedia.statusAiring,
          next_airing_at: sharedMedia.nextAiringAt,
          next_airing_ep: sharedMedia.nextAiringEp,
          relations_json: sharedMedia.relationsJson,
          cached_at: sharedMedia.cachedAt,
          updated_at: sharedMedia.cachedAt,
        },
      ],
      library_entries: [
        {
          id: 'remote-entry-b',
          user_id: 'user-uuid-1',
          media_item_id: sharedMedia.id,
          status: 'WATCHING',
          personal_score: 9,
          current_episode: 8,
          notes: 'Device B ep 8',
          rewatch_count: 0,
          started_at: isoAgo(300),
          completed_at: null,
          updated_at: isoAgo(30), // Newer than Device A's 60m-ago stale edit
        },
      ],
      episode_progress: [
        {
          id: 'remote-ep8-b',
          user_id: 'user-uuid-1',
          media_item_id: sharedMedia.id,
          episode_number: 8,
          position_seconds: 1400,
          duration_seconds: 1440,
          is_completed: true,
          watched_via: 'APP_PLAYER',
          updated_at: isoAgo(30),
        },
      ],
      watch_history: [],
      unitv_links: [
        {
          user_id: 'user-uuid-1',
          media_item_id: sharedMedia.id,
          unitv_vod_id: 'vod-device-b',
          unitv_title: 'Solo Leveling B',
          unitv_season_tag: 'S1',
          preferred_audio_or_sub: 'SUB',
          last_verified_at: isoAgo(30),
          updated_at: isoAgo(30),
        },
      ],
    };

    const statefulClient: SupabaseSyncClient = {
      upsert: jest.fn(async (table, rows) => {
        const list = remoteStore[table];
        for (const row of rows) {
          const idx = list.findIndex((existing) => {
            if (table === 'media_items') {
              return existing.user_id === row.user_id && existing.anilist_id === row.anilist_id;
            }
            if (table === 'library_entries' || table === 'unitv_links') {
              return (
                existing.user_id === row.user_id &&
                existing.media_item_id === row.media_item_id
              );
            }
            if (table === 'episode_progress') {
              return (
                existing.user_id === row.user_id &&
                existing.media_item_id === row.media_item_id &&
                existing.episode_number === row.episode_number
              );
            }
            return existing.user_id === row.user_id && existing.id === row.id;
          });
          if (idx >= 0) {
            list[idx] = { ...row };
          } else {
            list.push({ ...row });
          }
        }
        return { error: null };
      }),
      selectUpdatedSince: jest.fn(async (table, userId, sinceIso) => {
        const rows = remoteStore[table].filter((row) => {
          if (row.user_id !== userId) {
            return false;
          }
          if (!sinceIso) {
            return true;
          }
          return Date.parse(String(row.updated_at)) > Date.parse(sinceIso);
        });
        return { data: rows.map((r) => ({ ...r })), error: null };
      }),
    };

    // Device A synced earlier at 120m ago, then made older offline edits at 60m ago + a newer edit at 10m ago
    await repo.saveSettings({ lastSyncAt: isoAgo(120) });
    await repo.upsertMediaItem(sharedMedia);
    await repo.setLibraryStatus(sharedMedia.id, 'WATCHING');
    await repo.updateNotes(sharedMedia.id, 'Device A stale offline edit');
    await repo.recordPlaybackProgress({
      mediaItemId: sharedMedia.id,
      episodeNumber: 8,
      positionSeconds: 200,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });
    await repo.saveUniTvLink({
      mediaItemId: sharedMedia.id,
      unitvVodId: 'vod-device-a-stale',
      unitvTitle: 'Solo Leveling A',
      unitvSeasonTag: 'S1',
      preferredAudioOrSub: 'DUB',
      lastVerifiedAt: isoAgo(60),
    });

    await adapter.execute(
      `UPDATE library_entries SET current_episode = 3, personal_score = 5, updated_at = ?, dirty = 1 WHERE media_item_id = ?`,
      [isoAgo(60), sharedMedia.id]
    );
    await adapter.execute(
      `UPDATE episode_progress SET updated_at = ?, dirty = 1 WHERE media_item_id = ? AND episode_number = 8`,
      [isoAgo(60), sharedMedia.id]
    );

    // Newer local entry on Device A (10m ago) must still push cleanly
    await repo.upsertMediaItem(deviceAMedia);
    await repo.setLibraryStatus(deviceAMedia.id, 'PLAN_TO_WATCH');
    await adapter.execute(
      `UPDATE library_entries SET updated_at = ?, dirty = 1 WHERE media_item_id = ?`,
      [isoAgo(10), deviceAMedia.id]
    );

    const engine = new SupabaseSyncEngine(adapter, statefulClient);
    const result = await engine.syncNow('user-uuid-1');

    expect(result.status).toBe('SYNCED');
    expect(await engine.getDirtyCount()).toBe(0);

    // Remote server MUST keep Device B's newer 30m-ago rows instead of Device A's stale 60m-ago rows
    const remoteSoloEntry = remoteStore.library_entries.find(
      (r) => r.media_item_id === sharedMedia.id
    );
    expect(remoteSoloEntry).toMatchObject({
      current_episode: 8,
      notes: 'Device B ep 8',
      personal_score: 9,
    });

    const remoteSoloEp8 = remoteStore.episode_progress.find(
      (r) => r.media_item_id === sharedMedia.id && r.episode_number === 8
    );
    expect(remoteSoloEp8).toMatchObject({
      position_seconds: 1400,
      is_completed: true,
    });

    const remoteSoloLink = remoteStore.unitv_links.find(
      (r) => r.media_item_id === sharedMedia.id
    );
    expect(remoteSoloLink?.unitv_vod_id).toBe('vod-device-b');

    // Device A's newer entry on anilist:21 WAS pushed to remote
    const remoteOpEntry = remoteStore.library_entries.find(
      (r) => r.media_item_id === deviceAMedia.id
    );
    expect(remoteOpEntry?.status).toBe('PLAN_TO_WATCH');

    // Local SQLite converged to Device B's newer state cleanly
    const localEntries = await repo.getAllLibraryEntries();
    const localSolo = localEntries.find((e) => e.mediaItemId === sharedMedia.id);
    expect(localSolo).toMatchObject({
      currentEpisode: 8,
      notes: 'Device B ep 8',
      personalScore: 9,
      dirty: 0,
    });
    const [localEp8] = await repo.getEpisodeProgressList(sharedMedia.id);
    expect(localEp8).toMatchObject({
      positionSeconds: 1400,
      isCompleted: true,
      dirty: 0,
    });
    expect((await repo.getUniTvLink(sharedMedia.id))?.unitvVodId).toBe('vod-device-b');
  });
});
