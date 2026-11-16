export const CURRENT_APP_VERSION = '1.2.0';
export const CURRENT_BUILD_NUMBER = 3;

export const DEFAULT_VERSION_MANIFEST_URL =
  'https://raw.githubusercontent.com/kelvynbonfim/personal-media-hub/main/version.json';

export const DEFAULT_APK_DOWNLOAD_URL =
  'https://github.com/kelvynbonfim/personal-media-hub/releases/latest/download/app-release.apk';

export interface AppUpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  latestBuildNumber: number;
  releaseNotes: string;
  downloadUrl: string;
  publishedAt?: string;
}

export interface CheckForUpdateOptions {
  currentVersion?: string;
  currentBuildNumber?: number;
  manifestUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface RemoteVersionManifest {
  version?: unknown;
  buildNumber?: unknown;
  releaseNotes?: unknown;
  downloadUrl?: unknown;
  publishedAt?: unknown;
}

function parseSemverParts(version: string): [number, number, number] {
  const cleaned = version.trim().replace(/^v/i, '').split('-')[0] ?? '';
  const segments = cleaned.split('.');
  const major = Number.parseInt(segments[0] ?? '0', 10);
  const minor = Number.parseInt(segments[1] ?? '0', 10);
  const patch = Number.parseInt(segments[2] ?? '0', 10);
  return [
    Number.isFinite(major) ? major : 0,
    Number.isFinite(minor) ? minor : 0,
    Number.isFinite(patch) ? patch : 0,
  ];
}

/**
 * Compares two semantic version strings (a > b => 1, a < b => -1, equal => 0).
 */
export function compareSemver(a: string, b: string): number {
  const partsA = parseSemverParts(a);
  const partsB = parseSemverParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (partsA[i] > partsB[i]) {
      return 1;
    }
    if (partsA[i] < partsB[i]) {
      return -1;
    }
  }
  return 0;
}

function buildFallbackResult(
  currentVersion: string,
  currentBuildNumber: number
): AppUpdateInfo {
  return {
    hasUpdate: false,
    currentVersion,
    latestVersion: currentVersion,
    latestBuildNumber: currentBuildNumber,
    releaseNotes: '',
    downloadUrl: DEFAULT_APK_DOWNLOAD_URL,
  };
}

/**
 * Checks GitHub for a newer release manifest and returns update availability metadata.
 */
export async function checkForAppUpdate(
  options: CheckForUpdateOptions = {}
): Promise<AppUpdateInfo> {
  const currentVersion = options.currentVersion ?? CURRENT_APP_VERSION;
  const currentBuildNumber = options.currentBuildNumber ?? CURRENT_BUILD_NUMBER;
  const manifestUrl = options.manifestUrl ?? DEFAULT_VERSION_MANIFEST_URL;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  const separator = manifestUrl.includes('?') ? '&' : '?';
  const requestUrl = `${manifestUrl}${separator}t=${Date.now()}`;

  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  const externalSignal = options.signal;
  if (externalSignal?.aborted && controller) {
    return buildFallbackResult(currentVersion, currentBuildNumber);
  }
  const onExternalAbort = () => {
    controller?.abort();
  };
  externalSignal?.addEventListener?.('abort', onExternalAbort);
  const timer = controller
    ? setTimeout(() => {
        controller.abort();
      }, timeoutMs)
    : null;

  try {
    const response = await fetchFn(requestUrl, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
      },
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!response.ok) {
      return buildFallbackResult(currentVersion, currentBuildNumber);
    }

    const data = (await response.json()) as RemoteVersionManifest | null;
    if (!data || typeof data !== 'object') {
      return buildFallbackResult(currentVersion, currentBuildNumber);
    }

    const latestVersion =
      typeof data.version === 'string' && data.version.trim().length > 0
        ? data.version.trim()
        : currentVersion;

    const latestBuildNumber =
      typeof data.buildNumber === 'number' && Number.isFinite(data.buildNumber)
        ? data.buildNumber
        : currentBuildNumber;

    const releaseNotes =
      typeof data.releaseNotes === 'string' ? data.releaseNotes.trim() : '';

    const downloadUrl =
      typeof data.downloadUrl === 'string' &&
      /^https?:\/\//i.test(data.downloadUrl.trim())
        ? data.downloadUrl.trim()
        : DEFAULT_APK_DOWNLOAD_URL;

    const publishedAt =
      typeof data.publishedAt === 'string' ? data.publishedAt.trim() : undefined;

    const hasUpdate =
      latestBuildNumber > currentBuildNumber ||
      compareSemver(latestVersion, currentVersion) > 0;

    return {
      hasUpdate,
      currentVersion,
      latestVersion,
      latestBuildNumber,
      releaseNotes,
      downloadUrl,
      ...(publishedAt ? { publishedAt } : {}),
    };
  } catch {
    return buildFallbackResult(currentVersion, currentBuildNumber);
  } finally {
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
