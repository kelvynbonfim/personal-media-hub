import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import Video, {
  OnLoadData,
  OnProgressData,
  OnVideoTracksData,
  ResizeMode,
  SelectedTrackType,
  SelectedVideoTrackType,
  VideoRef,
} from 'react-native-video';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { getMediaDisplayTitle } from '../components/MediaPosterCard';
import {
  DEFAULT_UNITV_PORTAL_URL,
  MediaItemRecord,
} from '../db/schema';
import { useOptionalAppServices } from '../navigation/AppServicesContext';
import { HlsVariant, selectBestHlsTrack } from '../playback/hls-track-selector';
import { PlaybackErrorCode, PlaybackResolution } from '../playback/types';
import {
  CLEAN_WEBVIEW_INJECT_SCRIPT,
  parseCleanWebViewStreamMessage,
} from '../playback/unitv-adapter';
import { buildPortalUrl } from '../playback/unitv-probe';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';
import { BaseDiscoveryScreenProps } from './discovery-helpers';

export interface VideoPlayerRoute {
  params?: {
    mediaItemId?: string;
    episodeNumber?: number;
  };
}

export interface VideoPlayerScreenProps extends BaseDiscoveryScreenProps {
  route?: VideoPlayerRoute;
}

const PROGRESS_SAVE_INTERVAL_MS = 10_000;
const NEXT_EPISODE_THRESHOLD_SECONDS = 90;
const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getErrorCopy(errorCode: PlaybackErrorCode): {
  title: string;
  description: string;
} {
  if (errorCode === 'CONCURRENT_SCREEN_LIMIT') {
    return {
      title: 'Limite de telas simultâneas atingido',
      description:
        'Sua assinatura UniTV já está em uso em outro aparelho no momento. Feche a reprodução no outro dispositivo e tente novamente.',
    };
  }
  if (errorCode === 'NOT_FOUND_IN_CATALOG') {
    return {
      title: 'Título não encontrado no catálogo do UniTV',
      description:
        'Este anime não foi encontrado automaticamente no portal UniTV. Você pode vinculá-lo manualmente na página do anime ou marcar os episódios com ✓.',
    };
  }
  return {
    title: 'Falha na autenticação UniTV',
    description:
      'Verifique seu usuário, senha e URL do portal UniTV nas Configurações antes de reproduzir.',
  };
}

export function VideoPlayerScreen(
  props: VideoPlayerScreenProps = {}
): React.JSX.Element {
  const { navigation, route, services: injectedServices } = props;
  const contextServices = useOptionalAppServices();
  const libraryRepository =
    injectedServices?.libraryRepository ??
    contextServices?.libraryRepository ??
    null;
  const playbackAdapter =
    injectedServices?.playbackAdapter ?? contextServices?.playbackAdapter ?? null;

  const mediaItemId = route?.params?.mediaItemId ?? '';
  const episodeNumber = route?.params?.episodeNumber ?? 1;
  const servicesReady = Boolean(libraryRepository && mediaItemId);

  const videoRef = React.useRef<VideoRef>(null);
  const isMountedRef = React.useRef<boolean>(true);
  const positionRef = React.useRef<number>(0);
  const durationRef = React.useRef<number>(0);
  const lastSavedPositionRef = React.useRef<number>(-1);
  const initialResumeSecondsRef = React.useRef<number>(0);
  const hasSeekedInitialRef = React.useRef<boolean>(false);
  const hasAppliedAutoQualityRef = React.useRef<boolean>(false);

  const [loading, setLoading] = React.useState<boolean>(servicesReady);
  const [media, setMedia] = React.useState<MediaItemRecord | null>(null);
  const [portalUrl, setPortalUrl] = React.useState<string>(DEFAULT_UNITV_PORTAL_URL);
  const [preferMaxQuality, setPreferMaxQuality] = React.useState<boolean>(true);
  const [resolution, setResolution] = React.useState<PlaybackResolution | null>(
    null
  );
  const [screenError, setScreenError] = React.useState<string | null>(null);

  const [paused, setPaused] = React.useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = React.useState<number>(1);
  const [currentTime, setCurrentTime] = React.useState<number>(0);
  const [duration, setDuration] = React.useState<number>(0);

  const [videoTracks, setVideoTracks] = React.useState<HlsVariant[]>([]);
  const [selectedVideoTrackIndex, setSelectedVideoTrackIndex] = React.useState<
    number | null
  >(null);
  const [qualityLabel, setQualityLabel] = React.useState<string | null>(null);

  const [audioTracks, setAudioTracks] = React.useState<
    Array<{ index: number; label: string }>
  >([]);
  const [selectedAudioIndex, setSelectedAudioIndex] = React.useState<
    number | null
  >(null);
  const [textTracks, setTextTracks] = React.useState<
    Array<{ index: number; label: string }>
  >([]);
  const [selectedTextIndex, setSelectedTextIndex] = React.useState<
    number | 'disabled' | null
  >(null);

  const [episodeCompleted, setEpisodeCompleted] = React.useState<boolean>(false);
  const [markingManual, setMarkingManual] = React.useState<boolean>(false);
  const [reloadCounter, setReloadCounter] = React.useState<number>(0);

  React.useEffect(() => {
    isMountedRef.current = true;
    void ScreenOrientation.lockAsync(
      ScreenOrientation.OrientationLock.LANDSCAPE
    ).catch(() => undefined);

    return () => {
      isMountedRef.current = false;
      void ScreenOrientation.unlockAsync().catch(() => undefined);
    };
  }, []);

  const persistProgress = React.useCallback(
    async (overridePosition?: number): Promise<void> => {
      if (!libraryRepository || !mediaItemId) {
        return;
      }
      const pos = overridePosition ?? positionRef.current;
      const dur = durationRef.current;
      if (pos <= 0 && dur <= 0) {
        return;
      }
      if (overridePosition === undefined && pos === lastSavedPositionRef.current) {
        return;
      }

      lastSavedPositionRef.current = pos;
      try {
        const result = await libraryRepository.recordPlaybackProgress({
          mediaItemId,
          episodeNumber,
          positionSeconds: Math.max(0, pos),
          durationSeconds: Math.max(0, dur),
          watchedVia: 'APP_PLAYER',
        });
        if (isMountedRef.current && result.episodeCompleted) {
          setEpisodeCompleted(true);
        }
      } catch {
        // Never interrupt video playback on transient SQLite write error.
      }
    },
    [episodeNumber, libraryRepository, mediaItemId]
  );

  const persistProgressRef = React.useRef(persistProgress);
  React.useEffect(() => {
    persistProgressRef.current = persistProgress;
  }, [persistProgress]);

  React.useEffect(() => {
    if (!servicesReady || !libraryRepository) {
      return undefined;
    }

    let cancelled = false;
    positionRef.current = 0;
    durationRef.current = 0;
    lastSavedPositionRef.current = -1;
    initialResumeSecondsRef.current = 0;
    hasSeekedInitialRef.current = false;
    hasAppliedAutoQualityRef.current = false;

    setLoading(true);
    setScreenError(null);
    setResolution(null);
    setPaused(false);
    setCurrentTime(0);
    setDuration(0);
    setVideoTracks([]);
    setSelectedVideoTrackIndex(null);
    setQualityLabel(null);
    setAudioTracks([]);
    setSelectedAudioIndex(null);
    setTextTracks([]);
    setSelectedTextIndex(null);
    setEpisodeCompleted(false);

    const resolvePlayback = async () => {
      try {
        const [loadedMedia, settings, existingLink, progressList] =
          await Promise.all([
            typeof libraryRepository.getMediaItemById === 'function'
              ? libraryRepository.getMediaItemById(mediaItemId)
              : Promise.resolve(null),
            typeof libraryRepository.getSettings === 'function'
              ? libraryRepository.getSettings()
              : Promise.resolve({
                  unitvPortalUrl: DEFAULT_UNITV_PORTAL_URL,
                  preferMaxQuality: true,
                  hideCompletedInExplore: false,
                  tmdbApiKey: null,
                  lastSyncAt: null,
                }),
            typeof libraryRepository.getUniTvLink === 'function'
              ? libraryRepository.getUniTvLink(mediaItemId)
              : Promise.resolve(null),
            typeof libraryRepository.getEpisodeProgressList === 'function'
              ? libraryRepository.getEpisodeProgressList(mediaItemId)
              : Promise.resolve([]),
          ]);

        if (cancelled || !isMountedRef.current) {
          return;
        }

        if (!loadedMedia) {
          setScreenError('Anime não encontrado na biblioteca local.');
          setLoading(false);
          return;
        }

        const existingEpisodeProgress = progressList.find(
          (row) => row.episodeNumber === episodeNumber
        );
        if (
          existingEpisodeProgress &&
          !existingEpisodeProgress.isCompleted &&
          existingEpisodeProgress.positionSeconds > 0
        ) {
          initialResumeSecondsRef.current =
            existingEpisodeProgress.positionSeconds;
          positionRef.current = existingEpisodeProgress.positionSeconds;
          lastSavedPositionRef.current = existingEpisodeProgress.positionSeconds;
          setCurrentTime(existingEpisodeProgress.positionSeconds);
        }

        setMedia(loadedMedia);
        setPortalUrl(settings.unitvPortalUrl);
        setPreferMaxQuality(settings.preferMaxQuality);

        if (!playbackAdapter) {
          setScreenError(
            'Adaptador de reprodução UniTV não disponível neste ambiente.'
          );
          setLoading(false);
          return;
        }

        const resolved = await playbackAdapter.resolveEpisodePlayback({
          media: loadedMedia,
          episodeNumber,
          existingLink,
          portalUrl: settings.unitvPortalUrl,
        });

        if (cancelled || !isMountedRef.current) {
          return;
        }

        setResolution(resolved);
      } catch (error) {
        if (!cancelled && isMountedRef.current) {
          setScreenError(
            error instanceof Error
              ? error.message
              : 'Falha ao resolver reprodução do episódio.'
          );
        }
      } finally {
        if (!cancelled && isMountedRef.current) {
          setLoading(false);
        }
      }
    };

    void resolvePlayback();

    return () => {
      cancelled = true;
      void persistProgressRef.current();
    };
  }, [
    episodeNumber,
    libraryRepository,
    mediaItemId,
    playbackAdapter,
    reloadCounter,
    servicesReady,
  ]);

  React.useEffect(() => {
    if (
      resolution?.mode !== 'EXOPLAYER_HLS' ||
      Boolean(resolution.errorCode) ||
      paused
    ) {
      return undefined;
    }

    const intervalId = setInterval(() => {
      void persistProgressRef.current();
    }, PROGRESS_SAVE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [paused, resolution?.errorCode, resolution?.mode]);

  const applyVideoTracks = React.useCallback(
    (
      rawTracks:
        | Array<{
            index: number;
            width?: number;
            height?: number;
            bitrate?: number;
          }>
        | undefined
    ) => {
      if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
        return;
      }
      const variants: HlsVariant[] = rawTracks.map((track, idx) => ({
        index: typeof track.index === 'number' ? track.index : idx,
        width: track.width ?? 0,
        height: track.height ?? 0,
        bitrate: track.bitrate ?? 0,
      }));
      setVideoTracks(variants);
      if (preferMaxQuality && !hasAppliedAutoQualityRef.current) {
        const best = selectBestHlsTrack(variants);
        if (best) {
          hasAppliedAutoQualityRef.current = true;
          setSelectedVideoTrackIndex(best.index);
          setQualityLabel(best.label);
        }
      }
    },
    [preferMaxQuality]
  );

  const handleVideoLoad = React.useCallback(
    (rawEvent: OnLoadData | { nativeEvent?: OnLoadData }) => {
      const event =
        rawEvent && 'nativeEvent' in rawEvent && rawEvent.nativeEvent
          ? rawEvent.nativeEvent
          : (rawEvent as OnLoadData);

      if (typeof event.duration === 'number' && Number.isFinite(event.duration)) {
        durationRef.current = event.duration;
        setDuration(event.duration);
      }

      if (
        !hasSeekedInitialRef.current &&
        initialResumeSecondsRef.current > 0 &&
        videoRef.current
      ) {
        hasSeekedInitialRef.current = true;
        videoRef.current.seek(initialResumeSecondsRef.current);
      }

      applyVideoTracks(event.videoTracks);

      if (Array.isArray(event.audioTracks)) {
        setAudioTracks(
          event.audioTracks.map((t, idx) => ({
            index: typeof t.index === 'number' ? t.index : idx,
            label: t.title || t.language || `Áudio ${idx + 1}`,
          }))
        );
      }
      if (Array.isArray(event.textTracks)) {
        setTextTracks(
          event.textTracks.map((t, idx) => ({
            index: typeof t.index === 'number' ? t.index : idx,
            label: t.title || t.language || `Legenda ${idx + 1}`,
          }))
        );
      }
    },
    [applyVideoTracks]
  );

  const handleVideoTracks = React.useCallback(
    (rawEvent: OnVideoTracksData | { nativeEvent?: OnVideoTracksData }) => {
      const event =
        rawEvent && 'nativeEvent' in rawEvent && rawEvent.nativeEvent
          ? rawEvent.nativeEvent
          : (rawEvent as OnVideoTracksData);
      applyVideoTracks(event.videoTracks);
    },
    [applyVideoTracks]
  );

  const handleVideoProgress = React.useCallback(
    (rawEvent: OnProgressData | { nativeEvent?: OnProgressData }) => {
      const event =
        rawEvent && 'nativeEvent' in rawEvent && rawEvent.nativeEvent
          ? rawEvent.nativeEvent
          : (rawEvent as OnProgressData);

      if (
        typeof event.currentTime === 'number' &&
        Number.isFinite(event.currentTime)
      ) {
        positionRef.current = event.currentTime;
        setCurrentTime(event.currentTime);
      }

      if (
        durationRef.current <= 0 &&
        typeof event.seekableDuration === 'number' &&
        event.seekableDuration > 0
      ) {
        durationRef.current = event.seekableDuration;
        setDuration(event.seekableDuration);
      }
    },
    []
  );

  const handleVideoEnd = React.useCallback(() => {
    const finalPos =
      durationRef.current > 0 ? durationRef.current : positionRef.current;
    positionRef.current = finalPos;
    setCurrentTime(finalPos);
    void persistProgress(finalPos);
  }, [persistProgress]);

  const handleVideoError = React.useCallback(() => {
    const fallbackUrl = buildPortalUrl(
      portalUrl,
      `vod/${encodeURIComponent(resolution?.vodId ?? mediaItemId)}?ep=${episodeNumber}`
    );
    setResolution((prev) => ({
      ...(prev ?? {}),
      mode: 'CLEAN_WEBVIEW',
      webViewUrl: prev?.webViewUrl ?? fallbackUrl,
    }));
  }, [episodeNumber, mediaItemId, portalUrl, resolution?.vodId]);

  const handleTogglePause = React.useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      if (next) {
        void persistProgress();
      }
      return next;
    });
  }, [persistProgress]);

  const handleSeekDelta = React.useCallback((deltaSeconds: number) => {
    const maxDur = durationRef.current;
    const nextPos = Math.max(
      0,
      maxDur > 0
        ? Math.min(maxDur, positionRef.current + deltaSeconds)
        : positionRef.current + deltaSeconds
    );
    positionRef.current = nextPos;
    setCurrentTime(nextPos);
    videoRef.current?.seek(nextPos);
  }, []);

  const handleClose = React.useCallback(async () => {
    await persistProgress();
    navigation?.goBack?.();
  }, [navigation, persistProgress]);

  const handleNextEpisode = React.useCallback(async () => {
    await persistProgress();
    navigation?.navigate('VideoPlayer', {
      mediaItemId,
      episodeNumber: episodeNumber + 1,
    });
  }, [episodeNumber, mediaItemId, navigation, persistProgress]);

  const handleCycleRate = React.useCallback(() => {
    setPlaybackRate((prev) => {
      const idx = PLAYBACK_RATES.indexOf(
        prev as (typeof PLAYBACK_RATES)[number]
      );
      return PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    });
  }, []);

  const handleCycleQuality = React.useCallback(() => {
    if (videoTracks.length <= 1) {
      return;
    }
    hasAppliedAutoQualityRef.current = true;
    const sorted = [...videoTracks].sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
    const currentIdx = sorted.findIndex(
      (track) => track.index === selectedVideoTrackIndex
    );
    const nextTrack = sorted[(currentIdx + 1) % sorted.length];
    setSelectedVideoTrackIndex(nextTrack.index);
    setQualityLabel(nextTrack.height > 0 ? `${nextTrack.height}p` : 'Auto');
  }, [selectedVideoTrackIndex, videoTracks]);

  const handleWebViewMessage = React.useCallback((event: WebViewMessageEvent) => {
    const captured = parseCleanWebViewStreamMessage(event.nativeEvent.data);
    if (!captured) {
      return;
    }
    setResolution((prev) => ({
      ...(prev ?? {}),
      mode: 'EXOPLAYER_HLS',
      streamUrl: captured.streamUrl,
      headers: captured.headers,
    }));
  }, []);

  const handleCompleteEpisodeManual = React.useCallback(async () => {
    if (!libraryRepository || !mediaItemId || markingManual) {
      return;
    }
    setMarkingManual(true);
    try {
      await libraryRepository.toggleEpisodeManual(mediaItemId, episodeNumber, true);
      if (isMountedRef.current) {
        setEpisodeCompleted(true);
      }
    } finally {
      if (isMountedRef.current) {
        setMarkingManual(false);
      }
    }
  }, [episodeNumber, libraryRepository, markingManual, mediaItemId]);

  if (!servicesReady) {
    return (
      <View style={styles.centeredBox}>
        <Text style={styles.errorTitle}>Player Full HD</Text>
        <Text style={styles.errorBody}>
          Selecione um episódio na biblioteca para iniciar a reprodução.
        </Text>
        {navigation?.goBack ? (
          <Pressable
            onPress={() => navigation.goBack?.()}
            accessibilityRole="button"
            testID="player-close-button"
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Fechar</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.centeredBox}>
        <ActivityIndicator size="large" color={THEME_TOKENS.accent.primary} />
        <Text style={styles.loadingText}>
          Conectando sessão UniTV em Full HD...
        </Text>
      </View>
    );
  }

  if (screenError || resolution?.errorCode) {
    const errorCopy = resolution?.errorCode
      ? getErrorCopy(resolution.errorCode)
      : {
          title: 'Não foi possível reproduzir',
          description: screenError ?? 'Erro desconhecido.',
        };

    return (
      <View testID="player-error-state" style={styles.centeredBox}>
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>{errorCopy.title}</Text>
          <Text style={styles.errorBody}>{errorCopy.description}</Text>

          <View style={styles.errorActions}>
            {resolution?.errorCode === 'AUTH_FAILED' ? (
              <Pressable
                onPress={() => navigation?.navigate('Settings')}
                accessibilityRole="button"
                testID="player-open-settings"
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  Abrir Configurações
                </Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => setReloadCounter((prev) => prev + 1)}
                accessibilityRole="button"
                testID="player-retry-button"
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Tentar novamente</Text>
              </Pressable>
            )}

            <Pressable
              onPress={() => navigation?.goBack?.()}
              accessibilityRole="button"
              testID="player-close-button"
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Voltar</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const title = media ? getMediaDisplayTitle(media) : 'Reproduzindo';
  const remainingSeconds =
    duration > 0 ? Math.max(0, duration - currentTime) : Number.POSITIVE_INFINITY;
  const hasNextEpisode =
    media?.episodesTotal == null || episodeNumber < media.episodesTotal;
  const showNextEpisode =
    duration > 0 &&
    remainingSeconds <= NEXT_EPISODE_THRESHOLD_SECONDS &&
    hasNextEpisode;

  if (resolution?.mode === 'CLEAN_WEBVIEW') {
    const fallbackUrl = resolution.webViewUrl ?? portalUrl;
    return (
      <View style={styles.playerContainer}>
        <WebView
          testID="video-player-webview"
          source={{ uri: fallbackUrl }}
          style={styles.fullSurface}
          injectedJavaScript={CLEAN_WEBVIEW_INJECT_SCRIPT}
          injectedJavaScriptBeforeContentLoaded={CLEAN_WEBVIEW_INJECT_SCRIPT}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          allowsFullscreenVideo={true}
          mediaPlaybackRequiresUserAction={false}
          setSupportMultipleWindows={false}
          onMessage={handleWebViewMessage}
          onShouldStartLoadWithRequest={(request) =>
            /^https?:\/\//i.test(request.url)
          }
        />

        <View style={styles.webViewTopOverlay}>
          <Pressable
            onPress={() => void handleClose()}
            accessibilityRole="button"
            testID="player-close-button"
            style={styles.overlayButton}
          >
            <Text style={styles.overlayButtonText}>✕ Fechar</Text>
          </Pressable>
          <Text style={styles.headerOverlayTitle} numberOfLines={1}>
            {`${title} · Ep. ${episodeNumber}`}
          </Text>
        </View>

        <Pressable
          onPress={() => void handleCompleteEpisodeManual()}
          disabled={markingManual}
          accessibilityRole="button"
          testID="player-webview-complete-button"
          style={styles.floatingCompleteButton}
        >
          <Text style={styles.floatingCompleteText}>
            {episodeCompleted ? 'Episódio Concluído ✓' : 'Concluir Episódio ✓'}
          </Text>
        </Pressable>
      </View>
    );
  }

  const selectedVideoTrack =
    selectedVideoTrackIndex !== null
      ? { type: SelectedVideoTrackType.INDEX, value: selectedVideoTrackIndex }
      : preferMaxQuality
        ? { type: SelectedVideoTrackType.AUTO }
        : undefined;

  const selectedAudioTrack =
    selectedAudioIndex !== null
      ? { type: SelectedTrackType.INDEX, value: selectedAudioIndex }
      : undefined;

  const selectedTextTrack =
    selectedTextIndex === 'disabled'
      ? { type: SelectedTrackType.DISABLED }
      : selectedTextIndex !== null
        ? { type: SelectedTrackType.INDEX, value: selectedTextIndex }
        : undefined;

  return (
    <View style={styles.playerContainer}>
      <Video
        ref={videoRef}
        testID="video-player-exo"
        source={{
          uri: resolution?.streamUrl,
          headers: resolution?.headers,
        }}
        style={styles.fullSurface}
        paused={paused}
        rate={playbackRate}
        resizeMode={ResizeMode.CONTAIN}
        progressUpdateInterval={1000}
        selectedVideoTrack={selectedVideoTrack}
        selectedAudioTrack={selectedAudioTrack}
        selectedTextTrack={selectedTextTrack}
        onLoad={handleVideoLoad}
        onVideoTracks={handleVideoTracks}
        onProgress={handleVideoProgress}
        onEnd={handleVideoEnd}
        onError={handleVideoError}
      />

      <View style={styles.controlsOverlay} pointerEvents="box-none">
        <View style={styles.topControlsRow}>
          <Pressable
            onPress={() => void handleClose()}
            accessibilityRole="button"
            testID="player-close-button"
            style={styles.overlayButton}
          >
            <Text style={styles.overlayButtonText}>✕ Voltar</Text>
          </Pressable>

          <Text style={styles.headerOverlayTitle} numberOfLines={1}>
            {`${title} · Ep. ${episodeNumber}`}
          </Text>

          <Pressable
            onPress={handleCycleQuality}
            accessibilityRole="button"
            testID="player-quality-badge"
            style={styles.qualityPill}
          >
            <Text style={styles.qualityPillText}>
              {qualityLabel
                ? preferMaxQuality
                  ? `${qualityLabel} / Máxima`
                  : qualityLabel
                : preferMaxQuality
                  ? 'Máxima'
                  : 'Auto'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.centerControlsRow}>
          <Pressable
            onPress={() => handleSeekDelta(-10)}
            accessibilityRole="button"
            testID="player-seek-back"
            style={styles.seekButton}
          >
            <Text style={styles.seekButtonText}>-10s</Text>
          </Pressable>

          <Pressable
            onPress={handleTogglePause}
            accessibilityRole="button"
            testID="player-play-pause"
            style={styles.playPauseButton}
          >
            <Text style={styles.playPauseText}>{paused ? '▶' : '❚❚'}</Text>
          </Pressable>

          <Pressable
            onPress={() => handleSeekDelta(10)}
            accessibilityRole="button"
            testID="player-seek-forward"
            style={styles.seekButton}
          >
            <Text style={styles.seekButtonText}>+10s</Text>
          </Pressable>
        </View>

        <View style={styles.bottomControlsRow}>
          <View style={styles.bottomLeftGroup}>
            <Text style={styles.timeText}>
              {`${formatTime(currentTime)} / ${formatTime(duration)}`}
            </Text>
            {episodeCompleted ? (
              <Text style={styles.completedBadge}>Concluído (85%+) ✓</Text>
            ) : null}
          </View>

          <View style={styles.bottomRightGroup}>
            <Pressable
              onPress={handleCycleRate}
              accessibilityRole="button"
              testID="player-rate-button"
              style={styles.overlayButton}
            >
              <Text style={styles.overlayButtonText}>{`${playbackRate}x`}</Text>
            </Pressable>

            {audioTracks.length > 0 ? (
              <Pressable
                onPress={() =>
                  setSelectedAudioIndex((prev) => {
                    const currentPos = audioTracks.findIndex(
                      (track) => track.index === prev
                    );
                    const nextTrack =
                      audioTracks[(currentPos + 1) % audioTracks.length];
                    return nextTrack.index;
                  })
                }
                accessibilityRole="button"
                testID="player-audio-button"
                style={styles.overlayButton}
              >
                <Text style={styles.overlayButtonText}>
                  {selectedAudioIndex !== null
                    ? audioTracks.find((t) => t.index === selectedAudioIndex)
                        ?.label ?? 'Áudio'
                    : 'Áudio'}
                </Text>
              </Pressable>
            ) : null}

            {textTracks.length > 0 ? (
              <Pressable
                onPress={() =>
                  setSelectedTextIndex((prev) => {
                    if (prev === null || prev === 'disabled') {
                      return textTracks[0].index;
                    }
                    const currentPos = textTracks.findIndex(
                      (track) => track.index === prev
                    );
                    if (currentPos === -1) {
                      return textTracks[0].index;
                    }
                    if (currentPos + 1 >= textTracks.length) {
                      return 'disabled';
                    }
                    return textTracks[currentPos + 1].index;
                  })
                }
                accessibilityRole="button"
                testID="player-subtitle-button"
                style={styles.overlayButton}
              >
                <Text style={styles.overlayButtonText}>
                  {typeof selectedTextIndex === 'number'
                    ? textTracks.find((t) => t.index === selectedTextIndex)
                        ?.label ?? 'Legenda'
                    : selectedTextIndex === 'disabled'
                      ? 'Legenda: Off'
                      : 'Legenda'}
                </Text>
              </Pressable>
            ) : null}

            {showNextEpisode ? (
              <Pressable
                onPress={() => void handleNextEpisode()}
                accessibilityRole="button"
                testID="player-next-episode-button"
                style={styles.nextEpisodeButton}
              >
                <Text style={styles.nextEpisodeText}>Próximo Episódio</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  playerContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  fullSurface: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  controlsOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    padding: THEME_TOKENS.spacing.lg,
    backgroundColor: 'rgba(8, 11, 12, 0.35)',
  },
  topControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.md,
  },
  webViewTopOverlay: {
    position: 'absolute',
    top: THEME_TOKENS.spacing.md,
    left: THEME_TOKENS.spacing.md,
    right: THEME_TOKENS.spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.md,
  },
  headerOverlayTitle: {
    flex: 1,
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  overlayButton: {
    backgroundColor: 'rgba(13, 18, 20, 0.84)',
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
  },
  overlayButtonText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
  },
  qualityPill: {
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
    borderColor: THEME_TOKENS.accent.primary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.pill,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
  },
  qualityPillText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  centerControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: THEME_TOKENS.spacing.xl,
  },
  seekButton: {
    backgroundColor: 'rgba(13, 18, 20, 0.8)',
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.pill,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
  },
  seekButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  playPauseButton: {
    width: 64,
    height: 64,
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playPauseText: {
    fontSize: 22,
    fontWeight: '700',
    color: THEME_TOKENS.bg.canvas,
  },
  bottomControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.md,
  },
  bottomLeftGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
  },
  bottomRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
  },
  timeText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
  },
  completedBadge: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  nextEpisodeButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
  },
  nextEpisodeText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  floatingCompleteButton: {
    position: 'absolute',
    right: THEME_TOKENS.spacing.lg,
    bottom: THEME_TOKENS.spacing.lg,
    backgroundColor: THEME_TOKENS.accent.primary,
    borderRadius: THEME_TOKENS.radius.pill,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
  },
  floatingCompleteText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  centeredBox: {
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
    maxWidth: 460,
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
  errorBody: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.text.secondary,
  },
  errorActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: THEME_TOKENS.spacing.sm,
    marginTop: THEME_TOKENS.spacing.sm,
  },
  primaryButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
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
  },
  secondaryButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
});
