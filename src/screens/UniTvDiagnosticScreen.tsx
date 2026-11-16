import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Video, {
  OnLoadData,
  OnProgressData,
  ResizeMode,
} from 'react-native-video';
import {
  WebView,
  WebViewMessageEvent,
  WebViewNavigation,
  WebViewProps,
} from 'react-native-webview';

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
type VideoErrorParam = Parameters<
  NonNullable<React.ComponentProps<typeof Video>['onError']>
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
import {
  createInitialExoPlayerState,
  ExoPlayerTestState,
  formatPhase2ReportSection,
  parsePhase2WebViewMessage,
  PHASE2_DOM_INSPECT_SCRIPT,
  PHASE2_STREAM_CAPTURE_SCRIPT,
  Phase2DomSnapshot,
  Phase2StreamCandidate,
  Phase2StreamLogEntry,
} from '../diagnostics/unitv-phase2-probe';
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

function formatResolutionFromLoad(event: OnLoadData): string | null {
  const tracks = Array.isArray(event.videoTracks) ? event.videoTracks : [];
  const maxHeight = tracks.reduce(
    (best, t) => (typeof t.height === 'number' && t.height > best ? t.height : best),
    0
  );
  if (maxHeight > 0) {
    return `${maxHeight}p`;
  }
  const natHeight = event.naturalSize?.height ?? 0;
  const natWidth = event.naturalSize?.width ?? 0;
  if (natHeight > 0) {
    return natWidth > 0 ? `${natWidth}x${natHeight}` : `${natHeight}p`;
  }
  return null;
}

function formatSanitizedExoError(rawEvent: VideoErrorParam): string {
  const errObj =
    rawEvent && typeof rawEvent === 'object' && 'error' in rawEvent
      ? (rawEvent.error as Record<string, unknown> | undefined)
      : undefined;
  const code = errObj?.errorCode ?? errObj?.code ?? 'UNKNOWN';
  const rawMessage =
    typeof errObj?.errorString === 'string'
      ? errObj.errorString
      : typeof errObj?.localizedDescription === 'string'
        ? errObj.localizedDescription
        : 'Falha ao carregar mídia no ExoPlayer';
  // Strip any embedded URL query strings from native error messages
  const sanitizedMessage = rawMessage.replace(/\?[^\s"']+/g, '?[redacted]');
  return `${String(code)}: ${sanitizedMessage}`;
}

export function UniTvDiagnosticScreen(
  props: UniTvDiagnosticScreenProps = {}
): React.JSX.Element {
  const { navigation } = props;
  const insets = useSafeAreaInsets();
  const webViewRef = React.useRef<WebView>(null);
  const eventSeqRef = React.useRef<number>(1);
  const bridgeLoadedRef = React.useRef<boolean>(false);
  const pendingBridgeActionsRef = React.useRef<Array<'DOM' | 'ARM_STREAM'>>([]);

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

  const [postLoginToolsEnabled, setPostLoginToolsEnabled] =
    React.useState<boolean>(false);
  const [streamCaptureArmed, setStreamCaptureArmed] =
    React.useState<boolean>(false);
  const [domSnapshots, setDomSnapshots] = React.useState<Phase2DomSnapshot[]>(
    []
  );
  const [streamLogs, setStreamLogs] = React.useState<Phase2StreamLogEntry[]>(
    []
  );
  const [streamCandidate, setStreamCandidate] =
    React.useState<Phase2StreamCandidate | null>(null);
  const [exoTestActive, setExoTestActive] = React.useState<boolean>(false);
  const [exoState, setExoState] = React.useState<ExoPlayerTestState>(() =>
    createInitialExoPlayerState()
  );
  const [phase2Hint, setPhase2Hint] = React.useState<string | null>(null);
  const exoTestActiveRef = React.useRef<boolean>(false);
  const streamCandidateRef = React.useRef<Phase2StreamCandidate | null>(null);
  exoTestActiveRef.current = exoTestActive;
  streamCandidateRef.current = streamCandidate;

  React.useEffect(() => {
    if (postLoginToolsEnabled && !bridgeLoadedRef.current) {
      webViewRef.current?.reload();
    }
  }, [postLoginToolsEnabled]);

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

  const runBridgeAction = React.useCallback((action: 'DOM' | 'ARM_STREAM') => {
    const script =
      action === 'DOM'
        ? PHASE2_DOM_INSPECT_SCRIPT
        : PHASE2_STREAM_CAPTURE_SCRIPT;
    webViewRef.current?.injectJavaScript(script);
  }, []);

  const triggerPostLoginAction = React.useCallback(
    (action: 'DOM' | 'ARM_STREAM') => {
      if (action === 'ARM_STREAM') {
        setStreamCaptureArmed(true);
      }
      if (!postLoginToolsEnabled || !bridgeLoadedRef.current) {
        if (!pendingBridgeActionsRef.current.includes(action)) {
          pendingBridgeActionsRef.current.push(action);
        }
        setPhase2Hint(
          'Ativando ponte pós-login e recarregando a página atual uma vez...'
        );
        setPostLoginToolsEnabled(true);
        return;
      }
      runBridgeAction(action);
      setPhase2Hint(
        action === 'DOM'
          ? 'Inspeção de DOM solicitada na página atual.'
          : 'Captura de requisições de mídia armada.'
      );
    },
    [postLoginToolsEnabled, runBridgeAction]
  );

  const handleWebViewLoadEnd = React.useCallback(() => {
    setWebLoading(false);
    if (!postLoginToolsEnabled) {
      return;
    }
    bridgeLoadedRef.current = true;
    const queued = [...pendingBridgeActionsRef.current];
    pendingBridgeActionsRef.current = [];

    for (const action of queued) {
      runBridgeAction(action);
    }
    if (streamCaptureArmed && !queued.includes('ARM_STREAM')) {
      runBridgeAction('ARM_STREAM');
    }
    if (queued.length > 0) {
      setPhase2Hint('Ponte pós-login pronta e captura executada.');
    }
  }, [postLoginToolsEnabled, runBridgeAction, streamCaptureArmed]);

  const handleWebViewMessage = React.useCallback(
    (event: WebViewMessageEvent) => {
      const parsed = parsePhase2WebViewMessage(event.nativeEvent.data);
      if (!parsed) {
        return;
      }
      if (parsed.kind === 'DOM') {
        setDomSnapshots((prev) => [...prev.slice(-5), parsed.snapshot]);
        setPhase2Hint(`DOM capturado: ${parsed.snapshot.url}`);
        return;
      }
      setStreamLogs((prev) => [...prev.slice(-19), parsed.entry]);
      if (parsed.kind === 'STREAM_CANDIDATE') {
        if (exoTestActiveRef.current) {
          setPhase2Hint(
            'Novo manifest registrado no log enquanto teste ExoPlayer está ativo.'
          );
          return;
        }
        if (streamCandidateRef.current?.streamUrl !== parsed.candidate.streamUrl) {
          setStreamCandidate(parsed.candidate);
          setExoState(createInitialExoPlayerState());
        }
        setPhase2Hint(
          `Candidato HTTP capturado (${parsed.candidate.sourceTag}): pronto para testar no ExoPlayer.`
        );
      } else if (parsed.kind === 'STREAM_BLOB') {
        setPhase2Hint(
          'Player reportou blob:/MediaSource (MSE); observe se há manifest .m3u8/.mp4 adicional.'
        );
      }
    },
    []
  );

  const handleStartExoTest = React.useCallback(() => {
    if (!streamCandidate) {
      return;
    }
    setExoTestActive(true);
    setExoState({
      ...createInitialExoPlayerState(),
      status: 'LOADING',
    });
  }, [streamCandidate]);

  const handleExoLoad = React.useCallback((event: OnLoadData) => {
    const resLabel = formatResolutionFromLoad(event);
    const dur =
      typeof event.duration === 'number' && Number.isFinite(event.duration)
        ? event.duration
        : 0;
    setExoState((prev) => ({
      ...prev,
      status: 'PLAYING',
      durationSeconds: dur,
      resolutionLabel: resLabel ?? prev.resolutionLabel,
      errorDetail: null,
    }));
  }, []);

  const handleExoProgress = React.useCallback((event: OnProgressData) => {
    const pos =
      typeof event.currentTime === 'number' &&
      Number.isFinite(event.currentTime)
        ? event.currentTime
        : 0;
    setExoState((prev) => ({
      ...prev,
      status: 'PLAYING',
      currentSeconds: pos,
    }));
  }, []);

  const handleExoError = React.useCallback((rawEvent: VideoErrorParam) => {
    setExoState((prev) => ({
      ...createInitialExoPlayerState(),
      status: 'ERROR',
      errorDetail: formatSanitizedExoError(rawEvent),
      manualConfirm: prev.manualConfirm,
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
  const sanitizedReport = React.useMemo(() => {
    const baseReport = formatSanitizedDiagnosticReport({
      checks,
      elapsedSeconds,
      currentSanitizedUrl,
      events,
    });
    const phase2Report = formatPhase2ReportSection({
      domSnapshots,
      streamLogs,
      exoState,
    });
    return `${baseReport}\n${phase2Report}`;
  }, [
    checks,
    currentSanitizedUrl,
    domSnapshots,
    elapsedSeconds,
    events,
    exoState,
    streamLogs,
  ]);

  const handleShareReport = React.useCallback(async () => {
    try {
      await Share.share({ message: sanitizedReport });
    } catch {
      // Ignore share cancellation errors on device.
    }
  }, [sanitizedReport]);

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

          <View style={styles.phase2Card}>
            <Text style={styles.sectionLabel}>
              Fase 2 — Busca, Episódios & Teste ExoPlayer (somente pós-login)
            </Text>
            <Text style={styles.mutedText}>
              {phase2Hint ??
                'Resolva /captcha e login primeiro. Só depois use estes botões para inspecionar DOM ou testar o stream no player nativo.'}
            </Text>

            <View style={styles.checkActions}>
              <Pressable
                onPress={() => triggerPostLoginAction('DOM')}
                accessibilityRole="button"
                testID="diagnostic-capture-dom-button"
                style={styles.actionPill}
              >
                <Text style={styles.actionPillText}>
                  {`Capturar DOM Atual (${domSnapshots.length})`}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => triggerPostLoginAction('ARM_STREAM')}
                accessibilityRole="button"
                testID="diagnostic-arm-stream-button"
                style={[
                  styles.neutralPill,
                  streamCaptureArmed && styles.stateButtonOk,
                ]}
              >
                <Text
                  style={[
                    styles.neutralPillText,
                    streamCaptureArmed && styles.stateButtonTextOk,
                  ]}
                >
                  {streamCaptureArmed
                    ? `Captura Armada (${streamLogs.length})`
                    : 'Armar Captura de Stream'}
                </Text>
              </Pressable>

              <Pressable
                onPress={handleStartExoTest}
                disabled={!streamCandidate}
                accessibilityRole="button"
                testID="diagnostic-test-exoplayer-button"
                style={[
                  styles.actionPill,
                  !streamCandidate && styles.disabledControl,
                ]}
              >
                <Text style={styles.actionPillText}>
                  {exoTestActive ? 'Reiniciar ExoPlayer' : 'Testar no ExoPlayer'}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => void handleShareReport()}
                accessibilityRole="button"
                testID="diagnostic-share-report-button"
                style={styles.neutralPill}
              >
                <Text style={styles.neutralPillText}>Compartilhar Resumo</Text>
              </Pressable>
            </View>

            {exoTestActive && streamCandidate ? (
              <View style={styles.exoTestBox}>
                <Text
                  testID="diagnostic-exoplayer-status"
                  style={styles.timerValue}
                >
                  {`ExoPlayer: ${exoState.status}${
                    exoState.resolutionLabel
                      ? ` · ${exoState.resolutionLabel}`
                      : ''
                  }${
                    exoState.durationSeconds > 0
                      ? ` · ${Math.round(exoState.currentSeconds)}s/${Math.round(exoState.durationSeconds)}s`
                      : ''
                  }`}
                </Text>
                {exoState.errorDetail ? (
                  <Text style={styles.stateButtonTextFail}>
                    {exoState.errorDetail}
                  </Text>
                ) : null}

                <View style={styles.exoVideoFrame}>
                  <Video
                    testID="diagnostic-exoplayer-video"
                    source={{
                      uri: streamCandidate.streamUrl,
                      headers: {
                        ...(streamCandidate.referer
                          ? { Referer: streamCandidate.referer }
                          : {}),
                        ...(streamCandidate.userAgent
                          ? { 'User-Agent': streamCandidate.userAgent }
                          : {}),
                      },
                    }}
                    style={styles.exoVideoSurface}
                    resizeMode={ResizeMode.CONTAIN}
                    controls={true}
                    paused={false}
                    progressUpdateInterval={1000}
                    onLoad={handleExoLoad}
                    onProgress={handleExoProgress}
                    onError={handleExoError}
                  />
                </View>

                <View style={styles.checkActions}>
                  <Pressable
                    onPress={() =>
                      setExoState((prev) => ({
                        ...prev,
                        manualConfirm: prev.manualConfirm === true ? null : true,
                      }))
                    }
                    accessibilityRole="button"
                    testID="diagnostic-exoplayer-ok"
                    style={[
                      styles.stateButton,
                      exoState.manualConfirm === true && styles.stateButtonOk,
                    ]}
                  >
                    <Text
                      style={[
                        styles.stateButtonText,
                        exoState.manualConfirm === true &&
                          styles.stateButtonTextOk,
                      ]}
                    >
                      ExoPlayer OK
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      setExoState((prev) => ({
                        ...prev,
                        manualConfirm:
                          prev.manualConfirm === false ? null : false,
                      }))
                    }
                    accessibilityRole="button"
                    testID="diagnostic-exoplayer-fail"
                    style={[
                      styles.stateButton,
                      exoState.manualConfirm === false &&
                        styles.stateButtonFail,
                    ]}
                  >
                    <Text
                      style={[
                        styles.stateButtonText,
                        exoState.manualConfirm === false &&
                          styles.stateButtonTextFail,
                      ]}
                    >
                      ExoPlayer Falhou
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setExoTestActive(false);
                      setExoState(createInitialExoPlayerState());
                    }}
                    accessibilityRole="button"
                    testID="diagnostic-exoplayer-close"
                    style={styles.neutralPill}
                  >
                    <Text style={styles.neutralPillText}>Fechar Teste</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>

          <View style={styles.logCard}>
            <Text style={styles.sectionLabel}>
              Resumo & Eventos Sanitizados (sem credenciais/cookies)
            </Text>
            <Text
              selectable={true}
              testID="diagnostic-report-preview"
              style={styles.reportText}
            >
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
          onMessage={postLoginToolsEnabled ? handleWebViewMessage : undefined}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onNavigationStateChange={handleNavigationStateChange}
          onLoadEnd={handleWebViewLoadEnd}
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
  phase2Card: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.sm,
  },
  exoTestBox: {
    marginTop: THEME_TOKENS.spacing.xs,
    gap: THEME_TOKENS.spacing.sm,
    paddingTop: THEME_TOKENS.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: THEME_TOKENS.border.subtle,
  },
  exoVideoFrame: {
    width: '100%',
    height: 200,
    backgroundColor: '#000000',
    borderRadius: THEME_TOKENS.radius.sm,
    overflow: 'hidden',
  },
  exoVideoSurface: {
    flex: 1,
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
