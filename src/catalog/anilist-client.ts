import { MediaItemRecord } from '../db/schema';
import {
  AniListClient,
  AniListHomeFeedData,
  AniListScheduleItem,
  AniListSeasonItem,
  CatalogFilter,
  CatalogRateLimitError,
  CatalogRelation,
  CatalogSort,
  FetchLike,
  parseRetryAfterSeconds,
  resolveDefaultFetch,
  SeasonName,
  stripHtmlText,
} from './types';

const ANILIST_GRAPHQL_ENDPOINT = 'https://graphql.anilist.co';
const ANILIST_MAX_REQ_PER_MIN = 90;

const MEDIA_FIELDS_FRAGMENT = `
  fragment MediaFields on Media {
    id
    idMal
    type
    isAdult
    title {
      romaji
      english
      native
    }
    description(asHtml: false)
    coverImage {
      extraLarge
      large
    }
    bannerImage
    genres
    seasonYear
    season
    format
    episodes
    status
    startDate {
      year
      month
      day
    }
    nextAiringEpisode {
      airingAt
      episode
    }
    relations {
      edges {
        relationType
        node {
          id
          type
          format
          seasonYear
          title {
            romaji
            english
          }
        }
      }
    }
  }
`;

const HOME_FEED_QUERY = `
  ${MEDIA_FIELDS_FRAGMENT}
  query HomeFeed($seasonYear: Int, $season: MediaSeason) {
    trending: Page(page: 1, perPage: 15) {
      media(type: ANIME, sort: [TRENDING_DESC], isAdult: false) {
        ...MediaFields
      }
    }
    season: Page(page: 1, perPage: 20) {
      media(type: ANIME, seasonYear: $seasonYear, season: $season, sort: [POPULARITY_DESC], isAdult: false) {
        ...MediaFields
      }
    }
  }
`;

const SEARCH_CATALOG_QUERY = `
  ${MEDIA_FIELDS_FRAGMENT}
  query SearchCatalog(
    $search: String,
    $genres: [String],
    $sort: [MediaSort],
    $seasonYear: Int,
    $season: MediaSeason,
    $format: MediaFormat
  ) {
    Page(page: 1, perPage: 25) {
      media(
        type: ANIME,
        search: $search,
        genre_in: $genres,
        sort: $sort,
        seasonYear: $seasonYear,
        season: $season,
        format: $format,
        isAdult: false
      ) {
        ...MediaFields
      }
    }
  }
`;

const WEEKLY_SCHEDULE_QUERY = `
  ${MEDIA_FIELDS_FRAGMENT}
  query WeeklySchedule($start: Int, $end: Int) {
    Page(page: 1, perPage: 50) {
      airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: [TIME]) {
        episode
        airingAt
        media {
          ...MediaFields
        }
      }
    }
  }
`;

const UPCOMING_SEASONS_QUERY = `
  ${MEDIA_FIELDS_FRAGMENT}
  query UpcomingSeasons {
    Page(page: 1, perPage: 30) {
      media(type: ANIME, status: NOT_YET_RELEASED, sort: [POPULARITY_DESC], isAdult: false) {
        ...MediaFields
      }
    }
  }
`;

interface RawAniListTitle {
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
}

interface RawAniListRelationEdge {
  relationType?: string | null;
  node?: {
    id?: number | null;
    type?: string | null;
    format?: string | null;
    seasonYear?: number | null;
    title?: RawAniListTitle | null;
  } | null;
}

interface RawAniListMedia {
  id: number;
  idMal?: number | null;
  type?: string | null;
  isAdult?: boolean | null;
  title?: RawAniListTitle | null;
  description?: string | null;
  coverImage?: {
    extraLarge?: string | null;
    large?: string | null;
  } | null;
  bannerImage?: string | null;
  genres?: unknown;
  seasonYear?: number | null;
  season?: string | null;
  format?: string | null;
  episodes?: number | null;
  status?: string | null;
  startDate?: {
    year?: number | null;
    month?: number | null;
    day?: number | null;
  } | null;
  nextAiringEpisode?: {
    airingAt?: number | null;
    episode?: number | null;
  } | null;
  relations?: {
    edges?: RawAniListRelationEdge[] | null;
  } | null;
}

function mapSortToAniList(sort: CatalogSort | undefined, hasQuery: boolean): string[] {
  switch (sort) {
    case 'TRENDING_MONTH':
      return ['TRENDING_DESC'];
    case 'POPULARITY':
      return ['POPULARITY_DESC'];
    case 'SCORE':
      return ['SCORE_DESC'];
    case 'NEWEST':
      return ['START_DATE_DESC'];
    default:
      return hasQuery ? ['SEARCH_MATCH'] : ['TRENDING_DESC'];
  }
}

function normalizeAniListRelationType(rawType: string | null | undefined): string | null {
  if (!rawType) {
    return null;
  }
  const upper = rawType.toUpperCase();
  if (upper === 'PREQUEL' || upper === 'SEQUEL' || upper === 'SIDE_STORY') {
    return upper;
  }
  if (upper === 'SPIN_OFF') {
    return 'SIDE_STORY';
  }
  return null;
}

function mapRelations(raw: RawAniListMedia): CatalogRelation[] {
  const edges = raw.relations?.edges;
  if (!Array.isArray(edges)) {
    return [];
  }

  const relations: CatalogRelation[] = [];
  for (const edge of edges) {
    if (!edge?.node || typeof edge.node.id !== 'number') {
      continue;
    }
    if (edge.node.type && edge.node.type !== 'ANIME') {
      continue;
    }
    const mappedType = normalizeAniListRelationType(edge.relationType);
    if (!mappedType) {
      continue;
    }
    const title =
      edge.node.title?.english?.trim() ||
      edge.node.title?.romaji?.trim() ||
      `Anime #${edge.node.id}`;
    relations.push({
      anilistId: edge.node.id,
      title,
      format: edge.node.format?.trim() || 'ANIME',
      relationType: mappedType,
      seasonYear:
        typeof edge.node.seasonYear === 'number' ? edge.node.seasonYear : null,
    });
  }
  return relations;
}

export interface AniListHttpClientOptions {
  endpoint?: string;
  fetchFn?: FetchLike;
  nowFn?: () => number;
  maxRequestsPerMinute?: number;
}

/**
 * GraphQL client for AniList v2 enforcing the 90 req/min free-tier cap and
 * converting HTTP 429 responses into CatalogRateLimitError.
 */
export class AniListHttpClient implements AniListClient {
  private readonly endpoint: string;
  private readonly fetchFn?: FetchLike;
  private readonly nowFn: () => number;
  private readonly maxRequestsPerMinute: number;
  private readonly recentTimestamps: number[] = [];

  constructor(options: AniListHttpClientOptions = {}) {
    this.endpoint = options.endpoint ?? ANILIST_GRAPHQL_ENDPOINT;
    this.fetchFn = options.fetchFn;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? ANILIST_MAX_REQ_PER_MIN;
  }

  private assertWithinMinuteBudget(): void {
    const now = this.nowFn();
    const cutoff = now - 60_000;
    while (this.recentTimestamps.length > 0 && this.recentTimestamps[0] <= cutoff) {
      this.recentTimestamps.shift();
    }
    if (this.recentTimestamps.length >= this.maxRequestsPerMinute) {
      const retryAfterSeconds = Math.ceil((this.recentTimestamps[0] + 60_000 - now) / 1000);
      throw new CatalogRateLimitError(
        'ANILIST',
        'AniList client-side 90 req/min rate budget reached',
        Math.max(1, retryAfterSeconds)
      );
    }
    this.recentTimestamps.push(now);
  }

  private mapMedia(raw: RawAniListMedia, cachedAtIso: string): MediaItemRecord {
    const genres = Array.isArray(raw.genres)
      ? raw.genres.filter((genre): genre is string => typeof genre === 'string')
      : [];
    const titleRomaji =
      raw.title?.romaji?.trim() ||
      raw.title?.english?.trim() ||
      raw.title?.native?.trim() ||
      `Anime #${raw.id}`;

    return {
      id: `anilist:${raw.id}`,
      mediaType: 'ANIME',
      anilistId: raw.id,
      malId: typeof raw.idMal === 'number' ? raw.idMal : null,
      tmdbId: null,
      titleRomaji,
      titleEnglish: raw.title?.english?.trim() || null,
      titlePt: null,
      synopsis: stripHtmlText(raw.description),
      coverUrl: raw.coverImage?.extraLarge || raw.coverImage?.large || '',
      bannerUrl: raw.bannerImage || null,
      genresJson: JSON.stringify(genres),
      seasonYear:
        typeof raw.seasonYear === 'number'
          ? raw.seasonYear
          : typeof raw.startDate?.year === 'number'
            ? raw.startDate.year
            : null,
      seasonName: typeof raw.season === 'string' ? raw.season.toUpperCase() : null,
      episodesTotal: typeof raw.episodes === 'number' ? raw.episodes : null,
      statusAiring: typeof raw.status === 'string' ? raw.status : 'UNKNOWN',
      nextAiringAt:
        typeof raw.nextAiringEpisode?.airingAt === 'number'
          ? raw.nextAiringEpisode.airingAt
          : null,
      nextAiringEp:
        typeof raw.nextAiringEpisode?.episode === 'number'
          ? raw.nextAiringEpisode.episode
          : null,
      relationsJson: JSON.stringify(mapRelations(raw)),
      cachedAt: cachedAtIso,
    };
  }

  private async executeGraphQL<TData>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<TData> {
    this.assertWithinMinuteBudget();
    const fetchImpl = this.fetchFn ?? resolveDefaultFetch();
    const response = await fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    const retryAfter = parseRetryAfterSeconds(response.headers);
    if (response.status === 429) {
      throw new CatalogRateLimitError(
        'ANILIST',
        'AniList API returned HTTP 429 Too Many Requests',
        retryAfter
      );
    }

    const payload = (await response.json()) as {
      data?: TData;
      errors?: Array<{ message?: string; status?: number }>;
    };

    if (
      Array.isArray(payload.errors) &&
      payload.errors.some((err) => err?.status === 429 || /too many requests/i.test(err?.message ?? ''))
    ) {
      throw new CatalogRateLimitError('ANILIST', 'AniList GraphQL rate limit exceeded', retryAfter);
    }

    if (!response.ok || !payload.data) {
      const errorMsg =
        payload.errors?.map((e) => e.message).filter(Boolean).join('; ') ||
        `HTTP ${response.status}`;
      throw new Error(`AniList GraphQL request failed: ${errorMsg}`);
    }

    return payload.data;
  }

  async getHomeFeed(
    seasonYear: number,
    seasonName: SeasonName
  ): Promise<AniListHomeFeedData> {
    const data = await this.executeGraphQL<{
      trending?: { media?: RawAniListMedia[] };
      season?: { media?: RawAniListMedia[] };
    }>(HOME_FEED_QUERY, {
      seasonYear,
      season: seasonName,
    });

    const cachedAtIso = new Date(this.nowFn()).toISOString();
    const trendingMonth = (data.trending?.media ?? [])
      .filter((m) => m && typeof m.id === 'number' && !m.isAdult)
      .map((m) => this.mapMedia(m, cachedAtIso));
    const currentSeason = (data.season?.media ?? [])
      .filter((m) => m && typeof m.id === 'number' && !m.isAdult)
      .map((m) => this.mapMedia(m, cachedAtIso));

    return { trendingMonth, currentSeason };
  }

  async searchCatalog(filter: CatalogFilter): Promise<MediaItemRecord[]> {
    const trimmedQuery = filter.query?.trim();
    const variables: Record<string, unknown> = {
      sort: mapSortToAniList(filter.sort, Boolean(trimmedQuery)),
    };
    if (trimmedQuery) {
      variables.search = trimmedQuery;
    }
    if (filter.genres && filter.genres.length > 0) {
      variables.genres = filter.genres;
    }
    if (typeof filter.seasonYear === 'number') {
      variables.seasonYear = filter.seasonYear;
    }
    if (filter.seasonName) {
      variables.season = filter.seasonName;
    }
    if (filter.format) {
      variables.format = filter.format;
    }

    const data = await this.executeGraphQL<{
      Page?: { media?: RawAniListMedia[] };
    }>(SEARCH_CATALOG_QUERY, variables);

    const cachedAtIso = new Date(this.nowFn()).toISOString();
    return (data.Page?.media ?? [])
      .filter((m) => m && typeof m.id === 'number' && !m.isAdult)
      .map((m) => this.mapMedia(m, cachedAtIso));
  }

  async getWeeklySchedule(
    startUnix: number,
    endUnix: number
  ): Promise<AniListScheduleItem[]> {
    const data = await this.executeGraphQL<{
      Page?: {
        airingSchedules?: Array<{
          episode?: number;
          airingAt?: number;
          media?: RawAniListMedia | null;
        }>;
      };
    }>(WEEKLY_SCHEDULE_QUERY, {
      start: Math.floor(startUnix),
      end: Math.floor(endUnix),
    });

    const cachedAtIso = new Date(this.nowFn()).toISOString();
    const items: AniListScheduleItem[] = [];

    for (const schedule of data.Page?.airingSchedules ?? []) {
      const rawMedia = schedule.media;
      if (
        !rawMedia ||
        typeof rawMedia.id !== 'number' ||
        rawMedia.isAdult ||
        (rawMedia.type && rawMedia.type !== 'ANIME') ||
        typeof schedule.airingAt !== 'number' ||
        typeof schedule.episode !== 'number'
      ) {
        continue;
      }

      const mapped = this.mapMedia(rawMedia, cachedAtIso);
      mapped.nextAiringAt = mapped.nextAiringAt ?? schedule.airingAt;
      mapped.nextAiringEp = mapped.nextAiringEp ?? schedule.episode;

      items.push({
        media: mapped,
        episodeNumber: schedule.episode,
        airingAtUnix: schedule.airingAt,
        format: rawMedia.format ?? undefined,
      });
    }

    return items;
  }

  async getUpcomingSeasons(): Promise<AniListSeasonItem[]> {
    const data = await this.executeGraphQL<{
      Page?: { media?: RawAniListMedia[] };
    }>(UPCOMING_SEASONS_QUERY, {});

    const cachedAtIso = new Date(this.nowFn()).toISOString();
    return (data.Page?.media ?? [])
      .filter((m) => m && typeof m.id === 'number' && !m.isAdult)
      .map((raw) => ({
        media: this.mapMedia(raw, cachedAtIso),
        startMonth:
          typeof raw.startDate?.month === 'number' &&
          raw.startDate.month >= 1 &&
          raw.startDate.month <= 12
            ? raw.startDate.month
            : null,
        format: raw.format ?? undefined,
      }));
  }
}
