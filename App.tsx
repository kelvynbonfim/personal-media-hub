import React from 'react';
import {
  ActivityIndicator,
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
import {
  AutoAnimePlaybackAdapter,
  fetchAnimeFirePtMetadata,
} from './src/playback/auto-anime-adapter';
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

const DATABASE_NAME = 'personal-media-hub.db';

export interface AppProps {
  services?: AppServices;
  screens?: Partial<RootNavigatorScreens>;
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
  const catalogService = new CatalogService(libraryRepository, {
    ptBrFallbackFn: fetchAnimeFirePtMetadata,
  });
  const credentialsStore = new CredentialsStore();

  const playbackAdapter = new AutoAnimePlaybackAdapter({
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
    syncEngine,
  };
}

export function App(props: AppProps): React.JSX.Element;
export function App(): React.JSX.Element;
export function App(props: AppProps = {}): React.JSX.Element {
  const { services: injectedServices, screens } = props;
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
});
