import React from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createClient } from '@supabase/supabase-js';
import { openDatabaseAsync } from 'expo-sqlite';
import { CatalogService } from './src/catalog/catalog-service';
import { BackupService } from './src/db/backup-service';
import { LibraryRepository } from './src/db/library-repository';
import { createExpoSqliteAdapter, initializeDatabase } from './src/db/schema';
import {
  AppServices,
  AppServicesProvider,
} from './src/navigation/AppServicesContext';
import {
  RootNavigator,
  RootNavigatorScreens,
} from './src/navigation/RootNavigator';
import { UniTvPlaybackAdapter } from './src/playback/unitv-adapter';
import { CredentialsStore } from './src/playback/credentials-store';
import {
  RuntimeWebViewBridgeController,
  RuntimeWebViewBridgeHost,
} from './src/playback/runtime-webview-bridge';
import {
  createSupabaseSyncClient,
  SupabaseSyncEngine,
} from './src/sync/supabase-sync';
import { THEME_TOKENS } from './src/theme/tokens';
import { AppUpdateInfo, checkForAppUpdate } from './src/updates/app-updater';

const DATABASE_NAME = 'personal-media-hub.db';

export interface AppProps {
  services?: AppServices;
  screens?: Partial<RootNavigatorScreens>;
  checkUpdateFn?: () => Promise<AppUpdateInfo | null>;
}

type BootstrapState =
  | { status: 'loading' }
  | { status: 'ready'; services: AppServices }
  | { status: 'error'; message: string };

function createOptionalSyncEngine(
  db: ReturnType<typeof createExpoSqliteAdapter>
): SupabaseSyncEngine | null {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
    },
  });
  return new SupabaseSyncEngine(db, createSupabaseSyncClient(client));
}

async function bootstrapServices(
  bridgeController: RuntimeWebViewBridgeController
): Promise<AppServices> {
  const sqliteDb = await openDatabaseAsync(DATABASE_NAME);
  const db = createExpoSqliteAdapter(sqliteDb);
  await initializeDatabase(db);

  const libraryRepository = new LibraryRepository(db);
  const backupService = new BackupService(db);
  const catalogService = new CatalogService(libraryRepository);
  const credentialsStore = new CredentialsStore();

  const playbackAdapter = new UniTvPlaybackAdapter({
    bridge: bridgeController,
    credentialsStore,
    repository: libraryRepository,
  });

  const syncEngine = createOptionalSyncEngine(db);

  return {
    db,
    libraryRepository,
    backupService,
    catalogService,
    credentialsStore,
    playbackAdapter,
    webViewBridge: bridgeController,
    syncEngine,
  };
}

export function App(props: AppProps): React.JSX.Element;
export function App(): React.JSX.Element;
export function App(props: AppProps = {}): React.JSX.Element {
  const { services: injectedServices, screens, checkUpdateFn } = props;
  const bridgeController = React.useMemo(
    () => new RuntimeWebViewBridgeController(),
    []
  );
  const [state, setState] = React.useState<BootstrapState>(() =>
    injectedServices
      ? { status: 'ready', services: injectedServices }
      : { status: 'loading' }
  );
  const [attempt, setAttempt] = React.useState(0);
  const [updateInfo, setUpdateInfo] = React.useState<AppUpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = React.useState(false);

  React.useEffect(() => {
    if (injectedServices) {
      setState((prev) =>
        prev.status === 'ready' && prev.services === injectedServices
          ? prev
          : { status: 'ready', services: injectedServices }
      );
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    bootstrapServices(bridgeController)
      .then((services) => {
        if (!cancelled) {
          setState({ status: 'ready', services });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message =
            error instanceof Error && error.message
              ? error.message
              : 'Falha ao inicializar o banco de dados local.';
          setState({ status: 'error', message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bridgeController, injectedServices, attempt]);

  React.useEffect(() => {
    if (state.status !== 'ready') {
      return undefined;
    }
    if (injectedServices && !checkUpdateFn) {
      return undefined;
    }

    let cancelled = false;
    const abortController =
      typeof AbortController !== 'undefined' ? new AbortController() : null;

    const runUpdateCheck = async () => {
      try {
        const result = checkUpdateFn
          ? await checkUpdateFn()
          : await checkForAppUpdate({ signal: abortController?.signal });
        if (!cancelled && result?.hasUpdate) {
          setUpdateInfo(result);
        }
      } catch {
        // Update check failures never interrupt normal app usage.
      }
    };

    void runUpdateCheck();

    return () => {
      cancelled = true;
      abortController?.abort();
    };
  }, [checkUpdateFn, injectedServices, state.status]);

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle="light-content"
        backgroundColor={THEME_TOKENS.bg.canvas}
      />
      {state.status === 'ready' ? (
        <AppServicesProvider value={state.services}>
          <RootNavigator screens={screens} />
          {!injectedServices ? (
            <RuntimeWebViewBridgeHost controller={bridgeController} />
          ) : null}
          {updateInfo?.hasUpdate && !updateDismissed ? (
            <View style={styles.updateOverlay} pointerEvents="box-none">
              <View testID="app-update-banner" style={styles.updateCard}>
                <Text style={styles.updateTitle}>
                  {`🚀 Atualização disponível · v${updateInfo.latestVersion}`}
                </Text>
                {updateInfo.releaseNotes ? (
                  <Text style={styles.updateNotes} numberOfLines={3}>
                    {updateInfo.releaseNotes}
                  </Text>
                ) : null}
                <View style={styles.updateActions}>
                  <Pressable
                    onPress={() => void Linking.openURL(updateInfo.downloadUrl)}
                    accessibilityRole="button"
                    testID="app-update-download-button"
                    style={styles.updatePrimaryButton}
                  >
                    <Text style={styles.updatePrimaryButtonText}>
                      Baixar no Celular
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setUpdateDismissed(true)}
                    accessibilityRole="button"
                    testID="app-update-dismiss-button"
                    style={styles.updateSecondaryButton}
                  >
                    <Text style={styles.updateSecondaryButtonText}>
                      Agora não
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : null}
        </AppServicesProvider>
      ) : state.status === 'error' ? (
        <View style={styles.centeredContainer}>
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Erro ao iniciar o aplicativo</Text>
            <Text style={styles.errorMessage}>{state.message}</Text>
            <Pressable
              onPress={() => setAttempt((prev) => prev + 1)}
              accessibilityRole="button"
              style={styles.retryButton}
            >
              <Text style={styles.retryButtonText}>Tentar novamente</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.centeredContainer}>
          <ActivityIndicator size="large" color={THEME_TOKENS.accent.primary} />
          <Text style={styles.loadingText}>Carregando biblioteca local...</Text>
        </View>
      )}
    </SafeAreaProvider>
  );
}

export default App;

const styles = StyleSheet.create({
  centeredContainer: {
    flex: 1,
    backgroundColor: THEME_TOKENS.bg.canvas,
    alignItems: 'center',
    justifyContent: 'center',
    padding: THEME_TOKENS.spacing.xl,
    gap: THEME_TOKENS.spacing.md,
  },
  loadingText: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.text.secondary,
  },
  errorCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.accent.secondary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.sm,
  },
  errorTitle: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.primary,
  },
  errorMessage: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.text.secondary,
  },
  retryButton: {
    marginTop: THEME_TOKENS.spacing.sm,
    alignSelf: 'flex-start',
    backgroundColor: THEME_TOKENS.accent.primary,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
  },
  retryButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
  },
  updateOverlay: {
    position: 'absolute',
    top: 36,
    left: 16,
    right: 16,
    zIndex: 999,
  },
  updateCard: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.accent.primary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.xs,
    elevation: 8,
  },
  updateTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.accent.primary,
    fontWeight: '700',
  },
  updateNotes: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
  },
  updateActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: THEME_TOKENS.spacing.sm,
    marginTop: THEME_TOKENS.spacing.xs,
  },
  updatePrimaryButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
  },
  updatePrimaryButtonText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  updateSecondaryButton: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
  },
  updateSecondaryButtonText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
});
