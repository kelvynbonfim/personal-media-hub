import { LibraryEntryRecord, MediaItemRecord, WatchStatus } from '../db/schema';

export type SeasonName = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
export type CatalogSort = 'TRENDING_MONTH' | 'POPULARITY' | 'SCORE' | 'NEWEST';
export type CatalogFormat = 'TV' | 'MOVIE' | 'OVA';
export type FranchiseRelationType = 'PREQUEL' | 'CURRENT' | 'SEQUEL' | 'SIDE_STORY';

export interface CatalogFilter {
  query?: string;
  genres?: string[];
  sort?: CatalogSort;
  seasonYear?: number;
  seasonName?: SeasonName;
  format?: CatalogFormat;
  hideCompleted?: boolean;
}

export interface WeeklyScheduleEntry {
  media: MediaItemRecord;
  episodeNumber: number;
  airingAtUnix: number;
  weekdayIndex: number;
  inUserActiveList: boolean;
}

export interface UpcomingSeasonEntry {
  media: MediaItemRecord;
  releaseLabel: string;
  isSequelToLibraryItem: boolean;
}

export interface FranchiseNode {
  anilistId: number;
  title: string;
  format: string;
  relationType: FranchiseRelationType;
  userStatus?: WatchStatus;
}

export interface HomeFeedResult {
  hero: MediaItemRecord | null;
  trendingMonth: MediaItemRecord[];
  currentSeason: MediaItemRecord[];
}

export interface CatalogRelation {
  anilistId: number;
  title: string;
  format: string;
  relationType: 'PREQUEL' | 'SEQUEL' | 'SIDE_STORY' | string;
  seasonYear?: number | null;
}

export class CatalogRateLimitError extends Error {
  public readonly statusCode = 429;
  public readonly provider: 'ANILIST' | 'JIKAN' | 'TMDB';
  public readonly retryAfterSeconds: number | null;

  constructor(
    provider: 'ANILIST' | 'JIKAN' | 'TMDB',
    message = `${provider} API rate limit exceeded (HTTP 429)`,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'CatalogRateLimitError';
    this.provider = provider;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AniListScheduleItem {
  media: MediaItemRecord;
  episodeNumber: number;
  airingAtUnix: number;
  format?: string;
}

export interface AniListSeasonItem {
  media: MediaItemRecord;
  startMonth: number | null;
  format?: string;
}

export interface AniListHomeFeedData {
  trendingMonth: MediaItemRecord[];
  currentSeason: MediaItemRecord[];
}

export interface AniListClient {
  getHomeFeed(seasonYear: number, seasonName: SeasonName): Promise<AniListHomeFeedData>;
  searchCatalog(filter: CatalogFilter): Promise<MediaItemRecord[]>;
  getWeeklySchedule(startUnix: number, endUnix: number): Promise<AniListScheduleItem[]>;
  getUpcomingSeasons(): Promise<AniListSeasonItem[]>;
}

export interface JikanClient {
  getTopTrending(): Promise<MediaItemRecord[]>;
  getCurrentSeason(): Promise<MediaItemRecord[]>;
  searchCatalog(filter: CatalogFilter): Promise<MediaItemRecord[]>;
  getWeeklySchedule(): Promise<AniListScheduleItem[]>;
  getUpcomingSeasons(): Promise<AniListSeasonItem[]>;
}

export interface TmdbAnimeLocalization {
  tmdbId: number;
  titlePt: string;
  originalTitle: string;
  overviewPt: string | null;
  mediaType: 'tv' | 'movie';
}

export interface TmdbClient {
  searchAnimePtBr(query: string, apiKey: string): Promise<TmdbAnimeLocalization[]>;
}

export interface FetchHeadersLike {
  get(name: string): string | null | undefined;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: FetchHeadersLike | Map<string, string> | null;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export type LibraryEntryWithOptionalMedia = LibraryEntryRecord & {
  media?: MediaItemRecord;
};

export function parseGenresSafe(genresJson: string): string[] {
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

export function parseRelationsSafe(relationsJson: string): CatalogRelation[] {
  try {
    const parsed: unknown = JSON.parse(relationsJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const relations: CatalogRelation[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (
        typeof record.anilistId === 'number' &&
        Number.isFinite(record.anilistId) &&
        typeof record.title === 'string' &&
        typeof record.relationType === 'string'
      ) {
        relations.push({
          anilistId: record.anilistId,
          title: record.title,
          format: typeof record.format === 'string' ? record.format : 'ANIME',
          relationType: record.relationType,
          seasonYear:
            typeof record.seasonYear === 'number' && Number.isFinite(record.seasonYear)
              ? record.seasonYear
              : null,
        });
      }
    }
    return relations;
  } catch {
    return [];
  }
}

export function stripHtmlText(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const cleaned = input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function parseRetryAfterSeconds(
  headers?: FetchHeadersLike | Map<string, string> | null
): number | null {
  if (!headers) {
    return null;
  }
  let raw: string | null | undefined = null;
  if (headers instanceof Map) {
    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase() === 'retry-after') {
        raw = value;
        break;
      }
    }
  } else if (typeof headers.get === 'function') {
    raw = headers.get('retry-after') ?? headers.get('Retry-After');
  }

  if (!raw) {
    return null;
  }
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function resolveDefaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Global fetch is not available in this runtime.');
  }
  return globalThis.fetch.bind(globalThis) as unknown as FetchLike;
}
