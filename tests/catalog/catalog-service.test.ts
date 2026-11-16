import {
  DatabaseAdapter,
  initializeDatabase,
  MediaItemRecord,
} from '../../src/db/schema';
import { LibraryRepository } from '../../src/db/library-repository';
import {
  AniListClient,
  CatalogFilter,
  CatalogRateLimitError,
  CatalogRelation,
  FranchiseNode,
  JikanClient,
  TmdbClient,
} from '../../src/catalog/types';
import { AniListHttpClient } from '../../src/catalog/anilist-client';
import { JikanHttpClient } from '../../src/catalog/jikan-client';
import { TmdbHttpClient } from '../../src/catalog/tmdb-client';
import { CatalogService } from '../../src/catalog/catalog-service';

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
    malId: overrides.malId !== undefined ? overrides.malId : null,
    tmdbId: overrides.tmdbId !== undefined ? overrides.tmdbId : null,
    titleRomaji: overrides.titleRomaji ?? 'Ore dake Level Up na Ken',
    titleEnglish: overrides.titleEnglish !== undefined ? overrides.titleEnglish : 'Solo Leveling',
    titlePt: overrides.titlePt !== undefined ? overrides.titlePt : null,
    synopsis:
      overrides.synopsis !== undefined
        ? overrides.synopsis
        : 'E-rank hunter awakens a mysterious system.',
    coverUrl: overrides.coverUrl ?? `https://img.example.com/${anilistId}.jpg`,
    bannerUrl:
      overrides.bannerUrl !== undefined
        ? overrides.bannerUrl
        : `https://img.example.com/${anilistId}-banner.jpg`,
    genresJson: overrides.genresJson ?? JSON.stringify(['Action', 'Adventure', 'Fantasy']),
    seasonYear: overrides.seasonYear !== undefined ? overrides.seasonYear : 2024,
    seasonName: overrides.seasonName !== undefined ? overrides.seasonName : 'WINTER',
    episodesTotal: overrides.episodesTotal !== undefined ? overrides.episodesTotal : 12,
    statusAiring: overrides.statusAiring ?? 'FINISHED',
    nextAiringAt: overrides.nextAiringAt !== undefined ? overrides.nextAiringAt : null,
    nextAiringEp: overrides.nextAiringEp !== undefined ? overrides.nextAiringEp : null,
    relationsJson: overrides.relationsJson ?? '[]',
    cachedAt: overrides.cachedAt ?? '2026-11-16T10:00:00.000Z',
  };
}

function createStubAniList(overrides: Partial<AniListClient> = {}): AniListClient {
  return {
    getHomeFeed: jest.fn(async () => ({ trendingMonth: [], currentSeason: [] })),
    searchCatalog: jest.fn(async () => []),
    getWeeklySchedule: jest.fn(async () => []),
    getUpcomingSeasons: jest.fn(async () => []),
    ...overrides,
  };
}

function createStubJikan(overrides: Partial<JikanClient> = {}): JikanClient {
  return {
    getTopTrending: jest.fn(async () => []),
    getCurrentSeason: jest.fn(async () => []),
    searchCatalog: jest.fn(async () => []),
    getWeeklySchedule: jest.fn(async () => []),
    getUpcomingSeasons: jest.fn(async () => []),
    ...overrides,
  };
}

function createStubTmdb(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    searchAnimePtBr: jest.fn(async () => []),
    ...overrides,
  };
}

describe('CatalogService & API Clients', () => {
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

  describe('HTTP 429 & offline cache fallback (Review Focus #3)', () => {
    it('falls back to JikanClient and caches results when AniList throws HTTP 429', async () => {
      const jikanAnime = makeMediaItem({
        id: 'mal:52991',
        anilistId: -52991,
        malId: 52991,
        titleRomaji: 'Sousou no Frieren',
        titleEnglish: 'Frieren: Beyond Journey\'s End',
        genresJson: JSON.stringify(['Adventure', 'Drama', 'Fantasy']),
      });

      const aniListClient = createStubAniList({
        searchCatalog: jest.fn(async () => {
          throw new CatalogRateLimitError('ANILIST', 'Too Many Requests', 60);
        }),
      });
      const jikanClient = createStubJikan({
        searchCatalog: jest.fn(async () => [jikanAnime]),
      });

      const service = new CatalogService(repo, {
        aniListClient,
        jikanClient,
        tmdbClient: createStubTmdb(),
      });

      const results = await service.exploreCatalog({ query: 'Frieren' }, new Set());

      expect(results).toHaveLength(1);
      expect(results[0].titleRomaji).toBe('Sousou no Frieren');
      expect(results[0].malId).toBe(52991);

      const persisted = await repo.getAllMediaItems();
      expect(persisted).toHaveLength(1);
      expect(persisted[0].titleRomaji).toBe('Sousou no Frieren');
    });

    it('returns filtered cached SQLite MediaItemRecord[] when both AniList and Jikan fail', async () => {
      await repo.upsertMediaItem(
        makeMediaItem({
          id: 'cached-frieren',
          anilistId: 154587,
          titleRomaji: 'Sousou no Frieren',
          titleEnglish: 'Frieren: Beyond Journey\'s End',
          genresJson: JSON.stringify(['Adventure', 'Drama', 'Fantasy']),
          seasonYear: 2023,
          seasonName: 'FALL',
        })
      );
      await repo.upsertMediaItem(
        makeMediaItem({
          id: 'cached-dandadan',
          anilistId: 171018,
          titleRomaji: 'Dandadan',
          titleEnglish: 'DAN DA DAN',
          genresJson: JSON.stringify(['Action', 'Comedy', 'Sci-Fi']),
          seasonYear: 2024,
          seasonName: 'FALL',
        })
      );

      const aniListClient = createStubAniList({
        searchCatalog: jest.fn(async () => {
          throw new CatalogRateLimitError('ANILIST');
        }),
      });
      const jikanClient = createStubJikan({
        searchCatalog: jest.fn(async () => {
          throw new Error('Network request failed');
        }),
      });

      const service = new CatalogService(repo, {
        aniListClient,
        jikanClient,
        tmdbClient: createStubTmdb(),
      });

      const results = await service.exploreCatalog(
        { query: 'Frieren', genres: ['Fantasy'] },
        new Set()
      );

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('cached-frieren');
      expect(results[0].anilistId).toBe(154587);
    });
  });

  describe('exploreCatalog hideCompleted filtering', () => {
    it('omits completed titles matching media.id, anilist_<id>, or anilist:<id> when hideCompleted is true', async () => {
      await repo.upsertMediaItem(
        makeMediaItem({
          id: 'custom-db-id-1',
          anilistId: 101,
          titleRomaji: 'Anime One',
        })
      );

      const remoteResults = [
        makeMediaItem({ id: 'anilist:101', anilistId: 101, titleRomaji: 'Anime One' }),
        makeMediaItem({ id: 'anilist:202', anilistId: 202, titleRomaji: 'Anime Two' }),
        makeMediaItem({ id: 'anilist:303', anilistId: 303, titleRomaji: 'Anime Three' }),
        makeMediaItem({ id: 'anilist:404', anilistId: 404, titleRomaji: 'Anime Four' }),
      ];

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({
          searchCatalog: jest.fn(async () => remoteResults),
        }),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb(),
      });

      const completedMediaIds = new Set<string>([
        'custom-db-id-1',
        'anilist_202',
        'anilist:303',
      ]);

      const filtered = await service.exploreCatalog(
        { hideCompleted: true },
        completedMediaIds
      );
      expect(filtered.map((item) => item.anilistId)).toEqual([404]);

      const unfiltered = await service.exploreCatalog(
        { hideCompleted: false },
        completedMediaIds
      );
      expect(unfiltered.map((item) => item.anilistId)).toEqual([101, 202, 303, 404]);
    });
  });

  describe('Weekly schedule, Upcoming radar & Franchise timeline (Review Focus #5)', () => {
    it('groups weekly airing episodes into weekdays 0..6 and marks inUserActiveList only for WATCHING and PLAN_TO_WATCH', async () => {
      const sundayNoon = Math.floor(new Date(2026, 10, 15, 12, 0, 0).getTime() / 1000);
      const wednesdayEvening = Math.floor(new Date(2026, 10, 18, 20, 30, 0).getTime() / 1000);
      const wednesdayMorning = Math.floor(new Date(2026, 10, 18, 9, 0, 0).getTime() / 1000);

      const mediaWatching = makeMediaItem({ id: 'db-watch', anilistId: 11, titleRomaji: 'Watching Show' });
      const mediaPlan = makeMediaItem({ id: 'anilist:12', anilistId: 12, titleRomaji: 'Plan Show' });
      const mediaPaused = makeMediaItem({ id: 'anilist:13', anilistId: 13, titleRomaji: 'Paused Show' });
      const mediaCompleted = makeMediaItem({ id: 'anilist:14', anilistId: 14, titleRomaji: 'Completed Show' });

      await repo.upsertMediaItem(mediaWatching);
      await repo.upsertMediaItem(mediaPlan);
      await repo.upsertMediaItem(mediaPaused);
      await repo.upsertMediaItem(mediaCompleted);

      const watchingEntry = await repo.setLibraryStatus('db-watch', 'WATCHING');
      const planEntry = await repo.setLibraryStatus('anilist:12', 'PLAN_TO_WATCH');
      const pausedEntry = await repo.setLibraryStatus('anilist:13', 'PAUSED');
      const completedEntry = await repo.setLibraryStatus('anilist:14', 'COMPLETED');

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({
          getWeeklySchedule: jest.fn(async () => [
            { media: makeMediaItem({ anilistId: 11, titleRomaji: 'Watching Show' }), episodeNumber: 7, airingAtUnix: sundayNoon },
            { media: mediaPlan, episodeNumber: 3, airingAtUnix: wednesdayEvening },
            { media: mediaPaused, episodeNumber: 5, airingAtUnix: wednesdayMorning },
            { media: mediaCompleted, episodeNumber: 12, airingAtUnix: wednesdayEvening + 3600 },
          ]),
        }),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb(),
      });

      const schedule = await service.getWeeklySchedule([
        watchingEntry,
        planEntry,
        pausedEntry,
        completedEntry,
      ]);

      expect(Object.keys(schedule).map(Number).sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6,
      ]);

      expect(schedule[0]).toHaveLength(1);
      expect(schedule[0][0]).toMatchObject({
        episodeNumber: 7,
        airingAtUnix: sundayNoon,
        weekdayIndex: 0,
        inUserActiveList: true,
      });
      expect(schedule[0][0].media.id).toBe('db-watch');

      expect(schedule[3].map((e) => e.media.anilistId)).toEqual([13, 12, 14]);
      expect(schedule[3].map((e) => e.inUserActiveList)).toEqual([false, true, false]);
      expect(schedule[1]).toEqual([]);
    });

    it('marks isSequelToLibraryItem = true when an upcoming NOT_YET_RELEASED anime references a PREQUEL in user library and formats releaseLabel', async () => {
      const prequelInDb = makeMediaItem({
        id: 'existing-uuid-solo-s1',
        anilistId: 151807,
        titleRomaji: 'Ore dake Level Up na Ken',
        statusAiring: 'FINISHED',
      });
      await repo.upsertMediaItem(prequelInDb);
      const completedS1 = await repo.setLibraryStatus('existing-uuid-solo-s1', 'COMPLETED');

      const upcomingSequel = makeMediaItem({
        anilistId: 176496,
        titleRomaji: 'Ore dake Level Up na Ken Season 3',
        statusAiring: 'NOT_YET_RELEASED',
        seasonYear: 2027,
        seasonName: 'WINTER',
        relationsJson: JSON.stringify([
          {
            anilistId: 151807,
            title: 'Solo Leveling',
            format: 'TV',
            relationType: 'PREQUEL',
            seasonYear: 2024,
          } satisfies CatalogRelation,
        ]),
      });

      const upcomingOriginal = makeMediaItem({
        anilistId: 199001,
        titleRomaji: 'New Original Fantasy',
        statusAiring: 'NOT_YET_RELEASED',
        seasonYear: 2027,
        seasonName: 'SPRING',
        relationsJson: '[]',
      });

      const upcomingTba = makeMediaItem({
        anilistId: 199002,
        titleRomaji: 'Mystery Project',
        statusAiring: 'NOT_YET_RELEASED',
        seasonYear: null,
        seasonName: null,
        relationsJson: JSON.stringify([
          {
            anilistId: 888888,
            title: 'Unwatched Prequel',
            format: 'TV',
            relationType: 'PREQUEL',
          } satisfies CatalogRelation,
        ]),
      });

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({
          getUpcomingSeasons: jest.fn(async () => [
            { media: upcomingSequel, startMonth: 1 },
            { media: upcomingOriginal, startMonth: null },
            { media: upcomingTba, startMonth: null },
          ]),
        }),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb(),
      });

      const radar = await service.getUpcomingSeasonsRadar([completedS1]);

      expect(radar).toHaveLength(3);
      expect(radar[0]).toMatchObject({
        releaseLabel: 'Janeiro/2027',
        isSequelToLibraryItem: true,
      });
      expect(radar[0].media.anilistId).toBe(176496);

      expect(radar[1]).toMatchObject({
        releaseLabel: 'Primavera 2027',
        isSequelToLibraryItem: false,
      });

      expect(radar[2]).toMatchObject({
        releaseLabel: 'Em breve',
        isSequelToLibraryItem: false,
      });
    });

    it('orders franchise timeline [PREQUEL, CURRENT, SEQUEL, SIDE_STORY] deterministically and attaches userStatus', async () => {
      const prequel = makeMediaItem({ id: 'anilist:100', anilistId: 100, titleRomaji: 'Part 1' });
      const current = makeMediaItem({
        id: 'anilist:200',
        anilistId: 200,
        titleRomaji: 'Part 2',
        titleEnglish: 'Part 2 EN',
        seasonYear: 2024,
        relationsJson: JSON.stringify([
          { anilistId: 400, title: 'Bonus OVA', format: 'OVA', relationType: 'SIDE_STORY', seasonYear: 2024 },
          { anilistId: 300, title: 'Part 3', format: 'TV', relationType: 'SEQUEL', seasonYear: 2025 },
          { anilistId: 999, title: 'Manga Source', format: 'MANGA', relationType: 'ADAPTATION' },
          { anilistId: 100, title: 'Part 1', format: 'TV', relationType: 'PREQUEL', seasonYear: 2023 },
        ] satisfies CatalogRelation[]),
      });
      const sequel = makeMediaItem({ id: 'anilist:300', anilistId: 300, titleRomaji: 'Part 3' });

      await repo.upsertMediaItem(prequel);
      await repo.upsertMediaItem(current);
      await repo.upsertMediaItem(sequel);

      const s1Entry = await repo.setLibraryStatus('anilist:100', 'COMPLETED');
      const s2Entry = await repo.setLibraryStatus('anilist:200', 'WATCHING');

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList(),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb(),
      });

      const timeline = service.buildFranchiseTimeline(current, [s1Entry, s2Entry]);

      expect(timeline).toEqual<FranchiseNode[]>([
        {
          anilistId: 100,
          title: 'Part 1',
          format: 'TV',
          relationType: 'PREQUEL',
          userStatus: 'COMPLETED',
        },
        {
          anilistId: 200,
          title: 'Part 2 EN',
          format: 'ANIME',
          relationType: 'CURRENT',
          userStatus: 'WATCHING',
        },
        {
          anilistId: 300,
          title: 'Part 3',
          format: 'TV',
          relationType: 'SEQUEL',
        },
        {
          anilistId: 400,
          title: 'Bonus OVA',
          format: 'OVA',
          relationType: 'SIDE_STORY',
        },
      ]);
    });
  });

  describe('Optional TMDB pt-BR enrichment', () => {
    it('skips TMDB completely when tmdbApiKey is null', async () => {
      const tmdbSearch = jest.fn(async () => []);
      const media = makeMediaItem({
        anilistId: 16498,
        titleRomaji: 'Shingeki no Kyojin',
        titleEnglish: 'Attack on Titan',
        titlePt: null,
      });

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({
          searchCatalog: jest.fn(async () => [media]),
        }),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb({ searchAnimePtBr: tmdbSearch }),
      });

      const searchResults = await service.exploreCatalog({ query: 'Attack on Titan' }, new Set());
      const enriched = await service.enrichWithPortugueseIfConfigured(media);

      expect(tmdbSearch).not.toHaveBeenCalled();
      expect(searchResults[0].titlePt).toBeNull();
      expect(enriched).toEqual(media);
    });

    it('resolves Portuguese query terms and populates titlePt/synopsis/tmdbId when tmdbApiKey is configured', async () => {
      await repo.saveSettings({ tmdbApiKey: 'tmdb-free-key-123' });

      const aniListMedia = makeMediaItem({
        anilistId: 16498,
        titleRomaji: 'Shingeki no Kyojin',
        titleEnglish: 'Attack on Titan',
        titlePt: null,
        synopsis: 'Centuries ago, mankind was slaughtered to near extinction by titans.',
      });

      const searchCatalogMock = jest.fn(async (filter: CatalogFilter) => {
        if (filter.query === 'Shingeki no Kyojin') {
          return [aniListMedia];
        }
        return [];
      });

      const tmdbSearchMock = jest.fn(async (query: string, apiKey: string) => {
        if (apiKey !== 'tmdb-free-key-123') {
          return [];
        }
        if (query === 'Ataque dos Titãs' || query === 'Attack on Titan') {
          return [
            {
              tmdbId: 1429,
              titlePt: 'Ataque dos Titãs',
              originalTitle: 'Shingeki no Kyojin',
              overviewPt: 'A humanidade vive cercada por muralhas gigantes para se proteger dos titãs.',
              mediaType: 'tv' as const,
            },
          ];
        }
        return [];
      });

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({ searchCatalog: searchCatalogMock }),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb({ searchAnimePtBr: tmdbSearchMock }),
      });

      const results = await service.exploreCatalog({ query: 'Ataque dos Titãs' }, new Set());

      expect(tmdbSearchMock).toHaveBeenCalledWith('Ataque dos Titãs', 'tmdb-free-key-123');
      expect(searchCatalogMock).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Shingeki no Kyojin' })
      );
      expect(results).toHaveLength(1);
      expect(results[0].titlePt).toBe('Ataque dos Titãs');
      expect(results[0].tmdbId).toBe(1429);
      expect(results[0].synopsis).toBe(
        'A humanidade vive cercada por muralhas gigantes para se proteger dos titãs.'
      );

      const saved = await repo.getMediaItemByAnilistId(16498);
      expect(saved?.titlePt).toBe('Ataque dos Titãs');
      expect(saved?.tmdbId).toBe(1429);

      const directEnriched = await service.enrichWithPortugueseIfConfigured(
        makeMediaItem({
          anilistId: 16498,
          titleRomaji: 'Shingeki no Kyojin',
          titleEnglish: 'Attack on Titan',
          titlePt: null,
          tmdbId: null,
        })
      );
      expect(directEnriched.titlePt).toBe('Ataque dos Titãs');
    });

    it('does not overwrite AniList results with mismatched Western TMDB matches on direct query, while matching Japanese same-year Kanji TMDB entries', async () => {
      await repo.saveSettings({ tmdbApiKey: 'tmdb-free-key-123' });

      const dragonBallZ = makeMediaItem({
        anilistId: 813,
        titleRomaji: 'Dragon Ball Z',
        titleEnglish: 'Dragon Ball Z',
        titlePt: null,
        seasonYear: 1989,
        synopsis: 'Goku defends Earth from Saiyan invaders.',
      });

      const frieren = makeMediaItem({
        anilistId: 154587,
        titleRomaji: 'Sousou no Frieren',
        titleEnglish: "Frieren: Beyond Journey's End",
        titlePt: null,
        seasonYear: 2023,
        synopsis: 'After the party of heroes defeated the Demon King...',
      });

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({
          searchCatalog: jest.fn(async (filter: CatalogFilter) => {
            if (filter.query === 'Dragon') {
              return [dragonBallZ];
            }
            if (filter.query === 'Frieren') {
              return [frieren];
            }
            return [];
          }),
        }),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb({
          searchAnimePtBr: jest.fn(async (query: string) => {
            if (query === 'Dragon') {
              return [
                {
                  tmdbId: 10191,
                  titlePt: 'Como Treinar o Seu Dragão',
                  originalTitle: 'How to Train Your Dragon',
                  overviewPt: 'Soluço faz amizade com um dragão.',
                  mediaType: 'movie' as const,
                },
              ];
            }
            if (query === 'Frieren') {
              return [
                {
                  tmdbId: 209867,
                  titlePt: 'Frieren e a Jornada para o Além',
                  originalTitle: '葬送のフリーレン',
                  overviewPt: 'Após derrotar o Rei Demônio, a maga elfa Frieren reflete sobre a vida.',
                  mediaType: 'tv' as const,
                  originalLanguage: 'ja',
                  releaseYear: 2023,
                },
              ];
            }
            return [];
          }),
        }),
      });

      const dragonResults = await service.exploreCatalog({ query: 'Dragon' }, new Set());
      expect(dragonResults).toHaveLength(1);
      expect(dragonResults[0].tmdbId).toBeNull();
      expect(dragonResults[0].titlePt).toBeNull();
      expect(dragonResults[0].synopsis).toBe('Goku defends Earth from Saiyan invaders.');

      const savedDbz = await repo.getMediaItemByAnilistId(813);
      expect(savedDbz?.tmdbId).toBeNull();
      expect(savedDbz?.titlePt).toBeNull();
      expect(savedDbz?.synopsis).toBe('Goku defends Earth from Saiyan invaders.');

      const frierenResults = await service.exploreCatalog({ query: 'Frieren' }, new Set());
      expect(frierenResults).toHaveLength(1);
      expect(frierenResults[0].tmdbId).toBe(209867);
      expect(frierenResults[0].titlePt).toBe('Frieren e a Jornada para o Além');
      expect(frierenResults[0].synopsis).toBe(
        'Após derrotar o Rei Demônio, a maga elfa Frieren reflete sobre a vida.'
      );
    });

    it('never mis-enriches spin-offs, movies, or same-keyword anime at results[1..N] via shared token overlap alone', async () => {
      await repo.saveSettings({ tmdbApiKey: 'tmdb-free-key-123' });

      const jjkTv = makeMediaItem({
        anilistId: 113415,
        titleRomaji: 'Jujutsu Kaisen',
        titleEnglish: 'JUJUTSU KAISEN',
        titlePt: null,
        seasonYear: 2020,
        synopsis: 'Original TV synopsis.',
      });
      const jjkZero = makeMediaItem({
        anilistId: 131573,
        titleRomaji: 'Jujutsu Kaisen 0',
        titleEnglish: 'JUJUTSU KAISEN 0',
        titlePt: null,
        seasonYear: 2021,
        synopsis: 'Prequel movie synopsis.',
      });
      const jjkMiniSpinOff = makeMediaItem({
        anilistId: 131999,
        titleRomaji: 'Jujutsu Kaisen Mini Spin-Off',
        titleEnglish: 'Jujutsu Kaisen Mini Spin-Off',
        titlePt: null,
        seasonYear: 2021,
        synopsis: 'Short ONA synopsis.',
      });

      const dbz = makeMediaItem({
        anilistId: 813,
        titleRomaji: 'Dragon Ball Z',
        titleEnglish: 'Dragon Ball Z',
        titlePt: null,
        seasonYear: 1989,
        synopsis: 'Saiyan saga synopsis.',
      });
      const dragonQuest = makeMediaItem({
        anilistId: 2229,
        titleRomaji: 'Dragon Quest: Abel Yuusha',
        titleEnglish: 'Dragon Quest',
        titlePt: null,
        seasonYear: 1989,
        synopsis: 'Abel RPG adventure synopsis.',
      });

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({
          searchCatalog: jest.fn(async (filter: CatalogFilter) => {
            if (filter.query === 'Jujutsu Kaisen') {
              return [jjkTv, jjkZero, jjkMiniSpinOff];
            }
            if (filter.query === 'Dragon') {
              return [dbz, dragonQuest];
            }
            return [];
          }),
        }),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb({
          searchAnimePtBr: jest.fn(async (query: string) => {
            if (query === 'Jujutsu Kaisen') {
              return [
                {
                  tmdbId: 95479,
                  titlePt: 'Jujutsu Kaisen',
                  originalTitle: '呪術廻戦',
                  overviewPt: 'Yuji engole o dedo de Sukuna.',
                  mediaType: 'tv' as const,
                  originalLanguage: 'ja',
                  releaseYear: 2020,
                },
                {
                  tmdbId: 810693,
                  titlePt: 'Jujutsu Kaisen 0',
                  originalTitle: '劇場版 呪術廻戦 0',
                  overviewPt: 'Yuta Okkotsu controla Rika.',
                  mediaType: 'movie' as const,
                  originalLanguage: 'ja',
                  releaseYear: 2021,
                },
              ];
            }
            if (query === 'Dragon') {
              return [
                {
                  tmdbId: 12971,
                  titlePt: 'Dragon Ball Z',
                  originalTitle: 'ドラゴンボールZ',
                  overviewPt: 'As aventuras de Goku.',
                  mediaType: 'tv' as const,
                  originalLanguage: 'ja',
                  releaseYear: 1989,
                },
              ];
            }
            return [];
          }),
        }),
      });

      const jjkResults = await service.exploreCatalog({ query: 'Jujutsu Kaisen' }, new Set());
      expect(jjkResults[0]).toMatchObject({
        anilistId: 113415,
        tmdbId: 95479,
        titlePt: 'Jujutsu Kaisen',
        synopsis: 'Yuji engole o dedo de Sukuna.',
      });
      expect(jjkResults[1]).toMatchObject({
        anilistId: 131573,
        tmdbId: 810693,
        titlePt: 'Jujutsu Kaisen 0',
        synopsis: 'Yuta Okkotsu controla Rika.',
      });
      expect(jjkResults[2]).toMatchObject({
        anilistId: 131999,
        tmdbId: null,
        titlePt: null,
        synopsis: 'Short ONA synopsis.',
      });

      const savedSpinOff = await repo.getMediaItemByAnilistId(131999);
      expect(savedSpinOff?.tmdbId).toBeNull();
      expect(savedSpinOff?.titlePt).toBeNull();
      expect(savedSpinOff?.synopsis).toBe('Short ONA synopsis.');

      const dragonResults = await service.exploreCatalog({ query: 'Dragon' }, new Set());
      expect(dragonResults[0].tmdbId).toBe(12971);
      expect(dragonResults[1]).toMatchObject({
        anilistId: 2229,
        tmdbId: null,
        titlePt: null,
        synopsis: 'Abel RPG adventure synopsis.',
      });
    });
  });

  describe('getHomeFeed & DB identity preservation', () => {
    it('selects active WATCHING item as hero when present, otherwise trending #1, and preserves existing DB id', async () => {
      const existingDbHero = makeMediaItem({
        id: 'local-uuid-frieren',
        anilistId: 154587,
        titleRomaji: 'Sousou no Frieren',
        titlePt: 'Frieren e a Jornada para o Além',
        tmdbId: 209867,
      });
      await repo.upsertMediaItem(existingDbHero);
      const watchingEntry = await repo.setLibraryStatus('local-uuid-frieren', 'WATCHING');

      const trendingTop = makeMediaItem({
        anilistId: 171018,
        titleRomaji: 'Dandadan',
        titleEnglish: 'DAN DA DAN',
      });
      const refreshedFrieren = makeMediaItem({
        id: 'anilist:154587',
        anilistId: 154587,
        titleRomaji: 'Sousou no Frieren',
        titlePt: null,
        tmdbId: null,
      });

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({
          getHomeFeed: jest.fn(async () => ({
            trendingMonth: [trendingTop],
            currentSeason: [refreshedFrieren],
          })),
        }),
        jikanClient: createStubJikan(),
        tmdbClient: createStubTmdb(),
      });

      const feedWithWatching = await service.getHomeFeed([watchingEntry]);
      expect(feedWithWatching.hero?.id).toBe('local-uuid-frieren');
      expect(feedWithWatching.hero?.titlePt).toBe('Frieren e a Jornada para o Além');
      expect(feedWithWatching.currentSeason[0].id).toBe('local-uuid-frieren');

      const feedWithoutWatching = await service.getHomeFeed([]);
      expect(feedWithoutWatching.hero?.anilistId).toBe(171018);
    });
  });

  describe('HTTP Client implementations', () => {
    it('AniListHttpClient queries GraphQL, maps MediaItemRecord with relations, and throws CatalogRateLimitError on HTTP 429', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({
            data: {
              Page: {
                media: [
                  {
                    id: 151807,
                    idMal: 52299,
                    title: { romaji: 'Ore dake Level Up na Ken', english: 'Solo Leveling' },
                    description: 'Hunters enter <b>gates</b>.',
                    coverImage: { extraLarge: 'https://anilist.co/cover.jpg', large: null },
                    bannerImage: 'https://anilist.co/banner.jpg',
                    genres: ['Action', 'Fantasy'],
                    seasonYear: 2024,
                    season: 'WINTER',
                    format: 'TV',
                    episodes: 12,
                    status: 'FINISHED',
                    nextAiringEpisode: { airingAt: 1730000000, episode: 2 },
                    relations: {
                      edges: [
                        {
                          relationType: 'SEQUEL',
                          node: {
                            id: 176496,
                            type: 'ANIME',
                            format: 'TV',
                            seasonYear: 2025,
                            title: { romaji: 'Solo Leveling S2', english: 'Solo Leveling Season 2' },
                          },
                        },
                        {
                          relationType: 'ADAPTATION',
                          node: {
                            id: 105398,
                            type: 'MANGA',
                            format: 'MANGA',
                            seasonYear: 2018,
                            title: { romaji: 'Solo Leveling', english: 'Solo Leveling' },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '45' : null) },
          json: async () => ({ errors: [{ message: 'Too Many Requests.', status: 429 }] }),
        });

      const client = new AniListHttpClient({ fetchFn: mockFetch as never });
      const results = await client.searchCatalog({ query: 'Solo Leveling', sort: 'SCORE' });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'anilist:151807',
        mediaType: 'ANIME',
        anilistId: 151807,
        malId: 52299,
        titleRomaji: 'Ore dake Level Up na Ken',
        titleEnglish: 'Solo Leveling',
        synopsis: 'Hunters enter gates.',
        nextAiringAt: 1730000000,
        nextAiringEp: 2,
      });
      expect(JSON.parse(results[0].relationsJson)).toEqual([
        {
          anilistId: 176496,
          title: 'Solo Leveling Season 2',
          format: 'TV',
          relationType: 'SEQUEL',
          seasonYear: 2025,
        },
      ]);

      await expect(client.searchCatalog({ query: 'Frieren' })).rejects.toThrow(
        CatalogRateLimitError
      );
    });

    it('JikanHttpClient enforces >= 350ms spacing across queued requests and maps MAL anime cleanly', async () => {
      let currentTime = 1000;
      const sleptMs: number[] = [];
      const callTimestamps: number[] = [];

      const mockFetch = jest.fn(async () => {
        callTimestamps.push(currentTime);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: [
              {
                mal_id: 52991,
                title: 'Sousou no Frieren',
                title_english: 'Frieren: Beyond Journey\'s End',
                synopsis: 'An elf mage reflects on mortality.',
                images: { jpg: { large_image_url: 'https://cdn.myanimelist.net/frieren.jpg' } },
                genres: [{ name: 'Adventure' }, { name: 'Fantasy' }],
                year: 2023,
                season: 'fall',
                episodes: 28,
                status: 'Finished Airing',
              },
            ],
          }),
        };
      });

      const client = new JikanHttpClient({
        fetchFn: mockFetch as never,
        nowFn: () => currentTime,
        sleepFn: async (ms: number) => {
          sleptMs.push(ms);
          currentTime += ms;
        },
        minIntervalMs: 350,
      });

      const [first, second] = await Promise.all([
        client.searchCatalog({ query: 'Frieren' }),
        client.getTopTrending(),
      ]);

      expect(first[0]).toMatchObject({
        id: 'mal:52991',
        mediaType: 'ANIME',
        anilistId: -52991,
        malId: 52991,
        seasonName: 'FALL',
        statusAiring: 'FINISHED',
      });
      expect(second).toHaveLength(1);
      expect(sleptMs).toEqual([350]);
      expect(callTimestamps[1] - callTimestamps[0]).toBeGreaterThanOrEqual(350);
    });

    it('TmdbHttpClient skips fetch when apiKey is empty and parses pt-BR animation matches when configured', async () => {
      const mockFetch = jest.fn(async (_url: string, _init?: unknown) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          results: [
            {
              id: 999,
              media_type: 'tv',
              name: 'Not Animation',
              original_name: 'Live Action',
              overview: 'Live action show',
              genre_ids: [18],
            },
            {
              id: 1429,
              media_type: 'tv',
              name: 'Ataque dos Titãs',
              original_name: '進撃の巨人',
              overview: 'Sinopse oficial em português.',
              genre_ids: [16, 10759],
            },
          ],
        }),
      }));

      const client = new TmdbHttpClient({ fetchFn: mockFetch as never });

      const skipped = await client.searchAnimePtBr('Ataque dos Titãs', '');
      expect(skipped).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();

      const matches = await client.searchAnimePtBr('Ataque dos Titãs', 'my-v3-key');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('language=pt-BR');
      expect(mockFetch.mock.calls[0][0]).toContain('api_key=my-v3-key');
      expect(matches[0]).toEqual({
        tmdbId: 1429,
        titlePt: 'Ataque dos Titãs',
        originalTitle: '進撃の巨人',
        overviewPt: 'Sinopse oficial em português.',
        mediaType: 'tv',
      });
    });

    it('TmdbHttpClient prioritizes Japanese animation (original_language === ja) over Western animation and extracts releaseYear', async () => {
      const mockFetch = jest.fn(async (_url: string, _init?: unknown) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          results: [
            {
              id: 10191,
              media_type: 'movie',
              title: 'Como Treinar o Seu Dragão',
              original_title: 'How to Train Your Dragon',
              overview: 'Dragões e vikings.',
              genre_ids: [16, 12],
              original_language: 'en',
              release_date: '2010-03-26',
            },
            {
              id: 12971,
              media_type: 'tv',
              name: 'Dragon Ball Z',
              original_name: 'ドラゴンボールZ',
              overview: 'As aventuras de Goku e os Guerreiros Z.',
              genre_ids: [16, 10759],
              original_language: 'ja',
              first_air_date: '1989-04-26',
            },
          ],
        }),
      }));

      const client = new TmdbHttpClient({ fetchFn: mockFetch as never });
      const matches = await client.searchAnimePtBr('Dragon', 'my-v3-key');

      expect(matches).toHaveLength(2);
      expect(matches[0]).toMatchObject({
        tmdbId: 12971,
        titlePt: 'Dragon Ball Z',
        originalTitle: 'ドラゴンボールZ',
        mediaType: 'tv',
        originalLanguage: 'ja',
        releaseYear: 1989,
      });
      expect(matches[1]).toMatchObject({
        tmdbId: 10191,
        originalLanguage: 'en',
        releaseYear: 2010,
      });
    });

    it('falls back cleanly across getHomeFeed, getWeeklySchedule, and getUpcomingSeasonsRadar when offline', async () => {
      const airingAt = Math.floor(new Date(2026, 10, 17, 15, 0, 0).getTime() / 1000);
      await repo.upsertMediaItem(
        makeMediaItem({
          id: 'cached-airing',
          anilistId: 7001,
          titleRomaji: 'Cached Airing',
          statusAiring: 'RELEASING',
          nextAiringAt: airingAt,
          nextAiringEp: 4,
          seasonYear: 2026,
          seasonName: 'FALL',
        })
      );
      await repo.upsertMediaItem(
        makeMediaItem({
          id: 'cached-upcoming',
          anilistId: 7002,
          titleRomaji: 'Cached Upcoming Sequel',
          statusAiring: 'NOT_YET_RELEASED',
          seasonYear: 2027,
          seasonName: 'SUMMER',
          relationsJson: JSON.stringify([
            {
              anilistId: 7001,
              title: 'Cached Airing',
              format: 'TV',
              relationType: 'PREQUEL',
            } satisfies CatalogRelation,
          ]),
        })
      );
      const entry = await repo.setLibraryStatus('cached-airing', 'WATCHING');

      const service = new CatalogService(repo, {
        aniListClient: createStubAniList({
          getHomeFeed: jest.fn(async () => {
            throw new CatalogRateLimitError('ANILIST');
          }),
          getWeeklySchedule: jest.fn(async () => {
            throw new CatalogRateLimitError('ANILIST');
          }),
          getUpcomingSeasons: jest.fn(async () => {
            throw new CatalogRateLimitError('ANILIST');
          }),
        }),
        jikanClient: createStubJikan({
          getTopTrending: jest.fn(async () => {
            throw new Error('offline');
          }),
          getCurrentSeason: jest.fn(async () => {
            throw new Error('offline');
          }),
          getWeeklySchedule: jest.fn(async () => {
            throw new Error('offline');
          }),
          getUpcomingSeasons: jest.fn(async () => {
            throw new Error('offline');
          }),
        }),
        tmdbClient: createStubTmdb(),
        nowFn: () => new Date(2026, 10, 16, 12, 0, 0),
      });

      const home = await service.getHomeFeed([entry]);
      expect(home.hero?.id).toBe('cached-airing');
      expect(home.trendingMonth.length).toBe(2);

      const schedule = await service.getWeeklySchedule([entry]);
      const tuesdayIndex = new Date(airingAt * 1000).getDay();
      expect(schedule[tuesdayIndex]).toHaveLength(1);
      expect(schedule[tuesdayIndex][0]).toMatchObject({
        episodeNumber: 4,
        inUserActiveList: true,
      });

      const radar = await service.getUpcomingSeasonsRadar([entry]);
      expect(radar).toHaveLength(1);
      expect(radar[0]).toMatchObject({
        releaseLabel: 'Verão 2027',
        isSequelToLibraryItem: true,
      });
    });

    it('AniListHttpClient handles homeFeed, weeklySchedule, upcomingSeasons, and enforces 90 req/min budget', async () => {
      const airingAt = Math.floor(new Date(2026, 10, 18, 18, 0, 0).getTime() / 1000);
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              trending: {
                media: [{ id: 10, title: { romaji: 'Top 1' }, genres: ['Action'], status: 'RELEASING' }],
              },
              season: {
                media: [{ id: 20, title: { romaji: 'Season 1' }, genres: ['Drama'], status: 'RELEASING' }],
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              Page: {
                airingSchedules: [
                  {
                    episode: 9,
                    airingAt,
                    media: { id: 10, type: 'ANIME', format: 'TV', title: { romaji: 'Top 1' }, status: 'RELEASING' },
                  },
                ],
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              Page: {
                media: [
                  {
                    id: 30,
                    title: { romaji: 'Future Show' },
                    status: 'NOT_YET_RELEASED',
                    season: 'SPRING',
                    seasonYear: 2027,
                    startDate: { year: 2027, month: 4, day: 1 },
                  },
                ],
              },
            },
          }),
        });

      const client = new AniListHttpClient({
        fetchFn: mockFetch as never,
        nowFn: () => 5000,
        maxRequestsPerMinute: 3,
      });

      const home = await client.getHomeFeed(2026, 'FALL');
      expect(home.trendingMonth[0].anilistId).toBe(10);
      expect(home.currentSeason[0].anilistId).toBe(20);

      const sched = await client.getWeeklySchedule(airingAt - 100, airingAt + 100);
      expect(sched[0]).toMatchObject({ episodeNumber: 9, airingAtUnix: airingAt });

      const upcoming = await client.getUpcomingSeasons();
      expect(upcoming[0]).toMatchObject({ startMonth: 4 });
      expect(upcoming[0].media.anilistId).toBe(30);

      await expect(client.getUpcomingSeasons()).rejects.toThrow(CatalogRateLimitError);
    });

    it('JikanHttpClient and TmdbHttpClient throw CatalogRateLimitError on HTTP 429', async () => {
      const jikan429 = new JikanHttpClient({
        fetchFn: jest.fn(async () => ({
          ok: false,
          status: 429,
          headers: { get: () => '30' },
          json: async () => ({}),
        })) as never,
      });
      const tmdb429 = new TmdbHttpClient({
        fetchFn: jest.fn(async () => ({
          ok: false,
          status: 429,
          headers: { get: () => '10' },
          json: async () => ({}),
        })) as never,
      });

      await expect(jikan429.getCurrentSeason()).rejects.toThrow(CatalogRateLimitError);
      await expect(tmdb429.searchAnimePtBr('Frieren', 'demo-key')).rejects.toThrow(
        CatalogRateLimitError
      );
    });
  });
});
