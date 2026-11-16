import {
  CatalogRateLimitError,
  FetchInitLike,
  FetchLike,
  parseRetryAfterSeconds,
  resolveDefaultFetch,
  TmdbAnimeLocalization,
  TmdbClient,
} from './types';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_ANIMATION_GENRE_ID = 16;

interface RawTmdbSearchResult {
  id: number;
  media_type?: string | null;
  name?: string | null;
  original_name?: string | null;
  title?: string | null;
  original_title?: string | null;
  overview?: string | null;
  genre_ids?: unknown;
  original_language?: string | null;
  first_air_date?: string | null;
  release_date?: string | null;
}

function parseReleaseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }
  const match = /^(\d{4})/.exec(dateStr.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

export interface TmdbHttpClientOptions {
  baseUrl?: string;
  fetchFn?: FetchLike;
}

/**
 * Strictly optional TMDB pt-BR client; only performs network calls when a
 * non-empty tmdbApiKey is supplied from app_settings.
 */
export class TmdbHttpClient implements TmdbClient {
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchLike;

  constructor(options: TmdbHttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? TMDB_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn;
  }

  async searchAnimePtBr(
    query: string,
    apiKey: string
  ): Promise<TmdbAnimeLocalization[]> {
    const trimmedKey = apiKey.trim();
    const trimmedQuery = query.trim();
    if (!trimmedKey || !trimmedQuery) {
      return [];
    }

    const params = new URLSearchParams({
      language: 'pt-BR',
      include_adult: 'false',
      query: trimmedQuery,
    });
    const init: FetchInitLike = {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    };

    if (trimmedKey.startsWith('eyJ')) {
      init.headers = {
        ...init.headers,
        Authorization: `Bearer ${trimmedKey}`,
      };
    } else {
      params.set('api_key', trimmedKey);
    }

    const fetchImpl = this.fetchFn ?? resolveDefaultFetch();
    const response = await fetchImpl(
      `${this.baseUrl}/search/multi?${params.toString()}`,
      init
    );

    if (response.status === 429) {
      throw new CatalogRateLimitError(
        'TMDB',
        'TMDB API returned HTTP 429 Too Many Requests',
        parseRetryAfterSeconds(response.headers)
      );
    }

    if (!response.ok) {
      throw new Error(`TMDB search request failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      results?: RawTmdbSearchResult[];
    };

    const candidates = (payload.results ?? []).filter(
      (item): item is RawTmdbSearchResult =>
        Boolean(item) &&
        typeof item.id === 'number' &&
        (item.media_type === 'tv' || item.media_type === 'movie')
    );

    const isAnimation = (item: RawTmdbSearchResult): boolean =>
      Array.isArray(item.genre_ids) && item.genre_ids.includes(TMDB_ANIMATION_GENRE_ID);

    const priorityTier = (item: RawTmdbSearchResult): number => {
      const anim = isAnimation(item);
      const isJapanese = item.original_language?.trim().toLowerCase() === 'ja';
      if (anim && isJapanese) {
        return 0;
      }
      if (anim) {
        return 1;
      }
      if (isJapanese) {
        return 2;
      }
      return 3;
    };

    const prioritized = [...candidates].sort((a, b) => priorityTier(a) - priorityTier(b));

    return prioritized.map((item) => {
      const isMovie = item.media_type === 'movie';
      const localizedTitle = isMovie
        ? item.title?.trim() || item.original_title?.trim() || ''
        : item.name?.trim() || item.original_name?.trim() || '';
      const originalTitle = isMovie
        ? item.original_title?.trim() || localizedTitle
        : item.original_name?.trim() || localizedTitle;
      const originalLanguage = item.original_language?.trim().toLowerCase() || null;
      const releaseYear = parseReleaseYear(isMovie ? item.release_date : item.first_air_date);

      return {
        tmdbId: item.id,
        titlePt: localizedTitle,
        originalTitle,
        overviewPt: item.overview?.trim() ? item.overview.trim() : null,
        mediaType: isMovie ? 'movie' : 'tv',
        ...(originalLanguage ? { originalLanguage } : {}),
        ...(releaseYear !== null ? { releaseYear } : {}),
      };
    });
  }
}
