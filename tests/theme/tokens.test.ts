import React from 'react';
import { Text, View } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as SQLite from 'expo-sqlite';
import { MediaItemRecord, WATCH_STATUSES, WatchStatus } from '../../src/db/schema';
import { BackupService } from '../../src/db/backup-service';
import { LibraryRepository } from '../../src/db/library-repository';
import { CatalogService } from '../../src/catalog/catalog-service';
import { CredentialsStore } from '../../src/playback/credentials-store';
import { MediaPosterCard } from '../../src/components/MediaPosterCard';
import { useAppServices } from '../../src/navigation/AppServicesContext';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { STATUS_META, THEME_TOKENS } from '../../src/theme/tokens';
import App from '../../App';

function createSampleMediaItem(overrides: Partial<MediaItemRecord> = {}): MediaItemRecord {
  return {
    id: 'anilist:154587',
    mediaType: 'ANIME',
    anilistId: 154587,
    malId: 52991,
    tmdbId: 209867,
    titleRomaji: 'Sousou no Frieren',
    titleEnglish: "Frieren: Beyond Journey's End",
    titlePt: 'Frieren e a Jornada para o Além',
    synopsis: 'A jornada de Frieren após derrotar o Rei Demônio.',
    coverUrl: 'https://img.example.com/frieren.jpg',
    bannerUrl: 'https://img.example.com/frieren-banner.jpg',
    genresJson: JSON.stringify(['Adventure', 'Drama', 'Fantasy']),
    seasonYear: 2023,
    seasonName: 'FALL',
    episodesTotal: 28,
    statusAiring: 'FINISHED',
    nextAiringAt: null,
    nextAiringEp: null,
    relationsJson: '[]',
    cachedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('Design System Tokens ("Ardósia Mineral & Menta Bioluminescente")', () => {
  it('defines exact specification hex palette and layout tokens', () => {
    expect(THEME_TOKENS.bg.canvas).toBe('#080B0C');
    expect(THEME_TOKENS.bg.surface).toBe('#0D1214');
    expect(THEME_TOKENS.bg.card).toBe('#131B1F');
    expect(THEME_TOKENS.border.subtle).toBe('#1E2C30');
    expect(THEME_TOKENS.accent.primary).toBe('#2DD4BF');
    expect(THEME_TOKENS.accent.secondary).toBe('#FB7185');
    expect(THEME_TOKENS.accent.gold).toBe('#FBBF24');
    expect(THEME_TOKENS.text.primary).toBe('#F0FDFA');
    expect(THEME_TOKENS.text.secondary).toBe('#94A3B8');

    expect(THEME_TOKENS.spacing.md).toBeGreaterThan(0);
    expect(THEME_TOKENS.radius.lg).toBeGreaterThan(0);
    expect(THEME_TOKENS.typography.cardTitle.fontSize).toBeGreaterThan(0);
  });

  it('maps all 6 WatchStatus enum values to Portuguese labels and badge styling', () => {
    const expectedLabels: Record<WatchStatus, string> = {
      WATCHING: 'Assistindo',
      PLAN_TO_WATCH: 'Pretendo assistir',
      COMPLETED: 'Concluído',
      PAUSED: 'Pausado',
      DROPPED: 'Dropado',
      REWATCHING: 'Reassistindo',
    };

    expect(Object.keys(STATUS_META).sort()).toEqual([...WATCH_STATUSES].sort());

    for (const status of WATCH_STATUSES) {
      const meta = STATUS_META[status];
      expect(meta.label).toBe(expectedLabels[status]);
      expect(meta.shortLabel.trim().length).toBeGreaterThan(0);
      expect(meta.color.trim().length).toBeGreaterThan(0);
      expect(meta.backgroundColor.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('MediaPosterCard', () => {
  it('prefers titlePt ?? titleEnglish ?? titleRomaji and ignores whitespace-only titles', () => {
    const onPress = jest.fn();

    const ptView = render(
      React.createElement(MediaPosterCard, {
        item: createSampleMediaItem({
          titlePt: 'Título PT',
          titleEnglish: 'English Title',
          titleRomaji: 'Romaji Title',
        }),
        onPress,
      })
    );
    expect(ptView.getByText('Título PT')).toBeTruthy();

    const enView = render(
      React.createElement(MediaPosterCard, {
        item: createSampleMediaItem({
          titlePt: '   ',
          titleEnglish: 'English Title',
          titleRomaji: 'Romaji Title',
        }),
        onPress,
      })
    );
    expect(enView.getByText('English Title')).toBeTruthy();

    const romajiView = render(
      React.createElement(MediaPosterCard, {
        item: createSampleMediaItem({
          titlePt: null,
          titleEnglish: null,
          titleRomaji: 'Romaji Title',
        }),
        onPress,
      })
    );
    expect(romajiView.getByText('Romaji Title')).toBeTruthy();
  });

  it('renders fallback initials when coverUrl is empty, plus optional #rankBadge, progressLabel, status badge, and press handlers', () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const item = createSampleMediaItem({
      coverUrl: '',
      titlePt: 'Solo Leveling',
    });

    const { getByText, getByTestId } = render(
      React.createElement(MediaPosterCard, {
        item,
        status: 'WATCHING',
        progressLabel: 'Ep. 06/28',
        rankBadge: 1,
        onPress,
        onLongPress,
        testID: 'poster-card',
      })
    );

    expect(getByText('SO')).toBeTruthy();
    expect(getByText('#1')).toBeTruthy();
    expect(getByText('Ep. 06/28')).toBeTruthy();
    expect(getByText(STATUS_META.WATCHING.shortLabel)).toBeTruthy();

    const card = getByTestId('poster-card');
    fireEvent.press(card);
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent(card, 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});

describe('RootNavigator & AppServicesContext', () => {
  it('renders the 4 bottom tabs (Início, Catálogo, Calendário, Biblioteca) without runtime warnings', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { getAllByText } = render(React.createElement(RootNavigator));

      expect(getAllByText('Início').length).toBeGreaterThan(0);
      expect(getAllByText('Catálogo').length).toBeGreaterThan(0);
      expect(getAllByText('Calendário').length).toBeGreaterThan(0);
      expect(getAllByText('Biblioteca').length).toBeGreaterThan(0);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('switches across tabs and navigates to AnimeDetails, VideoPlayer, and Settings routes cleanly', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    function InteractiveHome({ navigation }: { navigation: any }) {
      return React.createElement(
        View,
        null,
        React.createElement(Text, {
          testID: 'go-details',
          onPress: () => navigation.navigate('AnimeDetails', { anilistId: 154587, mediaItemId: 'anilist:154587' }),
        }),
        React.createElement(Text, {
          testID: 'go-player',
          onPress: () => navigation.navigate('VideoPlayer', { mediaItemId: 'anilist:154587', episodeNumber: 3 }),
        }),
        React.createElement(Text, {
          testID: 'go-settings',
          onPress: () => navigation.navigate('Settings'),
        })
      );
    }

    function DetailsSpy({ route, navigation }: { route: any; navigation: any }) {
      return React.createElement(
        View,
        null,
        React.createElement(Text, { testID: 'details-route' }, `Details:${route.params.anilistId}`),
        React.createElement(Text, {
          testID: 'details-to-player',
          onPress: () => navigation.navigate('VideoPlayer', { mediaItemId: 'anilist:154587', episodeNumber: 3 }),
        }),
        React.createElement(Text, {
          testID: 'details-back',
          onPress: () => navigation.goBack(),
        })
      );
    }

    function PlayerSpy({ route, navigation }: { route: any; navigation: any }) {
      return React.createElement(
        View,
        null,
        React.createElement(Text, { testID: 'player-route' }, `Player:${route.params.episodeNumber}`),
        React.createElement(Text, {
          testID: 'player-back',
          onPress: () => navigation.goBack(),
        })
      );
    }

    function SettingsSpy() {
      return React.createElement(Text, { testID: 'settings-route' }, 'SettingsScreen');
    }

    try {
      const { getByTestId, getByText } = render(
        React.createElement(RootNavigator, {
          screens: {
            HomeTab: InteractiveHome,
            AnimeDetails: DetailsSpy,
            VideoPlayer: PlayerSpy,
            Settings: SettingsSpy,
          },
        })
      );

      fireEvent.press(getByTestId('tab-explore'));
      expect(getByText('Busca instantânea e filtros avançados de animes.')).toBeTruthy();

      fireEvent.press(getByTestId('tab-calendar'));
      expect(getByText('Grade semanal de lançamentos e radar de próximas temporadas.')).toBeTruthy();

      fireEvent.press(getByTestId('tab-library'));
      expect(getByText('Seus animes organizados nos 6 status de acompanhamento.')).toBeTruthy();

      fireEvent.press(getByTestId('tab-home'));

      fireEvent.press(getByTestId('go-details'));
      expect(getByTestId('details-route').props.children).toBe('Details:154587');

      fireEvent.press(getByTestId('details-to-player'));
      expect(getByTestId('player-route').props.children).toBe('Player:3');

      fireEvent.press(getByTestId('player-back'));
      expect(getByTestId('details-route').props.children).toBe('Details:154587');

      fireEvent.press(getByTestId('details-back'));
      fireEvent.press(getByTestId('go-settings'));
      expect(getByTestId('settings-route').props.children).toBe('SettingsScreen');

      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('throws a clear error when useAppServices is called outside AppServicesProvider', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    function InvalidConsumer() {
      useAppServices();
      return null;
    }

    try {
      expect(() => render(React.createElement(InvalidConsumer))).toThrow(
        'useAppServices must be used inside an AppServicesProvider.'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('initializes SQLite and provides repositories/services via AppServicesContext in App', async () => {
    function ProbeScreen() {
      const services = useAppServices();
      return React.createElement(
        View,
        null,
        React.createElement(
          Text,
          { testID: 'services-ready' },
          services.libraryRepository instanceof LibraryRepository &&
            services.backupService instanceof BackupService &&
            services.catalogService instanceof CatalogService &&
            services.credentialsStore instanceof CredentialsStore
            ? 'services-ok'
            : 'services-invalid'
        )
      );
    }

    const { getByTestId } = render(
      React.createElement(App, { screens: { HomeTab: ProbeScreen } })
    );

    await waitFor(() => {
      expect(getByTestId('services-ready').props.children).toBe('services-ok');
    });

    expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
  });

  it('displays error recovery state when SQLite initialization fails and recovers on retry', async () => {
    const openSpy = SQLite.openDatabaseAsync as jest.Mock;
    openSpy.mockRejectedValueOnce(new Error('SQLite disk busy'));

    function ReadyProbe() {
      const services = useAppServices();
      return React.createElement(Text, { testID: 'recovered-ok' }, services.db ? 'ok' : 'no');
    }

    const { getByText, getByTestId } = render(
      React.createElement(App, { screens: { HomeTab: ReadyProbe } })
    );

    await waitFor(() => {
      expect(getByText('SQLite disk busy')).toBeTruthy();
    });

    fireEvent.press(getByText('Tentar novamente'));

    await waitFor(() => {
      expect(getByTestId('recovered-ok').props.children).toBe('ok');
    });
  });
});
