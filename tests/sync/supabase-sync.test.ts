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
    await repo.upsertMediaItem(localItem);
    await repo.setLibraryStatus(localItem.id, 'WATCHING');
    await repo.updatePersonalScore(localItem.id, 8);
    await repo.updateNotes(localItem.id, 'Local initial note');
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

    // media_items (1) + library_entries (1) + episode_progress (1) + watch_history (2) + unitv_links (1) = 6
    expect(result.status).toBe('SYNCED');
    expect(result.pushedCount).toBe(6);
    // pulled: media_items (1) + library_entries (2) + episode_progress (1 applied, 1 ignored) + watch_history (1) + unitv_links (1) = 6
    expect(result.pulledCount).toBe(6);

    // FK integrity: media_items must be pushed first
    expect(pushCalls[0].table).toBe('media_items');
    expect(pushCalls.map((c) => c.table)).toEqual([
      'media_items',
      'library_entries',
      'episode_progress',
      'watch_history',
      'unitv_links',
    ]);

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
    expect(allEntries).toHaveLength(2);
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

    it('preserves lastSyncAt when pull fails after push succeeds, while keeping pushed rows marked clean', async () => {
      const item = makeMediaItem({ id: 'anilist:999', anilistId: 999 });
      await repo.upsertMediaItem(item);
      await repo.setLibraryStatus(item.id, 'WATCHING');

      const previousSyncAt = '2026-11-15T10:00:00.000Z';
      await repo.saveSettings({ lastSyncAt: previousSyncAt });

      const engine = new SupabaseSyncEngine(adapter, {
        upsert: jest.fn(async () => ({ error: null })),
        selectUpdatedSince: jest.fn(async () => ({
          data: null,
          error: { message: 'Project is paused', status: 503 },
        })),
      });

      const result = await engine.syncNow('user-uuid-1');
      expect(result.status).toBe('DEFERRED_OFFLINE_OR_PAUSED');
      expect(result.pulledCount).toBe(0);
      expect(result.errorMessage).toContain('Project is paused');
      // Push succeeded and cleared dirty = 0, while lastSyncAt stayed at previousSyncAt so pull isn't skipped
      expect(await engine.getDirtyCount()).toBe(0);
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
});
