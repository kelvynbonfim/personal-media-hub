import React from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AppSettingsRecord,
  DEFAULT_APP_SETTINGS,
  DEFAULT_UNITV_PORTAL_URL,
} from '../db/schema';
import { useOptionalAppServices } from '../navigation/AppServicesContext';
import {
  buildPortalUrl,
  classifyProbeOutcome,
  UniTvProbeResult,
} from '../playback/unitv-probe';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';
import {
  AppUpdateInfo,
  checkForAppUpdate,
  CURRENT_APP_VERSION,
  DEFAULT_APK_DOWNLOAD_URL,
} from '../updates/app-updater';
import { BaseDiscoveryScreenProps } from './discovery-helpers';

export interface SettingsScreenProps extends BaseDiscoveryScreenProps {
  testConnection?: (params: {
    portalUrl: string;
    username: string;
    password: string;
  }) => Promise<UniTvProbeResult>;
  syncUserId?: string;
  checkForUpdate?: () => Promise<AppUpdateInfo>;
}

interface ProbeTestableAdapter {
  testConnection?: (params: {
    portalUrl: string;
    username: string;
    password: string;
  }) => Promise<UniTvProbeResult>;
}

function formatProbeFeedback(result: UniTvProbeResult): {
  headline: string;
  detail?: string;
  isError: boolean;
} {
  if (result.status === 'STREAM_READY') {
    return {
      headline: 'Conexão OK · Player 1080p pronto (STREAM_READY)',
      detail: result.streamUrl,
      isError: false,
    };
  }
  if (result.status === 'WEBVIEW_ONLY') {
    return {
      headline: 'Conexão OK · Sessão UniTV verificada (WEBVIEW_ONLY)',
      detail: result.reason,
      isError: false,
    };
  }
  return {
    headline: 'Conexão bloqueada ou falha de login (BLOCKED)',
    detail: result.reason,
    isError: true,
  };
}

export function SettingsScreen(
  props: SettingsScreenProps = {}
): React.JSX.Element {
  const {
    services: injectedServices,
    testConnection: injectedTestConnection,
    syncUserId: initialSyncUserId,
    checkForUpdate: injectedCheckForUpdate,
  } = props;
  const contextServices = useOptionalAppServices();

  const libraryRepository =
    injectedServices?.libraryRepository ??
    contextServices?.libraryRepository ??
    null;
  const credentialsStore =
    injectedServices?.credentialsStore ??
    contextServices?.credentialsStore ??
    null;
  const backupService =
    injectedServices?.backupService ?? contextServices?.backupService ?? null;
  const syncEngine =
    injectedServices?.syncEngine ?? contextServices?.syncEngine ?? null;
  const playbackAdapter =
    injectedServices?.playbackAdapter ?? contextServices?.playbackAdapter ?? null;

  const servicesReady = Boolean(libraryRepository);

  const [loading, setLoading] = React.useState<boolean>(servicesReady);
  const [portalUrlInput, setPortalUrlInput] = React.useState<string>(
    DEFAULT_UNITV_PORTAL_URL
  );
  const [usernameInput, setUsernameInput] = React.useState<string>('');
  const [passwordInput, setPasswordInput] = React.useState<string>('');
  const [preferMaxQuality, setPreferMaxQuality] = React.useState<boolean>(true);
  const [hideCompletedInExplore, setHideCompletedInExplore] =
    React.useState<boolean>(false);
  const [tmdbKeyInput, setTmdbKeyInput] = React.useState<string>('');
  const [savedTmdbKey, setSavedTmdbKey] = React.useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = React.useState<string | null>(null);
  const [dirtyCount, setDirtyCount] = React.useState<number>(0);
  const [syncUserIdInput, setSyncUserIdInput] = React.useState<string>(
    initialSyncUserId ?? 'local-user'
  );

  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [probeResult, setProbeResult] = React.useState<UniTvProbeResult | null>(
    null
  );
  const [probing, setProbing] = React.useState<boolean>(false);
  const [syncing, setSyncing] = React.useState<boolean>(false);
  const [syncFeedback, setSyncFeedback] = React.useState<string | null>(null);
  const [backupJsonText, setBackupJsonText] = React.useState<string>('');
  const [backupFeedback, setBackupFeedback] = React.useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = React.useState<boolean>(false);
  const [updateCheckResult, setUpdateCheckResult] =
    React.useState<AppUpdateInfo | null>(null);
  const [updateFeedback, setUpdateFeedback] = React.useState<string | null>(null);

  const isMountedRef = React.useRef<boolean>(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const applyLoadedSettings = React.useCallback((settings: AppSettingsRecord) => {
    setPortalUrlInput(settings.unitvPortalUrl);
    setPreferMaxQuality(settings.preferMaxQuality);
    setHideCompletedInExplore(settings.hideCompletedInExplore);
    setTmdbKeyInput(settings.tmdbApiKey ?? '');
    setSavedTmdbKey(settings.tmdbApiKey);
    setLastSyncAt(settings.lastSyncAt);
  }, []);

  React.useEffect(() => {
    if (!libraryRepository) {
      return undefined;
    }

    let cancelled = false;
    setLoading(true);

    const bootstrap = async () => {
      try {
        const [settings, credentials, pendingDirty] = await Promise.all([
          typeof libraryRepository.getSettings === 'function'
            ? libraryRepository.getSettings()
            : Promise.resolve({ ...DEFAULT_APP_SETTINGS }),
          credentialsStore &&
          typeof credentialsStore.getUniTvCredentials === 'function'
            ? credentialsStore.getUniTvCredentials().catch(() => null)
            : Promise.resolve(null),
          syncEngine && typeof syncEngine.getDirtyCount === 'function'
            ? syncEngine.getDirtyCount().catch(() => 0)
            : Promise.resolve(0),
        ]);

        if (cancelled || !isMountedRef.current) {
          return;
        }

        applyLoadedSettings(settings);
        if (credentials) {
          setUsernameInput(credentials.username);
          setPasswordInput(credentials.password);
        }
        setDirtyCount(pendingDirty);
      } catch (error) {
        if (!cancelled && isMountedRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Falha ao carregar configurações.'
          );
        }
      } finally {
        if (!cancelled && isMountedRef.current) {
          setLoading(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [applyLoadedSettings, credentialsStore, libraryRepository, syncEngine]);

  const handleSaveUniTv = React.useCallback(async (): Promise<void> => {
    if (!libraryRepository) {
      return;
    }
    setErrorMessage(null);
    setStatusMessage(null);

    const normalizedUrl = portalUrlInput.trim();
    if (!normalizedUrl) {
      setErrorMessage('A URL do portal UniTV não pode ficar vazia.');
      return;
    }

    const trimmedUser = usernameInput.trim();
    const hasUsername = trimmedUser.length > 0;
    const hasPassword = passwordInput.trim().length > 0;
    if (hasUsername !== hasPassword) {
      setErrorMessage(
        'Informe usuário e senha completos ou deixe ambos em branco.'
      );
      return;
    }

    try {
      const updated = await libraryRepository.saveSettings({
        unitvPortalUrl: normalizedUrl,
      });

      if (hasUsername && hasPassword && credentialsStore) {
        await credentialsStore.saveUniTvCredentials({
          username: trimmedUser,
          password: passwordInput,
        });
      }

      if (!isMountedRef.current) {
        return;
      }
      applyLoadedSettings(updated);
      setStatusMessage('Configurações UniTV salvas com segurança.');
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Falha ao salvar configurações UniTV.'
        );
      }
    }
  }, [
    applyLoadedSettings,
    credentialsStore,
    libraryRepository,
    passwordInput,
    portalUrlInput,
    usernameInput,
  ]);

  const handleClearCredentials = React.useCallback(async (): Promise<void> => {
    if (!credentialsStore) {
      return;
    }
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await credentialsStore.clearUniTvCredentials();
      if (!isMountedRef.current) {
        return;
      }
      setUsernameInput('');
      setPasswordInput('');
      setStatusMessage('Credenciais removidas do armazenamento seguro.');
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Falha ao remover credenciais.'
        );
      }
    }
  }, [credentialsStore]);

  const handleTogglePreference = React.useCallback(
    async (
      patch: Partial<
        Pick<AppSettingsRecord, 'preferMaxQuality' | 'hideCompletedInExplore'>
      >
    ): Promise<void> => {
      if (patch.preferMaxQuality !== undefined) {
        setPreferMaxQuality(patch.preferMaxQuality);
      }
      if (patch.hideCompletedInExplore !== undefined) {
        setHideCompletedInExplore(patch.hideCompletedInExplore);
      }
      if (!libraryRepository) {
        return;
      }
      try {
        await libraryRepository.saveSettings(patch);
      } catch (error) {
        if (isMountedRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Falha ao salvar preferência.'
          );
        }
      }
    },
    [libraryRepository]
  );

  const handleTestConnection = React.useCallback(async (): Promise<void> => {
    if (probing) {
      return;
    }
    setProbing(true);
    setErrorMessage(null);

    try {
      const normalizedUrl = buildPortalUrl(
        portalUrlInput.trim() || DEFAULT_UNITV_PORTAL_URL,
        ''
      );
      const storedCreds =
        !usernameInput.trim() && credentialsStore
          ? await credentialsStore.getUniTvCredentials().catch(() => null)
          : null;
      const effectiveUsername = usernameInput.trim() || storedCreds?.username || '';
      const effectivePassword = passwordInput || storedCreds?.password || '';

      let result: UniTvProbeResult;

      if (injectedTestConnection) {
        result = await injectedTestConnection({
          portalUrl: normalizedUrl,
          username: effectiveUsername,
          password: effectivePassword,
        });
      } else if (
        playbackAdapter &&
        typeof (playbackAdapter as ProbeTestableAdapter).testConnection ===
          'function'
      ) {
        result = await (playbackAdapter as ProbeTestableAdapter).testConnection!({
          portalUrl: normalizedUrl,
          username: effectiveUsername,
          password: effectivePassword,
        });
      } else if (!normalizedUrl || !effectiveUsername || !effectivePassword) {
        result = classifyProbeOutcome({
          extractedUrl: null,
          authSucceeded: false,
          pageBlockedByBot: false,
        });
      } else {
        try {
          const response = await fetch(normalizedUrl, { method: 'GET' });
          const bodyText =
            typeof response.text === 'function' ? await response.text() : '';
          const blockedByBot =
            response.status === 403 ||
            response.status === 429 ||
            /captcha|cloudflare|turnstile/i.test(bodyText);
          result = classifyProbeOutcome({
            extractedUrl: null,
            authSucceeded: response.ok && !blockedByBot,
            pageBlockedByBot: blockedByBot,
          });
        } catch {
          result = classifyProbeOutcome({
            extractedUrl: null,
            authSucceeded: false,
            pageBlockedByBot: false,
          });
        }
      }

      if (!isMountedRef.current) {
        return;
      }
      setProbeResult(result);
    } catch (error) {
      if (isMountedRef.current) {
        setProbeResult({
          status: 'BLOCKED',
          reason:
            error instanceof Error
              ? error.message
              : 'Falha ao testar conexão com o portal UniTV.',
        });
      }
    } finally {
      if (isMountedRef.current) {
        setProbing(false);
      }
    }
  }, [
    credentialsStore,
    injectedTestConnection,
    passwordInput,
    playbackAdapter,
    portalUrlInput,
    probing,
    usernameInput,
  ]);

  const handleSyncNow = React.useCallback(async (): Promise<void> => {
    if (!syncEngine || syncing) {
      return;
    }
    const effectiveUserId = syncUserIdInput.trim() || 'local-user';
    setSyncing(true);
    setSyncFeedback(null);
    try {
      const result = await syncEngine.syncNow(effectiveUserId);
      const nextDirty =
        typeof syncEngine.getDirtyCount === 'function'
          ? await syncEngine.getDirtyCount().catch(() => dirtyCount)
          : dirtyCount;

      if (!isMountedRef.current) {
        return;
      }
      setDirtyCount(nextDirty);
      if (result.status === 'SYNCED') {
        const refreshedSettings =
          libraryRepository && typeof libraryRepository.getSettings === 'function'
            ? await libraryRepository.getSettings().catch(() => null)
            : null;
        if (isMountedRef.current && refreshedSettings) {
          setLastSyncAt(refreshedSettings.lastSyncAt);
        }
        setSyncFeedback(
          `Sincronizado: ${result.pushedCount} enviados, ${result.pulledCount} recebidos.`
        );
      } else {
        setSyncFeedback(
          `Sincronização adiada (offline ou Supabase pausado): ${
            result.errorMessage ?? 'tente novamente mais tarde.'
          }`
        );
      }
    } catch (error) {
      if (isMountedRef.current) {
        setSyncFeedback(
          error instanceof Error
            ? error.message
            : 'Erro ao sincronizar com Supabase.'
        );
      }
    } finally {
      if (isMountedRef.current) {
        setSyncing(false);
      }
    }
  }, [dirtyCount, libraryRepository, syncEngine, syncUserIdInput, syncing]);

  const handleExportBackup = React.useCallback(async (): Promise<void> => {
    if (!backupService) {
      return;
    }
    setBackupFeedback(null);
    try {
      const json = await backupService.exportBackupJson();
      if (!isMountedRef.current) {
        return;
      }
      setBackupJsonText(json);
      setBackupFeedback('Backup .json exportado com sucesso.');
    } catch (error) {
      if (isMountedRef.current) {
        setBackupFeedback(
          error instanceof Error ? error.message : 'Falha ao exportar backup.'
        );
      }
    }
  }, [backupService]);

  const handleImportBackup = React.useCallback(async (): Promise<void> => {
    if (!backupService) {
      return;
    }
    setBackupFeedback(null);
    try {
      const summary = await backupService.importBackupJson(backupJsonText);
      const refreshed =
        libraryRepository && typeof libraryRepository.getSettings === 'function'
          ? await libraryRepository.getSettings().catch(() => null)
          : null;
      if (!isMountedRef.current) {
        return;
      }
      if (refreshed) {
        applyLoadedSettings(refreshed);
      }
      setBackupFeedback(
        `Backup importado: ${summary.importedEntries} animes, ${summary.importedProgress} progressos.`
      );
    } catch (error) {
      if (isMountedRef.current) {
        setBackupFeedback(
          error instanceof Error ? error.message : 'JSON de backup inválido.'
        );
      }
    }
  }, [applyLoadedSettings, backupJsonText, backupService, libraryRepository]);

  const handleSaveTmdbKey = React.useCallback(async (): Promise<void> => {
    if (!libraryRepository) {
      return;
    }
    setErrorMessage(null);
    setStatusMessage(null);
    const trimmedKey = tmdbKeyInput.trim();
    try {
      const updated = await libraryRepository.saveSettings({
        tmdbApiKey: trimmedKey.length > 0 ? trimmedKey : null,
      });
      if (!isMountedRef.current) {
        return;
      }
      setSavedTmdbKey(updated.tmdbApiKey);
      setStatusMessage(
        updated.tmdbApiKey
          ? 'Chave TMDB salva. Busca e sinopses em PT-BR ativadas.'
          : 'Chave TMDB removida.'
      );
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(
          error instanceof Error ? error.message : 'Falha ao salvar chave TMDB.'
        );
      }
    }
  }, [libraryRepository, tmdbKeyInput]);

  const handleCheckUpdate = React.useCallback(async (): Promise<void> => {
    if (checkingUpdate) {
      return;
    }
    setCheckingUpdate(true);
    setUpdateFeedback(null);
    try {
      const info = injectedCheckForUpdate
        ? await injectedCheckForUpdate()
        : await checkForAppUpdate();
      if (!isMountedRef.current) {
        return;
      }
      setUpdateCheckResult(info);
      setUpdateFeedback(
        info.hasUpdate
          ? `Nova versão v${info.latestVersion} disponível! ${info.releaseNotes}`
          : `Seu aplicativo já está na versão mais recente (v${info.currentVersion}).`
      );
    } catch {
      if (isMountedRef.current) {
        setUpdateFeedback(
          'Não foi possível verificar atualizações agora. Tente novamente.'
        );
      }
    } finally {
      if (isMountedRef.current) {
        setCheckingUpdate(false);
      }
    }
  }, [checkingUpdate, injectedCheckForUpdate]);

  if (!servicesReady) {
    return (
      <View style={styles.centeredBox}>
        <Text style={styles.sectionTitle}>Configurações</Text>
        <Text style={styles.mutedText}>
          Integração UniTV, sincronização Supabase e backup JSON.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.centeredBox}>
        <ActivityIndicator size="large" color={THEME_TOKENS.accent.primary} />
        <Text style={styles.mutedText}>Carregando configurações...</Text>
      </View>
    );
  }

  const probeBanner = probeResult ? formatProbeFeedback(probeResult) : null;
  const hasTmdbConfigured = Boolean(savedTmdbKey && savedTmdbKey.trim().length > 0);

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {statusMessage ? (
          <View style={styles.successBanner}>
            <Text style={styles.successText}>{statusMessage}</Text>
          </View>
        ) : null}

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Integração UniTV</Text>
          <Text style={styles.mutedText}>
            Suas credenciais ficam criptografadas apenas no Android Keystore
            (expo-secure-store) e nunca são gravadas no SQLite ou na nuvem.
          </Text>

          <Text style={styles.inputLabel}>URL do Web Player UniTV</Text>
          <TextInput
            value={portalUrlInput}
            onChangeText={setPortalUrlInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={DEFAULT_UNITV_PORTAL_URL}
            placeholderTextColor={THEME_TOKENS.text.secondary}
            testID="settings-portal-url-input"
            style={styles.input}
          />

          <Text style={styles.inputLabel}>Usuário ou e-mail UniTV</Text>
          <TextInput
            value={usernameInput}
            onChangeText={setUsernameInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="seu@email.com"
            placeholderTextColor={THEME_TOKENS.text.secondary}
            testID="settings-unitv-username-input"
            style={styles.input}
          />

          <Text style={styles.inputLabel}>Senha UniTV</Text>
          <TextInput
            value={passwordInput}
            onChangeText={setPasswordInput}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="••••••••"
            placeholderTextColor={THEME_TOKENS.text.secondary}
            testID="settings-unitv-password-input"
            style={styles.input}
          />

          <View style={styles.buttonRow}>
            <Pressable
              onPress={() => void handleSaveUniTv()}
              accessibilityRole="button"
              testID="settings-save-unitv-button"
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Salvar UniTV</Text>
            </Pressable>

            <Pressable
              onPress={() => void handleClearCredentials()}
              accessibilityRole="button"
              testID="settings-clear-credentials-button"
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Limpar credenciais</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={() => void handleTestConnection()}
            disabled={probing}
            accessibilityRole="button"
            testID="settings-test-connection-button"
            style={styles.outlineAccentButton}
          >
            <Text style={styles.outlineAccentButtonText}>
              {probing ? 'Testando sessão...' : 'Testar Conexão & Sessão'}
            </Text>
          </Pressable>

          {probeBanner ? (
            <View
              testID="settings-probe-feedback"
              style={[
                styles.probeCard,
                probeBanner.isError ? styles.probeCardError : styles.probeCardOk,
              ]}
            >
              <Text
                style={[
                  styles.probeHeadline,
                  probeBanner.isError
                    ? styles.probeHeadlineError
                    : styles.probeHeadlineOk,
                ]}
              >
                {probeBanner.headline}
              </Text>
              {probeBanner.detail ? (
                <Text style={styles.mutedText}>{probeBanner.detail}</Text>
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Preferências</Text>

          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.switchTitle}>Sempre Máxima / Full HD</Text>
              <Text style={styles.mutedText}>
                Seleciona automaticamente a maior resolução HLS (1080p).
              </Text>
            </View>
            <Switch
              value={preferMaxQuality}
              onValueChange={(value) =>
                void handleTogglePreference({ preferMaxQuality: value })
              }
              testID="settings-prefer-max-quality-switch"
              trackColor={{
                false: THEME_TOKENS.border.subtle,
                true: THEME_TOKENS.accent.primary,
              }}
              thumbColor={THEME_TOKENS.text.primary}
            />
          </View>

          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.switchTitle}>
                Ocultar já concluídos no Catálogo
              </Text>
              <Text style={styles.mutedText}>
                Remove da aba Catálogo os títulos com status Concluído.
              </Text>
            </View>
            <Switch
              value={hideCompletedInExplore}
              onValueChange={(value) =>
                void handleTogglePreference({ hideCompletedInExplore: value })
              }
              testID="settings-hide-completed-switch"
              trackColor={{
                false: THEME_TOKENS.border.subtle,
                true: THEME_TOKENS.accent.primary,
              }}
              thumbColor={THEME_TOKENS.text.primary}
            />
          </View>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Sincronização Supabase Free Tier</Text>
          <Text style={styles.mutedText}>
            {`Última sincronização: ${lastSyncAt ?? 'Nunca sincronizado'} · Pendentes: ${dirtyCount}`}
          </Text>

          <Text style={styles.inputLabel}>ID do Usuário (Auth UID)</Text>
          <TextInput
            value={syncUserIdInput}
            onChangeText={setSyncUserIdInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="uuid-do-usuario-supabase"
            placeholderTextColor={THEME_TOKENS.text.secondary}
            testID="settings-sync-user-id-input"
            style={styles.input}
          />

          <Pressable
            onPress={() => void handleSyncNow()}
            disabled={!syncEngine || syncing}
            accessibilityRole="button"
            testID="settings-sync-now-button"
            style={[
              styles.primaryButton,
              (!syncEngine || syncing) && styles.disabledButton,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {syncEngine
                ? syncing
                  ? 'Sincronizando...'
                  : 'Sincronizar Agora'
                : 'Supabase não configurado (Modo Offline)'}
            </Text>
          </Pressable>

          {syncFeedback ? (
            <Text style={styles.feedbackText}>{syncFeedback}</Text>
          ) : null}
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Backup Local (.json)</Text>
          <Text style={styles.mutedText}>
            Exporte ou restaure sua biblioteca, histórico e vínculos UniTV em JSON
            (sem credenciais).
          </Text>

          <View style={styles.buttonRow}>
            <Pressable
              onPress={() => void handleExportBackup()}
              disabled={!backupService}
              accessibilityRole="button"
              testID="settings-export-backup-button"
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Exportar .json</Text>
            </Pressable>

            <Pressable
              onPress={() => void handleImportBackup()}
              disabled={!backupService}
              accessibilityRole="button"
              testID="settings-import-backup-button"
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Importar .json</Text>
            </Pressable>
          </View>

          <TextInput
            value={backupJsonText}
            onChangeText={setBackupJsonText}
            multiline
            placeholder="Cole ou visualize o payload JSON de backup aqui..."
            placeholderTextColor={THEME_TOKENS.text.secondary}
            testID="settings-backup-json-input"
            style={styles.jsonInput}
          />

          {backupFeedback ? (
            <Text style={styles.feedbackText}>{backupFeedback}</Text>
          ) : null}
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>TMDB Opcional (PT-BR)</Text>
          <Text style={styles.mutedText}>
            Informe uma chave gratuita da API TMDB para traduzir buscas e exibir
            sinopses em português quando ausentes no AniList.
          </Text>

          <TextInput
            value={tmdbKeyInput}
            onChangeText={setTmdbKeyInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Chave TMDB (opcional)"
            placeholderTextColor={THEME_TOKENS.text.secondary}
            testID="settings-tmdb-key-input"
            style={styles.input}
          />

          <Pressable
            onPress={() => void handleSaveTmdbKey()}
            accessibilityRole="button"
            testID="settings-save-tmdb-button"
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Salvar chave TMDB</Text>
          </Pressable>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>
            {`Atualizações do Aplicativo (v${CURRENT_APP_VERSION})`}
          </Text>
          <Text style={styles.mutedText}>
            Sempre que houver melhorias, você recebe um aviso ao abrir o app para
            baixar e atualizar direto pelo celular sem perder seus dados.
          </Text>

          <View style={styles.buttonRow}>
            <Pressable
              onPress={() => void handleCheckUpdate()}
              disabled={checkingUpdate}
              accessibilityRole="button"
              testID="settings-check-update-button"
              style={styles.outlineAccentButton}
            >
              <Text style={styles.outlineAccentButtonText}>
                {checkingUpdate ? 'Verificando...' : 'Verificar Atualização Agora'}
              </Text>
            </Pressable>

            {updateCheckResult?.hasUpdate ? (
              <Pressable
                onPress={() =>
                  void Linking.openURL(
                    updateCheckResult.downloadUrl || DEFAULT_APK_DOWNLOAD_URL
                  )
                }
                accessibilityRole="button"
                testID="settings-download-update-button"
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  Baixar e Instalar Atualização
                </Text>
              </Pressable>
            ) : null}
          </View>

          {updateFeedback ? (
            <Text testID="settings-update-feedback" style={styles.feedbackText}>
              {updateFeedback}
            </Text>
          ) : null}
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Sobre</Text>
          <Text style={styles.mutedText}>
            Personal Media Hub V1 · Tema Ardósia Mineral & Menta Bioluminescente.
          </Text>
          <Text style={styles.mutedText}>
            Metadados gratuitos fornecidos por AniList GraphQL API e Jikan v4.
          </Text>
          {hasTmdbConfigured ? (
            <Text testID="settings-tmdb-attribution" style={styles.tmdbAttribution}>
              This product uses the TMDB API but is not endorsed or certified by TMDB.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: THEME_TOKENS.bg.canvas,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.md,
    paddingBottom: THEME_TOKENS.spacing.xxl,
  },
  centeredBox: {
    flex: 1,
    backgroundColor: THEME_TOKENS.bg.canvas,
    alignItems: 'center',
    justifyContent: 'center',
    padding: THEME_TOKENS.spacing.xl,
    gap: THEME_TOKENS.spacing.sm,
  },
  sectionCard: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.sm,
  },
  sectionTitle: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.primary,
  },
  mutedText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  inputLabel: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
  },
  input: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.sm,
    color: THEME_TOKENS.text.primary,
    ...THEME_TOKENS.typography.body,
  },
  jsonInput: {
    minHeight: 88,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
    color: THEME_TOKENS.text.primary,
    textAlignVertical: 'top',
    ...THEME_TOKENS.typography.caption,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: THEME_TOKENS.spacing.sm,
  },
  primaryButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    alignItems: 'center',
  },
  primaryButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    alignItems: 'center',
  },
  secondaryButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  outlineAccentButton: {
    borderColor: THEME_TOKENS.accent.primary,
    borderWidth: 1,
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    alignItems: 'center',
  },
  outlineAccentButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.accent.primary,
  },
  disabledButton: {
    opacity: 0.5,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.md,
  },
  switchCopy: {
    flex: 1,
    gap: 2,
  },
  switchTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  successBanner: {
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
    borderColor: THEME_TOKENS.accent.primary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
  },
  successText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
  },
  errorBanner: {
    backgroundColor: STATUS_META.DROPPED.backgroundColor,
    borderColor: THEME_TOKENS.accent.secondary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
  },
  errorText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.secondary,
  },
  probeCard: {
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.sm,
    gap: 4,
  },
  probeCardOk: {
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
    borderColor: THEME_TOKENS.accent.primary,
  },
  probeCardError: {
    backgroundColor: STATUS_META.DROPPED.backgroundColor,
    borderColor: THEME_TOKENS.accent.secondary,
  },
  probeHeadline: {
    ...THEME_TOKENS.typography.cardTitle,
  },
  probeHeadlineOk: {
    color: THEME_TOKENS.accent.primary,
  },
  probeHeadlineError: {
    color: THEME_TOKENS.accent.secondary,
  },
  feedbackText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
  },
  tmdbAttribution: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
    marginTop: THEME_TOKENS.spacing.xs,
  },
});
