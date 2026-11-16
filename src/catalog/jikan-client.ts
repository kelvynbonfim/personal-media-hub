import { MediaItemRecord } from '../db/schema';
import {
  AniListScheduleItem,
  AniListSeasonItem,
  CatalogFilter,
  CatalogFormat,
  CatalogRateLimitError,
  CatalogSort,
  FetchLike,
  JikanClient,
  parseGenresSafe,
  parseRetryAfterSeconds,
  resolveDefaultFetch,
} from './types';

const JIKAN_BASE_URL = 'https://api.jikan.moe/v4';
const JIKAN_MIN_INTERVAL_MS = 350;
const JIKAN_MAX_REQ_PER_MIN = 60;

const JIKAN_GENRE_IDS: Record<string, number> = {
  action: 1,
  adventure: 2,
  comedy: 4,
  drama: 8,
  fantasy: 10,
  horror: 14,
  mystery: 7,
  romance: 22,
  'sci-fi': 24,
  'slice of life': 36,
  sports: 30,
  supernatural: 37,
  suspense: 41,
};

const WEEKDAY_NAME_TO_INDEX: Record<string, number> = {
  sundays: 0,
  sunday: 0,
  mondays: 1,
  monday: 1,
  tuesdays: 2,
  tuesday: 2,
  wednesdays: 3,
  wednesday: 3,
  thursdays: 4,
  thursday: 4,
  fridays: 5,
  friday: 5,
  saturdays: 6,
  saturday: 6,
};

interface RawJikanAnime {
  mal_id: number;
  title?: string | null;
  title_english?: string | null;
  synopsis?: string | null;
  type?: string | null;
  images?: {
    jpg?: {
      large_image_url?: string | null;
      image_url?: string | null;
    } | null;
    webp?: {
      large_image_url?: string | null;
      image_url?: string | null;
    } | null;
  } | null;
  genres?: Array<{ name?: string | null }> | null;
  themes?: Array<{ name?: string | null }> | null;
  year?: number | null;
  season?: string | null;
  episodes?: number | null;
  status?: string | null;
  aired?: {
    from?: string | null;
  } | null;
  broadcast?: {
    day?: string | null;
    time?: string | null;
  } | null;
}

function mapJikanStatus(status: string | null | undefined): string {
  if (!status) {
    return 'UNKNOWN';
  }
  const lower = status.toLowerCase();
  if (lower.includes('currently airing')) {
    return 'RELEASING';
  }
  if (lower.includes('finished')) {
    return 'FINISHED';
  }
  if (lower.includes('not yet aired')) {
    return 'NOT_YET_RELEASED';
  }
  return status.toUpperCase();
}

function parseAiredDateParts(iso: string | null | undefined): {
  year: number | null;
  month: number | null;
} {
  if (!iso || typeof iso !== 'string') {
    return { year: null, month: null };
  }
  const match = /^(\d{4})-(\d{2})/.exec(iso.trim());
  if (!match) {
    return { year: null, month: null };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    year: Number.isFinite(year) ? year : null,
    month: Number.isFinite(month) && month >= 1 && month <= 12 ? month : null,
  };
}

function mapJikanFormat(format: CatalogFormat | undefined): string | undefined {
  switch (format) {
    case 'TV':
      return 'tv';
    case 'MOVIE':
      return 'movie';
    case 'OVA':
      return 'ova';
    default:
      return undefined;
  }
}

function mapJikanSort(sort: CatalogSort | undefined): {
  orderBy?: string;
  sort?: 'asc' | 'desc';
} {
  switch (sort) {
    case 'TRENDING_MONTH':
    case 'POPULARITY':
      return { orderBy: 'members', sort: 'desc' };
    case 'SCORE':
      return { orderBy: 'score', sort: 'desc' };
    case 'NEWEST':
      return { orderBy: 'start_date', sort: 'desc' };
    default:
      return {};
  }
}

function estimateWeekdayAiringUnix(
  nowMs: number,
  dayName: string | null | undefined,
  timeStr: string | null | undefined
): number | null {
  if (!dayName) {
    return null;
  }
  const targetDay = WEEKDAY_NAME_TO_INDEX[dayName.trim().toLowerCase()];
  if (targetDay === undefined) {
    return null;
  }
  const date = new Date(nowMs);
  const currentDay = date.getDay();
  const deltaDays = (targetDay - currentDay + 7) % 7;
  date.setDate(date.getDate() + deltaDays);

  let hours = 12;
  let minutes = 0;
  if (timeStr) {
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
    if (timeMatch) {
      hours = Math.min(23, Number(timeMatch[1]));
      minutes = Math.min(59, Number(timeMatch[2]));
    }
  }
  date.setHours(hours, minutes, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export interface JikanHttpClientOptions {
  baseUrl?: string;
  fetchFn?: FetchLike;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  maxRequestsPerMinute?: number;
}

/**
 * REST client for Jikan v4 enforcing a serialized request queue with >=350ms
 * spacing (<= 3 req/s) and <=60 req/min rate protection.
 */
export class JikanHttpClient implements JikanClient {
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchLike;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRequestsPerMinute: number;
  private readonly recentTimestamps: number[] = [];
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: JikanHttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? JIKAN_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.sleepFn =
      options.sleepFn ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minIntervalMs = options.minIntervalMs ?? JIKAN_MIN_INTERVAL_MS;
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? JIKAN_MAX_REQ_PER_MIN;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.requestQueue.then(async () => {
      if (this.lastRequestAt > 0 && this.minIntervalMs > 0) {
        const elapsed = this.nowFn() - this.lastRequestAt;
        if (elapsed < this.minIntervalMs) {
          await this.sleepFn(this.minIntervalMs - elapsed);
        }
      }

      const nowAfterSpacing = this.nowFn();
      const cutoff = nowAfterSpacing - 60_000;
      while (this.recentTimestamps.length > 0 && this.recentTimestamps[0] <= cutoff) {
        this.recentTimestamps.shift();
      }
      if (this.recentTimestamps.length >= this.maxRequestsPerMinute) {
        const waitMs = Math.max(1, this.recentTimestamps[0] + 60_000 - nowAfterSpacing);
        await this.sleepFn(waitMs);
      }

      const dispatchTime = this.nowFn();
      this.lastRequestAt = dispatchTime;
      this.recentTimestamps.push(dispatchTime);
      return task();
    });

    this.requestQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async getJson<TPayload>(pathWithQuery: string): Promise<TPayload> {
    return this.enqueue(async () => {
      const fetchImpl = this.fetchFn ?? resolveDefaultFetch();
      const response = await fetchImpl(`${this.baseUrl}${pathWithQuery}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (response.status === 429) {
        throw new CatalogRateLimitError(
          'JIKAN',
          'Jikan API v4 returned HTTP 429 Too Many Requests',
          parseRetryAfterSeconds(response.headers)
        );
      }

      if (!response.ok) {
        throw new Error(`Jikan API request failed: HTTP ${response.status}`);
      }

      return (await response.json()) as TPayload;
    });
  }

  private mapAnime(raw: RawJikanAnime, cachedAtIso: string): MediaItemRecord {
    const genreNames = [
      ...(raw.genres ?? []),
      ...(raw.themes ?? []),
    ]
      .map((item) => item?.name?.trim())
      .filter((name): name is string => Boolean(name));
    const uniqueGenres = Array.from(new Set(genreNames));
    const airedParts = parseAiredDateParts(raw.aired?.from);
    const malId = raw.mal_id;

    return {
      id: `mal:${malId}`,
      mediaType: 'ANIME',
      anilistId: -Math.abs(malId),
      malId,
      tmdbId: null,
      titleRomaji: raw.title?.trim() || raw.title_english?.trim() || `MAL #${malId}`,
      titleEnglish: raw.title_english?.trim() || null,
      titlePt: null,
      synopsis: raw.synopsis?.trim() || null,
      coverUrl:
        raw.images?.webp?.large_image_url ||
        raw.images?.jpg?.large_image_url ||
        raw.images?.webp?.image_url ||
        raw.images?.jpg?.image_url ||
        '',
      bannerUrl: null,
      genresJson: JSON.stringify(uniqueGenres),
      seasonYear: typeof raw.year === 'number' ? raw.year : airedParts.year,
      seasonName:
        typeof raw.season === 'string' && raw.season.trim()
          ? raw.season.trim().toUpperCase()
          : null,
      episodesTotal: typeof raw.episodes === 'number' ? raw.episodes : null,
      statusAiring: mapJikanStatus(raw.status),
      nextAiringAt: null,
      nextAiringEp: null,
      relationsJson: '[]',
      cachedAt: cachedAtIso,
    };
  }

  async getTopTrending(): Promise<MediaItemRecord[]> {
    const payload = await this.getJson<{ data?: RawJikanAnime[] }>(
      '/top/anime?filter=airing&limit=15&sfw=true'
    );
    const cachedAtIso = new Date(this.nowFn()).toISOString();
    return (payload.data ?? [])
      .filter((item) => item && typeof item.mal_id === 'number')
      .map((item) => this.mapAnime(item, cachedAtIso));
  }

  async getCurrentSeason(): Promise<MediaItemRecord[]> {
    const payload = await this.getJson<{ data?: RawJikanAnime[] }>(
      '/seasons/now?limit=20&sfw=true'
    );
    const cachedAtIso = new Date(this.nowFn()).toISOString();
    return (payload.data ?? [])
      .filter((item) => item && typeof item.mal_id === 'number')
      .map((item) => this.mapAnime(item, cachedAtIso));
  }

  async searchCatalog(filter: CatalogFilter): Promise<MediaItemRecord[]> {
    const params = new URLSearchParams();
    params.set('sfw', 'true');
    params.set('limit', '20');

    const trimmedQuery = filter.query?.trim();
    if (trimmedQuery) {
      params.set('q', trimmedQuery);
    }

    const mappedType = mapJikanFormat(filter.format);
    if (mappedType) {
      params.set('type', mappedType);
    }

    const sortSpec = mapJikanSort(filter.sort);
    if (sortSpec.orderBy) {
      params.set('order_by', sortSpec.orderBy);
      if (sortSpec.sort) {
        params.set('sort', sortSpec.sort);
      }
    }

    if (filter.genres && filter.genres.length > 0) {
      const ids = filter.genres
        .map((genre) => JIKAN_GENRE_IDS[genre.trim().toLowerCase()])
        .filter((id): id is number => typeof id === 'number');
      if (ids.length > 0) {
        params.set('genres', ids.join(','));
      }
    }

    const payload = await this.getJson<{ data?: RawJikanAnime[] }>(
      `/anime?${params.toString()}`
    );
    const cachedAtIso = new Date(this.nowFn()).toISOString();
    const mapped = (payload.data ?? [])
      .filter((item) => item && typeof item.mal_id === 'number')
      .map((item) => this.mapAnime(item, cachedAtIso));

    return mapped.filter((item) => {
      if (filter.seasonYear !== undefined && item.seasonYear !== filter.seasonYear) {
        return false;
      }
      if (
        filter.seasonName !== undefined &&
        item.seasonName?.toUpperCase() !== filter.seasonName
      ) {
        return false;
      }
      if (filter.genres && filter.genres.length > 0) {
        const itemGenres = new Set(parseGenresSafe(item.genresJson).map((g) => g.toLowerCase()));
        if (!filter.genres.every((g) => itemGenres.has(g.trim().toLowerCase()))) {
          return false;
        }
      }
      return true;
    });
  }

  async getWeeklySchedule(): Promise<AniListScheduleItem[]> {
    const payload = await this.getJson<{ data?: RawJikanAnime[] }>(
      '/schedules?sfw=true&limit=25'
    );
    const nowMs = this.nowFn();
    const cachedAtIso = new Date(nowMs).toISOString();
    const results: AniListScheduleItem[] = [];

    for (const raw of payload.data ?? []) {
      if (!raw || typeof raw.mal_id !== 'number') {
        continue;
      }
      const airingAtUnix = estimateWeekdayAiringUnix(
        nowMs,
        raw.broadcast?.day,
        raw.broadcast?.time
      );
      if (airingAtUnix === null) {
        continue;
      }
      const media = this.mapAnime(raw, cachedAtIso);
      media.nextAiringAt = airingAtUnix;
      media.nextAiringEp = 1;

      results.push({
        media,
        episodeNumber: 1,
        airingAtUnix,
        format: raw.type ?? undefined,
      });
    }

    return results;
  }

  async getUpcomingSeasons(): Promise<AniListSeasonItem[]> {
    const payload = await this.getJson<{ data?: RawJikanAnime[] }>(
      '/seasons/upcoming?limit=25&sfw=true'
    );
    const cachedAtIso = new Date(this.nowFn()).toISOString();

    return (payload.data ?? [])
      .filter((item) => item && typeof item.mal_id === 'number')
      .map((raw) => {
        const media = this.mapAnime(raw, cachedAtIso);
        media.statusAiring = 'NOT_YET_RELEASED';
        const airedParts = parseAiredDateParts(raw.aired?.from);
        return {
          media,
          startMonth: airedParts.month,
          format: raw.type ?? undefined,
        };
      });
  }
}
