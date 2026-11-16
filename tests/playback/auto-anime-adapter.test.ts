import { CatalogService } from '../../src/catalog/catalog-service';
import { LibraryRepository } from '../../src/db/library-repository';
import {
  DatabaseAdapter,
  initializeDatabase,
  MediaItemRecord,
} from '../../src/db/schema';
import {
  AutoAnimePlaybackAdapter,
  extractBloggerIframeUrl,
  extractGoogleVideoMp4Url,
  fetchAnimeFirePtMetadata,
  MOBILE_BROWSER_USER_AGENT,
  slugifyAnimeTitle,
} from '../../src/playback/auto-anime-adapter';
import {
  CredentialsStore,
  SecureStoreBackend,
} from '../../src/playback/credentials-store';
import {
  UniTvPlaybackAdapter,
  UniTvSessionBridge,
} from '../../src/playback/unitv-adapter';

type NodeSqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => Record<string, unknown>[];
  };
  close: () => void;
};

type NodeSqliteModule = {
  DatabaseSync: new (location: string) => NodeSqliteDatabase;
};

function createInMemorySqliteAdapter(): { adapter: DatabaseAdapter; close: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as NodeSqliteModule;
  const sqlite = new DatabaseSync(':memory:');

  const normalizeParam = (value: unknown): string | number | null | Uint8Array => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    if (
      typeof value === 'number' ||
      typeof value === 'string' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    return String(value);
  };

  const adapter: DatabaseAdapter = {
    async execute(sql: string, params?: unknown[]): Promise<void> {
      if (!params || params.length === 0) {
        sqlite.exec(sql);
        return;
      }
      sqlite.prepare(sql).run(...params.map(normalizeParam));
    },
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const bound = (params ?? []).map(normalizeParam);
      const rows = sqlite.prepare(sql).all(...bound);
      return rows.map((row) => ({ ...row }) as T);
    },
  };

  return {
    adapter,
    close: () => sqlite.close(),
  };
}

function makeMedia(overrides: Partial<MediaItemRecord> = {}): MediaItemRecord {
  const anilistId = overrides.anilistId ?? 151807;
  return {
    id: overrides.id ?? `anilist:${anilistId}`,
    mediaType: 'ANIME',
    anilistId,
    malId: 52299,
    tmdbId: null,
    titleRomaji: overrides.titleRomaji ?? 'Ore dake Level Up na Ken',
    titleEnglish: overrides.titleEnglish ?? 'Solo Leveling',
    titlePt: overrides.titlePt !== undefined ? overrides.titlePt : null,
    synopsis: overrides.synopsis ?? 'Hunters battle monsters.',
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

function createMemoryCredentialsStore(): CredentialsStore {
  const map = new Map<string, string>();
  const backend: SecureStoreBackend = {
    setItemAsync: async (key, val) => {
      map.set(key, val);
    },
    getItemAsync: async (key) => map.get(key) ?? null,
    deleteItemAsync: async (key) => {
      map.delete(key);
    },
  };
  return new CredentialsStore(backend);
}

function createStubBridge(): UniTvSessionBridge {
  return {
    authenticate: jest.fn(async () => ({ ok: false, errorCode: 'AUTH_FAILED' as const })),
    searchVod: jest.fn(async () => null),
    extractEpisodeStream: jest.fn(async () => ({ errorCode: 'AUTH_FAILED' as const })),
  };
}

function makeResponse(input: {
  ok: boolean;
  status?: number;
  jsonData?: unknown;
  textData?: string;
}): Response {
  return {
    ok: input.ok,
    status: input.status ?? (input.ok ? 200 : 404),
    json: async () => input.jsonData,
    text: async () =>
      input.textData !== undefined
        ? input.textData
        : JSON.stringify(input.jsonData ?? {}),
  } as unknown as Response;
}

describe('AutoAnimePlaybackAdapter & helpers', () => {
  it('slugifies titles, extracts Blogger iframe URL, and picks itag=22 MP4 over itag=18 while ignoring yt-ump', () => {
    expect(slugifyAnimeTitle('Frieren: A Jornada para o Além!')).toBe(
      'frieren-a-jornada-para-o-alem'
    );

    const episodeHtml = `
      <div class="play-box-iframe">
        <iframe class="metaframe rptss" src="https://www.blogger.com/video.g?token=ABC_TOKEN_123&amp;autoplay=1" allowfullscreen></iframe>
      </div>
    `;
    expect(extractBloggerIframeUrl(episodeHtml)).toBe(
      'https://www.blogger.com/video.g?token=ABC_TOKEN_123&autoplay=1'
    );

    const bloggerHtml = `
      <script>
        var cfg = [
          "https://rr1---sn.googlevideo.com/videoplayback?id\\u003d123\\u0026itag\\u003d18\\u0026mime\\u003dvideo/mp4\\u0026sig\\u003dlow",
          "https://rr2---sn.googlevideo.com/videoplayback?id\\u003d123\\u0026itag\\u003d22\\u0026mime\\u003dvideo/mp4\\u0026sig\\u003dhd720",
          "https://rr3---sn.googlevideo.com/videoplayback?id\\u003d123\\u0026itag\\u003d99\\u0026mime\\u003dapplication/vnd.yt-ump"
        ];
      </script>
    `;
    expect(extractGoogleVideoMp4Url(bloggerHtml)).toBe(
      'https://rr2---sn.googlevideo.com/videoplayback?id=123&itag=22&mime=video/mp4&sig=hd720'
    );

    const onlyUmpHtml = `"https://rr3---sn.googlevideo.com/videoplayback?mime=application/vnd.yt-ump&itag=18"`;
    expect(extractGoogleVideoMp4Url(onlyUmpHtml)).toBeNull();
  });

  it('extends UniTvPlaybackAdapter and resolves live 1080p HLS streams from AnimeFire API without login', async () => {
    const saveUniTvLink = jest.fn(async () => undefined);
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/animes/pesquisar?')) {
        return makeResponse({
          ok: true,
          jsonData: {
            data: [
              {
                id: 'anime-bc-id',
                titles: { BR: 'Black Clover', US: 'Black Clover' },
              },
            ],
          },
        });
      }
      if (url.includes('/anime/anime-bc-id?')) {
        return makeResponse({
          ok: true,
          jsonData: {
            data: {
              titles: { BR: 'Black Clover' },
              episodes: [{ id: 'ep-7-id', number: 7, season: 1 }],
            },
          },
        });
      }
      if (url.includes('/episode/ep-7-id?')) {
        return makeResponse({
          ok: true,
          jsonData: {
            data: {
              streams: [
                {
                  audio: 'legendado',
                  is_offline: false,
                  url: 'https://akumast.net/i/abc123/h.jpg',
                  qualities: ['480p', '720p', '1080p'],
                },
              ],
            },
          },
        });
      }
      if (url === 'https://akumast.net/i/abc123/h.jpg') {
        return makeResponse({
          ok: true,
          status: 200,
          textData: '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080',
        });
      }
      return makeResponse({ ok: false, status: 404 });
    });

    const adapter = new AutoAnimePlaybackAdapter({
      bridge: createStubBridge(),
      credentialsStore: createMemoryCredentialsStore(),
      repository: { saveUniTvLink } as unknown as Pick<
        LibraryRepository,
        'saveUniTvLink'
      >,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(adapter).toBeInstanceOf(UniTvPlaybackAdapter);

    const resolution = await adapter.resolveEpisodePlayback({
      media: makeMedia({
        titleRomaji: 'Black Clover',
        titleEnglish: 'Black Clover',
      }),
      episodeNumber: 7,
      existingLink: null,
      portalUrl: 'https://www.uvwebs.info',
    });

    expect(resolution).toEqual({
      mode: 'EXOPLAYER_HLS',
      streamUrl: 'https://akumast.net/i/abc123/h.jpg',
      headers: {
        Referer: 'https://animefire.plus/',
        Origin: 'https://animefire.plus',
      },
      webViewUrl: 'https://animefire.plus/anime/anime-bc-id',
      matchedTitle: 'Black Clover',
      vodId: 'af:anime-bc-id',
    });
    expect(saveUniTvLink).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaItemId: 'anilist:151807',
        unitvVodId: 'af:anime-bc-id',
        unitvTitle: 'Black Clover',
        preferredAudioOrSub: 'LEG',
      })
    );
  });

  it('falls back to AnimesOnlineCC + Blogger 720p direct MP4 when AnimeFire stream returns 404', async () => {
    const saveUniTvLink = jest.fn(async () => undefined);
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/animes/pesquisar?')) {
        return makeResponse({
          ok: true,
          jsonData: {
            data: [{ id: 'af-solo-1', titles: { BR: 'Solo Leveling' } }],
          },
        });
      }
      if (url.includes('/anime/af-solo-1?')) {
        return makeResponse({
          ok: true,
          jsonData: {
            data: {
              titles: { BR: 'Solo Leveling' },
              episodes: [{ id: 'af-ep-1', number: 1, season: 1 }],
            },
          },
        });
      }
      if (url.includes('/episode/af-ep-1?')) {
        return makeResponse({
          ok: true,
          jsonData: {
            data: {
              streams: [
                {
                  audio: 'dublado',
                  is_offline: false,
                  url: 'https://akumast.net/i/expired/h.jpg',
                },
              ],
            },
          },
        });
      }
      if (url === 'https://akumast.net/i/expired/h.jpg') {
        return makeResponse({ ok: false, status: 404 });
      }
      if (url === 'https://animesonlinecc.to/episodio/solo-leveling-episodio-1/') {
        return makeResponse({
          ok: true,
          textData:
            '<iframe class="metaframe rptss" src="https://www.blogger.com/video.g?token=SOLO_TOKEN"></iframe>',
        });
      }
      if (url === 'https://www.blogger.com/video.g?token=SOLO_TOKEN') {
        return makeResponse({
          ok: true,
          textData:
            '&quot;https://rr13.googlevideo.com/videoplayback?itag\\u003d18\\u0026mime\\u003dvideo/mp4&quot; &quot;https://rr13.googlevideo.com/videoplayback?itag\\u003d22\\u0026mime\\u003dvideo/mp4&quot;',
        });
      }
      return makeResponse({ ok: false, status: 404 });
    });

    const adapter = new AutoAnimePlaybackAdapter({
      bridge: createStubBridge(),
      credentialsStore: createMemoryCredentialsStore(),
      repository: { saveUniTvLink } as unknown as Pick<
        LibraryRepository,
        'saveUniTvLink'
      >,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const resolution = await adapter.resolveEpisodePlayback({
      media: makeMedia(),
      episodeNumber: 1,
      existingLink: null,
      portalUrl: 'https://www.uvwebs.info',
    });

    expect(resolution).toEqual({
      mode: 'EXOPLAYER_HLS',
      streamUrl:
        'https://rr13.googlevideo.com/videoplayback?itag=22&mime=video/mp4',
      headers: {
        Referer: 'https://www.blogger.com/',
        'User-Agent': MOBILE_BROWSER_USER_AGENT,
      },
      webViewUrl: 'https://www.blogger.com/video.g?token=SOLO_TOKEN',
      matchedTitle: 'Solo Leveling',
      vodId: 'aocc:solo-leveling',
    });
    expect(saveUniTvLink).toHaveBeenCalledWith(
      expect.objectContaining({
        unitvVodId: 'aocc:solo-leveling',
      })
    );
  });

  it('falls back to CLEAN_WEBVIEW pointing to blogger.com/video.g when Blogger HTML has no direct MP4 link', async () => {
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://api.animefire.one')) {
        return makeResponse({ ok: true, jsonData: { data: [] } });
      }
      if (url === 'https://animesonlinecc.to/episodio/dandadan-episodio-3/') {
        return makeResponse({
          ok: true,
          textData:
            '<iframe class="metaframe" src="https://www.blogger.com/video.g?token=DDD_WEBVIEW"></iframe>',
        });
      }
      if (url === 'https://www.blogger.com/video.g?token=DDD_WEBVIEW') {
        return makeResponse({
          ok: true,
          textData: '<html><body><video></video></body></html>',
        });
      }
      return makeResponse({ ok: false, status: 404 });
    });

    const adapter = new AutoAnimePlaybackAdapter({
      bridge: createStubBridge(),
      credentialsStore: createMemoryCredentialsStore(),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const resolution = await adapter.resolveEpisodePlayback({
      media: makeMedia({
        titleRomaji: 'Dandadan',
        titleEnglish: 'Dandadan',
      }),
      episodeNumber: 3,
      existingLink: null,
      portalUrl: 'https://www.uvwebs.info',
    });

    expect(resolution).toEqual({
      mode: 'CLEAN_WEBVIEW',
      webViewUrl: 'https://www.blogger.com/video.g?token=DDD_WEBVIEW',
      matchedTitle: 'Dandadan',
      vodId: 'aocc:dandadan',
    });
  });

  it('reports STREAM_READY in testConnection when the automatic PT-BR provider responds HTTP 200', async () => {
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/animes/lancamentos')) {
        return makeResponse({ ok: true, jsonData: { data: { animes: [] } } });
      }
      return makeResponse({ ok: false, status: 404 });
    });

    const adapter = new AutoAnimePlaybackAdapter({
      bridge: createStubBridge(),
      credentialsStore: createMemoryCredentialsStore(),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const probe = await adapter.testConnection({
      portalUrl: 'https://www.uvwebs.info',
      username: '',
      password: '',
    });

    expect(probe).toEqual({
      status: 'STREAM_READY',
      streamUrl:
        'Fonte Automática PT-BR Ativa (Full HD 1080p · Dublado & Legendado · Tempo Real)',
    });
  });

  it('uses ptBrFallbackFn inside CatalogService.enrichWithPortugueseIfConfigured when tmdbApiKey is null', async () => {
    const mem = createInMemorySqliteAdapter();
    try {
      await initializeDatabase(mem.adapter);
      const repo = new LibraryRepository(mem.adapter);
      const media = makeMedia({
        anilistId: 154587,
        titleRomaji: 'Sousou no Frieren',
        titleEnglish: "Frieren: Beyond Journey's End",
        titlePt: null,
        synopsis: 'English synopsis.',
      });
      await repo.upsertMediaItem(media);

      const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/animes/pesquisar?')) {
          return makeResponse({
            ok: true,
            jsonData: {
              data: [
                {
                  id: 'frieren-pt',
                  titles: { BR: 'Frieren e a Jornada para o Além' },
                },
              ],
            },
          });
        }
        if (url.includes('/anime/frieren-pt?')) {
          return makeResponse({
            ok: true,
            jsonData: {
              data: {
                titles: { BR: 'Frieren e a Jornada para o Além' },
                synopsis:
                  'Após derrotar o Rei Demônio, a maga elfa Frieren inicia uma nova jornada.',
              },
            },
          });
        }
        return makeResponse({ ok: false, status: 404 });
      });

      const service = new CatalogService(repo, {
        ptBrFallbackFn: (item) =>
          fetchAnimeFirePtMetadata(item, mockFetch as unknown as typeof fetch),
      });

      const enriched = await service.enrichWithPortugueseIfConfigured(media);
      expect(enriched.titlePt).toBe('Frieren e a Jornada para o Além');
      expect(enriched.synopsis).toBe(
        'Após derrotar o Rei Demônio, a maga elfa Frieren inicia uma nova jornada.'
      );

      const persisted = await repo.getMediaItemById(media.id);
      expect(persisted?.titlePt).toBe('Frieren e a Jornada para o Além');
    } finally {
      mem.close();
    }
  });
});
