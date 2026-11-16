import { LibraryRepository } from '../db/library-repository';
import { MediaItemRecord } from '../db/schema';
import { CredentialsStore, UniTvCredentials } from './credentials-store';
import {
  PlaybackErrorCode,
  PlaybackResolution,
  PlaybackResolveParams,
  PlaybackSourceAdapter,
} from './types';
import {
  buildPortalUrl,
  parseInjectedStreamPayload,
  UNITV_STREAM_HOOK_SCRIPT,
} from './unitv-probe';

const DEFAULT_EXTRACTION_TIMEOUT_MS = 8000;

export const CLEAN_WEBVIEW_HIDE_CHROME_CSS = `
header,
nav,
footer,
.header,
.navbar,
.nav,
.footer,
.sidebar,
.ads,
.ad-banner,
.banner,
[class*="cookie"],
[class*="popup"],
[id*="cookie"],
[id*="banner"] {
  display: none !important;
}

html,
body {
  background: #000000 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow-x: hidden !important;
}

video {
  max-width: 100vw !important;
  max-height: 100vh !important;
}
`.trim();

export const CLEAN_WEBVIEW_INJECT_SCRIPT = `
(function () {
  var STYLE_ID = 'unitv-clean-webview-style';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.type = 'text/css';
    style.appendChild(document.createTextNode(${JSON.stringify(CLEAN_WEBVIEW_HIDE_CHROME_CSS)}));
    var target = document.head || document.documentElement;
    if (target) {
      target.appendChild(style);
    }
  }
})();
${UNITV_STREAM_HOOK_SCRIPT}
`.trim();

export interface UniTvSessionBridge {
  authenticate(
    portalUrl: string,
    credentials: UniTvCredentials
  ): Promise<{ ok: boolean; errorCode?: 'CONCURRENT_SCREEN_LIMIT' | 'AUTH_FAILED' }>;
  searchVod(
    portalUrl: string,
    queryCandidates: string[]
  ): Promise<{ vodId: string; title: string; watchPath: string } | null>;
  extractEpisodeStream(params: {
    portalUrl: string;
    vodId: string;
    watchPath?: string;
    episodeNumber: number;
    timeoutMs: number;
  }): Promise<
    | { streamUrl: string; headers?: Record<string, string> }
    | { timedOut: true; webViewUrl: string }
    | { errorCode: PlaybackErrorCode }
  >;
}

/**
 * Builds normalized, deduplicated search candidates in priority order: PT -> English -> Romaji.
 */
export function buildTitleCandidates(media: MediaItemRecord): string[] {
  const rawCandidates = [media.titlePt, media.titleEnglish, media.titleRomaji];
  const seen = new Set<string>();
  const normalizedList: string[] = [];

  for (const candidate of rawCandidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const normalized = candidate.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      continue;
    }
    const dedupKey = normalized.toLowerCase();
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    normalizedList.push(normalized);
  }

  return normalizedList;
}

/**
 * Parses an injected WebView stream capture event using the UniTV stream hook contract.
 */
export function parseCleanWebViewStreamMessage(
  rawJson: string
): { streamUrl: string; headers: Record<string, string> } | null {
  const parsed = parseInjectedStreamPayload(rawJson);
  if (!parsed) {
    return null;
  }
  return {
    streamUrl: parsed.url,
    headers: parsed.headers,
  };
}

function buildPortalWebViewUrl(
  portalBaseUrl: string,
  vodId: string,
  episodeNumber: number,
  pathOrUrl?: string
): string {
  const defaultPath = `vod/${encodeURIComponent(vodId)}?ep=${episodeNumber}`;
  const trimmed = pathOrUrl?.trim() ?? '';
  if (!trimmed) {
    return buildPortalUrl(portalBaseUrl, defaultPath);
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const candidateUrl = new URL(trimmed);
      const baseUrl = new URL(portalBaseUrl);
      if (candidateUrl.origin === baseUrl.origin) {
        return candidateUrl.toString();
      }
      const relative = `${candidateUrl.pathname}${candidateUrl.search}${candidateUrl.hash}`;
      return buildPortalUrl(portalBaseUrl, relative);
    } catch {
      return buildPortalUrl(portalBaseUrl, defaultPath);
    }
  }

  return buildPortalUrl(portalBaseUrl, trimmed);
}

type ExtractionOutcome =
  | { streamUrl: string; headers?: Record<string, string> }
  | { timedOut: true; webViewUrl: string }
  | { errorCode: PlaybackErrorCode };

/**
 * Resolves UniTV episode playback to direct ExoPlayer HLS/MP4 or falls back to Clean WebView after 8s.
 */
export class UniTvPlaybackAdapter implements PlaybackSourceAdapter {
  private readonly bridge: UniTvSessionBridge;
  private readonly credentialsStore: CredentialsStore;
  private readonly repository?: Pick<LibraryRepository, 'saveUniTvLink'>;
  private readonly timeoutMs: number;

  constructor(deps: {
    bridge: UniTvSessionBridge;
    credentialsStore: CredentialsStore;
    repository?: Pick<LibraryRepository, 'saveUniTvLink'>;
    timeoutMs?: number;
  }) {
    this.bridge = deps.bridge;
    this.credentialsStore = deps.credentialsStore;
    this.repository = deps.repository;
    this.timeoutMs =
      typeof deps.timeoutMs === 'number' &&
      Number.isFinite(deps.timeoutMs) &&
      deps.timeoutMs > 0
        ? deps.timeoutMs
        : DEFAULT_EXTRACTION_TIMEOUT_MS;
  }

  async resolveEpisodePlayback(
    params: PlaybackResolveParams
  ): Promise<PlaybackResolution> {
    const portalBaseUrl = buildPortalUrl(params.portalUrl, '');
    if (!portalBaseUrl) {
      return { mode: 'CLEAN_WEBVIEW', errorCode: 'AUTH_FAILED' };
    }

    const credentials = await this.credentialsStore.getUniTvCredentials();
    if (!credentials) {
      return { mode: 'CLEAN_WEBVIEW', errorCode: 'AUTH_FAILED' };
    }

    const authResult = await this.bridge.authenticate(portalBaseUrl, credentials);
    if (!authResult.ok) {
      return {
        mode: 'CLEAN_WEBVIEW',
        errorCode: authResult.errorCode ?? 'AUTH_FAILED',
      };
    }

    const target = await this.resolveTargetVod(portalBaseUrl, params);
    if ('errorCode' in target) {
      return {
        mode: 'CLEAN_WEBVIEW',
        errorCode: target.errorCode,
      };
    }

    const fallbackWebViewUrl = buildPortalWebViewUrl(
      portalBaseUrl,
      target.vodId,
      params.episodeNumber,
      target.watchPath
    );

    const outcome = await this.extractWithTimeout(
      portalBaseUrl,
      target.vodId,
      target.watchPath,
      params.episodeNumber,
      fallbackWebViewUrl
    );

    if ('errorCode' in outcome) {
      return {
        mode: 'CLEAN_WEBVIEW',
        matchedTitle: target.matchedTitle,
        vodId: target.vodId,
        errorCode: outcome.errorCode,
      };
    }

    if ('timedOut' in outcome && outcome.timedOut) {
      return {
        mode: 'CLEAN_WEBVIEW',
        webViewUrl: buildPortalWebViewUrl(
          portalBaseUrl,
          target.vodId,
          params.episodeNumber,
          outcome.webViewUrl || target.watchPath
        ),
        matchedTitle: target.matchedTitle,
        vodId: target.vodId,
      };
    }

    if (!('streamUrl' in outcome)) {
      return {
        mode: 'CLEAN_WEBVIEW',
        webViewUrl: fallbackWebViewUrl,
        matchedTitle: target.matchedTitle,
        vodId: target.vodId,
      };
    }

    const streamUrl =
      typeof outcome.streamUrl === 'string' ? outcome.streamUrl.trim() : '';

    if (!streamUrl) {
      return {
        mode: 'CLEAN_WEBVIEW',
        webViewUrl: fallbackWebViewUrl,
        matchedTitle: target.matchedTitle,
        vodId: target.vodId,
      };
    }

    return {
      mode: 'EXOPLAYER_HLS',
      streamUrl,
      headers: outcome.headers,
      matchedTitle: target.matchedTitle,
      vodId: target.vodId,
    };
  }

  private async resolveTargetVod(
    portalBaseUrl: string,
    params: PlaybackResolveParams
  ): Promise<
    | { vodId: string; matchedTitle: string; watchPath?: string }
    | { errorCode: PlaybackErrorCode }
  > {
    if (params.existingLink) {
      return {
        vodId: params.existingLink.unitvVodId,
        matchedTitle: params.existingLink.unitvTitle,
        watchPath: undefined,
      };
    }

    const candidates = buildTitleCandidates(params.media);
    if (candidates.length === 0) {
      return { errorCode: 'NOT_FOUND_IN_CATALOG' };
    }

    const match = await this.bridge.searchVod(portalBaseUrl, candidates);
    if (!match) {
      return { errorCode: 'NOT_FOUND_IN_CATALOG' };
    }

    if (this.repository) {
      await this.repository.saveUniTvLink({
        mediaItemId: params.media.id,
        unitvVodId: match.vodId,
        unitvTitle: match.title,
        unitvSeasonTag: null,
        preferredAudioOrSub: null,
        lastVerifiedAt: new Date().toISOString(),
      });
    }

    return {
      vodId: match.vodId,
      matchedTitle: match.title,
      watchPath: match.watchPath,
    };
  }

  private async extractWithTimeout(
    portalBaseUrl: string,
    vodId: string,
    watchPath: string | undefined,
    episodeNumber: number,
    fallbackWebViewUrl: string
  ): Promise<ExtractionOutcome> {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const extractionPromise = this.bridge
      .extractEpisodeStream({
        portalUrl: portalBaseUrl,
        vodId,
        watchPath,
        episodeNumber,
        timeoutMs: this.timeoutMs,
      })
      .catch((error: unknown): ExtractionOutcome => {
        if (!settled) {
          throw error;
        }
        return {
          timedOut: true,
          webViewUrl: fallbackWebViewUrl,
        };
      });

    const timeoutPromise = new Promise<ExtractionOutcome>((resolve) => {
      timerId = setTimeout(() => {
        resolve({
          timedOut: true,
          webViewUrl: fallbackWebViewUrl,
        });
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([extractionPromise, timeoutPromise]);
    } finally {
      settled = true;
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }
}
