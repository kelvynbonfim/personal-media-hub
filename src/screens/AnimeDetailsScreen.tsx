import React from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FranchiseNode, FranchiseRelationType } from '../catalog/types';
import { getMediaDisplayTitle } from '../components/MediaPosterCard';
import {
  EpisodeProgressRecord,
  LibraryEntryRecord,
  MediaItemRecord,
  UniTvLinkRecord,
  WATCH_STATUSES,
  WatchStatus,
} from '../db/schema';
import { useOptionalAppServices } from '../navigation/AppServicesContext';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';
import {
  BaseDiscoveryScreenProps,
  formatGenresPreview,
  navigateToVideoPlayer,
  persistLibraryStatus,
  resolveDiscoveryServices,
} from './discovery-helpers';

export interface AnimeDetailsRoute {
  params?: {
    anilistId?: number;
    mediaItemId?: string;
  };
}

export interface AnimeDetailsScreenProps extends BaseDiscoveryScreenProps {
  route?: AnimeDetailsRoute;
}

const SCORE_STEPS: readonly number[] = Array.from(
  { length: 21 },
  (_, index) => index * 0.5
);

const RELATION_LABELS_PT: Record<FranchiseRelationType, string> = {
  PREQUEL: 'Anterior',
  CURRENT: 'Atual',
  SEQUEL: 'Continuação',
  SIDE_STORY: 'Extra',
};

function formatClockTime(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildEpisodeNumbers(
  media: MediaItemRecord,
  entry: LibraryEntryRecord | null,
  progressRows: EpisodeProgressRecord[]
): number[] {
  if (media.episodesTotal !== null && media.episodesTotal > 0) {
    return Array.from({ length: media.episodesTotal }, (_, idx) => idx + 1);
  }
  const maxProgressEp = progressRows.reduce(
    (max, row) => Math.max(max, row.episodeNumber),
    0
  );
  const dynamicCount = Math.max(
    entry?.currentEpisode ?? 0,
    maxProgressEp,
    media.nextAiringEp ? Math.max(1, media.nextAiringEp - 1) : 0,
    12
  );
  return Array.from({ length: dynamicCount }, (_, idx) => idx + 1);
}

export function AnimeDetailsScreen(
  props: AnimeDetailsScreenProps = {}
): React.JSX.Element {
  const { navigation, route, services: injectedServices } = props;
  const contextServices = useOptionalAppServices();
  const { catalogService, libraryRepository } = resolveDiscoveryServices(
    injectedServices,
    contextServices
  );
  const servicesReady = Boolean(libraryRepository);

  const targetAnilistId = route?.params?.anilistId;
  const targetMediaItemId = route?.params?.mediaItemId;

  const [loading, setLoading] = React.useState<boolean>(servicesReady);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [media, setMedia] = React.useState<MediaItemRecord | null>(null);
  const [entry, setEntry] = React.useState<LibraryEntryRecord | null>(null);
  const [allEntries, setAllEntries] = React.useState<LibraryEntryRecord[]>([]);
  const [progressList, setProgressList] = React.useState<EpisodeProgressRecord[]>([]);
  const [uniTvLink, setUniTvLink] = React.useState<UniTvLinkRecord | null>(null);

  const [synopsisExpanded, setSynopsisExpanded] = React.useState<boolean>(false);
  const [notesDraft, setNotesDraft] = React.useState<string>('');
  const [notesSavedBanner, setNotesSavedBanner] = React.useState<boolean>(false);
  const [seasonCompletedPromptVisible, setSeasonCompletedPromptVisible] =
    React.useState<boolean>(false);

  const [linkModalVisible, setLinkModalVisible] = React.useState<boolean>(false);
  const [linkVodIdInput, setLinkVodIdInput] = React.useState<string>('');
  const [linkTitleInput, setLinkTitleInput] = React.useState<string>('');
  const [linkSeasonTagInput, setLinkSeasonTagInput] = React.useState<string>('');
  const [linkAudioPref, setLinkAudioPref] = React.useState<'LEG' | 'DUB' | null>(
    null
  );

  const isMountedRef = React.useRef<boolean>(true);
  const hasLoadedOnceRef = React.useRef<boolean>(false);
  const entryRef = React.useRef<LibraryEntryRecord | null>(null);
  const progressListRef = React.useRef<EpisodeProgressRecord[]>([]);

  React.useEffect(() => {
    entryRef.current = entry;
  }, [entry]);

  React.useEffect(() => {
    progressListRef.current = progressList;
  }, [progressList]);

  React.useEffect(() => {
    hasLoadedOnceRef.current = false;
    entryRef.current = null;
    progressListRef.current = [];
    setLoading(servicesReady);
    setMedia(null);
    setEntry(null);
    setAllEntries([]);
    setProgressList([]);
    setUniTvLink(null);
    setNotesDraft('');
    setSynopsisExpanded(false);
    setNotesSavedBanner(false);
    setSeasonCompletedPromptVisible(false);
    setLinkModalVisible(false);
    setErrorMessage(null);
  }, [servicesReady, targetAnilistId, targetMediaItemId]);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadDetails = React.useCallback(async (): Promise<void> => {
    if (!libraryRepository) {
      return;
    }

    if (!hasLoadedOnceRef.current) {
      setLoading(true);
    }
    setErrorMessage(null);

    try {
      let resolvedMedia: MediaItemRecord | null = null;
      if (
        targetMediaItemId &&
        typeof libraryRepository.getMediaItemById === 'function'
      ) {
        resolvedMedia = await libraryRepository.getMediaItemById(targetMediaItemId);
      }
      if (
        !resolvedMedia &&
        typeof targetAnilistId === 'number' &&
        typeof libraryRepository.getMediaItemByAnilistId === 'function'
      ) {
        resolvedMedia = await libraryRepository.getMediaItemByAnilistId(
          targetAnilistId
        );
      }

      if (!resolvedMedia) {
        if (!isMountedRef.current) {
          return;
        }
        setMedia(null);
        setErrorMessage('Anime não encontrado no cache local.');
        hasLoadedOnceRef.current = true;
        return;
      }

      if (
        catalogService &&
        typeof catalogService.enrichWithPortugueseIfConfigured === 'function' &&
        !resolvedMedia.titlePt
      ) {
        try {
          resolvedMedia =
            await catalogService.enrichWithPortugueseIfConfigured(resolvedMedia);
        } catch {
          // Keep existing cached metadata if optional TMDB lookup fails.
        }
      }

      const [entries, epProgress, existingLink] = await Promise.all([
        libraryRepository.getAllLibraryEntries(),
        typeof libraryRepository.getEpisodeProgressList === 'function'
          ? libraryRepository.getEpisodeProgressList(resolvedMedia.id)
          : Promise.resolve<EpisodeProgressRecord[]>([]),
        typeof libraryRepository.getUniTvLink === 'function'
          ? libraryRepository.getUniTvLink(resolvedMedia.id)
          : Promise.resolve<UniTvLinkRecord | null>(null),
      ]);

      if (!isMountedRef.current) {
        return;
      }

      const matchedEntry =
        entries.find((item) => item.mediaItemId === resolvedMedia!.id) ?? null;

      setMedia(resolvedMedia);
      setAllEntries(entries);
      setEntry(matchedEntry);
      setNotesDraft(matchedEntry?.notes ?? '');
      setProgressList(epProgress);
      setUniTvLink(existingLink);
      hasLoadedOnceRef.current = true;
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Não foi possível carregar os detalhes do anime.'
      );
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [catalogService, libraryRepository, targetAnilistId, targetMediaItemId]);

  React.useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  React.useEffect(() => {
    if (!navigation || typeof navigation.addListener !== 'function') {
      return undefined;
    }
    return navigation.addListener('focus', () => {
      if (hasLoadedOnceRef.current) {
        void loadDetails();
      }
    });
  }, [navigation, loadDetails]);

  const franchiseTimeline = React.useMemo<FranchiseNode[]>(() => {
    if (!media) {
      return [];
    }
    if (
      catalogService &&
      typeof catalogService.buildFranchiseTimeline === 'function'
    ) {
      return catalogService.buildFranchiseTimeline(media, allEntries);
    }
    return [
      {
        anilistId: media.anilistId,
        title: getMediaDisplayTitle(media),
        format: media.mediaType,
        relationType: 'CURRENT',
        ...(entry ? { userStatus: entry.status } : {}),
      },
    ];
  }, [allEntries, catalogService, entry, media]);

  const sequelNode = React.useMemo(
    () => franchiseTimeline.find((node) => node.relationType === 'SEQUEL') ?? null,
    [franchiseTimeline]
  );

  const progressByEpisode = React.useMemo(
    () => new Map(progressList.map((row) => [row.episodeNumber, row])),
    [progressList]
  );

  const episodeNumbers = React.useMemo(
    () => (media ? buildEpisodeNumbers(media, entry, progressList) : []),
    [entry, media, progressList]
  );

  const highlightedEpisode = React.useMemo(() => {
    const inProgress = progressList.find(
      (row) => !row.isCompleted && row.positionSeconds > 0
    );
    if (inProgress) {
      return inProgress.episodeNumber;
    }
    const baseNext = (entry?.currentEpisode ?? 0) + 1;
    if (media?.episodesTotal) {
      return Math.min(media.episodesTotal, Math.max(1, baseNext));
    }
    return Math.max(1, baseNext);
  }, [entry?.currentEpisode, media?.episodesTotal, progressList]);

  const handleStatusChange = React.useCallback(
    async (status: WatchStatus): Promise<void> => {
      if (!media || !libraryRepository) {
        return;
      }
      try {
        const updated = await persistLibraryStatus(
          libraryRepository,
          media,
          status
        );
        if (!isMountedRef.current) {
          return;
        }
        const prevEntry = entryRef.current;
        const merged: LibraryEntryRecord = prevEntry
          ? {
              ...updated,
              personalScore: prevEntry.personalScore,
              notes: prevEntry.notes,
              currentEpisode: Math.max(
                prevEntry.currentEpisode,
                updated.currentEpisode
              ),
            }
          : updated;
        entryRef.current = merged;
        setEntry(merged);
        setAllEntries((entriesPrev) => [
          merged,
          ...entriesPrev.filter((item) => item.mediaItemId !== media.id),
        ]);
        if (status === 'COMPLETED') {
          setSeasonCompletedPromptVisible(false);
        }
      } catch (error) {
        if (isMountedRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Não foi possível atualizar o status.'
          );
        }
      }
    },
    [libraryRepository, media]
  );

  const withMediaUpsertRetry = React.useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        if (
          media &&
          libraryRepository &&
          msg.includes('Media item not found') &&
          typeof libraryRepository.upsertMediaItem === 'function'
        ) {
          await libraryRepository.upsertMediaItem(media);
          return action();
        }
        throw error;
      }
    },
    [libraryRepository, media]
  );

  const handleScoreChange = React.useCallback(
    async (nextScore: number | null): Promise<void> => {
      if (!media || !libraryRepository) {
        return;
      }
      try {
        await withMediaUpsertRetry(() =>
          libraryRepository.updatePersonalScore(media.id, nextScore)
        );
        if (!isMountedRef.current) {
          return;
        }
        setEntry((prev) =>
          prev
            ? { ...prev, personalScore: nextScore }
            : {
                id: `entry-${media.id}`,
                mediaItemId: media.id,
                status: 'PLAN_TO_WATCH',
                personalScore: nextScore,
                currentEpisode: 0,
                notes: notesDraft,
                rewatchCount: 0,
                startedAt: null,
                completedAt: null,
                updatedAt: new Date().toISOString(),
                dirty: 1,
              }
        );
      } catch (error) {
        if (isMountedRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Não foi possível salvar a nota.'
          );
        }
      }
    },
    [libraryRepository, media, notesDraft, withMediaUpsertRetry]
  );

  const handleSaveNotes = React.useCallback(async (): Promise<void> => {
    if (!media || !libraryRepository) {
      return;
    }
    setNotesSavedBanner(false);
    try {
      await withMediaUpsertRetry(() =>
        libraryRepository.updateNotes(media.id, notesDraft)
      );
      if (!isMountedRef.current) {
        return;
      }
      setEntry((prev) =>
        prev
          ? { ...prev, notes: notesDraft }
          : {
              id: `entry-${media.id}`,
              mediaItemId: media.id,
              status: 'PLAN_TO_WATCH',
              personalScore: null,
              currentEpisode: 0,
              notes: notesDraft,
              rewatchCount: 0,
              startedAt: null,
              completedAt: null,
              updatedAt: new Date().toISOString(),
              dirty: 1,
            }
      );
      setNotesSavedBanner(true);
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Não foi possível salvar as anotações.'
        );
      }
    }
  }, [libraryRepository, media, notesDraft, withMediaUpsertRetry]);

  const handleToggleEpisodeManual = React.useCallback(
    async (episodeNumber: number): Promise<void> => {
      if (!media || !libraryRepository) {
        return;
      }
      const existing = progressByEpisode.get(episodeNumber);
      const nextCompleted = !Boolean(existing?.isCompleted);
      try {
        const result = await withMediaUpsertRetry(() =>
          libraryRepository.toggleEpisodeManual(
            media.id,
            episodeNumber,
            nextCompleted
          )
        );
        if (!isMountedRef.current) {
          return;
        }
        setProgressList((prevProgress) => {
          const existingRow = prevProgress.find(
            (row) => row.episodeNumber === episodeNumber
          );
          const rest = prevProgress.filter(
            (row) => row.episodeNumber !== episodeNumber
          );
          const updatedRow: EpisodeProgressRecord = existingRow
            ? {
                ...existingRow,
                isCompleted: nextCompleted,
                watchedVia: 'MANUAL',
                updatedAt: new Date().toISOString(),
              }
            : {
                id: `ep-${media.id}-${episodeNumber}`,
                mediaItemId: media.id,
                episodeNumber,
                positionSeconds: 0,
                durationSeconds: 0,
                isCompleted: nextCompleted,
                watchedVia: 'MANUAL',
                updatedAt: new Date().toISOString(),
                dirty: 1,
              };
          const next = [...rest, updatedRow].sort(
            (a, b) => a.episodeNumber - b.episodeNumber
          );
          progressListRef.current = next;
          return next;
        });
        const prevEntry = entryRef.current;
        const nowIso = new Date().toISOString();
        let nextEntry: LibraryEntryRecord | null = prevEntry;

        if (!prevEntry) {
          nextEntry = {
            id: `entry-${media.id}`,
            mediaItemId: media.id,
            status: 'WATCHING',
            personalScore: null,
            currentEpisode: nextCompleted ? episodeNumber : 0,
            notes: notesDraft,
            rewatchCount: 0,
            startedAt: nowIso,
            completedAt: null,
            updatedAt: nowIso,
            dirty: 1,
          };
        } else if (nextCompleted) {
          nextEntry = {
            ...prevEntry,
            currentEpisode: Math.max(prevEntry.currentEpisode, episodeNumber),
          };
        } else if (prevEntry.currentEpisode === episodeNumber) {
          const maxCompleted = progressListRef.current
            .filter(
              (row) => row.isCompleted && row.episodeNumber !== episodeNumber
            )
            .reduce((max, row) => Math.max(max, row.episodeNumber), 0);
          nextEntry = {
            ...prevEntry,
            currentEpisode:
              maxCompleted > 0 ? maxCompleted : Math.max(0, episodeNumber - 1),
          };
        }

        if (nextEntry && nextEntry !== prevEntry) {
          entryRef.current = nextEntry;
          setEntry(nextEntry);
          setAllEntries((entriesPrev) => [
            nextEntry!,
            ...entriesPrev.filter((item) => item.mediaItemId !== media.id),
          ]);
        }
        if (result.seasonCompletedPrompt) {
          setSeasonCompletedPromptVisible(true);
        }
      } catch (error) {
        if (isMountedRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Não foi possível atualizar o episódio.'
          );
        }
      }
    },
    [
      libraryRepository,
      media,
      notesDraft,
      progressByEpisode,
      withMediaUpsertRetry,
    ]
  );

  const openUniTvLinkModal = React.useCallback(() => {
    if (!media) {
      return;
    }
    setLinkVodIdInput(uniTvLink?.unitvVodId ?? '');
    setLinkTitleInput(uniTvLink?.unitvTitle ?? getMediaDisplayTitle(media));
    setLinkSeasonTagInput(uniTvLink?.unitvSeasonTag ?? '');
    setLinkAudioPref(
      uniTvLink?.preferredAudioOrSub === 'DUB' ||
        uniTvLink?.preferredAudioOrSub === 'LEG'
        ? uniTvLink.preferredAudioOrSub
        : null
    );
    setLinkModalVisible(true);
  }, [media, uniTvLink]);

  const handleSaveUniTvLink = React.useCallback(async (): Promise<void> => {
    if (!media || !libraryRepository) {
      return;
    }
    const vodId = linkVodIdInput.trim();
    const title = linkTitleInput.trim();
    if (!vodId || !title) {
      setErrorMessage('Informe o ID VOD e o título no UniTV para salvar o vínculo.');
      return;
    }

    const record: UniTvLinkRecord = {
      mediaItemId: media.id,
      unitvVodId: vodId,
      unitvTitle: title,
      unitvSeasonTag: linkSeasonTagInput.trim() || null,
      preferredAudioOrSub: linkAudioPref,
      lastVerifiedAt: new Date().toISOString(),
    };

    try {
      await withMediaUpsertRetry(() =>
        libraryRepository.saveUniTvLink(record)
      );
      if (!isMountedRef.current) {
        return;
      }
      setUniTvLink(record);
      setLinkModalVisible(false);
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Não foi possível salvar o vínculo UniTV.'
        );
      }
    }
  }, [
    libraryRepository,
    linkAudioPref,
    linkSeasonTagInput,
    linkTitleInput,
    linkVodIdInput,
    media,
    withMediaUpsertRetry,
  ]);

  if (!servicesReady) {
    return (
      <View style={styles.centeredBox}>
        <Text style={styles.emptyTitle}>Detalhes do Anime</Text>
        <Text style={styles.emptySubtitle}>
          Conecte a biblioteca local para visualizar episódios e progresso.
        </Text>
      </View>
    );
  }

  if (loading && !media) {
    return (
      <View style={styles.centeredBox}>
        <ActivityIndicator size="large" color={THEME_TOKENS.accent.primary} />
        <Text style={styles.emptySubtitle}>Carregando detalhes do anime...</Text>
      </View>
    );
  }

  if (!media) {
    return (
      <View style={styles.centeredBox}>
        <Text style={styles.emptyTitle}>Título indisponível</Text>
        <Text style={styles.emptySubtitle}>
          {errorMessage ?? 'Anime não encontrado no cache local.'}
        </Text>
        {navigation?.goBack ? (
          <Pressable
            onPress={() => navigation.goBack?.()}
            accessibilityRole="button"
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Voltar</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const displayTitle = getMediaDisplayTitle(media);
  const genresLine = formatGenresPreview(media.genresJson, 4);
  const currentScore = entry?.personalScore ?? null;

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.heroCard}>
          <View style={styles.heroTopRow}>
            <View style={styles.posterFrame}>
              {media.coverUrl.trim().length > 0 ? (
                <Image
                  source={{ uri: media.coverUrl }}
                  style={styles.posterImage}
                  resizeMode="cover"
                />
              ) : (
                <View style={styles.posterFallback}>
                  <Text style={styles.posterFallbackText}>
                    {displayTitle.slice(0, 2).toUpperCase()}
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.heroInfo}>
              <Text style={styles.title}>{displayTitle}</Text>
              {media.titleRomaji !== displayTitle ? (
                <Text style={styles.subtitle}>{media.titleRomaji}</Text>
              ) : null}
              {genresLine ? (
                <Text style={styles.genresText}>{genresLine}</Text>
              ) : null}
              <Text style={styles.metaText}>
                {[
                  media.seasonYear ? String(media.seasonYear) : null,
                  media.episodesTotal
                    ? `${media.episodesTotal} episódios`
                    : 'Em exibição',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>

              <Pressable
                onPress={openUniTvLinkModal}
                accessibilityRole="button"
                testID="details-unitv-link-button"
                style={({ pressed }) => [
                  styles.unitvBadgeButton,
                  uniTvLink && styles.unitvBadgeLinked,
                  pressed && styles.pressedOpacity,
                ]}
              >
                <Text
                  style={[
                    styles.unitvBadgeText,
                    uniTvLink && styles.unitvBadgeTextLinked,
                  ]}
                >
                  {uniTvLink ? 'Full HD ✓' : 'Vincular no UniTV'}
                </Text>
                {uniTvLink ? (
                  <Text style={styles.unitvSubLabel} numberOfLines={1}>
                    {uniTvLink.unitvTitle}
                  </Text>
                ) : null}
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Seu Status</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRail}
          >
            {WATCH_STATUSES.map((statusOption) => {
              const meta = STATUS_META[statusOption];
              const isCurrent = entry?.status === statusOption;
              return (
                <Pressable
                  key={statusOption}
                  onPress={() => void handleStatusChange(statusOption)}
                  accessibilityRole="button"
                  testID={`details-status-chip-${statusOption}`}
                  style={[
                    styles.statusChip,
                    isCurrent && {
                      backgroundColor: meta.backgroundColor,
                      borderColor: meta.color,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusChipText,
                      isCurrent && { color: meta.color, fontWeight: '700' },
                    ]}
                  >
                    {meta.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.scoreHeaderRow}>
            <Text style={styles.sectionTitle}>Nota Pessoal</Text>
            <View style={styles.scoreStepperRow}>
              <Pressable
                onPress={() =>
                  void handleScoreChange(
                    currentScore === null
                      ? 0
                      : Math.max(0, Math.round((currentScore - 0.5) * 2) / 2)
                  )
                }
                accessibilityRole="button"
                testID="score-decrement"
                style={styles.stepperButton}
              >
                <Text style={styles.stepperButtonText}>-0.5</Text>
              </Pressable>
              <Text testID="details-score-value" style={styles.scoreDisplay}>
                {currentScore !== null ? `★ ${currentScore.toFixed(1)}` : 'Sem nota'}
              </Text>
              <Pressable
                onPress={() =>
                  void handleScoreChange(
                    currentScore === null
                      ? 0.5
                      : Math.min(10, Math.round((currentScore + 0.5) * 2) / 2)
                  )
                }
                accessibilityRole="button"
                testID="score-increment"
                style={styles.stepperButton}
              >
                <Text style={styles.stepperButtonText}>+0.5</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRail}
          >
            <Pressable
              onPress={() => void handleScoreChange(null)}
              accessibilityRole="button"
              testID="score-clear"
              style={[
                styles.scoreChip,
                currentScore === null && styles.scoreChipSelected,
              ]}
            >
              <Text
                style={[
                  styles.scoreChipText,
                  currentScore === null && styles.scoreChipTextSelected,
                ]}
              >
                Limpar
              </Text>
            </Pressable>
            {SCORE_STEPS.map((scoreValue) => {
              const selected = currentScore === scoreValue;
              return (
                <Pressable
                  key={scoreValue}
                  onPress={() => void handleScoreChange(scoreValue)}
                  accessibilityRole="button"
                  testID={`score-chip-${scoreValue}`}
                  style={[
                    styles.scoreChip,
                    selected && styles.scoreChipSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.scoreChipText,
                      selected && styles.scoreChipTextSelected,
                    ]}
                  >
                    {Number.isInteger(scoreValue)
                      ? String(scoreValue)
                      : scoreValue.toFixed(1)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Linha do Tempo da Franquia</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRail}
          >
            {franchiseTimeline.map((node) => {
              const isCurrent = node.relationType === 'CURRENT';
              const statusMeta = node.userStatus
                ? STATUS_META[node.userStatus]
                : undefined;
              return (
                <Pressable
                  key={`${node.relationType}-${node.anilistId}`}
                  disabled={isCurrent}
                  onPress={() =>
                    navigation?.navigate('AnimeDetails', {
                      anilistId: node.anilistId,
                    })
                  }
                  accessibilityRole="button"
                  testID={`franchise-node-${node.anilistId}`}
                  style={[
                    styles.franchiseNodeCard,
                    isCurrent && styles.franchiseNodeCurrent,
                  ]}
                >
                  <Text style={styles.franchiseRelationTag}>
                    {RELATION_LABELS_PT[node.relationType]}
                  </Text>
                  <Text style={styles.franchiseTitle} numberOfLines={2}>
                    {node.title}
                  </Text>
                  <View style={styles.franchiseMetaRow}>
                    <Text style={styles.franchiseFormat}>{node.format}</Text>
                    {statusMeta ? (
                      <Text
                        style={[
                          styles.franchiseUserStatus,
                          { color: statusMeta.color },
                        ]}
                      >
                        {statusMeta.shortLabel}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {media.synopsis ? (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Sinopse</Text>
            <Text
              numberOfLines={synopsisExpanded ? undefined : 3}
              testID="details-synopsis-text"
              style={styles.synopsisBody}
            >
              {media.synopsis}
            </Text>
            <Pressable
              onPress={() => setSynopsisExpanded((prev) => !prev)}
              accessibilityRole="button"
              testID="details-synopsis-toggle"
              style={styles.synopsisToggle}
            >
              <Text style={styles.synopsisToggleText}>
                {synopsisExpanded ? 'Ver menos' : 'Ver mais'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Anotações Pessoais</Text>
          <TextInput
            value={notesDraft}
            onChangeText={(text) => {
              setNotesDraft(text);
              setNotesSavedBanner(false);
            }}
            multiline
            placeholder="Escreva lembretes, opiniões ou em qual minuto parou na TV..."
            placeholderTextColor={THEME_TOKENS.text.secondary}
            testID="details-notes-input"
            style={styles.notesInput}
          />
          <View style={styles.notesFooterRow}>
            <Pressable
              onPress={() => void handleSaveNotes()}
              accessibilityRole="button"
              testID="details-save-notes-button"
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Salvar notas</Text>
            </Pressable>
            {notesSavedBanner ? (
              <Text style={styles.notesSavedText}>Notas salvas ✓</Text>
            ) : null}
          </View>
        </View>

        {seasonCompletedPromptVisible ? (
          <View
            testID="season-completed-prompt"
            style={styles.seasonCompletedCard}
          >
            <Text style={styles.seasonCompletedTitle}>
              Temporada concluída!
            </Text>
            <Text style={styles.seasonCompletedSubtitle}>
              Você chegou ao último episódio. Deseja mover este título para Concluído?
            </Text>
            <View style={styles.seasonCompletedActions}>
              <Pressable
                onPress={() => void handleStatusChange('COMPLETED')}
                accessibilityRole="button"
                testID="season-completed-confirm"
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  Mover para Concluído
                </Text>
              </Pressable>
              {sequelNode ? (
                <Pressable
                  onPress={() =>
                    navigation?.navigate('AnimeDetails', {
                      anilistId: sequelNode.anilistId,
                    })
                  }
                  accessibilityRole="button"
                  testID="season-completed-sequel"
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>
                    Ir para continuação
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        <View style={styles.sectionCard}>
          <View style={styles.episodesHeaderRow}>
            <Text style={styles.sectionTitle}>Episódios</Text>
            {!uniTvLink ? (
              <Text style={styles.unlinkedHint}>
                Sem vínculo UniTV · Use Play para buscar ou ✓ manual
              </Text>
            ) : null}
          </View>

          <View style={styles.episodesList}>
            {episodeNumbers.map((epNumber) => {
              const progress = progressByEpisode.get(epNumber);
              const isCompleted = Boolean(progress?.isCompleted);
              const isCurrent = epNumber === highlightedEpisode;
              const ratio =
                progress && progress.durationSeconds > 0
                  ? Math.min(1, progress.positionSeconds / progress.durationSeconds)
                  : 0;

              let progressCaption = 'Não assistido';
              if (isCompleted) {
                progressCaption = 'Concluído ✓';
              } else if (progress && progress.positionSeconds > 0) {
                progressCaption = `Parou em ${formatClockTime(
                  progress.positionSeconds
                )}`;
              }

              return (
                <View
                  key={epNumber}
                  testID={`episode-row-${epNumber}`}
                  style={[
                    styles.episodeRow,
                    isCurrent && styles.episodeRowCurrent,
                  ]}
                >
                  <View style={styles.episodeInfo}>
                    <Text style={styles.episodeTitle}>
                      {`Ep. ${String(epNumber).padStart(2, '0')}`}
                    </Text>
                    <Text
                      style={[
                        styles.episodeStatus,
                        isCompleted && styles.episodeStatusCompleted,
                      ]}
                    >
                      {progressCaption}
                    </Text>
                    {!isCompleted && ratio > 0 ? (
                      <View style={styles.episodeProgressTrack}>
                        <View
                          style={[
                            styles.episodeProgressFill,
                            {
                              width: `${Math.round(ratio * 100)}%` as `${number}%`,
                            },
                          ]}
                        />
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.episodeActions}>
                    <Pressable
                      onPress={() =>
                        navigateToVideoPlayer(navigation, media.id, epNumber)
                      }
                      accessibilityRole="button"
                      testID={`episode-play-${epNumber}`}
                      style={({ pressed }) => [
                        styles.episodePlayButton,
                        pressed && styles.pressedOpacity,
                      ]}
                    >
                      <Text style={styles.episodePlayText}>▶ Play</Text>
                    </Pressable>

                    <Pressable
                      onPress={() => void handleToggleEpisodeManual(epNumber)}
                      accessibilityRole="button"
                      accessibilityLabel={`Marcar episódio ${epNumber}`}
                      testID={`episode-toggle-${epNumber}`}
                      style={[
                        styles.episodeCheckButton,
                        isCompleted && styles.episodeCheckButtonActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.episodeCheckText,
                          isCompleted && styles.episodeCheckTextActive,
                        ]}
                      >
                        ✓
                      </Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>

      <Modal
        visible={linkModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLinkModalVisible(false)}
        testID="details-unitv-modal"
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Vincular manualmente no UniTV</Text>

            <Text style={styles.inputLabel}>ID VOD no UniTV</Text>
            <TextInput
              value={linkVodIdInput}
              onChangeText={setLinkVodIdInput}
              placeholder="Ex: vod-154587"
              placeholderTextColor={THEME_TOKENS.text.secondary}
              testID="unitv-modal-vod-id-input"
              style={styles.modalInput}
            />

            <Text style={styles.inputLabel}>Título no catálogo UniTV</Text>
            <TextInput
              value={linkTitleInput}
              onChangeText={setLinkTitleInput}
              placeholder="Ex: Frieren (Dublado)"
              placeholderTextColor={THEME_TOKENS.text.secondary}
              testID="unitv-modal-title-input"
              style={styles.modalInput}
            />

            <Text style={styles.inputLabel}>Tag de temporada (opcional)</Text>
            <TextInput
              value={linkSeasonTagInput}
              onChangeText={setLinkSeasonTagInput}
              placeholder="Ex: S1"
              placeholderTextColor={THEME_TOKENS.text.secondary}
              testID="unitv-modal-season-input"
              style={styles.modalInput}
            />

            <Text style={styles.inputLabel}>Preferência de áudio / legenda</Text>
            <View style={styles.audioChoiceRow}>
              {(['LEG', 'DUB'] as const).map((choice) => {
                const selected = linkAudioPref === choice;
                return (
                  <Pressable
                    key={choice}
                    onPress={() =>
                      setLinkAudioPref((prev) => (prev === choice ? null : choice))
                    }
                    accessibilityRole="button"
                    testID={`unitv-modal-audio-${choice}`}
                    style={[
                      styles.audioChip,
                      selected && styles.audioChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.audioChipText,
                        selected && styles.audioChipTextSelected,
                      ]}
                    >
                      {choice === 'LEG' ? 'Legendado (LEG)' : 'Dublado (DUB)'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.modalActionsRow}>
              <Pressable
                onPress={() => setLinkModalVisible(false)}
                accessibilityRole="button"
                testID="unitv-modal-cancel"
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Cancelar</Text>
              </Pressable>
              <Pressable
                onPress={() => void handleSaveUniTvLink()}
                accessibilityRole="button"
                testID="unitv-modal-save"
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Salvar vínculo</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  emptyTitle: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.primary,
  },
  emptySubtitle: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.text.secondary,
    textAlign: 'center',
  },
  errorBanner: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.accent.secondary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
  },
  errorText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.secondary,
  },
  heroCard: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.md,
  },
  heroTopRow: {
    flexDirection: 'row',
    gap: THEME_TOKENS.spacing.md,
  },
  posterFrame: {
    width: 108,
    aspectRatio: 2 / 3,
    borderRadius: THEME_TOKENS.radius.md,
    overflow: 'hidden',
    backgroundColor: THEME_TOKENS.bg.surface,
  },
  posterImage: {
    width: '100%',
    height: '100%',
  },
  posterFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  posterFallbackText: {
    ...THEME_TOKENS.typography.heroTitle,
    color: THEME_TOKENS.text.secondary,
  },
  heroInfo: {
    flex: 1,
    gap: THEME_TOKENS.spacing.xs,
  },
  title: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.primary,
  },
  subtitle: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  genresText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
  },
  metaText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  unitvBadgeButton: {
    marginTop: THEME_TOKENS.spacing.xs,
    alignSelf: 'flex-start',
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
    gap: 2,
  },
  unitvBadgeLinked: {
    borderColor: THEME_TOKENS.accent.primary,
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
  },
  unitvBadgeText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.text.primary,
  },
  unitvBadgeTextLinked: {
    color: THEME_TOKENS.accent.primary,
  },
  unitvSubLabel: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
    fontSize: 11,
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
  chipRail: {
    gap: THEME_TOKENS.spacing.sm,
    alignItems: 'center',
  },
  statusChip: {
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: 7,
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  statusChipText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  scoreHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.sm,
  },
  scoreStepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
  },
  stepperButton: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.sm,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 4,
  },
  stepperButtonText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.text.primary,
  },
  scoreDisplay: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.accent.gold,
  },
  scoreChip: {
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 5,
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  scoreChipSelected: {
    backgroundColor: THEME_TOKENS.accent.gold,
    borderColor: THEME_TOKENS.accent.gold,
  },
  scoreChipText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  scoreChipTextSelected: {
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  franchiseNodeCard: {
    width: 156,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.sm,
    gap: 4,
  },
  franchiseNodeCurrent: {
    borderColor: THEME_TOKENS.accent.primary,
  },
  franchiseRelationTag: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  franchiseTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  franchiseMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  franchiseFormat: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  franchiseUserStatus: {
    ...THEME_TOKENS.typography.badge,
  },
  synopsisBody: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.text.secondary,
  },
  synopsisToggle: {
    alignSelf: 'flex-start',
  },
  synopsisToggleText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.accent.primary,
  },
  notesInput: {
    minHeight: 78,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
    color: THEME_TOKENS.text.primary,
    textAlignVertical: 'top',
    ...THEME_TOKENS.typography.body,
  },
  notesFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.md,
  },
  notesSavedText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
  },
  seasonCompletedCard: {
    backgroundColor: STATUS_META.COMPLETED.backgroundColor,
    borderColor: THEME_TOKENS.accent.primary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.sm,
  },
  seasonCompletedTitle: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.accent.primary,
  },
  seasonCompletedSubtitle: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.text.primary,
  },
  seasonCompletedActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: THEME_TOKENS.spacing.sm,
  },
  episodesHeaderRow: {
    gap: 2,
  },
  unlinkedHint: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.gold,
  },
  episodesList: {
    gap: THEME_TOKENS.spacing.sm,
  },
  episodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.md,
  },
  episodeRowCurrent: {
    borderColor: THEME_TOKENS.accent.primary,
  },
  episodeInfo: {
    flex: 1,
    gap: 4,
  },
  episodeTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  episodeStatus: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  episodeStatusCompleted: {
    color: THEME_TOKENS.accent.primary,
  },
  episodeProgressTrack: {
    height: 4,
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.bg.card,
    overflow: 'hidden',
  },
  episodeProgressFill: {
    height: '100%',
    backgroundColor: THEME_TOKENS.accent.primary,
  },
  episodeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
  },
  episodePlayButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.sm,
  },
  episodePlayText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  episodeCheckButton: {
    width: 36,
    height: 36,
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  episodeCheckButtonActive: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderColor: THEME_TOKENS.accent.primary,
  },
  episodeCheckText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.secondary,
  },
  episodeCheckTextActive: {
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(8, 11, 12, 0.85)',
    justifyContent: 'center',
    padding: THEME_TOKENS.spacing.lg,
  },
  modalCard: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.xl,
    padding: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.sm,
  },
  modalTitle: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.primary,
    marginBottom: THEME_TOKENS.spacing.xs,
  },
  inputLabel: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  modalInput: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.sm,
    color: THEME_TOKENS.text.primary,
    ...THEME_TOKENS.typography.body,
  },
  audioChoiceRow: {
    flexDirection: 'row',
    gap: THEME_TOKENS.spacing.sm,
  },
  audioChip: {
    flex: 1,
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    alignItems: 'center',
  },
  audioChipSelected: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderColor: THEME_TOKENS.accent.primary,
  },
  audioChipText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  audioChipTextSelected: {
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  modalActionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: THEME_TOKENS.spacing.sm,
    marginTop: THEME_TOKENS.spacing.sm,
  },
  pressedOpacity: {
    opacity: 0.85,
  },
});
