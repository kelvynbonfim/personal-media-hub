import React from 'react';
import { Linking } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import App from '../../App';
import { CatalogService } from '../../src/catalog/catalog-service';
import { BackupService } from '../../src/db/backup-service';
import { LibraryRepository } from '../../src/db/library-repository';
import { AppSettingsRecord, DEFAULT_APP_SETTINGS } from '../../src/db/schema';
import { AppServices, AppServicesProvider } from '../../src/navigation/AppServicesContext';
import { CredentialsStore } from '../../src/playback/credentials-store';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import {
  AppUpdateInfo,
  checkForAppUpdate,
  compareSemver,
  DEFAULT_APK_DOWNLOAD_URL,
} from '../../src/updates/app-updater';

function createMinimalServices(): AppServices {
  const libraryRepository = {
    getAllLibraryEntries: jest.fn(async () => []),
    getAllMediaItems: jest.fn(async () => []),
    getLibraryByStatus: jest.fn(async () => []),
    getEpisodeProgressList: jest.fn(async () => []),
    getAllEpisodeProgress: jest.fn(async () => []),
    getSettings: jest.fn(async (): Promise<AppSettingsRecord> => ({
      ...DEFAULT_APP_SETTINGS,
    })),
    saveSettings: jest.fn(
      async (patch: Partial<AppSettingsRecord>): Promise<AppSettingsRecord> => ({
        ...DEFAULT_APP_SETTINGS,
        ...patch,
      })
    ),
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
  } as unknown as CatalogService;

  const backupService = {
    exportBackupJson: jest.fn(async () => '{}'),
    importBackupJson: jest.fn(async () => ({
      importedEntries: 0,
      importedProgress: 0,
    })),
  } as unknown as BackupService;

  const credentialsStore = {
    getUniTvCredentials: jest.fn(async () => null),
    saveUniTvCredentials: jest.fn(async () => undefined),
    clearUniTvCredentials: jest.fn(async () => undefined),
  } as unknown as CredentialsStore;

  return {
    db: {} as AppServices['db'],
    libraryRepository,
    backupService,
    catalogService,
    credentialsStore,
    playbackAdapter: null,
    syncEngine: null,
  };
}

describe('In-app Updater & Notification Banner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('compares semantic versions accurately', () => {
    expect(compareSemver('1.2.0', '1.1.0')).toBe(1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('v1.1.0', '1.1.0')).toBe(0);
    expect(compareSemver('1.0.9', '1.1.0')).toBe(-1);
  });

  it('detects newer remote buildNumber or version and safely returns hasUpdate=false when equal or offline', async () => {
    const newerMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        version: '1.2.0',
        buildNumber: 3,
        releaseNotes: 'Novo player ainda mais rápido!',
        downloadUrl: 'https://example.com/app-v1.2.0.apk',
      }),
    }));

    const newerResult = await checkForAppUpdate({
      currentVersion: '1.1.0',
      currentBuildNumber: 2,
      fetchFn: newerMock as unknown as typeof fetch,
    });
    expect(newerResult).toEqual({
      hasUpdate: true,
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      latestBuildNumber: 3,
      releaseNotes: 'Novo player ainda mais rápido!',
      downloadUrl: 'https://example.com/app-v1.2.0.apk',
    });

    const equalMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        version: '1.1.0',
        buildNumber: 2,
        releaseNotes: 'Atual',
      }),
    }));
    const equalResult = await checkForAppUpdate({
      currentVersion: '1.1.0',
      currentBuildNumber: 2,
      fetchFn: equalMock as unknown as typeof fetch,
    });
    expect(equalResult.hasUpdate).toBe(false);
    expect(equalResult.downloadUrl).toBe(DEFAULT_APK_DOWNLOAD_URL);

    const failingMock = jest.fn(async () => {
      throw new Error('Offline');
    });
    const offlineResult = await checkForAppUpdate({
      currentVersion: '1.1.0',
      currentBuildNumber: 2,
      fetchFn: failingMock as unknown as typeof fetch,
    });
    expect(offlineResult.hasUpdate).toBe(false);
  });

  it('displays startup update banner in App when hasUpdate is true, triggers Linking.openURL on download, and dismisses cleanly', async () => {
    const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const services = createMinimalServices();
    const updatePayload: AppUpdateInfo = {
      hasUpdate: true,
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      latestBuildNumber: 3,
      releaseNotes: 'Melhorias de velocidade no catálogo.',
      downloadUrl: 'https://github.com/kelvynbonfim/personal-media-hub/releases/latest/download/app-release.apk',
    };

    const { getByTestId, getByText, queryByTestId } = render(
      <App
        services={services}
        screens={{ HomeTab: () => React.createElement(React.Fragment) }}
        checkUpdateFn={async () => updatePayload}
      />
    );

    await waitFor(() => {
      expect(getByTestId('app-update-banner')).toBeTruthy();
    });
    expect(getByText(/Atualização disponível · v1\.2\.0/)).toBeTruthy();
    expect(getByText('Melhorias de velocidade no catálogo.')).toBeTruthy();

    fireEvent.press(getByTestId('app-update-download-button'));
    expect(openUrlSpy).toHaveBeenCalledWith(updatePayload.downloadUrl);

    fireEvent.press(getByTestId('app-update-dismiss-button'));
    expect(queryByTestId('app-update-banner')).toBeNull();
  });

  it('allows manual update check and direct APK download inside SettingsScreen', async () => {
    const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const services = createMinimalServices();
    const checkForUpdate = jest.fn(async (): Promise<AppUpdateInfo> => ({
      hasUpdate: true,
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      latestBuildNumber: 3,
      releaseNotes: 'Novo episódio automático.',
      downloadUrl: 'https://github.com/kelvynbonfim/personal-media-hub/releases/latest/download/app-release.apk',
    }));

    const { getByTestId, getByText } = render(
      <AppServicesProvider value={services}>
        <SettingsScreen checkForUpdate={checkForUpdate} />
      </AppServicesProvider>
    );

    await waitFor(() => {
      expect(getByTestId('settings-check-update-button')).toBeTruthy();
    });

    fireEvent.press(getByTestId('settings-check-update-button'));
    await waitFor(() => {
      expect(getByTestId('settings-download-update-button')).toBeTruthy();
      expect(getByText(/Nova versão v1\.2\.0 disponível/i)).toBeTruthy();
    });

    fireEvent.press(getByTestId('settings-download-update-button'));
    expect(openUrlSpy).toHaveBeenCalledWith(
      'https://github.com/kelvynbonfim/personal-media-hub/releases/latest/download/app-release.apk'
    );
  });
});
