import { LibraryRepository } from '../db/library-repository';
import { LibraryEntryRecord, MediaItemRecord, WatchStatus } from '../db/schema';
import { AniListHttpClient } from './anilist-client';
import { JikanHttpClient } from './jikan-client';
import { TmdbHttpClient } from './tmdb-client';
import {
  AniListClient,
  AniListScheduleItem,
  AniListSeasonItem,
  CatalogFilter,
  FranchiseNode,
  FranchiseRelationType,
  HomeFeedResult,
  JikanClient,
  LibraryEntryWithOptionalMedia,
  parseGenresSafe,
  parseRelationsSafe,
  SeasonName,
  TmdbAnimeLocalization,
  TmdbClient,
  UpcomingSeasonEntry,
  WeeklyScheduleEntry,
} from './types';

export type {
  CatalogFilter,
  CatalogRelation,
  FranchiseNode,
  HomeFeedResult,
  UpcomingSeasonEntry,
  WeeklyScheduleEntry,
} from './types';
export { CatalogRateLimitError } from './types';

const MONTHS_PT = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
] as const;

const SEASONS_PT: Record<SeasonName, string> = {
  WINTER: 'Inverno',
  SPRING: 'Primavera',
  SUMMER: 'Verão',
  FALL: 'Outono',
};

const RELATION_ORDER: Record<FranchiseRelationType, number> = {
  PREQUEL: 0,
  CURRENT: 1,
  SEQUEL: 2,
  SIDE_STORY: 3,
};

function getAnimeSeasonForDate(date: Date): {
  seasonYear: number;
  seasonName: SeasonName;
} {
  const month = date.getMonth() + 1;
  const seasonYear = date.getFullYear();
  if (month <= 3) {
    return { seasonYear, seasonName: 'WINTER' };
  }
  if (month <= 6) {
    return { seasonYear, seasonName: 'SPRING' };
  }
  if (month <= 9) {
    return { seasonYear, seasonName: 'SUMMER' };
  }
  return { seasonYear, seasonName: 'FALL' };
}

function normalizeTitleKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function extractAnilistIdFromDeterministicId(mediaItemId: string): number | null {
  const match = /^(?:anilist:|anilist_|anime-)(\d+)$/.exec(mediaItemId.trim());
  if (match) {
    return Number(match[1]);
  }
  if (/^\d+$/.test(mediaItemId.trim())) {
    return Number(mediaItemId.trim());
  }
  return null;
}

function formatReleaseLabel(
  seasonYear: number | null,
  seasonName: string | null,
  startMonth: number | null
): string {
  if (
    startMonth !== null &&
    startMonth >= 1 &&
    startMonth <= 12 &&
    seasonYear !== null
  ) {
    return `${MONTHS_PT[startMonth - 1]}/${seasonYear}`;
  }

  const normalizedSeason = seasonName?.trim().toUpperCase() as SeasonName | undefined;
  const ptSeason = normalizedSeason ? SEASONS_PT[normalizedSeason] : undefined;

  if (ptSeason && seasonYear !== null) {
    return `${ptSeason} ${seasonYear}`;
  }
  if (ptSeason) {
    return `Temporada de ${ptSeason}`;
  }
  if (seasonYear !== null) {
    return String(seasonYear);
  }
  return 'Em breve';
}

function pickDisplayTitle(media: MediaItemRecord): string {
  return (
    media.titlePt?.trim() ||
    media.titleEnglish?.trim() ||
    media.titleRomaji.trim()
  );
}

function mapFranchiseRelationType(
  rawType: string
): Exclude<FranchiseRelationType, 'CURRENT'> | null {
  const upper = rawType.trim().toUpperCase();
  if (upper === 'PREQUEL' || upper === 'SEQUEL' || upper === 'SIDE_STORY') {
    return upper;
  }
  if (upper === 'SPIN_OFF') {
    return 'SIDE_STORY';
  }
  return null;
}

function isMediaCompleted(media: MediaItemRecord, completedMediaIds: Set<string>): boolean {
  return (
    completedMediaIds.has(media.id) ||
    completedMediaIds.has(`anilist:${media.anilistId}`) ||
    completedMediaIds.has(`anilist_${media.anilistId}`) ||
    completedMediaIds.has(String(media.anilistId))
  );
}

function applyLocalCatalogFilter(
  items: MediaItemRecord[],
  filter: CatalogFilter
): MediaItemRecord[] {
  const normalizedQuery = filter.query?.trim().toLowerCase() ?? '';
  const requiredGenres = (filter.genres ?? [])
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);

  const filtered = items.filter((item) => {
    if (normalizedQuery) {
      const searchable = [
        item.titleRomaji,
        item.titleEnglish ?? '',
        item.titlePt ?? '',
        item.synopsis ?? '',
      ]
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(normalizedQuery)) {
        return false;
      }
    }

    if (requiredGenres.length > 0) {
      const itemGenres = new Set(parseGenresSafe(item.genresJson).map((g) => g.toLowerCase()));
      if (!requiredGenres.every((genre) => itemGenres.has(genre))) {
        return false;
      }
    }

    if (filter.seasonYear !== undefined && item.seasonYear !== filter.seasonYear) {
      return false;
    }

    if (
      filter.seasonName !== undefined &&
      item.seasonName?.toUpperCase() !== filter.seasonName
    ) {
      return false;
    }

    if (filter.format === 'MOVIE' && item.episodesTotal !== null && item.episodesTotal !== 1) {
      return false;
    }

    return true;
  });

  if (filter.sort === 'NEWEST') {
    return [...filtered].sort((a, b) => (b.seasonYear ?? 0) - (a.seasonYear ?? 0));
  }

  return filtered;
}

export interface CatalogServiceDeps {
  aniListClient?: AniListClient;
  jikanClient?: JikanClient;
  tmdbClient?: TmdbClient;
  nowFn?: () => Date;
}

/**
 * Cache-First catalog orchestrator backed by SQLite (LibraryRepository),
 * prioritizing AniList GraphQL with Jikan v4 + SQLite offline fallbacks and
 * strictly optional TMDB pt-BR enrichment.
 */
export class CatalogService {
  private readonly aniListClient: AniListClient;
  private readonly jikanClient: JikanClient;
  private readonly tmdbClient: TmdbClient;
  private readonly nowFn: () => Date;
  private readonly anilistIdByMediaId = new Map<string, number>();
  private readonly formatByAnilistId = new Map<number, string>();

  constructor(
    private readonly repo: LibraryRepository,
    deps: CatalogServiceDeps = {}
  ) {
    this.aniListClient = deps.aniListClient ?? new AniListHttpClient();
    this.jikanClient = deps.jikanClient ?? new JikanHttpClient();
    this.tmdbClient = deps.tmdbClient ?? new TmdbHttpClient();
    this.nowFn = deps.nowFn ?? (() => new Date());
  }

  private async upsertAndNormalizeMedia(
    items: MediaItemRecord[],
    formats?: Map<number, string>
  ): Promise<MediaItemRecord[]> {
    if (formats) {
      for (const [anilistId, format] of formats.entries()) {
        if (format) {
          this.formatByAnilistId.set(anilistId, format);
        }
      }
    }

    if (items.length === 0) {
      return [];
    }

    const existingItems = await this.repo.getAllMediaItems();
    const byAnilistId = new Map<number, MediaItemRecord>();
    const byMalId = new Map<number, MediaItemRecord>();

    for (const existing of existingItems) {
      this.anilistIdByMediaId.set(existing.id, existing.anilistId);
      byAnilistId.set(existing.anilistId, existing);
      if (existing.malId !== null) {
        byMalId.set(existing.malId, existing);
      }
    }

    const persisted: MediaItemRecord[] = [];

    for (const incoming of items) {
      let existing = byAnilistId.get(incoming.anilistId);
      if (!existing && incoming.malId !== null) {
        const malCandidate = byMalId.get(incoming.malId);
        if (
          malCandidate &&
          (incoming.anilistId < 0 || malCandidate.anilistId < 0)
        ) {
          existing = malCandidate;
        }
      }

      const resolvedAnilistId =
        incoming.anilistId > 0
          ? incoming.anilistId
          : (existing?.anilistId ?? incoming.anilistId);
      const resolvedId = existing
        ? existing.id
        : resolvedAnilistId > 0
          ? `anilist:${resolvedAnilistId}`
          : incoming.id;

      const preservePortugueseSynopsis = Boolean(
        existing?.tmdbId &&
          existing?.titlePt &&
          existing?.synopsis &&
          incoming.tmdbId === null
      );

      const merged: MediaItemRecord = {
        ...incoming,
        id: resolvedId,
        mediaType: 'ANIME',
        anilistId: resolvedAnilistId,
        malId: incoming.malId ?? existing?.malId ?? null,
        tmdbId: incoming.tmdbId ?? existing?.tmdbId ?? null,
        titleEnglish: incoming.titleEnglish ?? existing?.titleEnglish ?? null,
        titlePt: incoming.titlePt ?? existing?.titlePt ?? null,
        synopsis: preservePortugueseSynopsis
          ? existing!.synopsis
          : (incoming.synopsis ?? existing?.synopsis ?? null),
        coverUrl: incoming.coverUrl || existing?.coverUrl || '',
        bannerUrl: incoming.bannerUrl ?? existing?.bannerUrl ?? null,
        genresJson:
          incoming.genresJson !== '[]'
            ? incoming.genresJson
            : (existing?.genresJson ?? '[]'),
        seasonYear: incoming.seasonYear ?? existing?.seasonYear ?? null,
        seasonName: incoming.seasonName ?? existing?.seasonName ?? null,
        episodesTotal: incoming.episodesTotal ?? existing?.episodesTotal ?? null,
        statusAiring:
          incoming.statusAiring !== 'UNKNOWN'
            ? incoming.statusAiring
            : (existing?.statusAiring ?? 'UNKNOWN'),
        nextAiringAt: incoming.nextAiringAt ?? existing?.nextAiringAt ?? null,
        nextAiringEp: incoming.nextAiringEp ?? existing?.nextAiringEp ?? null,
        relationsJson:
          incoming.relationsJson !== '[]'
            ? incoming.relationsJson
            : (existing?.relationsJson ?? '[]'),
      };

      await this.repo.upsertMediaItem(merged);
      if (existing && existing.anilistId !== merged.anilistId) {
        byAnilistId.delete(existing.anilistId);
      }
      this.anilistIdByMediaId.set(merged.id, merged.anilistId);
      byAnilistId.set(merged.anilistId, merged);
      if (merged.malId !== null) {
        byMalId.set(merged.malId, merged);
      }
      persisted.push(merged);
    }

    return persisted;
  }

  private resolveEntryAnilistId(
    entry: LibraryEntryWithOptionalMedia,
    dbMediaById?: Map<string, MediaItemRecord>
  ): number | null {
    if (entry.media && typeof entry.media.anilistId === 'number') {
      return entry.media.anilistId;
    }
    const fromDb = dbMediaById?.get(entry.mediaItemId);
    if (fromDb) {
      return fromDb.anilistId;
    }
    const fromIndex = this.anilistIdByMediaId.get(entry.mediaItemId);
    if (fromIndex !== undefined) {
      return fromIndex;
    }
    return extractAnilistIdFromDeterministicId(entry.mediaItemId);
  }

  private applyTmdbMatchToMedia(
    media: MediaItemRecord,
    match: TmdbAnimeLocalization
  ): MediaItemRecord {
    return {
      ...media,
      tmdbId: match.tmdbId,
      titlePt: match.titlePt.trim() || media.titlePt,
      synopsis:
        match.overviewPt && match.overviewPt.trim().length > 0
          ? match.overviewPt.trim()
          : media.synopsis,
      cachedAt: this.nowFn().toISOString(),
    };
  }

  private findBestTmdbMatch(
    media: MediaItemRecord,
    matches: TmdbAnimeLocalization[]
  ): TmdbAnimeLocalization | null {
    if (matches.length === 0) {
      return null;
    }
    const candidateKeys = new Set(
      [media.titleRomaji, media.titleEnglish, media.titlePt]
        .map(normalizeTitleKey)
        .filter(Boolean)
    );
    const exactMatch = matches.find(
      (match) =>
        candidateKeys.has(normalizeTitleKey(match.originalTitle)) ||
        candidateKeys.has(normalizeTitleKey(match.titlePt))
    );
    return exactMatch ?? matches[0];
  }

  async getHomeFeed(userEntries: LibraryEntryRecord[]): Promise<HomeFeedResult> {
    const { seasonYear, seasonName } = getAnimeSeasonForDate(this.nowFn());
    let trendingMonth: MediaItemRecord[] = [];
    let currentSeason: MediaItemRecord[] = [];

    try {
      const feed = await this.aniListClient.getHomeFeed(seasonYear, seasonName);
      trendingMonth = await this.upsertAndNormalizeMedia(feed.trendingMonth);
      currentSeason = await this.upsertAndNormalizeMedia(feed.currentSeason);
    } catch {
      try {
        const [jikanTrending, jikanSeason] = await Promise.all([
          this.jikanClient.getTopTrending(),
          this.jikanClient.getCurrentSeason(),
        ]);
        trendingMonth = await this.upsertAndNormalizeMedia(jikanTrending);
        currentSeason = await this.upsertAndNormalizeMedia(jikanSeason);
      } catch {
        const cached = await this.repo.getAllMediaItems();
        for (const item of cached) {
          this.anilistIdByMediaId.set(item.id, item.anilistId);
        }
        trendingMonth = cached.slice(0, 15);
        currentSeason = cached.filter(
          (item) =>
            item.seasonYear === seasonYear &&
            item.seasonName?.toUpperCase() === seasonName
        );
        if (currentSeason.length === 0) {
          currentSeason = cached.slice(0, 20);
        }
      }
    }

    const activeEntries = [...userEntries]
      .filter((entry) => entry.status === 'WATCHING' || entry.status === 'REWATCHING')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const fetchedById = new Map<string, MediaItemRecord>();
    for (const item of [...trendingMonth, ...currentSeason]) {
      fetchedById.set(item.id, item);
    }

    let hero: MediaItemRecord | null = null;
    for (const activeEntry of activeEntries) {
      const matched =
        fetchedById.get(activeEntry.mediaItemId) ??
        (await this.repo.getMediaItemById(activeEntry.mediaItemId));
      if (matched) {
        this.anilistIdByMediaId.set(matched.id, matched.anilistId);
        hero = matched;
        break;
      }
    }

    if (!hero) {
      hero = trendingMonth[0] ?? currentSeason[0] ?? null;
    }

    return {
      hero,
      trendingMonth,
      currentSeason,
    };
  }

  async exploreCatalog(
    filter: CatalogFilter,
    completedMediaIds: Set<string>
  ): Promise<MediaItemRecord[]> {
    const settings = await this.repo.getSettings();
    const tmdbApiKey = settings.tmdbApiKey?.trim() || null;
    const trimmedQuery = filter.query?.trim() ?? '';

    let tmdbMatches: TmdbAnimeLocalization[] = [];
    if (tmdbApiKey && trimmedQuery) {
      try {
        tmdbMatches = await this.tmdbClient.searchAnimePtBr(trimmedQuery, tmdbApiKey);
      } catch {
        tmdbMatches = [];
      }
    }

    const translatedQuery =
      tmdbMatches.find(
        (match) =>
          match.originalTitle.trim().length > 0 &&
          normalizeTitleKey(match.originalTitle) !== normalizeTitleKey(trimmedQuery)
      )?.originalTitle.trim() ?? null;

    let results: MediaItemRecord[] = [];
    let fromCacheOnly = false;

    try {
      results = await this.aniListClient.searchCatalog(filter);
      if (results.length === 0 && translatedQuery) {
        results = await this.aniListClient.searchCatalog({
          ...filter,
          query: translatedQuery,
        });
      }
    } catch {
      try {
        results = await this.jikanClient.searchCatalog(filter);
        if (results.length === 0 && translatedQuery) {
          results = await this.jikanClient.searchCatalog({
            ...filter,
            query: translatedQuery,
          });
        }
      } catch {
        fromCacheOnly = true;
        const cached = await this.repo.getAllMediaItems();
        for (const item of cached) {
          this.anilistIdByMediaId.set(item.id, item.anilistId);
        }
        results = applyLocalCatalogFilter(cached, filter);
        if (results.length === 0 && translatedQuery) {
          results = applyLocalCatalogFilter(cached, {
            ...filter,
            query: translatedQuery,
          });
        }
      }
    }

    if (!fromCacheOnly) {
      if (tmdbMatches.length > 0 && results.length > 0) {
        results = results.map((item, index) => {
          const matchedTmdb = this.findBestTmdbMatch(item, tmdbMatches);
          if (!matchedTmdb) {
            return item;
          }
          const itemTitleKeys = new Set(
            [item.titleRomaji, item.titleEnglish, item.titlePt]
              .map(normalizeTitleKey)
              .filter(Boolean)
          );
          const isExactTitleMatch =
            itemTitleKeys.has(normalizeTitleKey(matchedTmdb.originalTitle)) ||
            itemTitleKeys.has(normalizeTitleKey(matchedTmdb.titlePt));
          const isMatch = isExactTitleMatch || (Boolean(translatedQuery) && index === 0);
          return isMatch ? this.applyTmdbMatchToMedia(item, matchedTmdb) : item;
        });
      }
      results = await this.upsertAndNormalizeMedia(results);
    }

    const shouldHideCompleted = filter.hideCompleted ?? settings.hideCompletedInExplore;
    if (!shouldHideCompleted) {
      return results;
    }

    return results.filter((item) => !isMediaCompleted(item, completedMediaIds));
  }

  async getWeeklySchedule(
    userEntries: LibraryEntryRecord[]
  ): Promise<Record<number, WeeklyScheduleEntry[]>> {
    const grouped: Record<number, WeeklyScheduleEntry[]> = {
      0: [],
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
    };

    const now = this.nowFn();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const startUnix = Math.floor(startOfDay.getTime() / 1000) - 1;
    const endUnix = startUnix + 1 + 7 * 86400;

    let rawSchedule: AniListScheduleItem[] = [];
    let fromCacheOnly = false;

    try {
      rawSchedule = await this.aniListClient.getWeeklySchedule(startUnix, endUnix);
    } catch {
      try {
        rawSchedule = await this.jikanClient.getWeeklySchedule();
      } catch {
        fromCacheOnly = true;
        const cached = await this.repo.getAllMediaItems();
        rawSchedule = cached
          .filter((item) => item.nextAiringAt !== null)
          .map((item) => ({
            media: item,
            episodeNumber: item.nextAiringEp ?? 1,
            airingAtUnix: item.nextAiringAt as number,
          }));
      }
    }

    let persistedByAnilistId = new Map<number, MediaItemRecord>();
    if (!fromCacheOnly && rawSchedule.length > 0) {
      const formatMap = new Map<number, string>();
      for (const item of rawSchedule) {
        if (item.format) {
          formatMap.set(item.media.anilistId, item.format);
        }
      }
      const persisted = await this.upsertAndNormalizeMedia(
        rawSchedule.map((item) => item.media),
        formatMap
      );
      persistedByAnilistId = new Map(persisted.map((m) => [m.anilistId, m]));
    }

    const allDbMedia = await this.repo.getAllMediaItems();
    const dbMediaById = new Map<string, MediaItemRecord>();
    for (const item of allDbMedia) {
      this.anilistIdByMediaId.set(item.id, item.anilistId);
      dbMediaById.set(item.id, item);
    }

    const activeMediaIds = new Set<string>();
    const activeAnilistIds = new Set<number>();
    for (const entry of userEntries as LibraryEntryWithOptionalMedia[]) {
      if (entry.status !== 'WATCHING' && entry.status !== 'PLAN_TO_WATCH') {
        continue;
      }
      activeMediaIds.add(entry.mediaItemId);
      const resolvedAnilist = this.resolveEntryAnilistId(entry, dbMediaById);
      if (resolvedAnilist !== null) {
        activeAnilistIds.add(resolvedAnilist);
      }
    }

    for (const item of rawSchedule) {
      const media = persistedByAnilistId.get(item.media.anilistId) ?? item.media;
      const weekdayIndex = new Date(item.airingAtUnix * 1000).getDay();
      const inUserActiveList =
        activeMediaIds.has(media.id) || activeAnilistIds.has(media.anilistId);

      grouped[weekdayIndex].push({
        media,
        episodeNumber: item.episodeNumber,
        airingAtUnix: item.airingAtUnix,
        weekdayIndex,
        inUserActiveList,
      });
    }

    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      grouped[day].sort((a, b) => {
        if (a.airingAtUnix !== b.airingAtUnix) {
          return a.airingAtUnix - b.airingAtUnix;
        }
        return a.media.titleRomaji.localeCompare(b.media.titleRomaji);
      });
    }

    return grouped;
  }

  async getUpcomingSeasonsRadar(
    userEntries: LibraryEntryRecord[]
  ): Promise<UpcomingSeasonEntry[]> {
    let rawUpcoming: AniListSeasonItem[] = [];
    let fromCacheOnly = false;

    try {
      rawUpcoming = await this.aniListClient.getUpcomingSeasons();
    } catch {
      try {
        rawUpcoming = await this.jikanClient.getUpcomingSeasons();
      } catch {
        fromCacheOnly = true;
        const cached = await this.repo.getAllMediaItems();
        rawUpcoming = cached
          .filter((item) => item.statusAiring === 'NOT_YET_RELEASED')
          .map((media) => ({ media, startMonth: null }));
      }
    }

    let persistedByAnilistId = new Map<number, MediaItemRecord>();
    if (!fromCacheOnly && rawUpcoming.length > 0) {
      const formatMap = new Map<number, string>();
      for (const item of rawUpcoming) {
        if (item.format) {
          formatMap.set(item.media.anilistId, item.format);
        }
      }
      const persisted = await this.upsertAndNormalizeMedia(
        rawUpcoming.map((item) => item.media),
        formatMap
      );
      persistedByAnilistId = new Map(persisted.map((m) => [m.anilistId, m]));
    }

    const allDbMedia = await this.repo.getAllMediaItems();
    const dbMediaById = new Map<string, MediaItemRecord>();
    const dbMediaByAnilistId = new Map<number, MediaItemRecord>();
    for (const item of allDbMedia) {
      this.anilistIdByMediaId.set(item.id, item.anilistId);
      dbMediaById.set(item.id, item);
      dbMediaByAnilistId.set(item.anilistId, item);
    }

    const userAnilistIds = new Set<number>();
    const sequelsFromUserLibrary = new Set<number>();

    for (const entry of userEntries as LibraryEntryWithOptionalMedia[]) {
      const anilistId = this.resolveEntryAnilistId(entry, dbMediaById);
      if (anilistId === null) {
        continue;
      }
      userAnilistIds.add(anilistId);
      const dbMedia = dbMediaByAnilistId.get(anilistId);
      if (dbMedia) {
        for (const rel of parseRelationsSafe(dbMedia.relationsJson)) {
          if (rel.relationType.toUpperCase() === 'SEQUEL') {
            sequelsFromUserLibrary.add(rel.anilistId);
          }
        }
      }
    }

    return rawUpcoming
      .map((item) => {
        const media = persistedByAnilistId.get(item.media.anilistId) ?? item.media;
        const relations = parseRelationsSafe(media.relationsJson);
        const isSequelToLibraryItem =
          relations.some(
            (rel) =>
              rel.relationType.toUpperCase() === 'PREQUEL' &&
              userAnilistIds.has(rel.anilistId)
          ) || sequelsFromUserLibrary.has(media.anilistId);

        return {
          media,
          releaseLabel: formatReleaseLabel(
            media.seasonYear,
            media.seasonName,
            item.startMonth
          ),
          isSequelToLibraryItem,
        };
      })
      .filter((entry) => entry.media.statusAiring === 'NOT_YET_RELEASED');
  }

  buildFranchiseTimeline(
    rootMedia: MediaItemRecord,
    userEntries: LibraryEntryRecord[]
  ): FranchiseNode[] {
    this.anilistIdByMediaId.set(rootMedia.id, rootMedia.anilistId);

    const statusByAnilistId = new Map<number, WatchStatus>();
    for (const entry of userEntries as LibraryEntryWithOptionalMedia[]) {
      if (entry.mediaItemId === rootMedia.id) {
        statusByAnilistId.set(rootMedia.anilistId, entry.status);
        continue;
      }
      const anilistId = this.resolveEntryAnilistId(entry);
      if (anilistId !== null) {
        statusByAnilistId.set(anilistId, entry.status);
      }
    }

    const seenAnilistIds = new Set<number>([rootMedia.anilistId]);

    const buildNode = (
      anilistId: number,
      title: string,
      format: string,
      relationType: FranchiseRelationType,
      seasonYear: number | null
    ): { node: FranchiseNode; seasonYear: number | null } => {
      const userStatus = statusByAnilistId.get(anilistId);
      return {
        node: {
          anilistId,
          title,
          format,
          relationType,
          ...(userStatus !== undefined ? { userStatus } : {}),
        },
        seasonYear,
      };
    };

    const sortableNodes: Array<{ node: FranchiseNode; seasonYear: number | null }> = [
      buildNode(
        rootMedia.anilistId,
        pickDisplayTitle(rootMedia),
        this.formatByAnilistId.get(rootMedia.anilistId) ?? rootMedia.mediaType,
        'CURRENT',
        rootMedia.seasonYear
      ),
    ];

    for (const rel of parseRelationsSafe(rootMedia.relationsJson)) {
      if (seenAnilistIds.has(rel.anilistId)) {
        continue;
      }
      const mappedType = mapFranchiseRelationType(rel.relationType);
      if (!mappedType) {
        continue;
      }
      seenAnilistIds.add(rel.anilistId);
      sortableNodes.push(
        buildNode(
          rel.anilistId,
          rel.title,
          rel.format || 'ANIME',
          mappedType,
          rel.seasonYear ?? null
        )
      );
    }

    sortableNodes.sort((a, b) => {
      const rankDiff =
        RELATION_ORDER[a.node.relationType] - RELATION_ORDER[b.node.relationType];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      const yearA = a.seasonYear ?? Number.MAX_SAFE_INTEGER;
      const yearB = b.seasonYear ?? Number.MAX_SAFE_INTEGER;
      if (yearA !== yearB) {
        return yearA - yearB;
      }
      return a.node.anilistId - b.node.anilistId;
    });

    return sortableNodes.map((entry) => entry.node);
  }

  async enrichWithPortugueseIfConfigured(
    media: MediaItemRecord
  ): Promise<MediaItemRecord> {
    const settings = await this.repo.getSettings();
    const apiKey = settings.tmdbApiKey?.trim() ?? '';
    if (!apiKey) {
      return media;
    }

    if (media.tmdbId !== null && media.titlePt && media.titlePt.trim().length > 0) {
      return media;
    }

    const candidateQueries = Array.from(
      new Set(
        [media.titleEnglish, media.titleRomaji, media.titlePt]
          .map((q) => q?.trim() ?? '')
          .filter(Boolean)
      )
    );

    let matches: TmdbAnimeLocalization[] = [];
    for (const query of candidateQueries) {
      try {
        matches = await this.tmdbClient.searchAnimePtBr(query, apiKey);
      } catch {
        return media;
      }
      if (matches.length > 0) {
        break;
      }
    }

    const bestMatch = this.findBestTmdbMatch(media, matches);
    if (!bestMatch) {
      return media;
    }

    const updated = this.applyTmdbMatchToMedia(media, bestMatch);
    const persisted = await this.upsertAndNormalizeMedia([updated]);
    return persisted[0] ?? updated;
  }
}
