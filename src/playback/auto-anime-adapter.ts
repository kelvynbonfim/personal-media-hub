import { LibraryRepository } from '../db/library-repository';
import { MediaItemRecord } from '../db/schema';
import { CredentialsStore } from './credentials-store';
import {
  PlaybackResolution,
  PlaybackResolveParams,
  PlaybackSourceAdapter,
} from './types';
import {
  buildTitleCandidates,
  UniTvPlaybackAdapter,
  UniTvSessionBridge,
} from './unitv-adapter';
import { UniTvProbeResult } from './unitv-probe';

const ANIMEFIRE_API_BASE = 'https://api.animefire.one';
const ANIMEFIRE_ORIGIN = 'https://animefire.plus';
const ANIMESONLINECC_BASE = 'https://animesonlinecc.to';
const DEFAULT_FETCH_TIMEOUT_MS = 6000;

export const MOBILE_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

interface AnimeFireTitleMap {
  BR?: string | null;
  US?: string | null;
  JP?: string | null;
}

interface AnimeFireSearchItem {
  id: string;
  titles?: AnimeFireTitleMap;
  audio?: string | null;
}

interface AnimeFireEpisodeSummary {
  id: string;
  number: number;
  season?: number | null;
}

interface AnimeFireStream {
  audio?: string | null;
  is_offline?: boolean;
  url?: string | null;
  qualities?: string[];
}

export interface AutoAnimePlaybackAdapterDeps {
  bridge: UniTvSessionBridge;
  credentialsStore: CredentialsStore;
  repository?: Pick<LibraryRepository, 'saveUniTvLink'>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

function normalizeMatchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Converts an anime title into an ASCII URL slug suitable for streaming portals.
 */
export function slugifyAnimeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds deduplicated search queries in PT -> EN -> Romaji order, appending stripped base titles.
 */
export function buildExpandedTitleCandidates(media: MediaItemRecord): string[] {
  const baseList = buildTitleCandidates(media);
  const seen = new Set<string>(baseList.map((item) => item.toLowerCase()));
  const expanded = [...baseList];

  for (const title of baseList) {
    const stripped = title
      .replace(
        /\s*(?:season\s*\d+|\d+(?:st|nd|rd|th)\s*season|part\s*\d+|cour\s*\d+|temporada\s*\d+|:\s*.*)$/i,
        ''
      )
      .trim()
      .replace(/\s+/g, ' ');

    if (stripped.length >= 2 && !seen.has(stripped.toLowerCase())) {
      seen.add(stripped.toLowerCase());
      expanded.push(stripped);
    }
  }

  return expanded;
}

/**
 * Extracts the embedded Blogger player iframe URL from an episode HTML page.
 */
export function extractBloggerIframeUrl(html: string): string | null {
  if (!html) {
    return null;
  }

  const bloggerMatch =
    /<iframe[^>]+src=["']([^"']*blogger\.com\/video\.g[^"']*)["']/i.exec(html);
  if (bloggerMatch?.[1]) {
    return bloggerMatch[1].replace(/&amp;/g, '&').trim();
  }

  const metaframeMatch =
    /<iframe[^>]+class=["'][^"']*metaframe[^"']*["'][^>]+src=["']([^"']+)["']/i.exec(
      html
    );
  if (metaframeMatch?.[1]) {
    return metaframeMatch[1].replace(/&amp;/g, '&').trim();
  }

  return null;
}

function getItagPriority(url: string): number {
  const match = /[?&]itag=(\d+)/i.exec(url);
  if (!match) {
    return 0;
  }
  switch (match[1]) {
    case '37':
      return 300;
    case '22':
      return 200;
    case '18':
      return 100;
    default:
      return 50;
  }
}

/**
 * Extracts the highest-quality direct MP4 playback URL from Blogger video.g HTML,
 * filtering out non-MP4 yt-ump manifests.
 */
export function extractGoogleVideoMp4Url(bloggerHtml: string): string | null {
  if (!bloggerHtml) {
    return null;
  }

  const unescaped = bloggerHtml
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\\+u003d/gi, '=')
    .replace(/\\+u0026/gi, '&')
    .replace(/\\+\//g, '/');

  const matches = unescaped.match(
    /https:\/\/[^\s"'<>\\]+googlevideo\.com\/videoplayback[^\s"'<>\\]+/gi
  );
  if (!matches || matches.length === 0) {
    return null;
  }

  const mp4Candidates = Array.from(new Set(matches)).filter((candidate) => {
    const lower = candidate.toLowerCase();
    if (lower.includes('application/vnd.yt-ump') || lower.includes('yt-ump')) {
      return false;
    }
    const hasMp4Mime =
      lower.includes('mime=video/mp4') || lower.includes('mime=video%2fmp4');
    const hasItag = /[?&]itag=\d+/.test(lower);
    return hasMp4Mime && hasItag;
  });

  if (mp4Candidates.length === 0) {
    return null;
  }

  mp4Candidates.sort((a, b) => getItagPriority(b) - getItagPriority(a));
  return mp4Candidates[0];
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  if (typeof AbortController === 'undefined') {
    return fetchFn(url, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchFn(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function getAnimeFireHeaders(): Record<string, string> {
  return {
    Origin: ANIMEFIRE_ORIGIN,
    Referer: `${ANIMEFIRE_ORIGIN}/`,
    'User-Agent': MOBILE_BROWSER_USER_AGENT,
  };
}

function getBrowserHeaders(referer = `${ANIMESONLINECC_BASE}/`): Record<string, string> {
  return {
    Referer: referer,
    'User-Agent': MOBILE_BROWSER_USER_AGENT,
  };
}

function pickBestAnimeFireItem(
  items: AnimeFireSearchItem[],
  candidates: string[]
): AnimeFireSearchItem | null {
  if (items.length === 0) {
    return null;
  }

  const normalizedCandidates = candidates.map(normalizeMatchText).filter(Boolean);
  for (const candidateKey of normalizedCandidates) {
    const exact = items.find((item) => {
      const titles = [item.titles?.BR, item.titles?.US, item.titles?.JP]
        .filter((t): t is string => Boolean(t))
        .map(normalizeMatchText);
      return titles.includes(candidateKey);
    });
    if (exact) {
      return exact;
    }
  }

  return items[0];
}

/**
 * Fetches Portuguese title & synopsis metadata from the public AnimeFire API without requiring API keys.
 */
export async function fetchAnimeFirePtMetadata(
  media: MediaItemRecord,
  fetchFn: typeof fetch = fetch
): Promise<{ titlePt?: string | null; synopsisPt?: string | null } | null> {
  const candidates = buildExpandedTitleCandidates(media);
  if (candidates.length === 0) {
    return null;
  }

  for (const query of candidates) {
    try {
      const searchUrl = `${ANIMEFIRE_API_BASE}/animes/pesquisar?q=${encodeURIComponent(
        query
      )}&v=3`;
      const searchRes = await fetchWithTimeout(
        fetchFn,
        searchUrl,
        { headers: getAnimeFireHeaders() },
        4000
      );
      if (!searchRes.ok) {
        continue;
      }

      const searchJson = (await searchRes.json()) as {
        data?: AnimeFireSearchItem[];
      };
      const best = pickBestAnimeFireItem(searchJson.data ?? [], candidates);
      if (!best?.id) {
        continue;
      }

      const detailRes = await fetchWithTimeout(
        fetchFn,
        `${ANIMEFIRE_API_BASE}/anime/${encodeURIComponent(best.id)}?v=3`,
        { headers: getAnimeFireHeaders() },
        4000
      );
      if (!detailRes.ok) {
        return {
          titlePt: best.titles?.BR?.trim() || null,
          synopsisPt: null,
        };
      }

      const detailJson = (await detailRes.json()) as {
        data?: {
          titles?: AnimeFireTitleMap;
          synopsis?: string | null;
        };
      };
      const rawTitlePt =
        detailJson.data?.titles?.BR?.trim() || best.titles?.BR?.trim() || null;
      const rawSynopsis = detailJson.data?.synopsis?.trim() ?? '';
      const validSynopsis =
        rawSynopsis.length > 0 && !/sem sinopse/i.test(rawSynopsis)
          ? rawSynopsis
          : null;

      if (!rawTitlePt && !validSynopsis) {
        return null;
      }
      return {
        titlePt: rawTitlePt,
        synopsisPt: validSynopsis,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Automatic zero-login PT-BR anime playback adapter combining AnimeFire 1080p HLS
 * and AnimesOnlineCC + Blogger direct MP4/WebView playback, while preserving optional custom UniTV fallback.
 */
export class AutoAnimePlaybackAdapter
  extends UniTvPlaybackAdapter
  implements PlaybackSourceAdapter
{
  private readonly customRepo?: Pick<LibraryRepository, 'saveUniTvLink'>;
  private readonly customCredsStore: CredentialsStore;
  private readonly fetchFn: typeof fetch;

  constructor(deps: AutoAnimePlaybackAdapterDeps) {
    super({
      bridge: deps.bridge,
      credentialsStore: deps.credentialsStore,
      repository: deps.repository,
      timeoutMs: deps.timeoutMs,
    });
    this.customRepo = deps.repository;
    this.customCredsStore = deps.credentialsStore;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private async saveLinkSafe(
    mediaItemId: string,
    vodId: string,
    title: string,
    preferredAudioOrSub: 'LEG' | 'DUB' | null = null
  ): Promise<void> {
    if (!this.customRepo || typeof this.customRepo.saveUniTvLink !== 'function') {
      return;
    }
    try {
      await this.customRepo.saveUniTvLink({
        mediaItemId,
        unitvVodId: vodId,
        unitvTitle: title,
        unitvSeasonTag: null,
        preferredAudioOrSub,
        lastVerifiedAt: new Date().toISOString(),
      });
    } catch {
      // Saving link metadata is best-effort and should never block playback.
    }
  }

  async resolveEpisodePlayback(
    params: PlaybackResolveParams
  ): Promise<PlaybackResolution> {
    const portalUrl = params.portalUrl?.trim() ?? '';
    if (portalUrl.length > 0 && !portalUrl.toLowerCase().includes('uvwebs.info')) {
      const creds = await this.customCredsStore.getUniTvCredentials().catch(() => null);
      if (creds && creds.username.trim() && creds.password.trim()) {
        const unitvResult = await super.resolveEpisodePlayback(params);
        if (!unitvResult.errorCode) {
          return unitvResult;
        }
      }
    }

    const candidates = buildExpandedTitleCandidates(params.media);
    if (candidates.length === 0) {
      return { mode: 'CLEAN_WEBVIEW', errorCode: 'NOT_FOUND_IN_CATALOG' };
    }

    const animeFireAttempt = await this.tryResolveAnimeFire(params, candidates);
    if (animeFireAttempt.resolution) {
      return animeFireAttempt.resolution;
    }

    const animesOnlineAttempt = await this.tryResolveAnimesOnlineCc(params, candidates);
    if (animesOnlineAttempt) {
      return animesOnlineAttempt;
    }

    if (animeFireAttempt.matchedAnimeId) {
      return {
        mode: 'CLEAN_WEBVIEW',
        webViewUrl: `${ANIMEFIRE_ORIGIN}/anime/${animeFireAttempt.matchedAnimeId}`,
        matchedTitle: animeFireAttempt.matchedTitle,
        vodId: `af:${animeFireAttempt.matchedAnimeId}`,
      };
    }

    return {
      mode: 'CLEAN_WEBVIEW',
      errorCode: 'NOT_FOUND_IN_CATALOG',
    };
  }

  private async tryResolveAnimeFire(
    params: PlaybackResolveParams,
    candidates: string[]
  ): Promise<{
    resolution: PlaybackResolution | null;
    matchedAnimeId?: string;
    matchedTitle?: string;
  }> {
    let matchedAnimeId: string | undefined;
    let matchedTitle = candidates[0];

    const linkedId = params.existingLink?.unitvVodId?.startsWith('af:')
      ? params.existingLink.unitvVodId.slice(3).trim()
      : '';
    if (linkedId) {
      matchedAnimeId = linkedId;
      matchedTitle = params.existingLink?.unitvTitle || matchedTitle;
    }

    if (!matchedAnimeId) {
      for (const query of candidates) {
        try {
          const res = await fetchWithTimeout(
            this.fetchFn,
            `${ANIMEFIRE_API_BASE}/animes/pesquisar?q=${encodeURIComponent(query)}&v=3`,
            { headers: getAnimeFireHeaders() }
          );
          if (!res.ok) {
            continue;
          }
          const json = (await res.json()) as { data?: AnimeFireSearchItem[] };
          const best = pickBestAnimeFireItem(json.data ?? [], candidates);
          if (best?.id) {
            matchedAnimeId = best.id;
            matchedTitle =
              best.titles?.BR?.trim() || best.titles?.US?.trim() || matchedTitle;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!matchedAnimeId) {
      return { resolution: null };
    }

    try {
      const detailRes = await fetchWithTimeout(
        this.fetchFn,
        `${ANIMEFIRE_API_BASE}/anime/${encodeURIComponent(matchedAnimeId)}?v=3`,
        { headers: getAnimeFireHeaders() }
      );
      if (!detailRes.ok) {
        return { resolution: null, matchedAnimeId, matchedTitle };
      }

      const detailJson = (await detailRes.json()) as {
        data?: {
          titles?: AnimeFireTitleMap;
          episodes?: AnimeFireEpisodeSummary[];
        };
      };
      matchedTitle =
        detailJson.data?.titles?.BR?.trim() ||
        detailJson.data?.titles?.US?.trim() ||
        matchedTitle;

      const episodes = detailJson.data?.episodes ?? [];
      if (episodes.length === 0) {
        return { resolution: null, matchedAnimeId, matchedTitle };
      }

      const targetEpisode =
        episodes.find(
          (ep) => ep.number === params.episodeNumber && (ep.season ?? 1) === 1
        ) ??
        episodes.find((ep) => ep.number === params.episodeNumber) ??
        episodes[params.episodeNumber - 1];

      if (!targetEpisode?.id) {
        return { resolution: null, matchedAnimeId, matchedTitle };
      }

      const epRes = await fetchWithTimeout(
        this.fetchFn,
        `${ANIMEFIRE_API_BASE}/episode/${encodeURIComponent(targetEpisode.id)}?v=3`,
        { headers: getAnimeFireHeaders() }
      );
      if (!epRes.ok) {
        return { resolution: null, matchedAnimeId, matchedTitle };
      }

      const epJson = (await epRes.json()) as {
        data?: { streams?: AnimeFireStream[] };
      };
      const rawStreams = (epJson.data?.streams ?? []).filter(
        (s) => !s.is_offline && typeof s.url === 'string' && s.url.trim().length > 0
      );
      if (rawStreams.length === 0) {
        return { resolution: null, matchedAnimeId, matchedTitle };
      }

      const preferredAudio =
        params.existingLink?.preferredAudioOrSub === 'DUB'
          ? 'dublado'
          : params.existingLink?.preferredAudioOrSub === 'LEG'
            ? 'legendado'
            : null;

      const orderedStreams = [...rawStreams].sort((a, b) => {
        if (!preferredAudio) {
          return 0;
        }
        const aMatch = (a.audio ?? '').toLowerCase() === preferredAudio ? 0 : 1;
        const bMatch = (b.audio ?? '').toLowerCase() === preferredAudio ? 0 : 1;
        return aMatch - bMatch;
      });

      for (const stream of orderedStreams) {
        const candidateUrl = stream.url!.trim();
        try {
          const check = await fetchWithTimeout(this.fetchFn, candidateUrl, {
            method: 'GET',
            headers: getAnimeFireHeaders(),
          });
          if (check.ok) {
            const audioTag =
              (stream.audio ?? '').toLowerCase() === 'dublado'
                ? 'DUB'
                : (stream.audio ?? '').toLowerCase() === 'legendado'
                  ? 'LEG'
                  : null;
            await this.saveLinkSafe(
              params.media.id,
              `af:${matchedAnimeId}`,
              matchedTitle,
              audioTag
            );
            return {
              resolution: {
                mode: 'EXOPLAYER_HLS',
                streamUrl: candidateUrl,
                headers: {
                  Referer: `${ANIMEFIRE_ORIGIN}/`,
                  Origin: ANIMEFIRE_ORIGIN,
                },
                webViewUrl: `${ANIMEFIRE_ORIGIN}/anime/${matchedAnimeId}`,
                matchedTitle,
                vodId: `af:${matchedAnimeId}`,
              },
              matchedAnimeId,
              matchedTitle,
            };
          }
        } catch {
          continue;
        }
      }

      return { resolution: null, matchedAnimeId, matchedTitle };
    } catch {
      return { resolution: null, matchedAnimeId, matchedTitle };
    }
  }

  private async tryResolveAnimesOnlineCc(
    params: PlaybackResolveParams,
    candidates: string[]
  ): Promise<PlaybackResolution | null> {
    const slugsToTry: Array<{ slug: string; title: string }> = [];
    const seenSlugs = new Set<string>();

    const linkedSlug = params.existingLink?.unitvVodId?.startsWith('aocc:')
      ? params.existingLink.unitvVodId.slice(5).trim()
      : '';
    if (linkedSlug) {
      seenSlugs.add(linkedSlug);
      slugsToTry.push({
        slug: linkedSlug,
        title: params.existingLink?.unitvTitle || candidates[0],
      });
    }

    for (const candidate of candidates) {
      const slug = slugifyAnimeTitle(candidate);
      if (slug && !seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        slugsToTry.push({ slug, title: candidate });
      }
    }

    for (const entry of slugsToTry) {
      const directEpUrl = `${ANIMESONLINECC_BASE}/episodio/${entry.slug}-episodio-${params.episodeNumber}/`;
      const resolved = await this.resolveAnimesOnlineCcEpisodeUrl(
        directEpUrl,
        entry.slug,
        entry.title,
        params.media.id
      );
      if (resolved) {
        return resolved;
      }
    }

    for (const candidate of candidates) {
      try {
        const searchRes = await fetchWithTimeout(
          this.fetchFn,
          `${ANIMESONLINECC_BASE}/?s=${encodeURIComponent(candidate)}`,
          { headers: getBrowserHeaders() }
        );
        if (!searchRes.ok) {
          continue;
        }
        const searchHtml = await searchRes.text();
        const animeMatch =
          /https:\/\/animesonlinecc\.to\/anime\/([a-z0-9-]+)\//i.exec(searchHtml);
        if (!animeMatch?.[1]) {
          continue;
        }
        const foundSlug = animeMatch[1].toLowerCase();
        const animePageUrl = `${ANIMESONLINECC_BASE}/anime/${foundSlug}/`;

        let discoveredEpUrl: string | null = null;
        try {
          const animeRes = await fetchWithTimeout(this.fetchFn, animePageUrl, {
            headers: getBrowserHeaders(),
          });
          if (animeRes.ok) {
            const animeHtml = await animeRes.text();
            const epUrls = Array.from(
              new Set(
                animeHtml.match(
                  /https:\/\/animesonlinecc\.to\/episodio\/[a-z0-9-]+\//gi
                ) ?? []
              )
            );
            const epRegex = new RegExp(
              `-episodio-0?${params.episodeNumber}(?:-[^/]+)?/?$`,
              'i'
            );
            discoveredEpUrl = epUrls.find((u) => epRegex.test(u)) ?? null;
          }
        } catch {
          discoveredEpUrl = null;
        }

        const targetEpUrl =
          discoveredEpUrl ??
          `${ANIMESONLINECC_BASE}/episodio/${foundSlug}-episodio-${params.episodeNumber}/`;
        const resolved = await this.resolveAnimesOnlineCcEpisodeUrl(
          targetEpUrl,
          foundSlug,
          candidate,
          params.media.id
        );
        if (resolved) {
          return resolved;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private async resolveAnimesOnlineCcEpisodeUrl(
    episodeUrl: string,
    slug: string,
    matchedTitle: string,
    mediaItemId: string
  ): Promise<PlaybackResolution | null> {
    try {
      const epRes = await fetchWithTimeout(this.fetchFn, episodeUrl, {
        headers: getBrowserHeaders(),
      });
      if (!epRes.ok) {
        return null;
      }

      const epHtml = await epRes.text();
      const bloggerIframeUrl = extractBloggerIframeUrl(epHtml);
      if (!bloggerIframeUrl) {
        return null;
      }

      let mp4Url: string | null = null;
      try {
        const bloggerRes = await fetchWithTimeout(this.fetchFn, bloggerIframeUrl, {
          headers: getBrowserHeaders(episodeUrl),
        });
        if (bloggerRes.ok) {
          const bloggerHtml = await bloggerRes.text();
          mp4Url = extractGoogleVideoMp4Url(bloggerHtml);
        }
      } catch {
        mp4Url = null;
      }

      await this.saveLinkSafe(mediaItemId, `aocc:${slug}`, matchedTitle);

      if (mp4Url) {
        return {
          mode: 'EXOPLAYER_HLS',
          streamUrl: mp4Url,
          headers: {
            Referer: 'https://www.blogger.com/',
            'User-Agent': MOBILE_BROWSER_USER_AGENT,
          },
          webViewUrl: bloggerIframeUrl,
          matchedTitle,
          vodId: `aocc:${slug}`,
        };
      }

      return {
        mode: 'CLEAN_WEBVIEW',
        webViewUrl: bloggerIframeUrl,
        matchedTitle,
        vodId: `aocc:${slug}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Probes the live automatic PT-BR anime streaming endpoints (and optional custom UniTV portal).
   */
  async testConnection(params: {
    portalUrl: string;
    username: string;
    password: string;
  }): Promise<UniTvProbeResult> {
    const endpoints: Array<{ url: string; headers: Record<string, string> }> = [
      {
        url: `${ANIMEFIRE_API_BASE}/animes/lancamentos?v=3`,
        headers: getAnimeFireHeaders(),
      },
      {
        url: `${ANIMESONLINECC_BASE}/`,
        headers: getBrowserHeaders(),
      },
    ];

    for (const endpoint of endpoints) {
      try {
        const res = await fetchWithTimeout(this.fetchFn, endpoint.url, {
          method: 'GET',
          headers: endpoint.headers,
        });
        if (res.ok) {
          return {
            status: 'STREAM_READY',
            streamUrl:
              'Fonte Automática PT-BR Ativa (Full HD 1080p · Dublado & Legendado · Tempo Real)',
          };
        }
      } catch {
        continue;
      }
    }

    const portalUrl = params.portalUrl?.trim() ?? '';
    if (
      portalUrl &&
      !portalUrl.toLowerCase().includes('uvwebs.info') &&
      params.username.trim() &&
      params.password.trim()
    ) {
      try {
        const probeRes = await fetchWithTimeout(this.fetchFn, portalUrl, {
          method: 'GET',
        });
        if (probeRes.ok) {
          return {
            status: 'WEBVIEW_ONLY',
            reason: 'Portal UniTV personalizado acessível.',
          };
        }
      } catch {
        // Fall through to BLOCKED result below.
      }
    }

    return {
      status: 'BLOCKED',
      reason:
        'Não foi possível conectar às fontes automáticas de streaming. Verifique sua internet.',
    };
  }
}
