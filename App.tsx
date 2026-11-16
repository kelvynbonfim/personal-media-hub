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
import { CredentialsStore } from './src/playback/credentials-store';
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

async function bootstrapServices(): Promise<AppServices> {
  const sqliteDb = await openDatabaseAsync(DATABASE_NAME);
  const db = createExpoSqliteAdapter(sqliteDb);
  await initializeDatabase(db);

  const libraryRepository = new LibraryRepository(db);
  const backupService = new BackupService(db);
  const catalogService = new CatalogService(libraryRepository);
  const credentialsStore = new CredentialsStore();

  return {
    db,
    libraryRepository,
    backupService,
    catalogService,
    credentialsStore,
  };
}

export function App({ services: injectedServices, screens }: AppProps): React.JSX.Element {
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

    bootstrapServices()
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
  }, [injectedServices, attempt]);

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle="light-content"
        backgroundColor={THEME_TOKENS.bg.canvas}
      />
      {state.status === 'ready' ? (
        <AppServicesProvider value={state.services}>
          <RootNavigator screens={screens} />
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
