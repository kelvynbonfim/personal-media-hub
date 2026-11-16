import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
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
  playbackAdapter?: PlaybackSourceAdapter | null;
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
