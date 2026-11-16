export type UniTvProbeStatus = 'STREAM_READY' | 'WEBVIEW_ONLY' | 'BLOCKED';

export interface UniTvProbeResult {
  status: UniTvProbeStatus;
  streamUrl?: string;
  headers?: Record<string, string>;
  reason?: string;
}

const STREAM_EXTENSION_PATTERN = /\.(m3u8|mp4)$/i;

export const UNITV_STREAM_HOOK_SCRIPT = `
(function () {
  if (window.__UNITV_HOOK_INSTALLED__) {
    return true;
  }
  window.__UNITV_HOOK_INSTALLED__ = true;

  var reportedUrls = {};

  function isStreamUrl(candidate) {
    if (typeof candidate !== 'string' || !/^https?:\\/\\//i.test(candidate)) {
      return false;
    }
    var clean = candidate.split('#')[0].split('?')[0].toLowerCase();
    return clean.endsWith('.m3u8') || clean.endsWith('.mp4');
  }

  function emitStream(url) {
    if (!isStreamUrl(url) || reportedUrls[url]) {
      return;
    }
    reportedUrls[url] = true;
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({
          type: 'STREAM_CAPTURED',
          url: url,
          headers: {
            Referer: window.location.href,
            'User-Agent': navigator.userAgent
          }
        })
      );
    }
  }

  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var reqUrl = typeof input === 'string' ? input : input && input.url;
        emitStream(reqUrl);
      } catch (e) {}
      return originalFetch.apply(this, arguments);
    };
  }

  if (typeof window.XMLHttpRequest === 'function') {
    var originalOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        emitStream(url);
      } catch (e) {}
      return originalOpen.apply(this, arguments);
    };
  }

  function scanVideos() {
    try {
      var videos = document.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) {
        var video = videos[i];
        emitStream(video.currentSrc || video.src);
        var sources = video.querySelectorAll('source');
        for (var j = 0; j < sources.length; j++) {
          emitStream(sources[j].src);
        }
      }
    } catch (e) {}
  }

  document.addEventListener('loadstart', function (event) {
    var target = event && event.target;
    if (target && target.tagName === 'VIDEO') {
      emitStream(target.currentSrc || target.src);
    }
  }, true);

  if (typeof MutationObserver === 'function' && document.documentElement) {
    var observer = new MutationObserver(scanVideos);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }

  scanVideos();
})();
true;
`.trim();

export function buildPortalUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, '');
  const normalizedPath = path.trim().replace(/^\/+/, '');
  if (!normalizedPath) {
    return normalizedBase;
  }
  if (!normalizedBase) {
    return `/${normalizedPath}`;
  }
  return `${normalizedBase}/${normalizedPath}`;
}

function isValidStreamUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return STREAM_EXTENSION_PATTERN.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function parseInjectedStreamPayload(
  rawJson: string
): { url: string; headers: Record<string, string> } | null {
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
  if (record.type !== 'STREAM_CAPTURED' || typeof record.url !== 'string') {
    return null;
  }

  const candidateUrl = record.url.trim();
  if (!isValidStreamUrl(candidateUrl)) {
    return null;
  }

  const headers: Record<string, string> = {};
  if (record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers)) {
    for (const [key, value] of Object.entries(record.headers as Record<string, unknown>)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }
  }

  return {
    url: candidateUrl,
    headers,
  };
}

export function classifyProbeOutcome(input: {
  extractedUrl: string | null;
  authSucceeded: boolean;
  pageBlockedByBot: boolean;
}): UniTvProbeResult {
  if (input.pageBlockedByBot) {
    return {
      status: 'BLOCKED',
      reason: 'UniTV web portal blocked by anti-bot protection or CAPTCHA.',
    };
  }

  if (!input.authSucceeded) {
    return {
      status: 'BLOCKED',
      reason: 'UniTV authentication failed or plan does not permit web playback.',
    };
  }

  const trimmedUrl = input.extractedUrl?.trim() ?? '';
  if (trimmedUrl.length > 0) {
    return {
      status: 'STREAM_READY',
      streamUrl: trimmedUrl,
    };
  }

  return {
    status: 'WEBVIEW_ONLY',
    reason: 'Authenticated playback without direct m3u8/mp4 stream extraction; use CLEAN_WEBVIEW fallback.',
  };
}
