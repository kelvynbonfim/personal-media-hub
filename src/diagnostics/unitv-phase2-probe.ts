import { sanitizeDiagnosticUrl } from './unitv-diagnostic';

export interface Phase2DomInput {
  tag: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
}

export interface Phase2DomAction {
  tag: string;
  id: string;
  className: string;
  hrefPath: string | null;
  text: string;
}

export interface Phase2VideoInfo {
  found: boolean;
  id: string | null;
  srcKind: 'NONE' | 'BLOB' | 'HTTP_STREAM' | 'HTTP_OTHER';
  srcSanitized: string | null;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  paused: boolean;
  textTrackCount: number;
}

export interface Phase2DomSnapshot {
  url: string;
  title: string;
  capturedAtIso: string;
  inputs: Phase2DomInput[];
  actions: Phase2DomAction[];
  video: Phase2VideoInfo | null;
}

export interface Phase2StreamLogEntry {
  id: string;
  kind: 'STREAM_CANDIDATE' | 'STREAM_SEGMENT' | 'STREAM_BLOB';
  sanitizedUrl: string;
  sourceTag: string;
  mimeHint: string | null;
  timestampIso: string;
}

export interface Phase2StreamCandidate {
  streamUrl: string;
  referer: string;
  userAgent: string;
  sourceTag: string;
  sanitizedUrl: string;
  mimeHint: string | null;
  capturedAtIso: string;
}

export interface ExoPlayerTestState {
  status: 'IDLE' | 'LOADING' | 'PLAYING' | 'ERROR';
  durationSeconds: number;
  currentSeconds: number;
  resolutionLabel: string | null;
  errorDetail: string | null;
  manualConfirm: boolean | null;
}

export type ParsedPhase2WebViewMessage =
  | { kind: 'DOM'; snapshot: Phase2DomSnapshot }
  | {
      kind: 'STREAM_CANDIDATE';
      entry: Phase2StreamLogEntry;
      candidate: Phase2StreamCandidate;
    }
  | { kind: 'STREAM_SEGMENT'; entry: Phase2StreamLogEntry }
  | { kind: 'STREAM_BLOB'; entry: Phase2StreamLogEntry };

const MAX_INPUTS = 15;
const MAX_ACTIONS = 40;
const MAX_TEXT_LENGTH = 80;
const STREAM_EXTENSION_HINT = /\.(m3u8|mp4|mpd)(\b|$)/i;
const SEGMENT_EXTENSION_HINT = /\.(ts|m4s|aac|vtt|srt|key)(\b|$)/i;

function isPlayableStreamManifest(
  sanitizedUrl: string,
  mimeHint: string | null
): boolean {
  if (SEGMENT_EXTENSION_HINT.test(sanitizedUrl)) {
    return false;
  }
  if (STREAM_EXTENSION_HINT.test(sanitizedUrl)) {
    return true;
  }
  if (
    mimeHint &&
    /(mpegurl|dash\+xml|video\/mp4)/i.test(mimeHint)
  ) {
    return true;
  }
  try {
    const pathname = new URL(sanitizedUrl).pathname.toLowerCase();
    if (pathname.includes('/api/')) {
      return false;
    }
    return /(?:^|\/)(?:master|playlist|manifest)(?:\.[a-z0-9]+)?$/i.test(
      pathname
    );
  } catch {
    return false;
  }
}

export const PHASE2_DOM_INSPECT_SCRIPT = `
(function () {
  var post = function (payload) {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };
  var cleanText = function (raw, maxLen) {
    return String(raw || '').replace(/\\s+/g, ' ').trim().slice(0, maxLen || 80);
  };
  var inputs = Array.prototype.slice.call(
    document.querySelectorAll('input, textarea, select')
  ).slice(0, 15).map(function (el) {
    return {
      tag: el.tagName || 'INPUT',
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: cleanText(el.getAttribute('placeholder') || '', 60)
    };
  });
  var actions = Array.prototype.slice.call(
    document.querySelectorAll(
      'a[href], button, [role="button"], [class*="ep"], [class*="episode"], [class*="vod"], [class*="card"], [class*="item"], li'
    )
  ).slice(0, 80).map(function (el) {
    return {
      tag: el.tagName || 'DIV',
      id: el.id || '',
      className: cleanText(typeof el.className === 'string' ? el.className : '', 60),
      href: el.getAttribute('href') || null,
      text: cleanText(el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '', 80)
    };
  }).filter(function (item) {
    return Boolean(item.href || item.text || item.id);
  }).slice(0, 40);
  var videoEl = document.querySelector('#v-player_html5_api, #v-player video, video');
  var videoInfo = videoEl ? {
    found: true,
    id: videoEl.id || null,
    src: String(videoEl.currentSrc || videoEl.getAttribute('src') || ''),
    readyState: Number(videoEl.readyState || 0),
    videoWidth: Number(videoEl.videoWidth || 0),
    videoHeight: Number(videoEl.videoHeight || 0),
    duration: Number.isFinite(videoEl.duration) ? Number(videoEl.duration) : 0,
    paused: Boolean(videoEl.paused),
    textTrackCount: videoEl.textTracks ? Number(videoEl.textTracks.length || 0) : 0
  } : {
    found: false,
    id: null,
    src: '',
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    duration: 0,
    paused: true,
    textTrackCount: 0
  };
  post({
    type: 'DIAG_PHASE2_DOM',
    payload: {
      url: String(window.location && window.location.href ? window.location.href : ''),
      title: cleanText(document.title || '', 80),
      inputs: inputs,
      actions: actions,
      video: videoInfo
    }
  });
})();
true;
`.trim();

export const PHASE2_STREAM_CAPTURE_SCRIPT = `
(function () {
  if (window.__UNITV_DIAG_CAPTURE_INSTALLED__) {
    return true;
  }
  window.__UNITV_DIAG_CAPTURE_INSTALLED__ = true;

  var seen = {};
  var isCandidate = function (url) {
    if (typeof url !== 'string' || !url) return false;
    var trimmed = url.trim();
    if (/^blob:/i.test(trimmed)) return true;
    if (!/^https?:\\/\\//i.test(trimmed)) return false;
    var clean = trimmed.split('#')[0].split('?')[0].toLowerCase();
    if (/\\.(css|js|png|jpe?g|webp|gif|svg|woff2?|ttf|ico)$/i.test(clean)) return false;
    return /\\.(m3u8|mp4|mpd|ts)(\\b|$)/i.test(clean) || /(master|playlist|manifest|hls|stream|video|media)/i.test(clean);
  };
  var emit = function (url, sourceTag, mimeHint) {
    if (!isCandidate(url)) return;
    var key = sourceTag + '|' + url;
    if (seen[key]) return;
    seen[key] = true;
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'DIAG_PHASE2_STREAM',
        url: url,
        referer: String(window.location && window.location.href ? window.location.href : ''),
        userAgent: String(navigator && navigator.userAgent ? navigator.userAgent : ''),
        sourceTag: sourceTag,
        mimeHint: mimeHint || null
      }));
    }
  };
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function (input) {
      try {
        var reqUrl = typeof input === 'string' ? input : input && input.url;
        emit(reqUrl, 'fetch', null);
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }
  if (typeof window.XMLHttpRequest === 'function') {
    var origOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        emit(url, 'xhr', null);
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  }
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    var origCreate = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      var res = origCreate.apply(this, arguments);
      try {
        var hint = obj && obj.constructor && obj.constructor.name ? obj.constructor.name : 'objectURL';
        emit(res, 'createObjectURL', hint);
      } catch (e) {}
      return res;
    };
  }
  document.addEventListener('loadstart', function (ev) {
    var target = ev && ev.target;
    if (target && target.tagName === 'VIDEO') {
      emit(target.currentSrc || target.getAttribute('src') || '', 'video.loadstart', null);
    }
  }, true);
  var existingVideos = document.querySelectorAll('video');
  for (var i = 0; i < existingVideos.length; i++) {
    var v = existingVideos[i];
    emit(v.currentSrc || v.getAttribute('src') || '', 'video.src', null);
  }
})();
true;
`.trim();

export function createInitialExoPlayerState(): ExoPlayerTestState {
  return {
    status: 'IDLE',
    durationSeconds: 0,
    currentSeconds: 0,
    resolutionLabel: null,
    errorDetail: null,
    manualConfirm: null,
  };
}

function clampString(raw: unknown, maxLen = MAX_TEXT_LENGTH): string {
  return typeof raw === 'string'
    ? raw.replace(/\s+/g, ' ').trim().slice(0, maxLen)
    : '';
}

function sanitizeHrefPath(rawHref: unknown, baseUrl: string): string | null {
  if (typeof rawHref !== 'string') {
    return null;
  }
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return sanitizeDiagnosticUrl(trimmed);
  }
  if (trimmed.startsWith('/')) {
    try {
      const origin = new URL(baseUrl).origin;
      return sanitizeDiagnosticUrl(`${origin}${trimmed}`);
    } catch {
      return trimmed.split('#')[0].split('?')[0];
    }
  }
  return trimmed.split('#')[0].split('?')[0];
}

function classifyVideoSource(rawSrc: unknown): {
  srcKind: Phase2VideoInfo['srcKind'];
  srcSanitized: string | null;
} {
  if (typeof rawSrc !== 'string' || !rawSrc.trim()) {
    return { srcKind: 'NONE', srcSanitized: null };
  }
  const trimmed = rawSrc.trim();
  if (/^blob:/i.test(trimmed)) {
    return { srcKind: 'BLOB', srcSanitized: 'blob://[redacted]' };
  }
  const sanitized = sanitizeDiagnosticUrl(trimmed);
  const isStream = STREAM_EXTENSION_HINT.test(sanitized);
  return {
    srcKind: isStream ? 'HTTP_STREAM' : 'HTTP_OTHER',
    srcSanitized: sanitized,
  };
}

let streamEventSeq = 1;

export function parsePhase2WebViewMessage(
  rawJson: string
): ParsedPhase2WebViewMessage | null {
  if (!rawJson || typeof rawJson !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  if (record.type === 'DIAG_PHASE2_DOM') {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const rawUrl = typeof payload.url === 'string' ? payload.url : '';
    const sanitizedPageUrl = sanitizeDiagnosticUrl(rawUrl);

    const rawInputs = Array.isArray(payload.inputs) ? payload.inputs : [];
    const inputs: Phase2DomInput[] = rawInputs
      .slice(0, MAX_INPUTS)
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        tag: clampString(item.tag, 20) || 'INPUT',
        type: clampString(item.type, 24),
        name: clampString(item.name, 40),
        id: clampString(item.id, 40),
        placeholder: clampString(item.placeholder, 60),
      }));

    const rawActions = Array.isArray(payload.actions) ? payload.actions : [];
    const actions: Phase2DomAction[] = rawActions
      .slice(0, MAX_ACTIONS)
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        tag: clampString(item.tag, 20) || 'DIV',
        id: clampString(item.id, 40),
        className: clampString(item.className, 60),
        hrefPath: sanitizeHrefPath(item.href, rawUrl),
        text: clampString(item.text, MAX_TEXT_LENGTH),
      }));

    const rawVideo =
      payload.video && typeof payload.video === 'object'
        ? (payload.video as Record<string, unknown>)
        : null;
    const video: Phase2VideoInfo | null = rawVideo
      ? (() => {
          const { srcKind, srcSanitized } = classifyVideoSource(rawVideo.src);
          return {
            found: Boolean(rawVideo.found),
            id:
              typeof rawVideo.id === 'string' && rawVideo.id.trim()
                ? clampString(rawVideo.id, 40)
                : null,
            srcKind,
            srcSanitized,
            readyState: Number.isFinite(Number(rawVideo.readyState))
              ? Number(rawVideo.readyState)
              : 0,
            videoWidth: Number.isFinite(Number(rawVideo.videoWidth))
              ? Number(rawVideo.videoWidth)
              : 0,
            videoHeight: Number.isFinite(Number(rawVideo.videoHeight))
              ? Number(rawVideo.videoHeight)
              : 0,
            duration: Number.isFinite(Number(rawVideo.duration))
              ? Number(rawVideo.duration)
              : 0,
            paused: Boolean(rawVideo.paused),
            textTrackCount: Number.isFinite(Number(rawVideo.textTrackCount))
              ? Number(rawVideo.textTrackCount)
              : 0,
          };
        })()
      : null;

    return {
      kind: 'DOM',
      snapshot: {
        url: sanitizedPageUrl,
        title: clampString(payload.title, MAX_TEXT_LENGTH),
        capturedAtIso: new Date().toISOString(),
        inputs,
        actions,
        video,
      },
    };
  }

  if (record.type === 'DIAG_PHASE2_STREAM' && typeof record.url === 'string') {
    const rawUrl = record.url.trim();
    const sourceTag = clampString(record.sourceTag, 32) || 'unknown';
    const mimeHint =
      typeof record.mimeHint === 'string' && record.mimeHint.trim()
        ? clampString(record.mimeHint, 60)
        : null;
    const timestampIso = new Date().toISOString();
    const id = `p2-stream-${streamEventSeq++}`;

    if (/^blob:/i.test(rawUrl)) {
      return {
        kind: 'STREAM_BLOB',
        entry: {
          id,
          kind: 'STREAM_BLOB',
          sanitizedUrl: 'blob://[redacted]',
          sourceTag,
          mimeHint,
          timestampIso,
        },
      };
    }

    if (!/^https?:\/\//i.test(rawUrl)) {
      return null;
    }

    const sanitizedUrl = sanitizeDiagnosticUrl(rawUrl);
    if (!isPlayableStreamManifest(sanitizedUrl, mimeHint)) {
      return {
        kind: 'STREAM_SEGMENT',
        entry: {
          id,
          kind: 'STREAM_SEGMENT',
          sanitizedUrl,
          sourceTag,
          mimeHint,
          timestampIso,
        },
      };
    }

    const sanitizedReferer =
      typeof record.referer === 'string' && /^https?:\/\//i.test(record.referer)
        ? sanitizeDiagnosticUrl(record.referer)
        : '';
    const userAgent = clampString(record.userAgent, 180);

    return {
      kind: 'STREAM_CANDIDATE',
      entry: {
        id,
        kind: 'STREAM_CANDIDATE',
        sanitizedUrl,
        sourceTag,
        mimeHint,
        timestampIso,
      },
      candidate: {
        streamUrl: rawUrl,
        referer: sanitizedReferer,
        userAgent,
        sourceTag,
        sanitizedUrl,
        mimeHint,
        capturedAtIso: timestampIso,
      },
    };
  }

  return null;
}

export function formatPhase2ReportSection(params: {
  domSnapshots: Phase2DomSnapshot[];
  streamLogs: Phase2StreamLogEntry[];
  exoState: ExoPlayerTestState;
}): string {
  const lines: string[] = [
    '',
    'Fase 2 (Busca / Episódios / ExoPlayer):',
    `- ExoPlayer: ${params.exoState.status}${
      params.exoState.resolutionLabel ? ` · ${params.exoState.resolutionLabel}` : ''
    }${
      params.exoState.durationSeconds > 0
        ? ` · ${Math.round(params.exoState.currentSeconds)}s/${Math.round(params.exoState.durationSeconds)}s`
        : ''
    }${
      params.exoState.manualConfirm === true
        ? ' · Confirmado OK'
        : params.exoState.manualConfirm === false
          ? ' · Falhou'
          : ''
    }`,
  ];

  if (params.exoState.errorDetail) {
    lines.push(`- Erro ExoPlayer: ${params.exoState.errorDetail}`);
  }

  if (params.domSnapshots.length > 0) {
    lines.push('', 'Snapshots DOM sanitizados:');
    for (const snap of params.domSnapshots) {
      lines.push(`- Página: ${snap.url} (${snap.title || 'sem título'})`);
      if (snap.inputs.length > 0) {
        const inputsSummary = snap.inputs
          .map(
            (i) =>
              `${i.tag}[type=${i.type || '?'} id=${i.id || '-'} name=${i.name || '-'} ph=${i.placeholder || '-'}]`
          )
          .join(', ');
        lines.push(`  Inputs: ${inputsSummary}`);
      }
      if (snap.actions.length > 0) {
        const actionsSummary = snap.actions
          .slice(0, 12)
          .map(
            (a) =>
              `${a.tag}(${a.className || a.id || '-'})="${a.text}"${a.hrefPath ? `->${a.hrefPath}` : ''}`
          )
          .join(' | ');
        lines.push(`  Ações/Cards (${snap.actions.length}): ${actionsSummary}`);
      }
      if (snap.video) {
        lines.push(
          `  Video: found=${snap.video.found} id=${snap.video.id ?? '-'} kind=${snap.video.srcKind} src=${snap.video.srcSanitized ?? '-'} ${snap.video.videoWidth}x${snap.video.videoHeight} dur=${Math.round(snap.video.duration)}s tracks=${snap.video.textTrackCount}`
        );
      }
    }
  }

  if (params.streamLogs.length > 0) {
    lines.push('', 'Captura de Mídia sanitizada:');
    for (const item of params.streamLogs.slice(-12)) {
      lines.push(
        `- [${item.kind}] ${item.sourceTag}: ${item.sanitizedUrl}${item.mimeHint ? ` (${item.mimeHint})` : ''}`
      );
    }
  }

  return lines.join('\n');
}
