import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { SelectedTrackType } from 'react-native-video';
import { WebView } from 'react-native-webview';
import { CatalogService, FranchiseNode } from '../../src/catalog/catalog-service';
import { BackupService } from '../../src/db/backup-service';
import { LibraryRepository } from '../../src/db/library-repository';
import {
  AppSettingsRecord,
  DEFAULT_APP_SETTINGS,
  EpisodeProgressRecord,
  LibraryEntryRecord,
  MediaItemRecord,
  UniTvLinkRecord,
  WATCH_STATUSES,
} from '../../src/db/schema';
import { AppServices, AppServicesProvider } from '../../src/navigation/AppServicesContext';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { CredentialsStore, UniTvCredentials } from '../../src/playback/credentials-store';
import {
  RuntimeWebViewBridgeController,
  RuntimeWebViewBridgeHost,
} from '../../src/playback/runtime-webview-bridge';
import { PlaybackSourceAdapter } from '../../src/playback/types';
import {
  CLEAN_WEBVIEW_INJECT_SCRIPT,
  UniTvPlaybackAdapter,
} from '../../src/playback/unitv-adapter';
import { UniTvProbeResult } from '../../src/playback/unitv-probe';
import { AnimeDetailsScreen } from '../../src/screens/AnimeDetailsScreen';
import { LibraryScreen } from '../../src/screens/LibraryScreen';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { VideoPlayerScreen } from '../../src/screens/VideoPlayerScreen';
import { SupabaseSyncEngine, SyncResult } from '../../src/sync/supabase-sync';
import { STATUS_META } from '../../src/theme/tokens';
import App from '../../App';

function makeMedia(overrides: Partial<MediaItemRecord> = {}): MediaItemRecord {
  const anilistId = overrides.anilistId ?? 154587;
  return {
    id: overrides.id ?? `anilist:${anilistId}`,
    mediaType: 'ANIME',
    anilistId,
    malId: overrides.malId ?? null,
    tmdbId: overrides.tmdbId ?? null,
    titleRomaji: overrides.titleRomaji ?? `Anime ${anilistId}`,
    titleEnglish:
      overrides.titleEnglish !== undefined
        ? overrides.titleEnglish
        : `Anime ${anilistId}`,
    titlePt: overrides.titlePt !== undefined ? overrides.titlePt : null,
    synopsis:
      overrides.synopsis !== undefined
        ? overrides.synopsis
        : 'Uma sinopse detalhada em português sobre a jornada épica dos personagens ao longo de várias temporadas.',
    coverUrl: overrides.coverUrl ?? `https://img.example.com/${anilistId}.jpg`,
    bannerUrl:
      overrides.bannerUrl !== undefined
        ? overrides.bannerUrl
        : `https://img.example.com/${anilistId}-banner.jpg`,
    genresJson: overrides.genresJson ?? JSON.stringify(['Action', 'Fantasy']),
    seasonYear: overrides.seasonYear !== undefined ? overrides.seasonYear : 2025,
    seasonName: overrides.seasonName !== undefined ? overrides.seasonName : 'FALL',
    episodesTotal:
      overrides.episodesTotal !== undefined ? overrides.episodesTotal : 12,
    statusAiring: overrides.statusAiring ?? 'FINISHED',
    nextAiringAt:
      overrides.nextAiringAt !== undefined ? overrides.nextAiringAt : null,
    nextAiringEp:
      overrides.nextAiringEp !== undefined ? overrides.nextAiringEp : null,
    relationsJson: overrides.relationsJson ?? '[]',
    cachedAt: overrides.cachedAt ?? '2026-11-16T10:00:00.000Z',
  };
}

function makeEntry(
  mediaItemId: string,
  overrides: Partial<LibraryEntryRecord> = {}
): LibraryEntryRecord {
  return {
    id: overrides.id ?? `entry-${mediaItemId}`,
    mediaItemId,
    status: overrides.status ?? 'WATCHING',
    personalScore:
      overrides.personalScore !== undefined ? overrides.personalScore : null,
    currentEpisode: overrides.currentEpisode ?? 0,
    notes: overrides.notes ?? '',
    rewatchCount: overrides.rewatchCount ?? 0,
    startedAt: overrides.startedAt ?? '2026-11-01T10:00:00.000Z',
    completedAt: overrides.completedAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-11-16T10:00:00.000Z',
    dirty: overrides.dirty ?? 1,
  };
}

function makeProgress(
  mediaItemId: string,
  episodeNumber: number,
  overrides: Partial<EpisodeProgressRecord> = {}
): EpisodeProgressRecord {
  return {
    id: overrides.id ?? `prog-${mediaItemId}-${episodeNumber}`,
    mediaItemId,
    episodeNumber,
    positionSeconds: overrides.positionSeconds ?? 0,
    durationSeconds: overrides.durationSeconds ?? 1440,
    isCompleted: overrides.isCompleted ?? false,
    watchedVia: overrides.watchedVia ?? 'APP_PLAYER',
    updatedAt: overrides.updatedAt ?? '2026-11-16T10:00:00.000Z',
    dirty: overrides.dirty ?? 1,
  };
}

function createMockServices(overrides: {
  libraryRepository?: Partial<LibraryRepository>;
  catalogService?: Partial<CatalogService>;
  backupService?: Partial<BackupService>;
  credentialsStore?: Partial<CredentialsStore>;
  playbackAdapter?: (PlaybackSourceAdapter & { testConnection?: unknown }) | null;
  webViewBridge?: { searchVod: jest.Mock; testConnection?: jest.Mock } | null;
  syncEngine?: Partial<SupabaseSyncEngine> | null;
} = {}): AppServices {
  const libraryRepository = {
    upsertMediaItem: jest.fn(async () => undefined),
    getMediaItemById: jest.fn(async () => null),
    getMediaItemByAnilistId: jest.fn(async () => null),
    getAllMediaItems: jest.fn(async () => []),
    setLibraryStatus: jest.fn(async (mediaItemId: string, status: LibraryEntryRecord['status']) =>
      makeEntry(mediaItemId, { status })
    ),
    updatePersonalScore: jest.fn(async () => undefined),
    updateNotes: jest.fn(async () => undefined),
    recordPlaybackProgress: jest.fn(async () => ({
      episodeCompleted: false,
      seasonCompletedPrompt: false,
    })),
    toggleEpisodeManual: jest.fn(async () => ({ seasonCompletedPrompt: false })),
    getLibraryByStatus: jest.fn(async () => []),
    getAllLibraryEntries: jest.fn(async () => []),
    getEpisodeProgressList: jest.fn(async () => []),
    getAllEpisodeProgress: jest.fn(async () => []),
    pickRandomPlanToWatch: jest.fn((entries, genreFilter?: string) => {
      const normalized = genreFilter?.trim().toLowerCase() ?? '';
      const matches = entries.filter((item: any) => {
        if (item.status !== 'PLAN_TO_WATCH') return false;
        if (!normalized) return true;
        return item.media.genresJson.toLowerCase().includes(normalized);
      });
      return matches[0] ?? null;
    }),
    getSettings: jest.fn(async (): Promise<AppSettingsRecord> => ({
      ...DEFAULT_APP_SETTINGS,
    })),
    saveSettings: jest.fn(
      async (patch: Partial<AppSettingsRecord>): Promise<AppSettingsRecord> => ({
        ...DEFAULT_APP_SETTINGS,
        ...patch,
      })
    ),
    saveUniTvLink: jest.fn(async () => undefined),
    getUniTvLink: jest.fn(async () => null),
    ...overrides.libraryRepository,
  } as unknown as LibraryRepository;

  const catalogService = {
    getHomeFeed: jest.fn(async () => ({
      hero: null,
      trendingMonth: [],
      currentSeason: [],
    })),
    exploreCatalog: jest.fn(async () => []),
    getWeeklySchedule: jest.fn(async () => ({
      0: [],
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
    })),
    getUpcomingSeasonsRadar: jest.fn(async () => []),
    buildFranchiseTimeline: jest.fn(
      (media: MediaItemRecord): FranchiseNode[] => [
        {
          anilistId: media.anilistId,
          title: media.titlePt ?? media.titleEnglish ?? media.titleRomaji,
          format: 'TV',
          relationType: 'CURRENT',
        },
      ]
    ),
    enrichWithPortugueseIfConfigured: jest.fn(async (media: MediaItemRecord) => media),
    ...overrides.catalogService,
  } as unknown as CatalogService;

  const backupService = {
    exportBackupJson: jest.fn(async () => '{"version":1}'),
    importBackupJson: jest.fn(async () => ({
      importedEntries: 0,
      importedProgress: 0,
    })),
    ...overrides.backupService,
  } as unknown as BackupService;

  const credentialsStore = {
    getUniTvCredentials: jest.fn(async () => null),
    saveUniTvCredentials: jest.fn(async () => undefined),
    clearUniTvCredentials: jest.fn(async () => undefined),
    ...overrides.credentialsStore,
  } as unknown as CredentialsStore;

  return {
    db: {} as AppServices['db'],
    libraryRepository,
    backupService,
    catalogService,
    credentialsStore,
    playbackAdapter: overrides.playbackAdapter ?? null,
    ...(overrides.webViewBridge !== undefined
      ? { webViewBridge: overrides.webViewBridge as AppServices['webViewBridge'] }
      : {}),
    syncEngine: (overrides.syncEngine as SupabaseSyncEngine | null | undefined) ?? null,
  };
}

describe('LibraryScreen', () => {
  it('renders summary counts, switches all 6 status chips, toggles Grid/List & sort order, and picks a title via "🎲 Escolher por mim"', async () => {
    const watchingAlpha = makeMedia({
      id: 'anilist:1',
      anilistId: 1,
      titlePt: 'Zeta Watching',
      episodesTotal: 12,
    });
    const watchingBeta = makeMedia({
      id: 'anilist:2',
      anilistId: 2,
      titlePt: 'Alpha Watching',
      episodesTotal: 24,
    });
    const planItem = makeMedia({
      id: 'anilist:3',
      anilistId: 3,
      titlePt: 'Dungeon Meshi',
      genresJson: JSON.stringify(['Fantasy', 'Comedy']),
    });
    const completedItem = makeMedia({
      id: 'anilist:4',
      anilistId: 4,
      titlePt: 'Frieren',
      episodesTotal: 28,
    });
    const pausedItem = makeMedia({
      id: 'anilist:5',
      anilistId: 5,
      titlePt: 'Monster Pausado',
      episodesTotal: 74,
    });
    const droppedItem = makeMedia({
      id: 'anilist:6',
      anilistId: 6,
      titlePt: 'Isekai Dropado',
      episodesTotal: 12,
    });
    const rewatchingItem = makeMedia({
      id: 'anilist:7',
      anilistId: 7,
      titlePt: 'Steins;Gate Reassistindo',
      episodesTotal: 24,
    });

    const byStatus: Record<LibraryEntryRecord['status'], Array<LibraryEntryRecord & { media: MediaItemRecord }>> = {
      WATCHING: [
        {
          ...makeEntry(watchingAlpha.id, {
            status: 'WATCHING',
            currentEpisode: 4,
            personalScore: 7.5,
            updatedAt: '2026-11-16T12:00:00.000Z',
          }),
          media: watchingAlpha,
        },
        {
          ...makeEntry(watchingBeta.id, {
            status: 'WATCHING',
            currentEpisode: 10,
            personalScore: 9.5,
            updatedAt: '2026-11-15T12:00:00.000Z',
          }),
          media: watchingBeta,
        },
      ],
      PLAN_TO_WATCH: [
        {
          ...makeEntry(planItem.id, { status: 'PLAN_TO_WATCH', currentEpisode: 0 }),
          media: planItem,
        },
      ],
      COMPLETED: [
        {
          ...makeEntry(completedItem.id, { status: 'COMPLETED', currentEpisode: 28 }),
          media: completedItem,
        },
      ],
      PAUSED: [
        {
          ...makeEntry(pausedItem.id, { status: 'PAUSED', currentEpisode: 15 }),
          media: pausedItem,
        },
      ],
      DROPPED: [
        {
          ...makeEntry(droppedItem.id, { status: 'DROPPED', currentEpisode: 2 }),
          media: droppedItem,
        },
      ],
      REWATCHING: [
        {
          ...makeEntry(rewatchingItem.id, { status: 'REWATCHING', currentEpisode: 6 }),
          media: rewatchingItem,
        },
      ],
    };

    const pickRandomPlanToWatch = jest.fn((entries) => entries[0] ?? null);
    const services = createMockServices({
      libraryRepository: {
        getLibraryByStatus: jest.fn(async (status) => byStatus[status] ?? []),
        pickRandomPlanToWatch,
      },
    });

    const navigate = jest.fn();
    const { getAllByTestId, getByTestId, getByText, queryByTestId } = render(
      <AppServicesProvider value={services}>
        <LibraryScreen navigation={{ navigate }} />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByText('Zeta Watching')).toBeTruthy();
    });

    // Summary counts: completed=1, watching+rewatching=3, episodes=4+10+0+28+15+2+6 = 65
    expect(getByTestId('library-summary-completed').props.children).toBe('1');
    expect(getByTestId('library-summary-watching').props.children).toBe('3');
    expect(getByTestId('library-summary-episodes').props.children).toBe('65');

    // All 6 status chips rendered with exact Portuguese labels
    for (const status of WATCH_STATUSES) {
      expect(getByText(STATUS_META[status].label)).toBeTruthy();
      expect(getByTestId(`library-status-chip-${status}`)).toBeTruthy();
    }

    // Default layout is Grid; toggle to List and verify list rows
    expect(getByTestId('library-grid')).toBeTruthy();
    fireEvent.press(getByTestId('library-layout-list'));
    expect(queryByTestId('library-grid')).toBeNull();
    expect(getByTestId('library-list')).toBeTruthy();
    expect(getByTestId(`library-row-${watchingAlpha.id}`)).toBeTruthy();

    // Initial RECENT sort places watchingAlpha (newer updatedAt) first
    expect(
      getAllByTestId(/^library-row-anilist:/).map((node) => node.props.testID)
    ).toEqual([`library-row-${watchingAlpha.id}`, `library-row-${watchingBeta.id}`]);

    // Sort by SCORE places 9.5 (Alpha Watching) first
    fireEvent.press(getByTestId('library-sort-SCORE'));
    expect(
      getAllByTestId(/^library-row-anilist:/).map((node) => node.props.testID)
    ).toEqual([`library-row-${watchingBeta.id}`, `library-row-${watchingAlpha.id}`]);

    // Sort by TITLE puts "Alpha Watching" (watchingBeta) first
    fireEvent.press(getByTestId('library-sort-TITLE'));
    expect(
      getAllByTestId(/^library-row-anilist:/).map((node) => node.props.testID)
    ).toEqual([`library-row-${watchingBeta.id}`, `library-row-${watchingAlpha.id}`]);

    // Switch through remaining status chips
    fireEvent.press(getByTestId('library-status-chip-PLAN_TO_WATCH'));
    expect(getByText('Dungeon Meshi')).toBeTruthy();

    fireEvent.press(getByTestId('library-status-chip-COMPLETED'));
    expect(getByText('Frieren')).toBeTruthy();

    fireEvent.press(getByTestId('library-status-chip-PAUSED'));
    expect(getByText('Monster Pausado')).toBeTruthy();

    fireEvent.press(getByTestId('library-status-chip-DROPPED'));
    expect(getByText('Isekai Dropado')).toBeTruthy();

    fireEvent.press(getByTestId('library-status-chip-REWATCHING'));
    expect(getByText('Steins;Gate Reassistindo')).toBeTruthy();

    // Trigger "🎲 Escolher por mim"
    fireEvent.press(getByTestId('library-pick-for-me-button'));
    expect(pickRandomPlanToWatch).toHaveBeenCalledWith(
      byStatus.PLAN_TO_WATCH,
      undefined
    );
    expect(getByTestId('library-roulette-result')).toBeTruthy();
    expect(getByText('Dungeon Meshi')).toBeTruthy();

    // Tapping picked recommendation navigates to AnimeDetails
    fireEvent.press(getByTestId('library-roulette-open-details'));
    expect(navigate).toHaveBeenCalledWith('AnimeDetails', {
      anilistId: planItem.anilistId,
      mediaItemId: planItem.id,
    });
  });

  it('handles empty PLAN_TO_WATCH roulette and genre-filtered roulette cleanly', async () => {
    const services = createMockServices({
      libraryRepository: {
        getLibraryByStatus: jest.fn(async () => []),
      },
    });

    const { getByTestId, getByText, queryByTestId } = render(
      <AppServicesProvider value={services}>
        <LibraryScreen navigation={{ navigate: jest.fn() }} />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('library-pick-for-me-button')).toBeTruthy();
    });

    fireEvent.press(getByTestId('library-roulette-genre-Fantasy'));
    fireEvent.press(getByTestId('library-pick-for-me-button'));

    expect(services.libraryRepository.pickRandomPlanToWatch).toHaveBeenCalledWith(
      [],
      'Fantasy'
    );
    expect(queryByTestId('library-roulette-result')).toBeNull();
    expect(
      getByText(/Nenhum título em "Pretendo assistir" corresponde/i)
    ).toBeTruthy();
  });
});

describe('AnimeDetailsScreen', () => {
  it('renders Option A unified view with status, half-step score, franchise timeline, synopsis toggle, notes, UniTV modal, episodes Play/manual ✓, and 1-tap season completion prompt', async () => {
    const media = makeMedia({
      id: 'anilist:154587',
      anilistId: 154587,
      titlePt: 'Frieren e a Jornada para o Além',
      episodesTotal: 12,
      synopsis:
        'Após uma jornada de dez anos ao lado do grupo do herói Himmel, a elfa maga Frieren parte em uma nova viagem para compreender os sentimentos humanos.',
    });

    const entry = makeEntry(media.id, {
      status: 'WATCHING',
      personalScore: 8.5,
      currentEpisode: 5,
      notes: 'Nota inicial',
    });

    const timeline: FranchiseNode[] = [
      {
        anilistId: 1000,
        title: 'Prólogo da Jornada',
        format: 'OVA',
        relationType: 'PREQUEL',
        userStatus: 'COMPLETED',
      },
      {
        anilistId: 154587,
        title: 'Frieren e a Jornada para o Além',
        format: 'TV',
        relationType: 'CURRENT',
        userStatus: 'WATCHING',
      },
      {
        anilistId: 2000,
        title: 'Frieren Temporada 2',
        format: 'TV',
        relationType: 'SEQUEL',
      },
    ];

    const setLibraryStatus = jest.fn(async (mediaItemId: string, status: LibraryEntryRecord['status']) =>
      makeEntry(mediaItemId, { status })
    );
    const updatePersonalScore = jest.fn(async () => undefined);
    const updateNotes = jest.fn(async () => undefined);
    const saveUniTvLink = jest.fn(async (_link: UniTvLinkRecord) => undefined);
    const toggleEpisodeManual = jest.fn(
      async (_mediaItemId: string, ep: number, completed: boolean) => ({
        seasonCompletedPrompt: completed && ep === 12,
      })
    );

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getAllLibraryEntries: jest.fn(async () => [entry]),
        getEpisodeProgressList: jest.fn(async () => [
          makeProgress(media.id, 6, {
            positionSeconds: 580,
            durationSeconds: 1440,
            isCompleted: false,
          }),
        ]),
        getUniTvLink: jest.fn(async () => null),
        setLibraryStatus,
        updatePersonalScore,
        updateNotes,
        saveUniTvLink,
        toggleEpisodeManual,
      },
      catalogService: {
        buildFranchiseTimeline: jest.fn(() => timeline),
      },
    });

    const navigate = jest.fn();
    const { getAllByText, getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <AnimeDetailsScreen
          navigation={{ navigate }}
          route={{ params: { anilistId: media.anilistId, mediaItemId: media.id } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(
        getAllByText('Frieren e a Jornada para o Além').length
      ).toBeGreaterThan(0);
    });

    // Status selector updates status
    fireEvent.press(getByTestId('details-status-chip-PAUSED'));
    await waitFor(() => {
      expect(setLibraryStatus).toHaveBeenCalledWith(media.id, 'PAUSED');
    });

    // 0..10 half-step (0.5) score picker
    fireEvent.press(getByTestId('score-increment'));
    await waitFor(() => {
      expect(updatePersonalScore).toHaveBeenCalledWith(media.id, 9);
    });
    fireEvent.press(getByTestId('score-chip-9.5'));
    await waitFor(() => {
      expect(updatePersonalScore).toHaveBeenCalledWith(media.id, 9.5);
    });

    // Franchise chronological timeline rendered and navigable
    expect(getByText('Prólogo da Jornada')).toBeTruthy();
    expect(getByText('Frieren Temporada 2')).toBeTruthy();
    fireEvent.press(getByTestId('franchise-node-2000'));
    expect(navigate).toHaveBeenCalledWith('AnimeDetails', { anilistId: 2000 });

    // Synopsis collapsed to 3 lines -> expands on toggle
    expect(getByTestId('details-synopsis-text').props.numberOfLines).toBe(3);
    fireEvent.press(getByTestId('details-synopsis-toggle'));
    expect(getByTestId('details-synopsis-text').props.numberOfLines).toBeUndefined();

    // Personal notes editor
    fireEvent.changeText(getByTestId('details-notes-input'), 'Episódio 6 emocionante!');
    fireEvent.press(getByTestId('details-save-notes-button'));
    await waitFor(() => {
      expect(updateNotes).toHaveBeenCalledWith(media.id, 'Episódio 6 emocionante!');
    });

    // Manual UniTV link modal
    fireEvent.press(getByTestId('details-unitv-link-button'));
    expect(getByTestId('details-unitv-modal')).toBeTruthy();
    fireEvent.changeText(getByTestId('unitv-modal-vod-id-input'), 'vod-frieren-hd');
    fireEvent.changeText(getByTestId('unitv-modal-title-input'), 'Frieren Dublado');
    fireEvent.changeText(getByTestId('unitv-modal-season-input'), 'S1');
    fireEvent.press(getByTestId('unitv-modal-audio-DUB'));
    fireEvent.press(getByTestId('unitv-modal-save'));

    await waitFor(() => {
      expect(saveUniTvLink).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaItemId: media.id,
          unitvVodId: 'vod-frieren-hd',
          unitvTitle: 'Frieren Dublado',
          unitvSeasonTag: 'S1',
          preferredAudioOrSub: 'DUB',
        })
      );
      expect(getByText('Full HD ✓')).toBeTruthy();
    });

    // Episode partial resume label & Play navigation
    expect(getByText('Parou em 09:40')).toBeTruthy();
    fireEvent.press(getByTestId('episode-play-6'));
    expect(navigate).toHaveBeenCalledWith('VideoPlayer', {
      mediaItemId: media.id,
      episodeNumber: 6,
    });

    // Manual ✓ on final episode triggers 1-tap season completion prompt
    fireEvent.press(getByTestId('episode-toggle-12'));
    await waitFor(() => {
      expect(toggleEpisodeManual).toHaveBeenCalledWith(media.id, 12, true);
      expect(getByTestId('season-completed-prompt')).toBeTruthy();
    });

    fireEvent.press(getByTestId('season-completed-confirm'));
    await waitFor(() => {
      expect(setLibraryStatus).toHaveBeenCalledWith(media.id, 'COMPLETED');
    });
  });
});

describe('VideoPlayerScreen', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders EXOPLAYER_HLS Video, selects highest resolution track (1080p), saves progress every 10,000 ms, and shows "Próximo Episódio" in last 90s', async () => {
    jest.useFakeTimers();

    const media = makeMedia({
      id: 'anilist:151807',
      anilistId: 151807,
      titlePt: 'Solo Leveling',
      episodesTotal: 12,
    });

    const recordPlaybackProgress = jest.fn(async (input) => ({
      episodeCompleted:
        input.durationSeconds > 0 &&
        input.positionSeconds / input.durationSeconds >= 0.85,
      seasonCompletedPrompt: false,
    }));

    const playbackAdapter: PlaybackSourceAdapter = {
      resolveEpisodePlayback: jest.fn(async () => ({
        mode: 'EXOPLAYER_HLS' as const,
        streamUrl: 'https://cdn.unitv.example/solo/ep01/master.m3u8',
        headers: { Referer: 'https://www.uvwebs.info/' },
        matchedTitle: 'Solo Leveling',
        vodId: 'vod-1',
      })),
    };

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getEpisodeProgressList: jest.fn(async () => []),
        recordPlaybackProgress,
      },
      playbackAdapter,
    });

    const navigate = jest.fn();
    const goBack = jest.fn();
    const openUrlSpy = jest.spyOn(Linking, 'openURL');

    const { getByTestId, getByText, queryByTestId, unmount } = render(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate, goBack }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ScreenOrientation.lockAsync).toHaveBeenCalledWith(
      ScreenOrientation.OrientationLock.LANDSCAPE
    );

    const video = getByTestId('video-player-exo');
    expect(video.props.source).toEqual({
      uri: 'https://cdn.unitv.example/solo/ep01/master.m3u8',
      headers: { Referer: 'https://www.uvwebs.info/' },
    });

    // Fire onLoad with multi-resolution HLS tracks
    act(() => {
      video.props.onLoad({
        currentTime: 0,
        duration: 1440,
        naturalSize: { width: 1920, height: 1080, orientation: 'landscape' },
        audioTracks: [],
        textTracks: [],
        videoTracks: [
          { index: 0, width: 1280, height: 720, bitrate: 3_000_000 },
          { index: 1, width: 1920, height: 1080, bitrate: 5_000_000 },
          { index: 2, width: 1920, height: 1080, bitrate: 8_500_000 },
        ],
      });
    });

    expect(getByTestId('video-player-exo').props.selectedVideoTrack).toEqual({
      type: 'index',
      value: 2,
    });
    expect(getByText('1080p / Máxima')).toBeTruthy();

    // Update playback position to 600s (remaining 840s > 90s -> Próximo Episódio hidden)
    act(() => {
      getByTestId('video-player-exo').props.onProgress({
        currentTime: 600,
        playableDuration: 700,
        seekableDuration: 1440,
      });
    });
    expect(queryByTestId('player-next-episode-button')).toBeNull();

    // 10,000 ms interval persistence check
    await act(async () => {
      jest.advanceTimersByTime(9999);
    });
    expect(recordPlaybackProgress).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(recordPlaybackProgress).toHaveBeenCalledTimes(1);
    expect(recordPlaybackProgress).toHaveBeenCalledWith({
      mediaItemId: media.id,
      episodeNumber: 1,
      positionSeconds: 600,
      durationSeconds: 1440,
      watchedVia: 'APP_PLAYER',
    });

    // Advance into last 90 seconds (1360s of 1440s -> 80s remaining)
    act(() => {
      getByTestId('video-player-exo').props.onProgress({
        currentTime: 1360,
        playableDuration: 1440,
        seekableDuration: 1440,
      });
    });

    const nextBtn = getByTestId('player-next-episode-button');
    expect(nextBtn).toBeTruthy();
    expect(getByText('Próximo Episódio')).toBeTruthy();

    await act(async () => {
      fireEvent.press(nextBtn);
    });
    expect(navigate).toHaveBeenCalledWith('VideoPlayer', {
      mediaItemId: media.id,
      episodeNumber: 2,
    });
    expect(openUrlSpy).not.toHaveBeenCalled();

    unmount();
    expect(ScreenOrientation.unlockAsync).toHaveBeenCalled();
  });

  it('renders CLEAN_WEBVIEW fallback with injected scripts and floating "Concluir Episódio ✓" button without leaving the app', async () => {
    const media = makeMedia({
      id: 'anilist:200',
      anilistId: 200,
      titlePt: 'Anime WebView',
      episodesTotal: 12,
    });

    const toggleEpisodeManual = jest.fn(async () => ({
      seasonCompletedPrompt: false,
    }));

    const playbackAdapter: PlaybackSourceAdapter = {
      resolveEpisodePlayback: jest.fn(async () => ({
        mode: 'CLEAN_WEBVIEW' as const,
        webViewUrl: 'https://www.uvwebs.info/vod/vod-200?ep=3',
        matchedTitle: 'Anime WebView',
        vodId: 'vod-200',
      })),
    };

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getEpisodeProgressList: jest.fn(async () => []),
        toggleEpisodeManual,
      },
      playbackAdapter,
    });

    const openUrlSpy = jest.spyOn(Linking, 'openURL');
    const { getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 3 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('video-player-webview')).toBeTruthy();
    });

    const webView = getByTestId('video-player-webview');
    expect(webView.props.source).toEqual({
      uri: 'https://www.uvwebs.info/vod/vod-200?ep=3',
    });
    expect(webView.props.injectedJavaScript).toBe(CLEAN_WEBVIEW_INJECT_SCRIPT);

    // Block external app deep-links (e.g. unitv://) inside WebView
    expect(
      webView.props.onShouldStartLoadWithRequest({ url: 'unitv://watch/123' })
    ).toBe(false);
    expect(
      webView.props.onShouldStartLoadWithRequest({
        url: 'https://www.uvwebs.info/vod/vod-200?ep=3',
      })
    ).toBe(true);

    // Floating "Concluir Episódio ✓" button
    expect(getByText('Concluir Episódio ✓')).toBeTruthy();
    fireEvent.press(getByTestId('player-webview-complete-button'));

    await waitFor(() => {
      expect(toggleEpisodeManual).toHaveBeenCalledWith(media.id, 3, true);
    });
    expect(openUrlSpy).not.toHaveBeenCalled();
  });

  it('displays clear Portuguese error states for CONCURRENT_SCREEN_LIMIT and NOT_FOUND_IN_CATALOG without crashing or opening external apps', async () => {
    const media = makeMedia({
      id: 'anilist:300',
      anilistId: 300,
      titlePt: 'Anime Erro',
    });
    const openUrlSpy = jest.spyOn(Linking, 'openURL');

    const concurrentServices = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'CLEAN_WEBVIEW' as const,
          errorCode: 'CONCURRENT_SCREEN_LIMIT' as const,
        })),
      },
    });

    const concurrentView = render(
      <AppServicesProvider value={concurrentServices}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(concurrentView.getByTestId('player-error-state')).toBeTruthy();
      expect(
        concurrentView.getByText(/Limite de telas simultâneas/i)
      ).toBeTruthy();
    });

    const notFoundServices = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'CLEAN_WEBVIEW' as const,
          errorCode: 'NOT_FOUND_IN_CATALOG' as const,
        })),
      },
    });

    const notFoundView = render(
      <AppServicesProvider value={notFoundServices}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(notFoundView.getByTestId('player-error-state')).toBeTruthy();
      expect(
        notFoundView.getByText(/não encontrado no catálogo do UniTV/i)
      ).toBeTruthy();
    });

    expect(openUrlSpy).not.toHaveBeenCalled();
  });

  it('saves progress immediately on pause and marks episode completed when crossing 85% duration', async () => {
    const media = makeMedia({
      id: 'anilist:350',
      anilistId: 350,
      titlePt: 'Anime Pause & 85%',
      episodesTotal: 12,
    });
    const recordPlaybackProgress = jest.fn(async (input) => ({
      episodeCompleted:
        input.durationSeconds > 0 &&
        input.positionSeconds / input.durationSeconds >= 0.85,
      seasonCompletedPrompt: false,
    }));
    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        recordPlaybackProgress,
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'EXOPLAYER_HLS' as const,
          streamUrl: 'https://cdn.unitv.example/350/ep1.m3u8',
        })),
      },
    });

    const { getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('video-player-exo')).toBeTruthy();
    });

    act(() => {
      getByTestId('video-player-exo').props.onLoad({
        currentTime: 0,
        duration: 1440,
        naturalSize: { width: 1920, height: 1080, orientation: 'landscape' },
        audioTracks: [],
        textTracks: [],
        videoTracks: [],
      });
      getByTestId('video-player-exo').props.onProgress({
        currentTime: 1224,
        playableDuration: 1440,
        seekableDuration: 1440,
      });
    });

    fireEvent.press(getByTestId('player-play-pause'));

    await waitFor(() => {
      expect(recordPlaybackProgress).toHaveBeenCalledWith({
        mediaItemId: media.id,
        episodeNumber: 1,
        positionSeconds: 1224,
        durationSeconds: 1440,
        watchedVia: 'APP_PLAYER',
      });
      expect(getByText('Concluído (85%+) ✓')).toBeTruthy();
    });
  });
});

describe('SettingsScreen', () => {
  it('saves configurable portal URL via saveSettings, credentials exclusively via CredentialsStore, runs testConnection probe, syncs Supabase, exports/imports JSON backup, and displays TMDB attribution when configured', async () => {
    const saveSettings = jest.fn(
      async (patch: Partial<AppSettingsRecord>): Promise<AppSettingsRecord> => ({
        ...DEFAULT_APP_SETTINGS,
        ...patch,
      })
    );
    const saveUniTvCredentials = jest.fn(
      async (_creds: UniTvCredentials) => undefined
    );
    const exportBackupJson = jest.fn(
      async () =>
        JSON.stringify(
          {
            version: 1,
            exportedAt: '2026-11-16T12:00:00.000Z',
            mediaItems: [],
            libraryEntries: [],
            episodeProgress: [],
            watchHistory: [],
            unitvLinks: [],
            settings: DEFAULT_APP_SETTINGS,
          },
          null,
          2
        )
    );
    const importBackupJson = jest.fn(async () => ({
      importedEntries: 3,
      importedProgress: 12,
    }));
    const syncNow = jest.fn(
      async (): Promise<SyncResult> => ({
        status: 'SYNCED',
        pushedCount: 2,
        pulledCount: 1,
      })
    );
    const testConnection = jest.fn(
      async (): Promise<UniTvProbeResult> => ({
        status: 'STREAM_READY',
        streamUrl: 'https://cdn.example.com/1080p.m3u8',
      })
    );

    const services = createMockServices({
      libraryRepository: {
        getSettings: jest.fn(async () => ({
          ...DEFAULT_APP_SETTINGS,
          tmdbApiKey: null,
        })),
        saveSettings,
      },
      credentialsStore: {
        getUniTvCredentials: jest.fn(async () => null),
        saveUniTvCredentials,
      },
      backupService: {
        exportBackupJson,
        importBackupJson,
      },
      syncEngine: {
        getDirtyCount: jest.fn(async () => 2),
        syncNow,
      },
    });

    const { getByTestId, getByText, queryByText } = render(
      <AppServicesProvider value={services}>
        <SettingsScreen testConnection={testConnection} />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('settings-portal-url-input').props.value).toBe(
        DEFAULT_APP_SETTINGS.unitvPortalUrl
      );
    });

    // TMDB attribution hidden when key is not configured
    expect(
      queryByText(
        'This product uses the TMDB API but is not endorsed or certified by TMDB.'
      )
    ).toBeNull();

    // Update portal URL & UniTV credentials
    fireEvent.changeText(
      getByTestId('settings-portal-url-input'),
      'https://mirror.unitv.example'
    );
    fireEvent.changeText(
      getByTestId('settings-unitv-username-input'),
      'user@example.com'
    );
    fireEvent.changeText(
      getByTestId('settings-unitv-password-input'),
      'super-secret-pass'
    );
    fireEvent.press(getByTestId('settings-save-unitv-button'));

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          unitvPortalUrl: 'https://mirror.unitv.example',
        })
      );
      expect(saveUniTvCredentials).toHaveBeenCalledWith({
        username: 'user@example.com',
        password: 'super-secret-pass',
      });
    });

    // Verify credentials were NEVER sent to saveSettings
    for (const call of saveSettings.mock.calls) {
      const payload = JSON.stringify(call[0]);
      expect(payload).not.toContain('super-secret-pass');
      expect(payload).not.toContain('user@example.com');
    }

    // Trigger "Testar Conexão & Sessão"
    fireEvent.press(getByTestId('settings-test-connection-button'));
    await waitFor(() => {
      expect(testConnection).toHaveBeenCalledWith({
        portalUrl: 'https://mirror.unitv.example',
        username: 'user@example.com',
        password: 'super-secret-pass',
      });
      expect(getByTestId('settings-probe-feedback')).toBeTruthy();
      expect(getByText(/STREAM_READY|1080p pronto/i)).toBeTruthy();
    });

    // Trigger Supabase sync
    fireEvent.changeText(
      getByTestId('settings-sync-user-id-input'),
      'user-uuid-42'
    );
    fireEvent.press(getByTestId('settings-sync-now-button'));
    await waitFor(() => {
      expect(syncNow).toHaveBeenCalledWith('user-uuid-42');
      expect(getByText(/2 enviados, 1 recebidos/i)).toBeTruthy();
    });

    // Export & Import JSON backup
    fireEvent.press(getByTestId('settings-export-backup-button'));
    await waitFor(() => {
      expect(exportBackupJson).toHaveBeenCalledTimes(1);
      expect(getByTestId('settings-backup-json-input').props.value).toContain(
        '"version": 1'
      );
    });

    fireEvent.press(getByTestId('settings-import-backup-button'));
    await waitFor(() => {
      expect(importBackupJson).toHaveBeenCalledTimes(1);
      expect(getByText(/3 animes, 12 progressos/i)).toBeTruthy();
    });

    // Save TMDB API key -> displays official attribution
    fireEvent.changeText(
      getByTestId('settings-tmdb-key-input'),
      'tmdb-free-key-123'
    );
    fireEvent.press(getByTestId('settings-save-tmdb-button'));
    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({
        tmdbApiKey: 'tmdb-free-key-123',
      });
      expect(
        getByText(
          'This product uses the TMDB API but is not endorsed or certified by TMDB.'
        )
      ).toBeTruthy();
    });
  });

  it('displays WEBVIEW_ONLY probe status and DEFERRED_OFFLINE_OR_PAUSED Supabase sync feedback without crashing', async () => {
    const services = createMockServices({
      syncEngine: {
        getDirtyCount: jest.fn(async () => 4),
        syncNow: jest.fn(async (): Promise<SyncResult> => ({
          status: 'DEFERRED_OFFLINE_OR_PAUSED',
          pushedCount: 0,
          pulledCount: 0,
          errorMessage: 'HTTP 540 Project is paused',
        })),
      },
    });

    const testConnection = jest.fn(
      async (): Promise<UniTvProbeResult> => ({
        status: 'WEBVIEW_ONLY',
        reason: 'Use CLEAN_WEBVIEW fallback.',
      })
    );

    const { getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <SettingsScreen testConnection={testConnection} />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('settings-test-connection-button')).toBeTruthy();
    });

    fireEvent.press(getByTestId('settings-test-connection-button'));
    await waitFor(() => {
      expect(getByText(/WEBVIEW_ONLY/)).toBeTruthy();
      expect(getByText(/Use CLEAN_WEBVIEW fallback\./)).toBeTruthy();
    });

    fireEvent.press(getByTestId('settings-sync-now-button'));
    await waitFor(() => {
      expect(
        getByText(/Sincronização adiada.*HTTP 540 Project is paused/i)
      ).toBeTruthy();
    });
  });
});

describe('RootNavigator & App Task 8 integration', () => {
  it('mounts real LibraryScreen as default LibraryTab and wires default UniTvPlaybackAdapter inside App', async () => {
    function ProbeScreen() {
      return React.createElement(React.Fragment, null);
    }

    const services = createMockServices();
    const { getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <RootNavigator />
      </AppServicesProvider>
    );

    fireEvent.press(getByTestId('tab-library'));
    await waitFor(() => {
      expect(getByTestId('library-pick-for-me-button')).toBeTruthy();
      expect(
        getByText('Seus animes organizados nos 6 status de acompanhamento.')
      ).toBeTruthy();
    });

    let capturedPlaybackAdapter: PlaybackSourceAdapter | null | undefined;
    function AdapterInspector() {
      const { useAppServices } = require('../../src/navigation/AppServicesContext');
      const appServices = useAppServices() as AppServices;
      capturedPlaybackAdapter = appServices.playbackAdapter;
      return React.createElement(ProbeScreen);
    }

    render(
      React.createElement(App, { screens: { HomeTab: AdapterInspector } })
    );

    await waitFor(() => {
      expect(capturedPlaybackAdapter).toBeInstanceOf(UniTvPlaybackAdapter);
    });
  });
});

describe('Task 8 review fix regressions', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('protects hidden RuntimeWebViewBridgeHost WebView against non-http schemes/popups, fails queued tasks fast on unmount, and prevents duplicate AUTH submits on redirect onLoadEnd', async () => {
    const controller = new RuntimeWebViewBridgeController();
    const { UNSAFE_getByType, unmount } = render(
      React.createElement(RuntimeWebViewBridgeHost, { controller })
    );

    const authPromise = controller.authenticate('https://www.uvwebs.info', {
      username: 'user@example.com',
      password: 'secret',
    });

    await waitFor(() => {
      expect(UNSAFE_getByType(WebView)).toBeTruthy();
    });

    const hiddenWebView = UNSAFE_getByType(WebView);
    expect(hiddenWebView.props.setSupportMultipleWindows).toBe(false);
    expect(
      hiddenWebView.props.onShouldStartLoadWithRequest({ url: 'unitv://watch/123' })
    ).toBe(false);
    expect(
      hiddenWebView.props.onShouldStartLoadWithRequest({ url: 'intent://app#Intent' })
    ).toBe(false);
    expect(
      hiddenWebView.props.onShouldStartLoadWithRequest({
        url: 'https://www.uvwebs.info/login',
      })
    ).toBe(true);

    // Queue a second task while AUTH is active, then verify repeated onLoadEnd only submits once
    const queuedSearchPromise = controller.searchVod('https://www.uvwebs.info', [
      'Frieren',
    ]);

    const scriptSpy = jest.spyOn(controller, 'getInjectionScriptForTask');

    // First onLoadEnd submits form; second onLoadEnd (after POST redirect) must inspect only, not re-submit
    act(() => {
      hiddenWebView.props.onLoadEnd();
    });
    act(() => {
      hiddenWebView.props.onLoadEnd();
    });
    expect(scriptSpy).toHaveBeenCalledTimes(2);
    expect(scriptSpy.mock.results[0].value).toContain('submit');
    expect(scriptSpy.mock.results[1].value).not.toContain('passInput.form.submit()');
    expect(scriptSpy.mock.results[1].value).not.toContain('submitBtn.click()');

    // Unmount host while AUTH is active and SEARCH is queued -> both settle immediately (no 10s hang)
    unmount();
    const [authRes, searchRes] = await Promise.all([authPromise, queuedSearchPromise]);
    expect(authRes).toEqual({ ok: false, errorCode: 'AUTH_FAILED' });
    expect(searchRes).toBeNull();
  });

  it('preserves resumed positionSeconds when VideoPlayerScreen closes between onLoad and first onProgress', async () => {
    const media = makeMedia({
      id: 'anilist:401',
      anilistId: 401,
      titlePt: 'Anime Retomado',
      episodesTotal: 12,
    });
    const recordPlaybackProgress = jest.fn(
      async (_input: {
        mediaItemId: string;
        episodeNumber: number;
        positionSeconds: number;
        durationSeconds: number;
        watchedVia: 'APP_PLAYER' | 'MANUAL';
      }) => ({
        episodeCompleted: false,
        seasonCompletedPrompt: false,
      })
    );

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getEpisodeProgressList: jest.fn(async () => [
          makeProgress(media.id, 4, {
            positionSeconds: 580,
            durationSeconds: 1440,
            isCompleted: false,
          }),
        ]),
        recordPlaybackProgress,
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'EXOPLAYER_HLS' as const,
          streamUrl: 'https://cdn.unitv.example/401/ep4.m3u8',
        })),
      },
    });

    const goBack = jest.fn();
    const { getByTestId, unmount } = render(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 4 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('video-player-exo')).toBeTruthy();
    });

    act(() => {
      getByTestId('video-player-exo').props.onLoad({
        currentTime: 0,
        duration: 1440,
        naturalSize: { width: 1920, height: 1080, orientation: 'landscape' },
        audioTracks: [],
        textTracks: [],
        videoTracks: [],
      });
    });

    await act(async () => {
      fireEvent.press(getByTestId('player-close-button'));
    });
    unmount();

    expect(goBack).toHaveBeenCalledTimes(1);
    for (const call of recordPlaybackProgress.mock.calls) {
      expect(call[0].positionSeconds).toBeGreaterThanOrEqual(580);
    }
  });

  it('respects preferMaxQuality=false, preserves manual quality selection across onVideoTracks, and emits SelectedTrackType.DISABLED when cycling subtitles off', async () => {
    const media = makeMedia({
      id: 'anilist:402',
      anilistId: 402,
      titlePt: 'Anime Qualidade e Legenda',
    });

    // 1) preferMaxQuality = false should NOT auto-force 1080p
    const autoOffServices = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getSettings: jest.fn(async () => ({
          ...DEFAULT_APP_SETTINGS,
          preferMaxQuality: false,
        })),
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'EXOPLAYER_HLS' as const,
          streamUrl: 'https://cdn.unitv.example/402/ep1.m3u8',
        })),
      },
    });

    const autoOffView = render(
      <AppServicesProvider value={autoOffServices}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(autoOffView.getByTestId('video-player-exo')).toBeTruthy();
    });

    act(() => {
      autoOffView.getByTestId('video-player-exo').props.onLoad({
        currentTime: 0,
        duration: 1440,
        naturalSize: { width: 1280, height: 720, orientation: 'landscape' },
        audioTracks: [],
        textTracks: [{ index: 0, title: 'Português', language: 'pt' }],
        videoTracks: [
          { index: 0, width: 1280, height: 720, bitrate: 3_000_000 },
          { index: 1, width: 1920, height: 1080, bitrate: 8_000_000 },
        ],
      });
    });

    expect(autoOffView.getByTestId('video-player-exo').props.selectedVideoTrack).toBeUndefined();

    // Cycling subtitle: Off -> Track 0 -> Disabled ({ type: SelectedTrackType.DISABLED })
    fireEvent.press(autoOffView.getByTestId('player-subtitle-button'));
    expect(autoOffView.getByTestId('video-player-exo').props.selectedTextTrack).toEqual({
      type: SelectedTrackType.INDEX,
      value: 0,
    });
    fireEvent.press(autoOffView.getByTestId('player-subtitle-button'));
    expect(autoOffView.getByTestId('video-player-exo').props.selectedTextTrack).toEqual({
      type: SelectedTrackType.DISABLED,
    });
    autoOffView.unmount();

    // 2) preferMaxQuality = true selects 1080p once, but preserves manual cycle to 720p across subsequent onVideoTracks
    const maxServices = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getSettings: jest.fn(async () => ({
          ...DEFAULT_APP_SETTINGS,
          preferMaxQuality: true,
        })),
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'EXOPLAYER_HLS' as const,
          streamUrl: 'https://cdn.unitv.example/402/ep1.m3u8',
        })),
      },
    });

    const maxView = render(
      <AppServicesProvider value={maxServices}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(maxView.getByTestId('video-player-exo')).toBeTruthy();
    });

    const tracks = [
      { index: 0, width: 1280, height: 720, bitrate: 3_000_000 },
      { index: 1, width: 1920, height: 1080, bitrate: 8_000_000 },
    ];
    act(() => {
      maxView.getByTestId('video-player-exo').props.onLoad({
        currentTime: 0,
        duration: 1440,
        naturalSize: { width: 1920, height: 1080, orientation: 'landscape' },
        audioTracks: [],
        textTracks: [],
        videoTracks: tracks,
      });
    });

    expect(maxView.getByTestId('video-player-exo').props.selectedVideoTrack).toEqual({
      type: 'index',
      value: 1,
    });

    // Manually cycle to 720p (index 0)
    fireEvent.press(maxView.getByTestId('player-quality-badge'));
    expect(maxView.getByTestId('video-player-exo').props.selectedVideoTrack).toEqual({
      type: 'index',
      value: 0,
    });

    // Subsequent onVideoTracks must NOT snap back to 1080p
    act(() => {
      maxView.getByTestId('video-player-exo').props.onVideoTracks({ videoTracks: tracks });
    });
    expect(maxView.getByTestId('video-player-exo').props.selectedVideoTrack).toEqual({
      type: 'index',
      value: 0,
    });
  });

  it('clamps LibraryScreen List quick-play episode to episodesTotal for completed titles', async () => {
    const completedMedia = makeMedia({
      id: 'anilist:403',
      anilistId: 403,
      titlePt: 'Anime Concluído Clamp',
      episodesTotal: 12,
    });

    const services = createMockServices({
      libraryRepository: {
        getLibraryByStatus: jest.fn(async (status) =>
          status === 'COMPLETED'
            ? [
                {
                  ...makeEntry(completedMedia.id, {
                    status: 'COMPLETED',
                    currentEpisode: 12,
                  }),
                  media: completedMedia,
                },
              ]
            : []
        ),
      },
    });

    const navigate = jest.fn();
    const { getByTestId } = render(
      <AppServicesProvider value={services}>
        <LibraryScreen navigation={{ navigate }} />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('library-status-chip-COMPLETED')).toBeTruthy();
    });

    fireEvent.press(getByTestId('library-status-chip-COMPLETED'));
    fireEvent.press(getByTestId('library-layout-list'));
    fireEvent.press(getByTestId(`library-row-play-${completedMedia.id}`));

    expect(navigate).toHaveBeenCalledWith('VideoPlayer', {
      mediaItemId: completedMedia.id,
      episodeNumber: 12,
    });
  });

  it('resets transient AnimeDetailsScreen UI state on route param change and initializes WATCHING entry on untracked episode toggle', async () => {
    const season1 = makeMedia({
      id: 'anilist:501',
      anilistId: 501,
      titlePt: 'Temporada 1',
      episodesTotal: 12,
    });
    const season2 = makeMedia({
      id: 'anilist:502',
      anilistId: 502,
      titlePt: 'Temporada 2',
      episodesTotal: 12,
    });

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async (id: string) =>
          id === season2.id ? season2 : season1
        ),
        getMediaItemByAnilistId: jest.fn(async (id: number) =>
          id === 502 ? season2 : season1
        ),
        getAllLibraryEntries: jest.fn(async () => []),
        getEpisodeProgressList: jest.fn(async () => []),
        toggleEpisodeManual: jest.fn(async () => ({
          seasonCompletedPrompt: true,
        })),
      },
    });

    const view = render(
      <AppServicesProvider value={services}>
        <AnimeDetailsScreen
          navigation={{ navigate: jest.fn() }}
          route={{ params: { anilistId: 501, mediaItemId: season1.id } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(view.getAllByText('Temporada 1').length).toBeGreaterThan(0);
    });

    // Expand synopsis & trigger season-completed prompt via manual toggle on untracked anime
    fireEvent.press(view.getByTestId('details-synopsis-toggle'));
    expect(view.getByTestId('details-synopsis-text').props.numberOfLines).toBeUndefined();

    fireEvent.press(view.getByTestId('episode-toggle-12'));
    await waitFor(() => {
      expect(view.getByTestId('season-completed-prompt')).toBeTruthy();
      expect(
        view.getByTestId('details-status-chip-WATCHING').props.style
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            borderColor: STATUS_META.WATCHING.color,
          }),
        ])
      );
    });

    // Navigate to Season 2 on the same mounted screen instance -> transient state resets
    view.rerender(
      <AppServicesProvider value={services}>
        <AnimeDetailsScreen
          navigation={{ navigate: jest.fn() }}
          route={{ params: { anilistId: 502, mediaItemId: season2.id } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(view.getAllByText('Temporada 2').length).toBeGreaterThan(0);
    });
    expect(view.queryByTestId('season-completed-prompt')).toBeNull();
    expect(view.getByTestId('details-synopsis-text').props.numberOfLines).toBe(3);
  });
});

describe('Final Fix Wave regressions', () => {
  it('prevents EXOPLAYER_HLS <-> CLEAN_WEBVIEW flip-flop loop for failed stream URLs and resets failed set when episode changes', async () => {
    const media = makeMedia({
      id: 'anilist:601',
      anilistId: 601,
      titlePt: 'Anime Loop Guard',
      episodesTotal: 12,
    });

    const resolveEpisodePlayback = jest.fn(async ({ episodeNumber }: { episodeNumber: number }) =>
      episodeNumber === 1
        ? {
            mode: 'EXOPLAYER_HLS' as const,
            streamUrl: 'https://cdn.unitv.example/bad.m3u8',
            headers: { Referer: 'https://www.uvwebs.info/' },
            vodId: 'vod-601',
          }
        : {
            mode: 'CLEAN_WEBVIEW' as const,
            webViewUrl: 'https://www.uvwebs.info/vod/vod-601?ep=2',
            vodId: 'vod-601',
          }
    );

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
      },
      playbackAdapter: {
        resolveEpisodePlayback,
      },
    });

    const view = render(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId('video-player-exo')).toBeTruthy();
    });

    // 1) Initial HLS URL fails -> falls back to CLEAN_WEBVIEW
    act(() => {
      view.getByTestId('video-player-exo').props.onError();
    });

    await waitFor(() => {
      expect(view.getByTestId('video-player-webview')).toBeTruthy();
    });

    // 2) WebView re-captures the same failed stream URL -> must stay stably in CLEAN_WEBVIEW
    act(() => {
      view.getByTestId('video-player-webview').props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'STREAM_CAPTURED',
            url: 'https://cdn.unitv.example/bad.m3u8',
            headers: { Referer: 'https://www.uvwebs.info/' },
          }),
        },
      });
    });

    expect(view.getByTestId('video-player-webview')).toBeTruthy();
    expect(view.queryByTestId('video-player-exo')).toBeNull();

    // 3) A different unfailed stream URL captured by WebView can still promote to EXOPLAYER_HLS
    act(() => {
      view.getByTestId('video-player-webview').props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'STREAM_CAPTURED',
            url: 'https://cdn.unitv.example/good.m3u8',
            headers: { Referer: 'https://www.uvwebs.info/' },
          }),
        },
      });
    });

    await waitFor(() => {
      expect(view.getByTestId('video-player-exo')).toBeTruthy();
    });
    expect(view.getByTestId('video-player-exo').props.source.uri).toBe(
      'https://cdn.unitv.example/good.m3u8'
    );

    // 4) If the second stream also errors, it stays in CLEAN_WEBVIEW when re-emitted
    act(() => {
      view.getByTestId('video-player-exo').props.onError();
    });
    await waitFor(() => {
      expect(view.getByTestId('video-player-webview')).toBeTruthy();
    });
    act(() => {
      view.getByTestId('video-player-webview').props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'STREAM_CAPTURED',
            url: 'https://cdn.unitv.example/good.m3u8',
            headers: {},
          }),
        },
      });
    });
    expect(view.queryByTestId('video-player-exo')).toBeNull();

    // 5) Switching to episode 2 resets failedStreamUrlsRef so the URL can be tried fresh
    view.rerender(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 2 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId('video-player-webview')).toBeTruthy();
    });

    act(() => {
      view.getByTestId('video-player-webview').props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'STREAM_CAPTURED',
            url: 'https://cdn.unitv.example/good.m3u8',
            headers: { Referer: 'https://www.uvwebs.info/' },
          }),
        },
      });
    });

    await waitFor(() => {
      expect(view.getByTestId('video-player-exo')).toBeTruthy();
    });
  });

  it('orders LibraryScreen PROGRESS sort by normalized completion ratio before ongoing unknown-total entries', async () => {
    const ongoingHighEp = makeMedia({
      id: 'anilist:701',
      anilistId: 701,
      titlePt: 'Ongoing Ep 5',
      episodesTotal: null,
    });
    const zeroTotal = makeMedia({
      id: 'anilist:702',
      anilistId: 702,
      titlePt: 'Zero Total Ep 3',
      episodesTotal: 0,
    });
    const completedFull = makeMedia({
      id: 'anilist:703',
      anilistId: 703,
      titlePt: 'Completed 100%',
      episodesTotal: 12,
    });
    const partialHigh = makeMedia({
      id: 'anilist:704',
      anilistId: 704,
      titlePt: 'Partial 75%',
      episodesTotal: 12,
    });
    const notStarted = makeMedia({
      id: 'anilist:705',
      anilistId: 705,
      titlePt: 'Not Started 0%',
      episodesTotal: 12,
    });

    const watchingList = [
      {
        ...makeEntry(ongoingHighEp.id, {
          status: 'WATCHING',
          currentEpisode: 5,
          updatedAt: '2026-11-16T12:00:00.000Z',
        }),
        media: ongoingHighEp,
      },
      {
        ...makeEntry(zeroTotal.id, {
          status: 'WATCHING',
          currentEpisode: 3,
          updatedAt: '2026-11-16T11:00:00.000Z',
        }),
        media: zeroTotal,
      },
      {
        ...makeEntry(notStarted.id, {
          status: 'WATCHING',
          currentEpisode: 0,
          updatedAt: '2026-11-16T10:00:00.000Z',
        }),
        media: notStarted,
      },
      {
        ...makeEntry(partialHigh.id, {
          status: 'WATCHING',
          currentEpisode: 9,
          updatedAt: '2026-11-16T09:00:00.000Z',
        }),
        media: partialHigh,
      },
      {
        ...makeEntry(completedFull.id, {
          status: 'WATCHING',
          currentEpisode: 12,
          updatedAt: '2026-11-16T08:00:00.000Z',
        }),
        media: completedFull,
      },
    ];

    const services = createMockServices({
      libraryRepository: {
        getLibraryByStatus: jest.fn(async (status) =>
          status === 'WATCHING' ? watchingList : []
        ),
      },
    });

    const { getAllByTestId, getByTestId } = render(
      <AppServicesProvider value={services}>
        <LibraryScreen navigation={{ navigate: jest.fn() }} />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId(`library-card-${completedFull.id}`)).toBeTruthy();
    });

    fireEvent.press(getByTestId('library-layout-list'));
    fireEvent.press(getByTestId('library-sort-PROGRESS'));

    expect(
      getAllByTestId(/^library-row-anilist:/).map((node) => node.props.testID)
    ).toEqual([
      `library-row-${completedFull.id}`,
      `library-row-${partialHigh.id}`,
      `library-row-${ongoingHighEp.id}`,
      `library-row-${zeroTotal.id}`,
      `library-row-${notStarted.id}`,
    ]);
  });
});


describe('v1.2.0 RuntimeWebViewBridge hybrid mode', () => {
  it('promotes visible Sessão UniTV modal on /captcha and resolves verifySession/testConnection without leaking credentials once portal route loads', async () => {
    const controller = new RuntimeWebViewBridgeController();
    const { UNSAFE_getByType, getByTestId, queryByTestId } = render(
      React.createElement(RuntimeWebViewBridgeHost, { controller })
    );

    const verifyPromise = controller.verifySession('https://www.unitvwebs.com', {
      username: 'hidden-user',
      password: 'hidden-password',
    });

    await waitFor(() => {
      expect(UNSAFE_getByType(WebView)).toBeTruthy();
    });

    const bridgeWebView = UNSAFE_getByType(WebView);
    expect(bridgeWebView.props.source.uri).toBe('https://www.unitvwebs.com');
    expect(queryByTestId('runtime-bridge-modal')).toBeNull();

    // Simulate landing on /captcha -> promotes modal without unmounting WebView
    act(() => {
      bridgeWebView.props.onLoadEnd({
        nativeEvent: { url: 'https://www.unitvwebs.com/captcha' },
      });
      bridgeWebView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'BRIDGE_AUTH_STATE',
            state: 'CAPTCHA',
            url: 'https://www.unitvwebs.com/captcha',
          }),
        },
      });
    });

    await waitFor(() => {
      expect(getByTestId('runtime-bridge-modal')).toBeTruthy();
    });
    expect(UNSAFE_getByType(WebView)).toBe(bridgeWebView);
    expect(queryByTestId('runtime-bridge-confirm')).toBeTruthy();

    // Simulate user solving CAPTCHA and reaching authenticated catalog route
    act(() => {
      bridgeWebView.props.onNavigationStateChange?.({
        url: 'https://www.unitvwebs.com/vod/uvweb_free/84911',
      });
      bridgeWebView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'BRIDGE_AUTH_STATE',
            state: 'AUTHENTICATED',
            url: 'https://www.unitvwebs.com/vod/uvweb_free/84911',
          }),
        },
      });
    });

    await expect(verifyPromise).resolves.toEqual({ ok: true });
    await waitFor(() => {
      expect(queryByTestId('runtime-bridge-modal')).toBeNull();
    });
  });

  it('settles interactive /captcha and searchVod cleanly with USER_CANCELLED when Cancelar is pressed', async () => {
    const controller = new RuntimeWebViewBridgeController();
    const { UNSAFE_getByType, getByTestId, queryByTestId } = render(
      React.createElement(RuntimeWebViewBridgeHost, { controller })
    );

    const verifyPromise = controller.verifySession('https://www.unitvwebs.com', null);

    await waitFor(() => {
      expect(UNSAFE_getByType(WebView)).toBeTruthy();
    });

    act(() => {
      UNSAFE_getByType(WebView).props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'BRIDGE_AUTH_STATE',
            state: 'CAPTCHA',
            url: 'https://www.unitvwebs.com/captcha',
          }),
        },
      });
    });

    await waitFor(() => {
      expect(getByTestId('runtime-bridge-cancel')).toBeTruthy();
    });

    fireEvent.press(getByTestId('runtime-bridge-cancel'));

    await expect(verifyPromise).resolves.toEqual({
      errorCode: 'USER_CANCELLED',
    });
    await waitFor(() => {
      expect(queryByTestId('runtime-bridge-modal')).toBeNull();
    });
  });

  it('opens Quasar /search/vod modal when direct links are absent and auto-links upon navigating to /vod/details/...', async () => {
    const controller = new RuntimeWebViewBridgeController();
    const { UNSAFE_getByType, getByTestId, getByText, queryByTestId } = render(
      React.createElement(RuntimeWebViewBridgeHost, { controller })
    );

    const searchPromise = controller.searchVod('https://www.unitvwebs.com', [
      'Naruto',
    ]);

    await waitFor(() => {
      expect(UNSAFE_getByType(WebView)).toBeTruthy();
    });

    const bridgeWebView = UNSAFE_getByType(WebView);
    expect(bridgeWebView.props.source.uri).toBe(
      'https://www.unitvwebs.com/search/vod'
    );

    act(() => {
      bridgeWebView.props.onLoadEnd({
        nativeEvent: { url: 'https://www.unitvwebs.com/search/vod' },
      });
      bridgeWebView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'BRIDGE_SEARCH_NEEDS_SELECTION',
            hasCaptcha: false,
            title: 'UniTV',
          }),
        },
      });
    });

    await waitFor(() => {
      expect(getByTestId('runtime-bridge-modal')).toBeTruthy();
      expect(getByText(/Selecionar na UniTV/i)).toBeTruthy();
    });

    // User taps Naruto card -> navigation enters /vod/details/... with extra query token
    act(() => {
      bridgeWebView.props.onNavigationStateChange?.({
        url: 'https://www.unitvwebs.com/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC?token=secret',
        title: 'Naruto - UniTV',
      });
    });

    await expect(searchPromise).resolves.toEqual({
      vodId: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
      watchPath: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
      title: 'Naruto',
    });
    await waitFor(() => {
      expect(queryByTestId('runtime-bridge-modal')).toBeNull();
    });
  });

  it('settles queued verifySession with USER_CANCELLED on host unmount without dangling callbacks', async () => {
    const controller = new RuntimeWebViewBridgeController();
    const { UNSAFE_getByType, unmount } = render(
      React.createElement(RuntimeWebViewBridgeHost, { controller })
    );

    const verifyPromise = controller.verifySession('https://www.unitvwebs.com', null);

    await waitFor(() => {
      expect(UNSAFE_getByType(WebView)).toBeTruthy();
    });

    unmount();

    await expect(verifyPromise).resolves.toEqual({
      errorCode: 'USER_CANCELLED',
    });
  });
});


describe('v1.2.0 SettingsScreen & AnimeDetailsScreen interactive UniTV flows', () => {
  it('invokes playbackAdapter.testConnection even on first-time empty credentials and renders clear WEBVIEW_ONLY OK copy without credential leaks', async () => {
    const adapterTestConnection = jest.fn(async () => ({
      status: 'WEBVIEW_ONLY' as const,
      reason: 'Conexão OK · Sessão UniTV verificada na WebView.',
    }));

    const services = createMockServices({
      libraryRepository: {
        getSettings: jest.fn(async () => ({
          ...DEFAULT_APP_SETTINGS,
          unitvPortalUrl: 'https://www.unitvwebs.com',
        })),
      },
      credentialsStore: {
        getUniTvCredentials: jest.fn(async () => null),
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(),
        testConnection: adapterTestConnection,
      },
    });

    const { getByTestId, getByText, queryByText } = render(
      <AppServicesProvider value={services}>
        <SettingsScreen />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('settings-portal-url-input').props.value).toBe(
        'https://www.unitvwebs.com'
      );
    });

    fireEvent.press(getByTestId('settings-test-connection-button'));

    await waitFor(() => {
      expect(adapterTestConnection).toHaveBeenCalledWith({
        portalUrl: 'https://www.unitvwebs.com',
        username: '',
        password: '',
      });
    });

    await waitFor(() => {
      expect(
        getByText(/Conexão OK · Sessão UniTV verificada \(WEBVIEW_ONLY\)/)
      ).toBeTruthy();
    });
    expect(queryByText(/Senha incorreta/i)).toBeNull();
  });

  it('allows searching and auto-linking /vod/details/... via webViewBridge from AnimeDetailsScreen modal', async () => {
    const media = makeMedia({
      id: 'anilist:20',
      anilistId: 20,
      titlePt: 'Naruto',
      titleEnglish: 'Naruto',
    });
    const saveUniTvLink = jest.fn(async () => undefined);
    const searchVod = jest.fn(async () => ({
      vodId: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
      watchPath: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
      title: 'Naruto',
    }));

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getSettings: jest.fn(async () => ({
          ...DEFAULT_APP_SETTINGS,
          unitvPortalUrl: 'https://www.unitvwebs.com',
        })),
        getUniTvLink: jest.fn(async () => null),
        saveUniTvLink,
      },
      webViewBridge: { searchVod },
    });

    const { getByTestId, queryByTestId } = render(
      <AppServicesProvider value={services}>
        <AnimeDetailsScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('details-unitv-link-button')).toBeTruthy();
    });

    fireEvent.press(getByTestId('details-unitv-link-button'));

    await waitFor(() => {
      expect(getByTestId('unitv-modal-interactive-search')).toBeTruthy();
    });

    fireEvent.press(getByTestId('unitv-modal-interactive-search'));

    await waitFor(() => {
      expect(searchVod).toHaveBeenCalledWith(
        'https://www.unitvwebs.com',
        expect.arrayContaining(['Naruto'])
      );
      expect(saveUniTvLink).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaItemId: media.id,
          unitvVodId: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
          unitvTitle: 'Naruto',
        })
      );
    });

    await waitFor(() => {
      expect(queryByTestId('unitv-modal-save')).toBeNull();
    });
  });

  it('handles USER_CANCELLED on interactive link search in AnimeDetailsScreen without saving a link', async () => {
    const media = makeMedia({
      id: 'anilist:21',
      anilistId: 21,
      titlePt: 'Bleach',
    });
    const saveUniTvLink = jest.fn(async () => undefined);
    const searchVod = jest.fn(async () => ({
      errorCode: 'USER_CANCELLED' as const,
    }));

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getUniTvLink: jest.fn(async () => null),
        saveUniTvLink,
      },
      webViewBridge: { searchVod },
    });

    const { getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <AnimeDetailsScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('details-unitv-link-button')).toBeTruthy();
    });
    fireEvent.press(getByTestId('details-unitv-link-button'));
    await waitFor(() => {
      expect(getByTestId('unitv-modal-interactive-search')).toBeTruthy();
    });
    fireEvent.press(getByTestId('unitv-modal-interactive-search'));

    await waitFor(() => {
      expect(getByText(/Busca na UniTV cancelada/i)).toBeTruthy();
    });
    expect(saveUniTvLink).not.toHaveBeenCalled();
  });
});


describe('v1.2.0 VideoPlayerScreen unified HUD over #v-player_html5_api', () => {
  it('renders unified HUD over CLEAN_WEBVIEW, controls #v-player_html5_api via injectJavaScript, resumes, clamps invalid telemetry, and persists 85% completion', async () => {
    const media = makeMedia({
      id: 'anilist:701',
      anilistId: 701,
      titlePt: 'Naruto',
      episodesTotal: 24,
    });
    const recordPlaybackProgress = jest.fn(
      async ({ positionSeconds, durationSeconds }) => ({
        episodeCompleted: durationSeconds > 0 && positionSeconds / durationSeconds >= 0.85,
        episodeAutoCompletedNow: false,
        seasonCompletedPrompt: false,
      })
    );

    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getSettings: jest.fn(async () => ({
          ...DEFAULT_APP_SETTINGS,
          unitvPortalUrl: 'https://www.unitvwebs.com',
        })),
        getEpisodeProgressList: jest.fn(async () => [
          {
            id: 'ep-prog-2',
            mediaItemId: media.id,
            episodeNumber: 2,
            positionSeconds: 120,
            durationSeconds: 1450,
            isCompleted: false,
            watchedVia: 'APP_PLAYER' as const,
            updatedAt: '2026-11-16T10:00:00.000Z',
            dirty: 0,
          },
        ]),
        recordPlaybackProgress,
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'CLEAN_WEBVIEW' as const,
          webViewUrl:
            'https://www.unitvwebs.com/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
          matchedTitle: 'Naruto',
          vodId: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
        })),
      },
    });

    const { getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 2 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('video-player-webview')).toBeTruthy();
    });

    const webView = getByTestId('video-player-webview');
    expect(getByTestId('player-webview-complete-button')).toBeTruthy();
    expect(getByText('Concluir Episódio ✓')).toBeTruthy();
    expect(getByTestId('player-play-pause')).toBeTruthy();
    expect(getByTestId('player-seek-back')).toBeTruthy();
    expect(getByTestId('player-seek-forward')).toBeTruthy();
    expect(getByTestId('player-rate-button')).toBeTruthy();
    expect(getByTestId('player-portal-episodes-toggle')).toBeTruthy();

    // Clamp NaN/zero duration telemetry cleanly
    act(() => {
      webView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'WEB_PLAYER_STATE',
            currentTime: Number.NaN,
            duration: 0,
            paused: false,
            ended: false,
            videoHeight: -5,
          }),
        },
      });
    });

    expect(getByText('00:00 / 00:00')).toBeTruthy();

    // Receive real #v-player_html5_api telemetry
    act(() => {
      webView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'WEB_PLAYER_STATE',
            currentTime: 120,
            duration: 1450,
            paused: false,
            ended: false,
            videoHeight: 480,
          }),
        },
      });
    });

    expect(getByText('02:00 / 24:10')).toBeTruthy();
    expect(getByText('480p')).toBeTruthy();

    // Controls update playback & cross 85% completion
    fireEvent.press(getByTestId('player-seek-forward'));
    expect(getByText('02:10 / 24:10')).toBeTruthy();

    fireEvent.press(getByTestId('player-rate-button'));
    expect(getByText('1.25x')).toBeTruthy();

    fireEvent.press(getByTestId('player-play-pause'));
    await waitFor(() => {
      expect(recordPlaybackProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaItemId: media.id,
          episodeNumber: 2,
          positionSeconds: 130,
          durationSeconds: 1450,
        })
      );
    });

    // Cross 85% (1250 / 1450)
    act(() => {
      webView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'WEB_PLAYER_STATE',
            currentTime: 1250,
            duration: 1450,
            paused: false,
            ended: false,
            videoHeight: 480,
          }),
        },
      });
    });

    await waitFor(() => {
      expect(getByText(/Concluído \(85%\+\)/)).toBeTruthy();
    });
  });

  it('ignores cleartext http:// STREAM_CAPTURED URLs on unitvwebs.com so ExoPlayer 22001 never triggers', async () => {
    const media = makeMedia({ id: 'anilist:702', anilistId: 702, titlePt: 'Naruto Cleartext' });
    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getSettings: jest.fn(async () => ({
          ...DEFAULT_APP_SETTINGS,
          unitvPortalUrl: 'https://www.unitvwebs.com',
        })),
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'CLEAN_WEBVIEW' as const,
          webViewUrl:
            'https://www.unitvwebs.com/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
          matchedTitle: 'Naruto Cleartext',
          vodId: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
        })),
      },
    });

    const { getByTestId, queryByTestId } = render(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('video-player-webview')).toBeTruthy();
    });

    act(() => {
      getByTestId('video-player-webview').props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'STREAM_CAPTURED',
            url: 'http://vod-uvweb2.329wu3569v.com/vod/DD74E140F2C04A998534E5F43C562EEC_media.mp4',
            headers: { Referer: 'https://www.unitvwebs.com/' },
          }),
        },
      });
    });

    expect(getByTestId('video-player-webview')).toBeTruthy();
    expect(queryByTestId('video-player-exo')).toBeNull();
  });

  it('steps HUD aside on WEB_PLAYER_INTERACTION_REQUIRED and toggles portal episode list cleanly', async () => {
    const media = makeMedia({ id: 'anilist:703', anilistId: 703, titlePt: 'Naruto Interativo' });
    const services = createMockServices({
      libraryRepository: {
        getMediaItemById: jest.fn(async () => media),
        getSettings: jest.fn(async () => ({
          ...DEFAULT_APP_SETTINGS,
          unitvPortalUrl: 'https://www.unitvwebs.com',
        })),
      },
      playbackAdapter: {
        resolveEpisodePlayback: jest.fn(async () => ({
          mode: 'CLEAN_WEBVIEW' as const,
          webViewUrl:
            'https://www.unitvwebs.com/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
          matchedTitle: 'Naruto Interativo',
          vodId: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC',
        })),
      },
    });

    const { getByTestId, getByText, queryByTestId } = render(
      <AppServicesProvider value={services}>
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('video-player-webview')).toBeTruthy();
    });

    // Portal episodes toggle frees HUD overlay
    fireEvent.press(getByTestId('player-portal-episodes-toggle'));
    expect(queryByTestId('player-play-pause')).toBeNull();
    expect(getByText(/Voltar ao Player/i)).toBeTruthy();

    fireEvent.press(getByTestId('player-portal-episodes-toggle'));
    expect(getByTestId('player-play-pause')).toBeTruthy();

    // Unexpected /captcha mid-playback moves HUD out of the way
    act(() => {
      getByTestId('video-player-webview').props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'WEB_PLAYER_INTERACTION_REQUIRED',
            reason: 'CAPTCHA',
          }),
        },
      });
    });

    expect(queryByTestId('player-play-pause')).toBeNull();
    expect(
      getByText(/Verificação necessária na UniTV/i)
    ).toBeTruthy();

    // Video state restores HUD automatically
    act(() => {
      getByTestId('video-player-webview').props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'WEB_PLAYER_STATE',
            currentTime: 5,
            duration: 1400,
            paused: false,
            ended: false,
            videoHeight: 480,
          }),
        },
      });
    });

    expect(getByTestId('player-play-pause')).toBeTruthy();
  });

  it('displays dedicated Portuguese error copy for CAPTCHA_REQUIRED and USER_CANCELLED without blaming credentials', async () => {
    const media = makeMedia({ id: 'anilist:704', anilistId: 704, titlePt: 'Anime Taxonomia' });

    const captchaView = render(
      <AppServicesProvider
        value={createMockServices({
          libraryRepository: { getMediaItemById: jest.fn(async () => media) },
          playbackAdapter: {
            resolveEpisodePlayback: jest.fn(async () => ({
              mode: 'CLEAN_WEBVIEW' as const,
              errorCode: 'CAPTCHA_REQUIRED' as const,
            })),
          },
        })}
      >
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(captchaView.getByTestId('player-error-state')).toBeTruthy();
    });
    expect(captchaView.getByText(/captcha/i)).toBeTruthy();
    expect(captchaView.queryByText(/Usuário ou senha incorretos/i)).toBeNull();

    const cancelView = render(
      <AppServicesProvider
        value={createMockServices({
          libraryRepository: { getMediaItemById: jest.fn(async () => media) },
          playbackAdapter: {
            resolveEpisodePlayback: jest.fn(async () => ({
              mode: 'CLEAN_WEBVIEW' as const,
              errorCode: 'USER_CANCELLED' as const,
            })),
          },
        })}
      >
        <VideoPlayerScreen
          navigation={{ navigate: jest.fn(), goBack: jest.fn() }}
          route={{ params: { mediaItemId: media.id, episodeNumber: 1 } }}
        />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(cancelView.getByTestId('player-error-state')).toBeTruthy();
    });
    expect(cancelView.getByText(/Ação cancelada|cancelada/i)).toBeTruthy();
    expect(cancelView.queryByText(/Usuário ou senha incorretos/i)).toBeNull();
  });
});


describe('v1.2.0 post-review anchor details path regression', () => {
  it('does not truncate full /vod/details/0/<hash> href paths in generated search injection script', async () => {
    const controller = new RuntimeWebViewBridgeController();
    const { UNSAFE_getByType } = render(
      React.createElement(RuntimeWebViewBridgeHost, { controller })
    );

    const searchPromise = controller.searchVod('https://www.unitvwebs.com', ['Naruto']);
    await waitFor(() => {
      expect(UNSAFE_getByType(WebView)).toBeTruthy();
    });

    const injectSpy = jest.fn();
    controller.handleLoadEnd(1, injectSpy, 'https://www.unitvwebs.com/search/vod', 'UniTV');
    const injectedScript = String(injectSpy.mock.calls[0]?.[0] ?? '');
    expect(injectedScript).toContain('(\\/vod\\/details\\/[^\\s?#]+)');

    act(() => {
      controller.cancelInteractiveModal();
    });
    await searchPromise;
  });
});
