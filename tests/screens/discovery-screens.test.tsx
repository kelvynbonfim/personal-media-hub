import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { CatalogService, UpcomingSeasonEntry, WeeklyScheduleEntry } from '../../src/catalog/catalog-service';
import { LibraryRepository } from '../../src/db/library-repository';
import {
  AppSettingsRecord,
  DEFAULT_APP_SETTINGS,
  EpisodeProgressRecord,
  LibraryEntryRecord,
  MediaItemRecord,
  WATCH_STATUSES,
} from '../../src/db/schema';
import { AppServices, AppServicesProvider } from '../../src/navigation/AppServicesContext';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { HomeScreen } from '../../src/screens/HomeScreen';
import { ExploreScreen } from '../../src/screens/ExploreScreen';
import { CalendarScreen } from '../../src/screens/CalendarScreen';
import { STATUS_META, THEME_TOKENS } from '../../src/theme/tokens';

function makeMedia(overrides: Partial<MediaItemRecord> = {}): MediaItemRecord {
  const anilistId = overrides.anilistId ?? 154587;
  return {
    id: overrides.id ?? `anilist:${anilistId}`,
    mediaType: 'ANIME',
    anilistId,
    malId: overrides.malId ?? null,
    tmdbId: overrides.tmdbId ?? null,
    titleRomaji: overrides.titleRomaji ?? `Anime ${anilistId}`,
    titleEnglish: overrides.titleEnglish !== undefined ? overrides.titleEnglish : `Anime ${anilistId}`,
    titlePt: overrides.titlePt !== undefined ? overrides.titlePt : null,
    synopsis:
      overrides.synopsis !== undefined
        ? overrides.synopsis
        : 'Sinopse de teste para catálogo de animes.',
    coverUrl: overrides.coverUrl ?? `https://img.example.com/${anilistId}.jpg`,
    bannerUrl:
      overrides.bannerUrl !== undefined
        ? overrides.bannerUrl
        : `https://img.example.com/${anilistId}-banner.jpg`,
    genresJson: overrides.genresJson ?? JSON.stringify(['Action', 'Fantasy']),
    seasonYear: overrides.seasonYear !== undefined ? overrides.seasonYear : 2025,
    seasonName: overrides.seasonName !== undefined ? overrides.seasonName : 'FALL',
    episodesTotal: overrides.episodesTotal !== undefined ? overrides.episodesTotal : 12,
    statusAiring: overrides.statusAiring ?? 'RELEASING',
    nextAiringAt: overrides.nextAiringAt !== undefined ? overrides.nextAiringAt : null,
    nextAiringEp: overrides.nextAiringEp !== undefined ? overrides.nextAiringEp : null,
    relationsJson: overrides.relationsJson ?? '[]',
    cachedAt: overrides.cachedAt ?? '2026-11-16T10:00:00.000Z',
  };
}

function makeLibraryEntry(
  mediaItemId: string,
  overrides: Partial<LibraryEntryRecord> = {}
): LibraryEntryRecord {
  return {
    id: overrides.id ?? `entry-${mediaItemId}`,
    mediaItemId,
    status: overrides.status ?? 'WATCHING',
    personalScore: overrides.personalScore ?? null,
    currentEpisode: overrides.currentEpisode ?? 0,
    notes: overrides.notes ?? '',
    rewatchCount: overrides.rewatchCount ?? 0,
    startedAt: overrides.startedAt ?? '2026-11-01T10:00:00.000Z',
    completedAt: overrides.completedAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-11-16T10:00:00.000Z',
    dirty: overrides.dirty ?? 1,
  };
}

function makeEpisodeProgress(
  mediaItemId: string,
  episodeNumber: number,
  overrides: Partial<EpisodeProgressRecord> = {}
): EpisodeProgressRecord {
  return {
    id: overrides.id ?? `ep-${mediaItemId}-${episodeNumber}`,
    mediaItemId,
    episodeNumber,
    positionSeconds: overrides.positionSeconds ?? 600,
    durationSeconds: overrides.durationSeconds ?? 1440,
    isCompleted: overrides.isCompleted ?? false,
    watchedVia: overrides.watchedVia ?? 'APP_PLAYER',
    updatedAt: overrides.updatedAt ?? '2026-11-16T10:00:00.000Z',
    dirty: overrides.dirty ?? 1,
  };
}

function createMockServices(overrides: {
  catalogService?: Partial<CatalogService>;
  libraryRepository?: Partial<LibraryRepository>;
} = {}): AppServices {
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
    ...overrides.catalogService,
  } as unknown as CatalogService;

  const libraryRepository = {
    upsertMediaItem: jest.fn(async () => undefined),
    getAllLibraryEntries: jest.fn(async () => []),
    getLibraryByStatus: jest.fn(async () => []),
    getAllEpisodeProgress: jest.fn(async () => []),
    getSettings: jest.fn(async (): Promise<AppSettingsRecord> => ({ ...DEFAULT_APP_SETTINGS })),
    setLibraryStatus: jest.fn(async (mediaItemId: string, status: LibraryEntryRecord['status']) =>
      makeLibraryEntry(mediaItemId, { status })
    ),
    ...overrides.libraryRepository,
  } as unknown as LibraryRepository;

  return {
    db: {} as AppServices['db'],
    libraryRepository,
    backupService: {} as AppServices['backupService'],
    catalogService,
    credentialsStore: {} as AppServices['credentialsStore'],
  };
}

describe('HomeScreen', () => {
  it('renders Hero resume CTA, Continuar Assistindo rail with remaining minutes, Top 10, Current Season, Weekly Upcoming, and navigates cleanly', async () => {
    const frieren = makeMedia({
      id: 'anilist:154587',
      anilistId: 154587,
      titlePt: 'Frieren e a Jornada para o Além',
      episodesTotal: 28,
      statusAiring: 'FINISHED',
    });
    const soloLeveling = makeMedia({
      id: 'anilist:151807',
      anilistId: 151807,
      titlePt: 'Solo Leveling',
      episodesTotal: 12,
    });
    const dandadan = makeMedia({
      id: 'anilist:171018',
      anilistId: 171018,
      titlePt: 'Dandadan',
      episodesTotal: 12,
      statusAiring: 'RELEASING',
    });

    const watchingEntry = makeLibraryEntry(frieren.id, {
      status: 'WATCHING',
      currentEpisode: 4,
    });
    const progressEp5 = makeEpisodeProgress(frieren.id, 5, {
      positionSeconds: 600,
      durationSeconds: 1440, // 840s remaining => 14 min restantes
      isCompleted: false,
    });

    const mondayUnix = Math.floor(new Date(2026, 10, 16, 19, 30, 0).getTime() / 1000);

    const services = createMockServices({
      libraryRepository: {
        getAllLibraryEntries: jest.fn(async () => [watchingEntry]),
        getLibraryByStatus: jest.fn(async (status) =>
          status === 'WATCHING' ? [{ ...watchingEntry, media: frieren }] : []
        ),
        getAllEpisodeProgress: jest.fn(async () => [progressEp5]),
      },
      catalogService: {
        getHomeFeed: jest.fn(async () => ({
          hero: frieren,
          trendingMonth: [soloLeveling, dandadan, frieren],
          currentSeason: [dandadan],
        })),
        getWeeklySchedule: jest.fn(async () => ({
          0: [],
          1: [
            {
              media: dandadan,
              episodeNumber: 8,
              airingAtUnix: mondayUnix,
              weekdayIndex: 1,
              inUserActiveList: true,
            },
          ],
          2: [],
          3: [],
          4: [],
          5: [],
          6: [],
        })),
      },
    });

    const navigate = jest.fn();
    const { getByText, getByTestId, getAllByText } = render(
      <AppServicesProvider value={services}>
        <HomeScreen navigation={{ navigate }} />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByText('Continuar Assistindo')).toBeTruthy();
    });

    // Hero CTA & sections
    expect(getByText('▶ Continuar Ep. 5')).toBeTruthy();
    expect(getByText('Mais Assistidos no Mês')).toBeTruthy();
    expect(getByText('Temporada Atual')).toBeTruthy();
    expect(getByText('Próximos Episódios da Semana')).toBeTruthy();

    // Continuar Assistindo details: episode, remaining minutes, mint progress bar
    expect(getByText('Ep. 5')).toBeTruthy();
    expect(getByText('14 min restantes')).toBeTruthy();
    const progressBarFill = getByTestId(`continue-progress-fill-${frieren.id}`);
    expect(progressBarFill.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backgroundColor: THEME_TOKENS.accent.primary,
          width: '42%',
        }),
      ])
    );

    // Top 10 rank badges & Weekly Upcoming active list indicator
    expect(getByText('#1')).toBeTruthy();
    expect(getByText('#2')).toBeTruthy();
    expect(getByText('Na sua lista')).toBeTruthy();
    expect(getAllByText('Solo Leveling').length).toBeGreaterThan(0);

    // Navigation: Hero CTA -> VideoPlayer
    fireEvent.press(getByTestId('home-hero-cta'));
    expect(navigate).toHaveBeenCalledWith('VideoPlayer', {
      mediaItemId: frieren.id,
      episodeNumber: 5,
    });

    // Navigation: Continuar Assistindo card -> VideoPlayer
    fireEvent.press(getByTestId(`continue-card-${frieren.id}`));
    expect(navigate).toHaveBeenCalledWith('VideoPlayer', {
      mediaItemId: frieren.id,
      episodeNumber: 5,
    });

    // Navigation: Trending card -> AnimeDetails
    fireEvent.press(getByTestId(`trending-card-${soloLeveling.id}`));
    expect(navigate).toHaveBeenCalledWith('AnimeDetails', {
      anilistId: soloLeveling.anilistId,
      mediaItemId: soloLeveling.id,
    });

    // Navigation: Settings gear button -> Settings
    fireEvent.press(getByTestId('home-settings-button'));
    expect(navigate).toHaveBeenCalledWith('Settings');
  });

  it('shows "+ Adicionar à Lista" on #1 Trending Hero when user has no active watching anime and persists PLAN_TO_WATCH on press', async () => {
    const trendingOne = makeMedia({
      id: 'anilist:2001',
      anilistId: 2001,
      titlePt: 'Anime Número Um',
    });

    const setLibraryStatus = jest.fn(async (mediaItemId: string, status: LibraryEntryRecord['status']) =>
      makeLibraryEntry(mediaItemId, { status })
    );

    const services = createMockServices({
      libraryRepository: {
        setLibraryStatus,
      },
      catalogService: {
        getHomeFeed: jest.fn(async () => ({
          hero: trendingOne,
          trendingMonth: [trendingOne],
          currentSeason: [],
        })),
      },
    });

    const { getByText, getByTestId } = render(
      <HomeScreen services={services} navigation={{ navigate: jest.fn() }} />
    );

    await waitFor(() => {
      expect(getByText('+ Adicionar à Lista')).toBeTruthy();
    });
    expect(getByText('#1 Em Alta no Mês')).toBeTruthy();

    fireEvent.press(getByTestId('home-hero-cta'));

    await waitFor(() => {
      expect(setLibraryStatus).toHaveBeenCalledWith(trendingOne.id, 'PLAN_TO_WATCH');
    });
    await waitFor(() => {
      expect(getByText(STATUS_META.PLAN_TO_WATCH.label)).toBeTruthy();
    });
  });

  it('handles errors gracefully and retries loading when "Tentar novamente" is pressed', async () => {
    const frieren = makeMedia({ id: 'anilist:154587', anilistId: 154587, titlePt: 'Frieren' });
    const getHomeFeed = jest
      .fn()
      .mockRejectedValueOnce(new Error('Rede indisponível'))
      .mockResolvedValueOnce({
        hero: frieren,
        trendingMonth: [frieren],
        currentSeason: [],
      });

    const services = createMockServices({
      catalogService: { getHomeFeed },
    });

    const { getByText } = render(
      <HomeScreen services={services} navigation={{ navigate: jest.fn() }} />
    );

    await waitFor(() => {
      expect(getByText('Tentar novamente')).toBeTruthy();
    });

    fireEvent.press(getByText('Tentar novamente'));

    await waitFor(() => {
      expect(getByText('Mais Assistidos no Mês')).toBeTruthy();
    });
    expect(getHomeFeed).toHaveBeenCalledTimes(2);
  });
});

describe('ExploreScreen', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('debounces search input by exactly 350 ms using fake timers', async () => {
    const frieren = makeMedia({
      id: 'anilist:154587',
      anilistId: 154587,
      titlePt: 'Frieren e a Jornada para o Além',
    });

    const exploreCatalog = jest.fn(async () => [frieren]);
    const services = createMockServices({
      catalogService: { exploreCatalog },
    });

    const { getByTestId } = render(
      <ExploreScreen services={services} navigation={{ navigate: jest.fn() }} />
    );

    await waitFor(() => {
      expect(exploreCatalog).toHaveBeenCalledTimes(1);
    });

    jest.useFakeTimers();

    const searchInput = getByTestId('explore-search-input');

    fireEvent.changeText(searchInput, 'F');
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(exploreCatalog).toHaveBeenCalledTimes(1);

    fireEvent.changeText(searchInput, 'Fr');
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(exploreCatalog).toHaveBeenCalledTimes(1);

    fireEvent.changeText(searchInput, 'Frieren');
    act(() => {
      jest.advanceTimersByTime(349);
    });
    expect(exploreCatalog).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
    });

    expect(exploreCatalog).toHaveBeenCalledTimes(2);
    expect(exploreCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: 'Frieren',
      }),
      expect.any(Set)
    );
  });

  it('clears pending 350 ms search debounce timer on unmount without firing stale queries', async () => {
    const exploreCatalog = jest.fn(async () => []);
    const services = createMockServices({
      catalogService: { exploreCatalog },
    });

    const { getByTestId, unmount } = render(
      <ExploreScreen services={services} navigation={{ navigate: jest.fn() }} />
    );

    await waitFor(() => {
      expect(exploreCatalog).toHaveBeenCalledTimes(1);
    });

    jest.useFakeTimers();
    fireEvent.changeText(getByTestId('explore-search-input'), 'Dandadan');
    unmount();

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(exploreCatalog).toHaveBeenCalledTimes(1);
  });

  it('applies multi-genre, sort, format, year/season filters and toggles "Ocultar já concluídos"', async () => {
    const completedItem = makeMedia({
      id: 'anilist:101',
      anilistId: 101,
      titlePt: 'Anime Concluído',
    });
    const pendingItem = makeMedia({
      id: 'anilist:102',
      anilistId: 102,
      titlePt: 'Anime Pendente',
    });

    const exploreCatalog = jest.fn(async (filter, completedIds: Set<string>) => {
      const items = [completedItem, pendingItem];
      return filter.hideCompleted
        ? items.filter((item) => !completedIds.has(item.id))
        : items;
    });

    const services = createMockServices({
      libraryRepository: {
        getAllLibraryEntries: jest.fn(async () => [
          makeLibraryEntry(completedItem.id, { status: 'COMPLETED' }),
        ]),
      },
      catalogService: { exploreCatalog },
    });

    const { getByTestId, getByText, queryByText } = render(
      <ExploreScreen services={services} navigation={{ navigate: jest.fn() }} />
    );

    await waitFor(() => {
      expect(getByText('Anime Concluído')).toBeTruthy();
      expect(getByText('Anime Pendente')).toBeTruthy();
    });

    // Multi-select genres
    fireEvent.press(getByTestId('genre-chip-Action'));
    fireEvent.press(getByTestId('genre-chip-Fantasy'));

    // Sort, Format, Season
    fireEvent.press(getByTestId('sort-chip-SCORE'));
    fireEvent.press(getByTestId('format-chip-MOVIE'));
    fireEvent.press(getByTestId('season-chip-FALL'));

    // Toggle "Ocultar já concluídos"
    fireEvent(getByTestId('explore-hide-completed-switch'), 'valueChange', true);

    await waitFor(() => {
      expect(exploreCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({
          genres: ['Action', 'Fantasy'],
          sort: 'SCORE',
          format: 'MOVIE',
          seasonName: 'FALL',
          hideCompleted: true,
        }),
        expect.any(Set)
      );
    });

    const lastCompletedSet = exploreCatalog.mock.calls.at(-1)?.[1] as Set<string>;
    expect(lastCompletedSet.has(completedItem.id)).toBe(true);

    await waitFor(() => {
      expect(queryByText('Anime Concluído')).toBeNull();
      expect(getByText('Anime Pendente')).toBeTruthy();
    });
  });

  it('opens quick 6-status action sheet on card long-press and persists status without leaving screen', async () => {
    const spyFamily = makeMedia({
      id: 'anilist:140960',
      anilistId: 140960,
      titlePt: 'Spy x Family',
    });

    const setLibraryStatus = jest.fn(async (mediaItemId: string, status: LibraryEntryRecord['status']) =>
      makeLibraryEntry(mediaItemId, { status })
    );

    const services = createMockServices({
      libraryRepository: { setLibraryStatus },
      catalogService: {
        exploreCatalog: jest.fn(async () => [spyFamily]),
      },
    });

    const navigate = jest.fn();
    const { getByTestId, getByText, queryByTestId } = render(
      <ExploreScreen services={services} navigation={{ navigate }} />
    );

    await waitFor(() => {
      expect(getByText('Spy x Family')).toBeTruthy();
    });

    fireEvent(getByTestId(`explore-card-${spyFamily.id}`), 'longPress');

    await waitFor(() => {
      expect(getByTestId('explore-status-modal')).toBeTruthy();
    });

    for (const status of WATCH_STATUSES) {
      expect(getByText(STATUS_META[status].label)).toBeTruthy();
    }

    fireEvent.press(getByTestId('status-option-WATCHING'));

    await waitFor(() => {
      expect(setLibraryStatus).toHaveBeenCalledWith(spyFamily.id, 'WATCHING');
    });

    await waitFor(() => {
      expect(queryByTestId('explore-status-modal')).toBeNull();
      expect(getByText(STATUS_META.WATCHING.shortLabel)).toBeTruthy();
    });

    // Regular press navigates to AnimeDetails
    fireEvent.press(getByTestId(`explore-card-${spyFamily.id}`));
    expect(navigate).toHaveBeenCalledWith('AnimeDetails', {
      anilistId: spyFamily.anilistId,
      mediaItemId: spyFamily.id,
    });
  });
});

describe('CalendarScreen', () => {
  it('switches Mon-Sun days highlighting active user list in menta and toggles to Upcoming Seasons with coral sequel badge', async () => {
    const mondayActive = makeMedia({
      id: 'anilist:301',
      anilistId: 301,
      titlePt: 'Anime da Segunda na Lista',
    });
    const wednesdayOther = makeMedia({
      id: 'anilist:302',
      anilistId: 302,
      titlePt: 'Anime de Quarta Geral',
    });
    const sequelUpcoming = makeMedia({
      id: 'anilist:401',
      anilistId: 401,
      titlePt: 'Frieren Temporada 2',
      statusAiring: 'NOT_YET_RELEASED',
    });
    const newUpcoming = makeMedia({
      id: 'anilist:402',
      anilistId: 402,
      titlePt: 'Nova Obra Original',
      statusAiring: 'NOT_YET_RELEASED',
    });

    const weeklySchedule: Record<number, WeeklyScheduleEntry[]> = {
      0: [],
      1: [
        {
          media: mondayActive,
          episodeNumber: 7,
          airingAtUnix: Math.floor(new Date(2026, 10, 16, 20, 0, 0).getTime() / 1000),
          weekdayIndex: 1,
          inUserActiveList: true,
        },
      ],
      2: [],
      3: [
        {
          media: wednesdayOther,
          episodeNumber: 3,
          airingAtUnix: Math.floor(new Date(2026, 10, 18, 21, 15, 0).getTime() / 1000),
          weekdayIndex: 3,
          inUserActiveList: false,
        },
      ],
      4: [],
      5: [],
      6: [],
    };

    const upcomingRadar: UpcomingSeasonEntry[] = [
      {
        media: sequelUpcoming,
        releaseLabel: 'Janeiro/2027',
        isSequelToLibraryItem: true,
      },
      {
        media: newUpcoming,
        releaseLabel: 'Primavera 2027',
        isSequelToLibraryItem: false,
      },
    ];

    const services = createMockServices({
      libraryRepository: {
        getAllLibraryEntries: jest.fn(async () => [
          makeLibraryEntry(mondayActive.id, { status: 'WATCHING' }),
        ]),
      },
      catalogService: {
        getWeeklySchedule: jest.fn(async () => weeklySchedule),
        getUpcomingSeasonsRadar: jest.fn(async () => upcomingRadar),
      },
    });

    const navigate = jest.fn();
    // 2026-11-16 is a Monday (weekdayIndex === 1)
    const fixedNow = () => new Date(2026, 10, 16, 12, 0, 0);

    const { getByText, getByTestId, getAllByText, queryByText } = render(
      <CalendarScreen services={services} navigation={{ navigate }} nowFn={fixedNow} />
    );

    await waitFor(() => {
      expect(getByText('Anime da Segunda na Lista')).toBeTruthy();
    });

    expect(getByText('Grade da Semana')).toBeTruthy();
    expect(getByText('Próximas Temporadas')).toBeTruthy();
    expect(getByText('Hoje')).toBeTruthy();
    expect(getByText('Na sua lista')).toBeTruthy();
    expect(getByText('Ep. 7')).toBeTruthy();

    // Switch to Wednesday (weekdayIndex 3)
    fireEvent.press(getByTestId('weekday-chip-3'));
    await waitFor(() => {
      expect(getByText('Anime de Quarta Geral')).toBeTruthy();
      expect(queryByText('Anime da Segunda na Lista')).toBeNull();
    });

    // Switch to "Próximas Temporadas"
    fireEvent.press(getByTestId('calendar-mode-upcoming'));
    await waitFor(() => {
      expect(getByText('Frieren Temporada 2')).toBeTruthy();
      expect(getByText('Nova Obra Original')).toBeTruthy();
    });

    expect(getByText('Janeiro/2027')).toBeTruthy();
    expect(getByText('Primavera 2027')).toBeTruthy();
    expect(getAllByText('Nova temporada de algo que você viu!')).toHaveLength(1);

    fireEvent.press(getByTestId(`upcoming-card-${sequelUpcoming.id}`));
    expect(navigate).toHaveBeenCalledWith('AnimeDetails', {
      anilistId: sequelUpcoming.anilistId,
      mediaItemId: sequelUpcoming.id,
    });
  });
});

describe('RootNavigator default Tabs 1-3 integration', () => {
  it('mounts real HomeScreen, ExploreScreen, and CalendarScreen as default tabs when wrapped in AppServicesProvider', async () => {
    const heroItem = makeMedia({
      id: 'anilist:555',
      anilistId: 555,
      titlePt: 'Anime Destaque Integrado',
    });

    const services = createMockServices({
      catalogService: {
        getHomeFeed: jest.fn(async () => ({
          hero: heroItem,
          trendingMonth: [heroItem],
          currentSeason: [heroItem],
        })),
        exploreCatalog: jest.fn(async () => [heroItem]),
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
      },
    });

    const { getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <RootNavigator />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByText('Mais Assistidos no Mês')).toBeTruthy();
    });

    fireEvent.press(getByTestId('tab-explore'));
    await waitFor(() => {
      expect(getByTestId('explore-search-input')).toBeTruthy();
    });

    fireEvent.press(getByTestId('tab-calendar'));
    await waitFor(() => {
      expect(getByTestId('calendar-mode-upcoming')).toBeTruthy();
    });
  });
});
