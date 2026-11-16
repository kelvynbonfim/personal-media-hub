import * as SecureStore from 'expo-secure-store';
import { MediaItemRecord, UniTvLinkRecord } from '../../src/db/schema';
import {
  CredentialsStore,
  SecureStoreBackend,
} from '../../src/playback/credentials-store';
import {
  HlsVariant,
  selectBestHlsTrack,
} from '../../src/playback/hls-track-selector';
import {
  PlaybackErrorCode,
  PlaybackMode,
  PlaybackResolution,
  PlaybackResolveParams,
  PlaybackSourceAdapter,
} from '../../src/playback/types';
import {
  buildTitleCandidates,
  CLEAN_WEBVIEW_HIDE_CHROME_CSS,
  CLEAN_WEBVIEW_INJECT_SCRIPT,
  parseCleanWebViewStreamMessage,
  UniTvPlaybackAdapter,
  UniTvSessionBridge,
} from '../../src/playback/unitv-adapter';

function createSampleMedia(overrides: Partial<MediaItemRecord> = {}): MediaItemRecord {
  return {
    id: 'media-1',
    mediaType: 'ANIME',
    anilistId: 151807,
    malId: 52299,
    tmdbId: 127532,
    titleRomaji: 'Ore dake Level Up na Ken',
    titleEnglish: 'Solo Leveling',
    titlePt: 'Solo Leveling: Arise',
    synopsis: 'A hunter levels up.',
    coverUrl: 'https://img.example.com/cover.jpg',
    bannerUrl: null,
    genresJson: JSON.stringify(['Action', 'Fantasy']),
    seasonYear: 2024,
    seasonName: 'WINTER',
    episodesTotal: 12,
    statusAiring: 'FINISHED',
    nextAiringAt: null,
    nextAiringEp: null,
    relationsJson: '[]',
    cachedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

function createMemoryBackend(): {
  backend: SecureStoreBackend;
  storage: Map<string, string>;
} {
  const storage = new Map<string, string>();
  const backend: SecureStoreBackend = {
    setItemAsync: jest.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => storage.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      storage.delete(key);
    }),
  };
  return { backend, storage };
}

function createMockBridge(
  overrides: Partial<UniTvSessionBridge> = {}
): UniTvSessionBridge {
  const authenticate = jest.fn<
    ReturnType<UniTvSessionBridge['authenticate']>,
    Parameters<UniTvSessionBridge['authenticate']>
  >(async () => ({ ok: true }));
  const searchVod = jest.fn<
    ReturnType<UniTvSessionBridge['searchVod']>,
    Parameters<UniTvSessionBridge['searchVod']>
  >(async () => ({
    vodId: 'vod-999',
    title: 'Solo Leveling Dublado',
    watchPath: '/vod/anime/vod-999',
  }));
  const extractEpisodeStream = jest.fn<
    ReturnType<UniTvSessionBridge['extractEpisodeStream']>,
    Parameters<UniTvSessionBridge['extractEpisodeStream']>
  >(async () => ({
    streamUrl: 'https://cdn.unitv.example/hls/ep01/1080p/master.m3u8',
    headers: { Referer: 'https://custom-mirror.unitv.test/' },
  }));

  return {
    authenticate,
    searchVod,
    extractEpisodeStream,
    ...overrides,
  };
}

describe('selectBestHlsTrack', () => {
  it('picks 1920x1080 over 1280x720 regardless of array order', () => {
    const variants: HlsVariant[] = [
      { index: 0, width: 1280, height: 720, bitrate: 4_500_000 },
      { index: 1, width: 854, height: 480, bitrate: 1_500_000 },
      { index: 2, width: 1920, height: 1080, bitrate: 5_000_000 },
    ];

    expect(selectBestHlsTrack(variants)).toEqual({
      index: 2,
      label: '1080p',
    });
    // Ensure input array is not mutated
    expect(variants.map((v) => v.index)).toEqual([0, 1, 2]);
  });

  it('breaks resolution ties by highest bitrate and returns 1080p label', () => {
    const variants: HlsVariant[] = [
      { index: 0, width: 1920, height: 1080, bitrate: 3_200_000 },
      { index: 1, width: 1920, height: 1080, bitrate: 7_800_000 },
      { index: 2, width: 1920, height: 1080, bitrate: 5_400_000 },
    ];

    expect(selectBestHlsTrack(variants)).toEqual({
      index: 1,
      label: '1080p',
    });
  });

  it('formats 2160p, 720p, and 480p labels accurately', () => {
    expect(
      selectBestHlsTrack([
        { index: 0, width: 1920, height: 1080, bitrate: 6_000_000 },
        { index: 1, width: 3840, height: 2160, bitrate: 14_000_000 },
      ])
    ).toEqual({ index: 1, label: '2160p' });

    expect(
      selectBestHlsTrack([
        { index: 0, width: 854, height: 480, bitrate: 1_200_000 },
        { index: 1, width: 1280, height: 720, bitrate: 3_000_000 },
      ])
    ).toEqual({ index: 1, label: '720p' });

    expect(
      selectBestHlsTrack([{ index: 3, width: 854, height: 480, bitrate: 1_200_000 }])
    ).toEqual({ index: 3, label: '480p' });
  });

  it('returns null for an empty array', () => {
    expect(selectBestHlsTrack([])).toBeNull();
  });
});

describe('CredentialsStore', () => {
  it('writes, reads, and clears credentials via injected SecureStoreBackend', async () => {
    const { backend, storage } = createMemoryBackend();
    const store = new CredentialsStore(backend);

    expect(await store.getUniTvCredentials()).toBeNull();

    await store.saveUniTvCredentials({
      username: '  viewer@example.com  ',
      password: 'secret-password',
    });

    expect(backend.setItemAsync).toHaveBeenCalledTimes(1);
    expect(storage.size).toBe(1);

    const loaded = await store.getUniTvCredentials();
    expect(loaded).toEqual({
      username: 'viewer@example.com',
      password: 'secret-password',
    });

    await store.clearUniTvCredentials();
    expect(backend.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(await store.getUniTvCredentials()).toBeNull();
  });

  it('uses expo-secure-store by default and never touches SQLite or app_settings', async () => {
    const store = new CredentialsStore();

    await store.saveUniTvCredentials({
      username: 'unitv_user',
      password: 'unitv_password_123',
    });

    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(await store.getUniTvCredentials()).toEqual({
      username: 'unitv_user',
      password: 'unitv_password_123',
    });

    await store.clearUniTvCredentials();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(await store.getUniTvCredentials()).toBeNull();
  });

  it('rejects empty or whitespace-only username or password', async () => {
    const { backend } = createMemoryBackend();
    const store = new CredentialsStore(backend);

    await expect(
      store.saveUniTvCredentials({ username: '', password: 'valid' })
    ).rejects.toThrow();
    await expect(
      store.saveUniTvCredentials({ username: '   ', password: 'valid' })
    ).rejects.toThrow();
    await expect(
      store.saveUniTvCredentials({ username: 'user', password: '' })
    ).rejects.toThrow();
    await expect(
      store.saveUniTvCredentials({ username: 'user', password: '   ' })
    ).rejects.toThrow();
    expect(backend.setItemAsync).not.toHaveBeenCalled();
  });

  it('returns null gracefully when stored secure payload is malformed JSON', async () => {
    const { backend, storage } = createMemoryBackend();
    storage.set('unitv_credentials_v1', '{not-valid-json');
    const store = new CredentialsStore(backend);

    const loaded = await store.getUniTvCredentials();
    expect(loaded).toBeNull();
  });
});

describe('buildTitleCandidates', () => {
  it('returns normalized deduplicated candidates in priority order titlePt, titleEnglish, titleRomaji', () => {
    const media = createSampleMedia({
      titlePt: '  Solo   Leveling  ',
      titleEnglish: 'solo leveling',
      titleRomaji: 'Ore dake Level Up na Ken',
    });

    expect(buildTitleCandidates(media)).toEqual([
      'Solo Leveling',
      'Ore dake Level Up na Ken',
    ]);

    const withoutPt = createSampleMedia({
      titlePt: '   ',
      titleEnglish: 'Frieren: Beyond Journey\'s End',
      titleRomaji: 'Sousou no Frieren',
    });

    expect(buildTitleCandidates(withoutPt)).toEqual([
      'Frieren: Beyond Journey\'s End',
      'Sousou no Frieren',
    ]);
  });
});

describe('UniTvPlaybackAdapter', () => {
  const customMirrorUrl = 'https://mirror-br.unitv.example/';

  async function createAuthenticatedStore(): Promise<CredentialsStore> {
    const { backend } = createMemoryBackend();
    const credentialsStore = new CredentialsStore(backend);
    await credentialsStore.saveUniTvCredentials({
      username: 'user@example.com',
      password: 'strong-password',
    });
    return credentialsStore;
  }

  it('reuses existingLink without calling searchVod and uses dynamic portalUrl', async () => {
    const credentialsStore = await createAuthenticatedStore();
    const bridge = createMockBridge({
      extractEpisodeStream: jest.fn(async () => ({
        streamUrl: 'https://cdn.mirror.example/1080p/ep6.m3u8',
        headers: { Referer: 'https://mirror-br.unitv.example/vod/existing-vod-77' },
      })),
    });
    const repository = {
      saveUniTvLink: jest.fn(async () => undefined),
    };

    const adapter: PlaybackSourceAdapter = new UniTvPlaybackAdapter({
      bridge,
      credentialsStore,
      repository,
    });

    const existingLink: UniTvLinkRecord = {
      mediaItemId: 'media-1',
      unitvVodId: 'existing-vod-77',
      unitvTitle: 'Solo Leveling (Dublado)',
      unitvSeasonTag: 'S1',
      preferredAudioOrSub: 'DUB',
      lastVerifiedAt: '2026-11-15T12:00:00.000Z',
    };

    const params: PlaybackResolveParams = {
      media: createSampleMedia(),
      episodeNumber: 6,
      existingLink,
      portalUrl: customMirrorUrl,
    };

    const resolution: PlaybackResolution = await adapter.resolveEpisodePlayback(params);

    expect(bridge.authenticate).toHaveBeenCalledWith('https://mirror-br.unitv.example', {
      username: 'user@example.com',
      password: 'strong-password',
    });
    expect(bridge.searchVod).not.toHaveBeenCalled();
    expect(repository.saveUniTvLink).not.toHaveBeenCalled();
    expect(bridge.extractEpisodeStream).toHaveBeenCalledWith({
      portalUrl: 'https://mirror-br.unitv.example',
      vodId: 'existing-vod-77',
      watchPath: undefined,
      episodeNumber: 6,
      timeoutMs: 8000,
    });

    const expectedMode: PlaybackMode = 'EXOPLAYER_HLS';
    expect(resolution).toEqual({
      mode: expectedMode,
      streamUrl: 'https://cdn.mirror.example/1080p/ep6.m3u8',
      headers: { Referer: 'https://mirror-br.unitv.example/vod/existing-vod-77' },
      matchedTitle: 'Solo Leveling (Dublado)',
      vodId: 'existing-vod-77',
    });
  });

  it('searches VOD with normalized candidates when existingLink is null and persists UniTvLinkRecord', async () => {
    const credentialsStore = await createAuthenticatedStore();
    const bridge = createMockBridge({
      searchVod: jest.fn(async () => ({
        vodId: 'vod-501',
        title: 'Solo Leveling: Arise (PT-BR)',
        watchPath: '/watch/vod-501',
      })),
      extractEpisodeStream: jest.fn(async () => ({
        streamUrl: 'https://cdn.mirror.example/vod-501/ep2.mp4',
      })),
    });
    const saveUniTvLink = jest.fn(async (_link: UniTvLinkRecord) => undefined);

    const adapter = new UniTvPlaybackAdapter({
      bridge,
      credentialsStore,
      repository: { saveUniTvLink },
    });

    const media = createSampleMedia({
      titlePt: 'Solo Leveling: Arise',
      titleEnglish: 'Solo Leveling',
      titleRomaji: 'Ore dake Level Up na Ken',
    });

    const resolution = await adapter.resolveEpisodePlayback({
      media,
      episodeNumber: 2,
      existingLink: null,
      portalUrl: 'https://alt-portal.unitv.net',
    });

    expect(bridge.searchVod).toHaveBeenCalledWith('https://alt-portal.unitv.net', [
      'Solo Leveling: Arise',
      'Solo Leveling',
      'Ore dake Level Up na Ken',
    ]);
    expect(saveUniTvLink).toHaveBeenCalledTimes(1);
    const savedLink = saveUniTvLink.mock.calls[0][0];
    expect(savedLink.mediaItemId).toBe('media-1');
    expect(savedLink.unitvVodId).toBe('vod-501');
    expect(savedLink.unitvTitle).toBe('Solo Leveling: Arise (PT-BR)');
    expect(typeof savedLink.lastVerifiedAt).toBe('string');

    expect(resolution).toEqual({
      mode: 'EXOPLAYER_HLS',
      streamUrl: 'https://cdn.mirror.example/vod-501/ep2.mp4',
      headers: undefined,
      matchedTitle: 'Solo Leveling: Arise (PT-BR)',
      vodId: 'vod-501',
    });
  });

  it('returns NOT_FOUND_IN_CATALOG gracefully when searchVod returns null', async () => {
    const credentialsStore = await createAuthenticatedStore();
    const bridge = createMockBridge({
      searchVod: jest.fn(async () => null),
    });
    const repository = {
      saveUniTvLink: jest.fn(async () => undefined),
    };

    const adapter = new UniTvPlaybackAdapter({
      bridge,
      credentialsStore,
      repository,
    });

    const resolution = await adapter.resolveEpisodePlayback({
      media: createSampleMedia(),
      episodeNumber: 1,
      existingLink: null,
      portalUrl: customMirrorUrl,
    });

    const expectedError: PlaybackErrorCode = 'NOT_FOUND_IN_CATALOG';
    expect(resolution.errorCode).toBe(expectedError);
    expect(resolution.streamUrl).toBeUndefined();
    expect(bridge.extractEpisodeStream).not.toHaveBeenCalled();
    expect(repository.saveUniTvLink).not.toHaveBeenCalled();
  });

  it('falls back to CLEAN_WEBVIEW rooted in configured portalUrl after 8000 ms timeout', async () => {
    jest.useFakeTimers();
    try {
      const credentialsStore = await createAuthenticatedStore();
      const bridge = createMockBridge({
        searchVod: jest.fn(async () => ({
          vodId: 'vod-timeout-1',
          title: 'Solo Leveling',
          watchPath: '/vod/anime/vod-timeout-1/ep-4',
        })),
        extractEpisodeStream: jest.fn(() => new Promise(() => {})),
      });

      const adapter = new UniTvPlaybackAdapter({
        bridge,
        credentialsStore,
      });

      let settled = false;
      const promise = adapter
        .resolveEpisodePlayback({
          media: createSampleMedia(),
          episodeNumber: 4,
          existingLink: null,
          portalUrl: 'https://custom-mirror-02.unitv.org/',
        })
        .then((res) => {
          settled = true;
          return res;
        });

      await jest.advanceTimersByTimeAsync(7999);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const resolution = await promise;
      expect(resolution).toEqual({
        mode: 'CLEAN_WEBVIEW',
        webViewUrl: 'https://custom-mirror-02.unitv.org/vod/anime/vod-timeout-1/ep-4',
        matchedTitle: 'Solo Leveling',
        vodId: 'vod-timeout-1',
      });
      expect(resolution.webViewUrl?.startsWith('https://custom-mirror-02.unitv.org/')).toBe(
        true
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('builds CLEAN_WEBVIEW fallback URL with vodId and episode when existingLink times out', async () => {
    jest.useFakeTimers();
    try {
      const credentialsStore = await createAuthenticatedStore();
      const bridge = createMockBridge({
        extractEpisodeStream: jest.fn(() => new Promise(() => {})),
      });

      const adapter = new UniTvPlaybackAdapter({
        bridge,
        credentialsStore,
      });

      const existingLink: UniTvLinkRecord = {
        mediaItemId: 'media-1',
        unitvVodId: 'vod-88',
        unitvTitle: 'Frieren',
        unitvSeasonTag: null,
        preferredAudioOrSub: null,
        lastVerifiedAt: '2026-11-16T00:00:00.000Z',
      };

      const promise = adapter.resolveEpisodePlayback({
        media: createSampleMedia(),
        episodeNumber: 10,
        existingLink,
        portalUrl: 'https://mirror-3.unitv.test',
      });

      await jest.advanceTimersByTimeAsync(8000);
      const resolution = await promise;

      expect(resolution.mode).toBe('CLEAN_WEBVIEW');
      expect(resolution.webViewUrl).toBe('https://mirror-3.unitv.test/vod/vod-88?ep=10');
      expect(resolution.vodId).toBe('vod-88');
      expect(resolution.matchedTitle).toBe('Frieren');
    } finally {
      jest.useRealTimers();
    }
  });

  it('handles CONCURRENT_SCREEN_LIMIT from authenticate and extractEpisodeStream cleanly', async () => {
    const credentialsStore = await createAuthenticatedStore();

    const bridgeAuthRejected = createMockBridge({
      authenticate: jest.fn(async () => ({
        ok: false,
        errorCode: 'CONCURRENT_SCREEN_LIMIT' as const,
      })),
    });

    const adapterAuthRejected = new UniTvPlaybackAdapter({
      bridge: bridgeAuthRejected,
      credentialsStore,
    });

    const authResolution = await adapterAuthRejected.resolveEpisodePlayback({
      media: createSampleMedia(),
      episodeNumber: 1,
      existingLink: null,
      portalUrl: customMirrorUrl,
    });

    expect(authResolution.errorCode).toBe('CONCURRENT_SCREEN_LIMIT');
    expect(authResolution.streamUrl).toBeUndefined();
    expect(bridgeAuthRejected.searchVod).not.toHaveBeenCalled();
    expect(bridgeAuthRejected.extractEpisodeStream).not.toHaveBeenCalled();

    const bridgeExtractRejected = createMockBridge({
      extractEpisodeStream: jest.fn(async () => ({
        errorCode: 'CONCURRENT_SCREEN_LIMIT' as const,
      })),
    });

    const adapterExtractRejected = new UniTvPlaybackAdapter({
      bridge: bridgeExtractRejected,
      credentialsStore,
    });

    const extractResolution = await adapterExtractRejected.resolveEpisodePlayback({
      media: createSampleMedia(),
      episodeNumber: 1,
      existingLink: null,
      portalUrl: customMirrorUrl,
    });

    expect(extractResolution.errorCode).toBe('CONCURRENT_SCREEN_LIMIT');
    expect(extractResolution.streamUrl).toBeUndefined();
  });

  it('returns AUTH_FAILED when credentials are missing or authentication fails', async () => {
    const { backend } = createMemoryBackend();
    const emptyCredentialsStore = new CredentialsStore(backend);
    const bridge = createMockBridge();

    const adapterNoCreds = new UniTvPlaybackAdapter({
      bridge,
      credentialsStore: emptyCredentialsStore,
    });

    const noCredsResult = await adapterNoCreds.resolveEpisodePlayback({
      media: createSampleMedia(),
      episodeNumber: 1,
      existingLink: null,
      portalUrl: customMirrorUrl,
    });

    expect(noCredsResult.errorCode).toBe('AUTH_FAILED');
    expect(bridge.authenticate).not.toHaveBeenCalled();

    const validCredsStore = await createAuthenticatedStore();
    const badAuthBridge = createMockBridge({
      authenticate: jest.fn(async () => ({
        ok: false,
        errorCode: 'AUTH_FAILED' as const,
      })),
    });

    const adapterBadAuth = new UniTvPlaybackAdapter({
      bridge: badAuthBridge,
      credentialsStore: validCredsStore,
    });

    const badAuthResult = await adapterBadAuth.resolveEpisodePlayback({
      media: createSampleMedia(),
      episodeNumber: 1,
      existingLink: null,
      portalUrl: customMirrorUrl,
    });

    expect(badAuthResult.errorCode).toBe('AUTH_FAILED');
    expect(badAuthBridge.searchVod).not.toHaveBeenCalled();
  });

  it('exports valid CLEAN_WEBVIEW CSS and JS injection helpers stripping site chrome', () => {
    expect(CLEAN_WEBVIEW_HIDE_CHROME_CSS).toContain('header');
    expect(CLEAN_WEBVIEW_HIDE_CHROME_CSS).toContain('nav');
    expect(CLEAN_WEBVIEW_HIDE_CHROME_CSS).toContain('footer');
    expect(CLEAN_WEBVIEW_HIDE_CHROME_CSS).toContain('display: none');
    expect(CLEAN_WEBVIEW_INJECT_SCRIPT).toContain('header');
    expect(() => new Function(CLEAN_WEBVIEW_INJECT_SCRIPT)).not.toThrow();
  });

  it('normalizes bridge-reported timedOut webViewUrl and parses WebView stream messages', async () => {
    const credentialsStore = await createAuthenticatedStore();
    const bridge = createMockBridge({
      extractEpisodeStream: jest.fn(async () => ({
        timedOut: true as const,
        webViewUrl: '/player/ep-3',
      })),
    });

    const adapter = new UniTvPlaybackAdapter({
      bridge,
      credentialsStore,
    });

    const resolution = await adapter.resolveEpisodePlayback({
      media: createSampleMedia(),
      episodeNumber: 3,
      existingLink: null,
      portalUrl: 'https://mirror-4.unitv.example/',
    });

    expect(resolution).toEqual({
      mode: 'CLEAN_WEBVIEW',
      webViewUrl: 'https://mirror-4.unitv.example/player/ep-3',
      matchedTitle: 'Solo Leveling Dublado',
      vodId: 'vod-999',
    });

    expect(
      parseCleanWebViewStreamMessage(
        JSON.stringify({
          type: 'STREAM_CAPTURED',
          url: 'https://cdn.example.com/1080p/video.m3u8',
          headers: { Referer: 'https://mirror-4.unitv.example/' },
        })
      )
    ).toEqual({
      streamUrl: 'https://cdn.example.com/1080p/video.m3u8',
      headers: { Referer: 'https://mirror-4.unitv.example/' },
    });
    expect(parseCleanWebViewStreamMessage('invalid')).toBeNull();
  });
});
