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
  UniTvProbeResult,
} from './unitv-probe';

const DEFAULT_EXTRACTION_TIMEOUT_MS = 8000;

export const DEFAULT_DIRECT_WEBVIEW_HOSTS = ['unitvwebs.com'] as const;

export function isDirectWebViewPortalUrl(
  portalUrl: string | null | undefined,
  directHosts: readonly string[] = DEFAULT_DIRECT_WEBVIEW_HOSTS
): boolean {
  if (!portalUrl || portalUrl.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(portalUrl.trim())
        ? portalUrl.trim()
        : `https://${portalUrl.trim()}`
    );
    const hostname = parsed.hostname.toLowerCase();
    return directHosts.some((host) => {
      const normalized = host.toLowerCase();
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

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
.q-header,
.q-footer,
.q-drawer,
.q-toolbar,
.q-page-sticky,
.vjs-control-bar,
.vjs-big-play-button,
.vjs-loading-spinner,
.vjs-modal-dialog,
[class*="cookie"],
[class*="popup"],
[id*="cookie"],
[id*="banner"] {
  display: none !important;
  visibility: hidden !important;
}

html,
body {
  background: #000000 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}

html:not(.pmh-portal-episodes) .vod-player-container,
html:not(.pmh-portal-episodes) #v-player,
html:not(.pmh-portal-episodes) .video-js,
html:not(.pmh-portal-episodes) video,
html:not(.pmh-portal-episodes) video#v-player_html5_api {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  object-fit: contain !important;
  background-color: #000000 !important;
  z-index: 99999 !important;
}

.vjs-text-track-display,
.vjs-text-track-cue,
.vjs-text-track-cue > div {
  display: block !important;
  visibility: visible !important;
  z-index: 100000 !important;
}

html.pmh-portal-episodes body {
  overflow: auto !important;
  background: #0C0F12 !important;
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

  function getVideoEl() {
    return (
      document.querySelector('video#v-player_html5_api') ||
      document.querySelector('#v-player video') ||
      document.querySelector('video')
    );
  }

  function postBridge(payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  function publishPlayerState() {
    var v = getVideoEl();
    if (!v) {
      var path = (window.location && window.location.pathname ? window.location.pathname : '').toLowerCase();
      var hasPw = Boolean(document.querySelector('input[type="password"]'));
      if (path.indexOf('/captcha') !== -1 || hasPw) {
        postBridge({
          type: 'WEB_PLAYER_INTERACTION_REQUIRED',
          reason: path.indexOf('/captcha') !== -1 ? 'CAPTCHA' : 'LOGIN',
        });
      }
      return;
    }
    postBridge({
      type: 'WEB_PLAYER_STATE',
      currentTime: Number.isFinite(v.currentTime) ? Math.max(0, v.currentTime) : 0,
      duration: Number.isFinite(v.duration) ? Math.max(0, v.duration) : 0,
      paused: Boolean(v.paused),
      ended: Boolean(v.ended),
      videoHeight: Number.isFinite(v.videoHeight) ? Math.max(0, v.videoHeight) : 0,
    });
  }

  if (!window.__pmhPlayer) {
    window.__pmhPlayer = {
      play: function () {
        var v = getVideoEl();
        if (v && typeof v.play === 'function') {
          Promise.resolve(v.play()).catch(function () {});
        }
        publishPlayerState();
      },
      pause: function () {
        var v = getVideoEl();
        if (v && typeof v.pause === 'function') {
          v.pause();
        }
        publishPlayerState();
      },
      togglePlay: function () {
        var v = getVideoEl();
        if (!v) return;
        if (v.paused) {
          Promise.resolve(v.play()).catch(function () {});
        } else {
          v.pause();
        }
        publishPlayerState();
      },
      seek: function (seconds) {
        var v = getVideoEl();
        var targetSec = Number(seconds);
        if (!v || !Number.isFinite(targetSec)) return;
        var dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : targetSec;
        v.currentTime = Math.max(0, Math.min(dur, targetSec));
        publishPlayerState();
      },
      setRate: function (rate) {
        var v = getVideoEl();
        var next = Number(rate);
        if (!v || !Number.isFinite(next) || next <= 0) return;
        v.playbackRate = next;
        publishPlayerState();
      },
      selectEpisode: function (epNumber) {
        var targetText = String(epNumber || '').trim();
        if (!targetText) return false;
        var nodes = document.querySelectorAll('a, button, [role="button"], .q-item, .episode-item');
        for (var i = 0; i < nodes.length; i += 1) {
          var el = nodes[i];
          if (el.closest && (el.closest('.vjs-control-bar') || el.closest('.q-toolbar') || el.closest('.q-header'))) {
            continue;
          }
          var txt = (el.textContent || '').trim();
          if (
            txt === targetText ||
            txt === 'Ep ' + targetText ||
            txt === 'Ep. ' + targetText ||
            txt === 'Episódio ' + targetText
          ) {
            el.click();
            return true;
          }
        }
        return false;
      },
      setPortalEpisodes: function (visible) {
        var root = document.documentElement;
        if (!root || !root.classList) return;
        if (visible) {
          root.classList.add('pmh-portal-episodes');
        } else {
          root.classList.remove('pmh-portal-episodes');
        }
      },
    };
  }

  function bindVideoListeners() {
    var v = getVideoEl();
    if (!v || v.__pmhBound) return;
    v.__pmhBound = true;
    ['play', 'pause', 'ended', 'seeked', 'loadedmetadata'].forEach(function (evt) {
      v.addEventListener(evt, publishPlayerState);
    });
    publishPlayerState();
  }

  if (!window.__pmhStateTimer) {
    window.__pmhStateTimer = setInterval(function () {
      bindVideoListeners();
      publishPlayerState();
    }, 1000);
  }
  bindVideoListeners();
})();
${UNITV_STREAM_HOOK_SCRIPT}
`.trim();

export type CleanWebViewPlayerCommand =
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'TOGGLE_PLAY' }
  | { type: 'SEEK'; timeSeconds: number }
  | { type: 'SET_RATE'; rate: number }
  | { type: 'SELECT_EPISODE'; episodeNumber: number }
  | { type: 'SET_PORTAL_EPISODES'; visible: boolean };

export type CleanWebViewPlayerEvent =
  | {
      type: 'WEB_PLAYER_STATE';
      currentTime: number;
      duration: number;
      paused: boolean;
      ended: boolean;
      videoHeight: number;
    }
  | {
      type: 'WEB_PLAYER_INTERACTION_REQUIRED';
      reason: 'CAPTCHA' | 'LOGIN';
    };

export function buildCleanWebViewCommandScript(
  command: CleanWebViewPlayerCommand
): string {
  switch (command.type) {
    case 'PLAY':
      return '(function(){ window.__pmhPlayer && window.__pmhPlayer.play(); })(); true;';
    case 'PAUSE':
      return '(function(){ window.__pmhPlayer && window.__pmhPlayer.pause(); })(); true;';
    case 'TOGGLE_PLAY':
      return '(function(){ window.__pmhPlayer && window.__pmhPlayer.togglePlay(); })(); true;';
    case 'SEEK': {
      const safeSeconds =
        typeof command.timeSeconds === 'number' && Number.isFinite(command.timeSeconds)
          ? Math.max(0, command.timeSeconds)
          : 0;
      return `(function(){ window.__pmhPlayer && window.__pmhPlayer.seek(${safeSeconds}); })(); true;`;
    }
    case 'SET_RATE': {
      const safeRate =
        typeof command.rate === 'number' &&
        Number.isFinite(command.rate) &&
        command.rate > 0
          ? command.rate
          : 1;
      return `(function(){ window.__pmhPlayer && window.__pmhPlayer.setRate(${safeRate}); })(); true;`;
    }
    case 'SELECT_EPISODE': {
      const safeEp =
        typeof command.episodeNumber === 'number' &&
        Number.isFinite(command.episodeNumber) &&
        command.episodeNumber >= 1
          ? Math.floor(command.episodeNumber)
          : 1;
      return `(function(){ window.__pmhPlayer && window.__pmhPlayer.selectEpisode(${safeEp}); })(); true;`;
    }
    case 'SET_PORTAL_EPISODES': {
      const flag = Boolean(command.visible);
      return `(function(){ window.__pmhPlayer && window.__pmhPlayer.setPortalEpisodes(${flag}); })(); true;`;
    }
  }
}

export function parseCleanWebViewPlayerMessage(
  raw: string
): CleanWebViewPlayerEvent | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    if (parsed.type === 'WEB_PLAYER_STATE') {
      const safeNonNeg = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? value
          : 0;

      return {
        type: 'WEB_PLAYER_STATE',
        currentTime: safeNonNeg(parsed.currentTime),
        duration: safeNonNeg(parsed.duration),
        paused: Boolean(parsed.paused),
        ended: Boolean(parsed.ended),
        videoHeight: safeNonNeg(parsed.videoHeight),
      };
    }

    if (parsed.type === 'WEB_PLAYER_INTERACTION_REQUIRED') {
      const reason = parsed.reason === 'LOGIN' ? 'LOGIN' : 'CAPTCHA';
      return {
        type: 'WEB_PLAYER_INTERACTION_REQUIRED',
        reason,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export interface UniTvSessionBridge {
  authenticate(
    portalUrl: string,
    credentials: UniTvCredentials
  ): Promise<{ ok: boolean; errorCode?: PlaybackErrorCode }>;
  verifySession?(
    portalUrl: string,
    credentials: UniTvCredentials | null
  ): Promise<{ ok: true } | { errorCode: PlaybackErrorCode; message?: string }>;
  searchVod(
    portalUrl: string,
    queryCandidates: string[]
  ): Promise<
    | { vodId: string; title: string; watchPath: string }
    | { errorCode: PlaybackErrorCode }
    | null
  >;
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

export function buildPortalWebViewUrl(
  portalBaseUrl: string,
  vodId: string,
  episodeNumber: number,
  pathOrUrl?: string
): string {
  const defaultPath = `vod/${encodeURIComponent(vodId)}?ep=${episodeNumber}`;
  const trimmedVodId = vodId.trim();
  const explicitCandidate =
    pathOrUrl?.trim() ||
    (trimmedVodId.startsWith('/') || /^https?:\/\//i.test(trimmedVodId)
      ? trimmedVodId
      : '');
  if (!explicitCandidate) {
    return buildPortalUrl(portalBaseUrl, defaultPath);
  }

  if (/^https?:\/\//i.test(explicitCandidate)) {
    try {
      const candidateUrl = new URL(explicitCandidate);
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

  return buildPortalUrl(portalBaseUrl, explicitCandidate);
}

type ExtractionOutcome =
  | { streamUrl: string; headers?: Record<string, string> }
  | { timedOut: true; webViewUrl: string }
  | { errorCode: PlaybackErrorCode };

export interface UniTvPlaybackAdapterDeps {
  bridge: UniTvSessionBridge;
  credentialsStore: CredentialsStore;
  repository?: Pick<LibraryRepository, 'saveUniTvLink'>;
  timeoutMs?: number;
  webViewDirectHosts?: readonly string[];
}

function mapConnectionErrorCopy(errorCode: PlaybackErrorCode): string {
  switch (errorCode) {
    case 'CAPTCHA_REQUIRED':
      return 'Verificação de segurança (/captcha) pendente na WebView da UniTV.';
    case 'USER_CANCELLED':
      return 'Teste de sessão cancelado pelo usuário antes de confirmar o acesso.';
    case 'CONCURRENT_SCREEN_LIMIT':
      return 'Limite de telas simultâneas atingido na sua conta UniTV.';
    case 'NOT_FOUND_IN_CATALOG':
      return 'Catálogo UniTV indisponível no momento para essa rota.';
    case 'AUTH_FAILED':
    default:
      return 'Não foi possível validar o login UniTV. Confirme seu usuário e senha na WebView.';
  }
}

/**
 * Resolves UniTV episode playback to direct ExoPlayer HLS/MP4 or falls back to Clean WebView.
 */
export class UniTvPlaybackAdapter implements PlaybackSourceAdapter {
  private readonly bridge: UniTvSessionBridge;
  private readonly credentialsStore: CredentialsStore;
  private readonly repository?: Pick<LibraryRepository, 'saveUniTvLink'>;
  private readonly timeoutMs: number;
  private readonly webViewDirectHosts: readonly string[];

  constructor(deps: UniTvPlaybackAdapterDeps) {
    this.bridge = deps.bridge;
    this.credentialsStore = deps.credentialsStore;
    this.repository = deps.repository;
    this.timeoutMs =
      typeof deps.timeoutMs === 'number' &&
      Number.isFinite(deps.timeoutMs) &&
      deps.timeoutMs > 0
        ? deps.timeoutMs
        : DEFAULT_EXTRACTION_TIMEOUT_MS;
    this.webViewDirectHosts =
      deps.webViewDirectHosts ?? DEFAULT_DIRECT_WEBVIEW_HOSTS;
  }

  async testConnection(params: {
    portalUrl?: string;
    username?: string;
    password?: string;
    credentials?: UniTvCredentials | null;
  }): Promise<UniTvProbeResult> {
    const portalBaseUrl = buildPortalUrl(params.portalUrl ?? '', '');
    if (!portalBaseUrl) {
      return {
        status: 'BLOCKED',
        reason: 'Informe uma URL válida para o portal UniTV (ex.: https://www.unitvwebs.com).',
      };
    }

    const savedCredentials = await this.credentialsStore.getUniTvCredentials();
    const inlineCredentials =
      params.credentials ??
      (params.username !== undefined || params.password !== undefined
        ? {
            username: params.username?.trim() ?? '',
            password: params.password ?? '',
          }
        : null);
    const effectiveCredentials =
      inlineCredentials &&
      (inlineCredentials.username.trim().length > 0 ||
        inlineCredentials.password.length > 0)
        ? inlineCredentials
        : savedCredentials;

    if (typeof this.bridge.verifySession === 'function') {
      const outcome = await this.bridge.verifySession(
        portalBaseUrl,
        effectiveCredentials
      );
      if ('ok' in outcome && outcome.ok) {
        return {
          status: 'WEBVIEW_ONLY',
          reason: 'Conexão OK · Sessão UniTV verificada na WebView.',
        };
      }
      const code =
        'errorCode' in outcome ? outcome.errorCode : ('AUTH_FAILED' as const);
      return {
        status: 'BLOCKED',
        reason: mapConnectionErrorCopy(code),
      };
    }

    const authOutcome = await this.bridge.authenticate(
      portalBaseUrl,
      effectiveCredentials ?? { username: '', password: '' }
    );
    if (authOutcome.ok) {
      return {
        status: 'WEBVIEW_ONLY',
        reason: 'Conexão OK · Sessão UniTV verificada na WebView.',
      };
    }

    return {
      status: 'BLOCKED',
      reason: mapConnectionErrorCopy(authOutcome.errorCode ?? 'AUTH_FAILED'),
    };
  }

  async resolveEpisodePlayback(
    params: PlaybackResolveParams
  ): Promise<PlaybackResolution> {
    const portalBaseUrl = buildPortalUrl(params.portalUrl, '');
    if (!portalBaseUrl) {
      return { mode: 'CLEAN_WEBVIEW', errorCode: 'AUTH_FAILED' };
    }

    const directWebView = isDirectWebViewPortalUrl(
      portalBaseUrl,
      this.webViewDirectHosts
    );
    const credentials = await this.credentialsStore.getUniTvCredentials();
    if (!credentials && !directWebView) {
      return { mode: 'CLEAN_WEBVIEW', errorCode: 'AUTH_FAILED' };
    }

    const authResult = await this.bridge.authenticate(
      portalBaseUrl,
      credentials ?? { username: '', password: '' }
    );
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

    if (directWebView) {
      return {
        mode: 'CLEAN_WEBVIEW',
        webViewUrl: fallbackWebViewUrl,
        matchedTitle: target.matchedTitle,
        vodId: target.vodId,
      };
    }

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
    if ('errorCode' in match) {
      return { errorCode: match.errorCode };
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
