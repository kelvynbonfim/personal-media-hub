import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewNavigation, WebViewProps } from 'react-native-webview';

type ShouldStartLoadParam = Parameters<
  NonNullable<WebViewProps['onShouldStartLoadWithRequest']>
>[0];
type WebViewHttpErrorParam = Parameters<
  NonNullable<WebViewProps['onHttpError']>
>[0];
type WebViewErrorParam = Parameters<
  NonNullable<WebViewProps['onError']>
>[0];
type WebViewRenderGoneParam = Parameters<
  NonNullable<WebViewProps['onRenderProcessGone']>
>[0];
import {
  AdObservationValue,
  classifyWebViewNavigationTarget,
  createInitialDiagnosticChecks,
  DiagnosticCheckValue,
  DiagnosticEventKind,
  evaluateDiagnosticConclusion,
  formatSanitizedDiagnosticReport,
  sanitizeDiagnosticUrl,
  UNITV_DIAGNOSTIC_PORTAL_URL,
  UniTvDiagnosticChecks,
  UniTvDiagnosticEvent,
} from '../diagnostics/unitv-diagnostic';
import { BaseDiscoveryScreenProps } from './discovery-helpers';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';

export type UniTvDiagnosticScreenProps = BaseDiscoveryScreenProps;

const MAX_LOG_EVENTS = 40;

interface ChecklistRowMeta {
  key: Exclude<keyof UniTvDiagnosticChecks, 'adOrRedirectObserved'>;
  label: string;
}

const CHECKLIST_ROWS: ReadonlyArray<ChecklistRowMeta> = [
  {
    key: 'portalOpenedAndManualAuth',
    label: '1. Portal abre e sessão/login concluído manualmente',
  },
  {
    key: 'episodeSelectedConfirmed',
    label: '2. Naruto Temp. 1, Episódio 1 confirmado',
  },
  {
    key: 'videoAndAudioActive',
    label: '3. Imagem e áudio ativos',
  },
  {
    key: 'continuous60sPlayback',
    label: '4. Avanço contínuo por ≥ 60 segundos',
  },
  {
    key: 'pauseResumeAndSeekOk',
    label: '5. Pausa, retomada e busca (seek)',
  },
  {
    key: 'stayedInsideApp',
    label: '6. Permaneceu dentro do aplicativo',
  },
];

function formatTimerClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function UniTvDiagnosticScreen(
  props: UniTvDiagnosticScreenProps = {}
): React.JSX.Element {
  const { navigation } = props;
  const insets = useSafeAreaInsets();
  const webViewRef = React.useRef<WebView>(null);
  const eventSeqRef = React.useRef<number>(1);

  const [panelOpen, setPanelOpen] = React.useState<boolean>(false);
  const [webLoading, setWebLoading] = React.useState<boolean>(true);
  const [canGoBack, setCanGoBack] = React.useState<boolean>(false);
  const [currentSanitizedUrl, setCurrentSanitizedUrl] = React.useState<string>(
    UNITV_DIAGNOSTIC_PORTAL_URL
  );
  const [checks, setChecks] = React.useState<UniTvDiagnosticChecks>(() =>
    createInitialDiagnosticChecks()
  );
  const [events, setEvents] = React.useState<UniTvDiagnosticEvent[]>([]);
  const [timerRunning, setTimerRunning] = React.useState<boolean>(false);
  const [elapsedSeconds, setElapsedSeconds] = React.useState<number>(0);

  React.useEffect(() => {
    if (!timerRunning) {
      return undefined;
    }
    const intervalId = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => {
      clearInterval(intervalId);
    };
  }, [timerRunning]);

  const appendEvent = React.useCallback(
    (kind: DiagnosticEventKind, rawUrl: string, detail: string) => {
      const sanitizedUrl = sanitizeDiagnosticUrl(rawUrl);
      const nextEvent: UniTvDiagnosticEvent = {
        id: `diag-evt-${eventSeqRef.current++}`,
        timestampIso: new Date().toISOString(),
        kind,
        sanitizedUrl,
        detail,
      };
      setEvents((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.kind === nextEvent.kind &&
          last.sanitizedUrl === nextEvent.sanitizedUrl &&
          last.detail === nextEvent.detail
        ) {
          return prev;
        }
        return [...prev.slice(-(MAX_LOG_EVENTS - 1)), nextEvent];
      });
    },
    []
  );

  const handleShouldStartLoad = React.useCallback(
    (request: ShouldStartLoadParam): boolean => {
      const target = classifyWebViewNavigationTarget(request.url);
      if (!target.allowInWebView) {
        appendEvent(
          'BLOCKED_SCHEME',
          request.url,
          request.isTopFrame ? 'Esquema externo bloqueado (top-frame)' : 'Esquema externo bloqueado'
        );
        return false;
      }

      if (target.kind === 'EXTERNAL_HOST' && request.isTopFrame) {
        appendEvent(
          'EXTERNAL_HOST',
          request.url,
          `Navegação top-frame fora de unitvwebs.com (${target.host ?? 'externo'})`
        );
      }
      return true;
    },
    [appendEvent]
  );

  const handleNavigationStateChange = React.useCallback(
    (navState: WebViewNavigation) => {
      setWebLoading(Boolean(navState.loading));
      setCanGoBack(Boolean(navState.canGoBack));
      const sanitized = sanitizeDiagnosticUrl(navState.url || UNITV_DIAGNOSTIC_PORTAL_URL);
      setCurrentSanitizedUrl(sanitized);
      if (!navState.loading && navState.url) {
        appendEvent('NAVIGATION', navState.url, 'Página carregada');
      }
    },
    [appendEvent]
  );

  const handleHttpError = React.useCallback(
    (event: WebViewHttpErrorParam) => {
      const { statusCode, description, url } = event.nativeEvent;
      appendEvent(
        'HTTP_ERROR',
        url || currentSanitizedUrl,
        `HTTP ${statusCode}${description ? ` · ${description}` : ''}`
      );
    },
    [appendEvent, currentSanitizedUrl]
  );

  const handleLoadError = React.useCallback(
    (event: WebViewErrorParam) => {
      const { code, description, url } = event.nativeEvent;
      setWebLoading(false);
      appendEvent(
        'LOAD_ERROR',
        url || currentSanitizedUrl,
        `Erro ${code}${description ? ` · ${description}` : ''}`
      );
    },
    [appendEvent, currentSanitizedUrl]
  );

  const handleRenderProcessGone = React.useCallback(
    (event: WebViewRenderGoneParam) => {
      appendEvent(
        'RENDER_CRASH',
        currentSanitizedUrl,
        event.nativeEvent.didCrash
          ? 'Processo de renderização WebView encerrou com crash'
          : 'Processo de renderização WebView encerrado pelo sistema'
      );
    },
    [appendEvent, currentSanitizedUrl]
  );

  const updateCheck = React.useCallback(
    (key: ChecklistRowMeta['key'], value: DiagnosticCheckValue) => {
      setChecks((prev) => ({
        ...prev,
        [key]: prev[key] === value ? null : value,
      }));
    },
    []
  );

  const updateAdObservation = React.useCallback((value: AdObservationValue) => {
    setChecks((prev) => ({
      ...prev,
      adOrRedirectObserved: prev.adOrRedirectObserved === value ? null : value,
    }));
  }, []);

  const handleBackNavigation = React.useCallback(() => {
    const canGoBack = navigation?.canGoBack
      ? navigation.canGoBack()
      : Boolean(navigation?.goBack);
    if (canGoBack && navigation?.goBack) {
      navigation.goBack();
      return;
    }
    navigation?.navigate('MainTabs');
  }, [navigation]);

  const conclusion = evaluateDiagnosticConclusion(checks);
  const errorCount = events.filter(
    (evt) =>
      evt.kind === 'HTTP_ERROR' ||
      evt.kind === 'LOAD_ERROR' ||
      evt.kind === 'RENDER_CRASH' ||
      evt.kind === 'BLOCKED_SCHEME'
  ).length;
  const sanitizedReport = React.useMemo(
    () =>
      formatSanitizedDiagnosticReport({
        checks,
        elapsedSeconds,
        currentSanitizedUrl,
        events,
      }),
    [checks, currentSanitizedUrl, elapsedSeconds, events]
  );

  return (
    <View
      style={[
        styles.screen,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <View style={styles.topBar}>
        <Pressable
          onPress={handleBackNavigation}
          accessibilityRole="button"
          accessibilityLabel="Voltar do diagnóstico"
          testID="diagnostic-back-button"
          style={styles.barButton}
        >
          <Text style={styles.barButtonText}>Voltar</Text>
        </Pressable>

        <View style={styles.urlBox}>
          <Text style={styles.badgeLabel}>ENSAIO DEV · WEBVIEW VISÍVEL</Text>
          <Text
            testID="diagnostic-sanitized-url"
            style={styles.urlText}
            numberOfLines={1}
          >
            {currentSanitizedUrl}
          </Text>
        </View>

        <Pressable
          onPress={() => setPanelOpen((prev) => !prev)}
          accessibilityRole="button"
          accessibilityLabel="Alternar painel de verificação"
          testID="diagnostic-toggle-panel-button"
          style={[styles.barButton, styles.primaryBarButton]}
        >
          <Text style={styles.primaryBarButtonText}>
            {panelOpen ? 'Ocultar Painel' : `Verificações (${errorCount})`}
          </Text>
        </Pressable>
      </View>

      <View style={styles.subBar}>
        <Pressable
          onPress={() => webViewRef.current?.goBack()}
          disabled={!canGoBack}
          accessibilityRole="button"
          testID="diagnostic-webview-back-button"
          style={[styles.miniControl, !canGoBack && styles.disabledControl]}
        >
          <Text style={styles.miniControlText}>◀ Página</Text>
        </Pressable>

        <Pressable
          onPress={() => webViewRef.current?.reload()}
          accessibilityRole="button"
          testID="diagnostic-webview-reload-button"
          style={styles.miniControl}
        >
          <Text style={styles.miniControlText}>↻ Recarregar</Text>
        </Pressable>

        <View style={styles.statusPill}>
          {webLoading ? (
            <ActivityIndicator size="small" color={THEME_TOKENS.accent.primary} />
          ) : null}
          <Text style={styles.statusPillText}>
            {webLoading ? 'Carregando' : 'Portal Visível'}
          </Text>
        </View>
      </View>

      {panelOpen ? (
        <ScrollView
          style={styles.panelScroll}
          contentContainerStyle={styles.panelContent}
          testID="diagnostic-panel-drawer"
        >
          <View
            style={[
              styles.conclusionCard,
              conclusion.status === 'PROVEN'
                ? styles.conclusionProven
                : conclusion.status === 'FAILED'
                  ? styles.conclusionFailed
                  : styles.conclusionPending,
            ]}
          >
            <Text style={styles.conclusionTitle} testID="diagnostic-conclusion-text">
              {conclusion.statement}
            </Text>
            <Text style={styles.mutedText}>{conclusion.nativePlayerPending}</Text>
          </View>

          <View style={styles.timerCard}>
            <View style={styles.timerCopy}>
              <Text testID="diagnostic-timer-label" style={styles.sectionLabel}>
                Cronômetro auxiliar manual (meta ≥ 60s · não comprova reprodução)
              </Text>
              <Text testID="diagnostic-timer-value" style={styles.timerValue}>
                {`${formatTimerClock(elapsedSeconds)} (${elapsedSeconds}s / 60s)`}
              </Text>
            </View>
            <View style={styles.timerButtons}>
              <Pressable
                onPress={() => setTimerRunning((prev) => !prev)}
                accessibilityRole="button"
                testID="diagnostic-timer-toggle-button"
                style={styles.actionPill}
              >
                <Text style={styles.actionPillText}>
                  {timerRunning ? 'Pausar' : 'Iniciar'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setTimerRunning(false);
                  setElapsedSeconds(0);
                }}
                accessibilityRole="button"
                testID="diagnostic-timer-reset-button"
                style={styles.neutralPill}
              >
                <Text style={styles.neutralPillText}>Zerar</Text>
              </Pressable>
            </View>
          </View>

          {CHECKLIST_ROWS.map((row) => {
            const current = checks[row.key];
            return (
              <View key={row.key} style={styles.checkRow}>
                <Text style={styles.checkLabel}>{row.label}</Text>
                <View style={styles.checkActions}>
                  <Pressable
                    onPress={() => updateCheck(row.key, true)}
                    accessibilityRole="button"
                    testID={`diagnostic-check-${row.key}-ok`}
                    style={[
                      styles.stateButton,
                      current === true && styles.stateButtonOk,
                    ]}
                  >
                    <Text
                      style={[
                        styles.stateButtonText,
                        current === true && styles.stateButtonTextOk,
                      ]}
                    >
                      OK
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => updateCheck(row.key, false)}
                    accessibilityRole="button"
                    testID={`diagnostic-check-${row.key}-fail`}
                    style={[
                      styles.stateButton,
                      current === false && styles.stateButtonFail,
                    ]}
                  >
                    <Text
                      style={[
                        styles.stateButtonText,
                        current === false && styles.stateButtonTextFail,
                      ]}
                    >
                      Falhou
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}

          <View style={styles.checkRow}>
            <Text style={styles.checkLabel}>
              7. Publicidade ou redirecionamentos observados
            </Text>
            <View style={styles.checkActions}>
              <Pressable
                onPress={() => updateAdObservation('NONE')}
                accessibilityRole="button"
                testID="diagnostic-ad-none"
                style={[
                  styles.stateButton,
                  checks.adOrRedirectObserved === 'NONE' && styles.stateButtonOk,
                ]}
              >
                <Text
                  style={[
                    styles.stateButtonText,
                    checks.adOrRedirectObserved === 'NONE' &&
                      styles.stateButtonTextOk,
                  ]}
                >
                  Sem anúncios
                </Text>
              </Pressable>
              <Pressable
                onPress={() => updateAdObservation('OBSERVED')}
                accessibilityRole="button"
                testID="diagnostic-ad-observed"
                style={[
                  styles.stateButton,
                  checks.adOrRedirectObserved === 'OBSERVED' &&
                    styles.stateButtonWarn,
                ]}
              >
                <Text
                  style={[
                    styles.stateButtonText,
                    checks.adOrRedirectObserved === 'OBSERVED' &&
                      styles.stateButtonTextWarn,
                  ]}
                >
                  Observado
                </Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.logCard}>
            <Text style={styles.sectionLabel}>
              Resumo & Eventos Sanitizados (sem credenciais/cookies)
            </Text>
            <Text testID="diagnostic-report-preview" style={styles.reportText}>
              {sanitizedReport}
            </Text>
          </View>
        </ScrollView>
      ) : null}

      <View style={styles.webViewContainer}>
        <WebView
          ref={webViewRef}
          testID="unitv-diagnostic-webview"
          source={{ uri: UNITV_DIAGNOSTIC_PORTAL_URL }}
          style={styles.webView}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          thirdPartyCookiesEnabled={true}
          allowsFullscreenVideo={true}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          webviewDebuggingEnabled={typeof __DEV__ !== 'undefined' && Boolean(__DEV__)}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onNavigationStateChange={handleNavigationStateChange}
          onHttpError={handleHttpError}
          onError={handleLoadError}
          onRenderProcessGone={handleRenderProcessGone}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: THEME_TOKENS.bg.canvas,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.sm,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
  },
  barButton: {
    minHeight: 44,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
  },
  barButtonText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
    fontWeight: '600',
  },
  primaryBarButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderColor: THEME_TOKENS.accent.primary,
  },
  primaryBarButtonText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  urlBox: {
    flex: 1,
    gap: 2,
  },
  badgeLabel: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  urlText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  subBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
  },
  miniControl: {
    minHeight: 44,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: THEME_TOKENS.bg.card,
    borderRadius: THEME_TOKENS.radius.sm,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  disabledControl: {
    opacity: 0.45,
  },
  miniControlText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
  },
  statusPill: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.xs,
  },
  statusPillText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  panelScroll: {
    maxHeight: '55%',
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
  },
  panelContent: {
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.sm,
  },
  conclusionCard: {
    borderRadius: THEME_TOKENS.radius.md,
    borderWidth: 1,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.xs,
  },
  conclusionPending: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
  },
  conclusionProven: {
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
    borderColor: THEME_TOKENS.accent.primary,
  },
  conclusionFailed: {
    backgroundColor: STATUS_META.DROPPED.backgroundColor,
    borderColor: THEME_TOKENS.accent.secondary,
  },
  conclusionTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  mutedText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  timerCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.sm,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
  },
  timerCopy: {
    gap: 2,
  },
  sectionLabel: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
    fontWeight: '700',
  },
  timerValue: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.accent.primary,
    fontWeight: '700',
  },
  timerButtons: {
    flexDirection: 'row',
    gap: THEME_TOKENS.spacing.sm,
  },
  actionPill: {
    minHeight: 44,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.accent.primary,
  },
  actionPillText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  neutralPill: {
    minHeight: 44,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  neutralPillText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
  },
  checkRow: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.sm,
  },
  checkLabel: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.text.primary,
  },
  checkActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: THEME_TOKENS.spacing.sm,
  },
  stateButton: {
    minHeight: 44,
    minWidth: 88,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  stateButtonOk: {
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
    borderColor: THEME_TOKENS.accent.primary,
  },
  stateButtonFail: {
    backgroundColor: STATUS_META.DROPPED.backgroundColor,
    borderColor: THEME_TOKENS.accent.secondary,
  },
  stateButtonWarn: {
    backgroundColor: STATUS_META.PAUSED.backgroundColor,
    borderColor: THEME_TOKENS.accent.gold,
  },
  stateButtonText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
    fontWeight: '600',
  },
  stateButtonTextOk: {
    color: THEME_TOKENS.accent.primary,
  },
  stateButtonTextFail: {
    color: THEME_TOKENS.accent.secondary,
  },
  stateButtonTextWarn: {
    color: THEME_TOKENS.accent.gold,
  },
  logCard: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.xs,
  },
  reportText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  webViewContainer: {
    flex: 1,
    minHeight: 320,
    backgroundColor: '#000000',
  },
  webView: {
    flex: 1,
    backgroundColor: '#000000',
  },
});
