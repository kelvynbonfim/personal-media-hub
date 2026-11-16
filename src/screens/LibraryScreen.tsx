import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  getMediaDisplayTitle,
  MediaPosterCard,
} from '../components/MediaPosterCard';
import {
  EpisodeProgressRecord,
  LibraryEntryRecord,
  MediaItemRecord,
  WATCH_STATUSES,
  WatchStatus,
} from '../db/schema';
import { useOptionalAppServices } from '../navigation/AppServicesContext';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';
import {
  BaseDiscoveryScreenProps,
  formatGenresPreview,
  navigateToAnimeDetails,
  navigateToVideoPlayer,
  resolveDiscoveryServices,
} from './discovery-helpers';

export type LibraryScreenProps = BaseDiscoveryScreenProps;

type LibraryEntryWithMedia = LibraryEntryRecord & { media: MediaItemRecord };
type LibraryLayoutMode = 'grid' | 'list';
type LibrarySortMode = 'RECENT' | 'SCORE' | 'PROGRESS' | 'TITLE';

const EMPTY_BY_STATUS: Record<WatchStatus, LibraryEntryWithMedia[]> = {
  WATCHING: [],
  PLAN_TO_WATCH: [],
  COMPLETED: [],
  PAUSED: [],
  DROPPED: [],
  REWATCHING: [],
};

const SORT_OPTIONS: ReadonlyArray<{ value: LibrarySortMode; label: string }> = [
  { value: 'RECENT', label: 'Último assistido' },
  { value: 'SCORE', label: 'Minha Nota' },
  { value: 'PROGRESS', label: 'Progresso' },
  { value: 'TITLE', label: 'A–Z' },
];

const ROULETTE_GENRE_OPTIONS: ReadonlyArray<{ value: string | undefined; label: string }> = [
  { value: undefined, label: 'Todos' },
  { value: 'Action', label: 'Ação' },
  { value: 'Fantasy', label: 'Fantasia' },
  { value: 'Comedy', label: 'Comédia' },
  { value: 'Drama', label: 'Drama' },
  { value: 'Romance', label: 'Romance' },
];

function formatProgressLabel(entry: LibraryEntryWithMedia): string {
  const total = entry.media.episodesTotal;
  if (total !== null && total > 0) {
    return `Ep. ${entry.currentEpisode}/${total}`;
  }
  return entry.currentEpisode > 0 ? `Ep. ${entry.currentEpisode}` : 'Não iniciado';
}

function getProgressRatio(entry: LibraryEntryWithMedia): number {
  const total = entry.media.episodesTotal;
  if (total !== null && total > 0) {
    return Math.min(1, Math.max(0, entry.currentEpisode / total));
  }
  return 0;
}

function sortLibraryEntries(
  entries: LibraryEntryWithMedia[],
  sortMode: LibrarySortMode
): LibraryEntryWithMedia[] {
  const copy = [...entries];
  copy.sort((a, b) => {
    if (sortMode === 'SCORE') {
      const scoreA = a.personalScore ?? -1;
      const scoreB = b.personalScore ?? -1;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    }
    if (sortMode === 'PROGRESS') {
      const ratioDiff = getProgressRatio(b) - getProgressRatio(a);
      if (ratioDiff !== 0) {
        return ratioDiff;
      }
      if (b.currentEpisode !== a.currentEpisode) {
        return b.currentEpisode - a.currentEpisode;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    }
    if (sortMode === 'TITLE') {
      return getMediaDisplayTitle(a.media).localeCompare(
        getMediaDisplayTitle(b.media),
        'pt-BR',
        { sensitivity: 'base' }
      );
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return copy;
}

function countCompletedEpisodesByMedia(
  progressRows: EpisodeProgressRecord[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of progressRows) {
    if (!row.isCompleted) {
      continue;
    }
    counts.set(row.mediaItemId, (counts.get(row.mediaItemId) ?? 0) + 1);
  }
  return counts;
}

export function LibraryScreen(props: LibraryScreenProps = {}): React.JSX.Element {
  const { navigation, services: injectedServices } = props;
  const contextServices = useOptionalAppServices();
  const { libraryRepository } = resolveDiscoveryServices(
    injectedServices,
    contextServices
  );
  const servicesReady = Boolean(libraryRepository);

  const [selectedStatus, setSelectedStatus] = React.useState<WatchStatus>('WATCHING');
  const [layoutMode, setLayoutMode] = React.useState<LibraryLayoutMode>('grid');
  const [sortMode, setSortMode] = React.useState<LibrarySortMode>('RECENT');
  const [entriesByStatus, setEntriesByStatus] =
    React.useState<Record<WatchStatus, LibraryEntryWithMedia[]>>(EMPTY_BY_STATUS);
  const [completedEpMap, setCompletedEpMap] = React.useState<Map<string, number>>(
    () => new Map()
  );
  const [loading, setLoading] = React.useState<boolean>(servicesReady);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const [rouletteGenre, setRouletteGenre] = React.useState<string | undefined>(
    undefined
  );
  const [shortOnly, setShortOnly] = React.useState<boolean>(false);
  const [pickedEntry, setPickedEntry] = React.useState<LibraryEntryWithMedia | null>(
    null
  );
  const [rouletteMessage, setRouletteMessage] = React.useState<string | null>(null);

  const isMountedRef = React.useRef<boolean>(true);
  const hasLoadedOnceRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadLibrary = React.useCallback(async (): Promise<void> => {
    if (!libraryRepository) {
      return;
    }

    if (!hasLoadedOnceRef.current) {
      setLoading(true);
    }
    setErrorMessage(null);

    try {
      const progressPromise =
        typeof libraryRepository.getAllEpisodeProgress === 'function'
          ? libraryRepository.getAllEpisodeProgress().catch(() => [])
          : Promise.resolve<EpisodeProgressRecord[]>([]);

      const [statusBuckets, progressRows] = await Promise.all([
        Promise.all(
          WATCH_STATUSES.map(async (status) => ({
            status,
            items: await libraryRepository.getLibraryByStatus(status),
          }))
        ),
        progressPromise,
      ]);

      if (!isMountedRef.current) {
        return;
      }

      const nextMap: Record<WatchStatus, LibraryEntryWithMedia[]> = {
        WATCHING: [],
        PLAN_TO_WATCH: [],
        COMPLETED: [],
        PAUSED: [],
        DROPPED: [],
        REWATCHING: [],
      };
      for (const bucket of statusBuckets) {
        nextMap[bucket.status] = bucket.items;
      }

      setEntriesByStatus(nextMap);
      setCompletedEpMap(countCompletedEpisodesByMedia(progressRows));
      hasLoadedOnceRef.current = true;
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Não foi possível carregar sua biblioteca.'
      );
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [libraryRepository]);

  React.useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  React.useEffect(() => {
    if (!navigation || typeof navigation.addListener !== 'function') {
      return undefined;
    }
    return navigation.addListener('focus', () => {
      if (hasLoadedOnceRef.current) {
        void loadLibrary();
      }
    });
  }, [navigation, loadLibrary]);

  const summary = React.useMemo(() => {
    const allEntries = WATCH_STATUSES.flatMap((status) => entriesByStatus[status]);
    const completedCount = entriesByStatus.COMPLETED.length;
    const watchingCount =
      entriesByStatus.WATCHING.length + entriesByStatus.REWATCHING.length;
    const episodesWatchedCount = allEntries.reduce((acc, entry) => {
      const completedFromProgress = completedEpMap.get(entry.mediaItemId) ?? 0;
      return acc + Math.max(entry.currentEpisode, completedFromProgress);
    }, 0);
    return {
      completedCount,
      watchingCount,
      episodesWatchedCount,
      totalCount: allEntries.length,
    };
  }, [completedEpMap, entriesByStatus]);

  const displayedEntries = React.useMemo(
    () => sortLibraryEntries(entriesByStatus[selectedStatus] ?? [], sortMode),
    [entriesByStatus, selectedStatus, sortMode]
  );

  const handlePickForMe = React.useCallback(() => {
    if (!libraryRepository) {
      return;
    }
    const basePlan = entriesByStatus.PLAN_TO_WATCH;
    const candidates = shortOnly
      ? basePlan.filter(
          (entry) =>
            entry.media.episodesTotal !== null && entry.media.episodesTotal <= 12
        )
      : basePlan;

    const picked = libraryRepository.pickRandomPlanToWatch(
      candidates,
      rouletteGenre
    );
    if (!picked) {
      setPickedEntry(null);
      setRouletteMessage(
        'Nenhum título em "Pretendo assistir" corresponde ao filtro escolhido.'
      );
      return;
    }
    setRouletteMessage(null);
    setPickedEntry(picked);
  }, [entriesByStatus.PLAN_TO_WATCH, libraryRepository, rouletteGenre, shortOnly]);

  const renderGridItem = ({ item }: { item: LibraryEntryWithMedia }) => (
    <MediaPosterCard
      item={item.media}
      status={item.status}
      progressLabel={formatProgressLabel(item)}
      onPress={() => navigateToAnimeDetails(navigation, item.media)}
      testID={`library-card-${item.media.id}`}
      style={styles.gridCard}
    />
  );

  const renderListItem = ({ item }: { item: LibraryEntryWithMedia }) => {
    const title = getMediaDisplayTitle(item.media);
    const meta = STATUS_META[item.status];
    const genres = formatGenresPreview(item.media.genresJson);
    const progressText = formatProgressLabel(item);

    return (
      <Pressable
        onPress={() => navigateToAnimeDetails(navigation, item.media)}
        accessibilityRole="button"
        testID={`library-row-${item.media.id}`}
        style={({ pressed }) => [
          styles.listRow,
          pressed && styles.pressedOpacity,
        ]}
      >
        <View style={styles.listThumbFrame}>
          {item.media.coverUrl.trim().length > 0 ? (
            <Image
              source={{ uri: item.media.coverUrl }}
              style={styles.listThumb}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.listThumbFallback}>
              <Text style={styles.listThumbFallbackText}>
                {title.slice(0, 2).toUpperCase()}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.listBody}>
          <Text style={styles.listTitle} numberOfLines={2}>
            {title}
          </Text>
          <View style={styles.listMetaRow}>
            <Text style={[styles.listStatusText, { color: meta.color }]}>
              {meta.shortLabel}
            </Text>
            <Text style={styles.listProgressText}>{progressText}</Text>
            {item.personalScore !== null ? (
              <Text style={styles.listScoreText}>
                {`★ ${item.personalScore.toFixed(1)}`}
              </Text>
            ) : null}
          </View>
          {genres ? (
            <Text style={styles.listGenresText} numberOfLines={1}>
              {genres}
            </Text>
          ) : null}
        </View>

        <Pressable
          onPress={() => {
            const nextEpisode =
              item.media.episodesTotal !== null && item.media.episodesTotal > 0
                ? Math.min(
                    item.media.episodesTotal,
                    Math.max(1, item.currentEpisode + 1)
                  )
                : Math.max(1, item.currentEpisode + 1);
            navigateToVideoPlayer(navigation, item.media.id, nextEpisode);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Reproduzir ${title}`}
          testID={`library-row-play-${item.media.id}`}
          style={({ pressed }) => [
            styles.listPlayButton,
            pressed && styles.pressedOpacity,
          ]}
        >
          <Text style={styles.listPlayText}>▶</Text>
        </Pressable>
      </Pressable>
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>Biblioteca</Text>
          <Text style={styles.headerSubtitle}>
            Seus animes organizados nos 6 status de acompanhamento.
          </Text>
        </View>
        <Pressable
          onPress={() => navigation?.navigate('Settings')}
          accessibilityRole="button"
          accessibilityLabel="Configurações"
          testID="library-settings-button"
          style={({ pressed }) => [
            styles.settingsButton,
            pressed && styles.pressedOpacity,
          ]}
        >
          <Text style={styles.settingsButtonText}>⚙</Text>
        </Pressable>
      </View>

      {!servicesReady ? (
        <View style={styles.centeredBox}>
          <Text style={styles.emptySubtitle}>
            Conecte a biblioteca local para visualizar seus 6 status e sortear títulos.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.topPanel}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryCard}>
                <Text
                  testID="library-summary-completed"
                  style={styles.summaryValue}
                >
                  {String(summary.completedCount)}
                </Text>
                <Text style={styles.summaryLabel}>Concluídos</Text>
              </View>
              <View style={styles.summaryCard}>
                <Text
                  testID="library-summary-episodes"
                  style={styles.summaryValue}
                >
                  {String(summary.episodesWatchedCount)}
                </Text>
                <Text style={styles.summaryLabel}>Episódios vistos</Text>
              </View>
              <View style={styles.summaryCard}>
                <Text
                  testID="library-summary-watching"
                  style={styles.summaryValue}
                >
                  {String(summary.watchingCount)}
                </Text>
                <Text style={styles.summaryLabel}>Em andamento</Text>
              </View>
            </View>

            <View style={styles.rouletteBox}>
              <View style={styles.rouletteHeader}>
                <Pressable
                  onPress={handlePickForMe}
                  accessibilityRole="button"
                  testID="library-pick-for-me-button"
                  style={({ pressed }) => [
                    styles.rouletteButton,
                    pressed && styles.pressedOpacity,
                  ]}
                >
                  <Text style={styles.rouletteButtonText}>🎲 Escolher por mim</Text>
                </Pressable>
                <Pressable
                  onPress={() => setShortOnly((prev) => !prev)}
                  accessibilityRole="button"
                  testID="library-roulette-short-toggle"
                  style={[
                    styles.filterPill,
                    shortOnly && styles.filterPillActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.filterPillText,
                      shortOnly && styles.filterPillTextActive,
                    ]}
                  >
                    Até 12 ep
                  </Text>
                </Pressable>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRail}
              >
                {ROULETTE_GENRE_OPTIONS.map((option) => {
                  const selected = rouletteGenre === option.value;
                  return (
                    <Pressable
                      key={option.label}
                      onPress={() => setRouletteGenre(option.value)}
                      accessibilityRole="button"
                      testID={`library-roulette-genre-${option.value ?? 'ALL'}`}
                      style={[
                        styles.filterPill,
                        selected && styles.filterPillActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.filterPillText,
                          selected && styles.filterPillTextActive,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {pickedEntry ? (
                <View
                  testID="library-roulette-result"
                  style={styles.rouletteResultCard}
                >
                  <View style={styles.rouletteResultCopy}>
                    <Text style={styles.rouletteResultEyebrow}>
                      Sugestão da sua fila
                    </Text>
                    <Text style={styles.rouletteResultTitle} numberOfLines={2}>
                      {getMediaDisplayTitle(pickedEntry.media)}
                    </Text>
                  </View>
                  <View style={styles.rouletteResultActions}>
                    <Pressable
                      onPress={() =>
                        navigateToAnimeDetails(navigation, pickedEntry.media)
                      }
                      accessibilityRole="button"
                      testID="library-roulette-open-details"
                      style={styles.rouletteActionButton}
                    >
                      <Text style={styles.rouletteActionText}>Detalhes</Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        navigateToVideoPlayer(navigation, pickedEntry.media.id, 1)
                      }
                      accessibilityRole="button"
                      testID="library-roulette-play"
                      style={styles.roulettePlayButton}
                    >
                      <Text style={styles.roulettePlayText}>▶ Play</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {rouletteMessage ? (
                <Text style={styles.rouletteEmptyText}>{rouletteMessage}</Text>
              ) : null}
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRail}
            >
              {WATCH_STATUSES.map((status) => {
                const selected = selectedStatus === status;
                const meta = STATUS_META[status];
                const count = entriesByStatus[status].length;
                return (
                  <Pressable
                    key={status}
                    onPress={() => setSelectedStatus(status)}
                    accessibilityRole="button"
                    testID={`library-status-chip-${status}`}
                    style={[
                      styles.statusChip,
                      selected && {
                        backgroundColor: meta.backgroundColor,
                        borderColor: meta.color,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusChipLabel,
                        selected && { color: meta.color, fontWeight: '700' },
                      ]}
                    >
                      {meta.label}
                    </Text>
                    <Text
                      style={[
                        styles.statusChipCount,
                        selected && { color: meta.color },
                      ]}
                    >
                      {String(count)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.toolbarRow}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRail}
              >
                {SORT_OPTIONS.map((option) => {
                  const selected = sortMode === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setSortMode(option.value)}
                      accessibilityRole="button"
                      testID={`library-sort-${option.value}`}
                      style={[
                        styles.filterPill,
                        selected && styles.filterPillActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.filterPillText,
                          selected && styles.filterPillTextActive,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <View style={styles.layoutToggleGroup}>
                <Pressable
                  onPress={() => setLayoutMode('grid')}
                  accessibilityRole="button"
                  testID="library-layout-grid"
                  style={[
                    styles.layoutToggleButton,
                    layoutMode === 'grid' && styles.layoutToggleButtonActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.layoutToggleText,
                      layoutMode === 'grid' && styles.layoutToggleTextActive,
                    ]}
                  >
                    Grade
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setLayoutMode('list')}
                  accessibilityRole="button"
                  testID="library-layout-list"
                  style={[
                    styles.layoutToggleButton,
                    layoutMode === 'list' && styles.layoutToggleButtonActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.layoutToggleText,
                      layoutMode === 'list' && styles.layoutToggleTextActive,
                    ]}
                  >
                    Lista
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{errorMessage}</Text>
              <Pressable onPress={() => void loadLibrary()} accessibilityRole="button">
                <Text style={styles.retryText}>Tentar novamente</Text>
              </Pressable>
            </View>
          ) : null}

          {loading ? (
            <View style={styles.centeredBox}>
              <ActivityIndicator size="large" color={THEME_TOKENS.accent.primary} />
              <Text style={styles.emptySubtitle}>Carregando biblioteca...</Text>
            </View>
          ) : (
            <FlatList
              key={layoutMode}
              data={displayedEntries}
              keyExtractor={(item) => item.mediaItemId}
              numColumns={layoutMode === 'grid' ? 2 : 1}
              testID={layoutMode === 'grid' ? 'library-grid' : 'library-list'}
              contentContainerStyle={styles.listContent}
              columnWrapperStyle={layoutMode === 'grid' ? styles.gridRow : undefined}
              renderItem={layoutMode === 'grid' ? renderGridItem : renderListItem}
              ListEmptyComponent={
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>Nenhum título nesta categoria</Text>
                  <Text style={styles.emptySubtitle}>
                    {`Sem animes em "${STATUS_META[selectedStatus].label}" no momento.`}
                  </Text>
                </View>
              }
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: THEME_TOKENS.bg.canvas,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.md,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
    gap: THEME_TOKENS.spacing.md,
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    ...THEME_TOKENS.typography.heroTitle,
    color: THEME_TOKENS.text.primary,
  },
  headerSubtitle: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  settingsButton: {
    width: 38,
    height: 38,
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsButtonText: {
    fontSize: 18,
    color: THEME_TOKENS.text.primary,
  },
  topPanel: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: THEME_TOKENS.spacing.sm,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingVertical: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    alignItems: 'center',
    gap: 2,
  },
  summaryValue: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.accent.primary,
  },
  summaryLabel: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
    fontSize: 11,
    textAlign: 'center',
  },
  rouletteBox: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.sm,
    gap: THEME_TOKENS.spacing.sm,
  },
  rouletteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.sm,
  },
  rouletteButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
  },
  rouletteButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  rouletteResultCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.accent.primary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.sm,
    gap: THEME_TOKENS.spacing.sm,
  },
  rouletteResultCopy: {
    flex: 1,
    gap: 2,
  },
  rouletteResultEyebrow: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  rouletteResultTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  rouletteResultActions: {
    flexDirection: 'row',
    gap: THEME_TOKENS.spacing.xs,
  },
  rouletteActionButton: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.sm,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 6,
  },
  rouletteActionText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
  },
  roulettePlayButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderRadius: THEME_TOKENS.radius.sm,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 6,
  },
  roulettePlayText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  rouletteEmptyText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  chipRail: {
    gap: THEME_TOKENS.spacing.sm,
    alignItems: 'center',
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: 6,
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  statusChipLabel: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  statusChipCount: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.text.secondary,
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.sm,
  },
  filterPill: {
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 5,
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  filterPillActive: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderColor: THEME_TOKENS.accent.primary,
  },
  filterPillText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  filterPillTextActive: {
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  layoutToggleGroup: {
    flexDirection: 'row',
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    overflow: 'hidden',
  },
  layoutToggleButton: {
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 5,
  },
  layoutToggleButtonActive: {
    backgroundColor: THEME_TOKENS.accent.primary,
  },
  layoutToggleText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  layoutToggleTextActive: {
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  listContent: {
    padding: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.md,
    paddingBottom: THEME_TOKENS.spacing.xxl,
  },
  gridRow: {
    gap: THEME_TOKENS.spacing.md,
    marginBottom: THEME_TOKENS.spacing.md,
  },
  gridCard: {
    flex: 1,
    maxWidth: '49%',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.sm,
    gap: THEME_TOKENS.spacing.md,
  },
  listThumbFrame: {
    width: 56,
    height: 80,
    borderRadius: THEME_TOKENS.radius.sm,
    overflow: 'hidden',
    backgroundColor: THEME_TOKENS.bg.surface,
  },
  listThumb: {
    width: '100%',
    height: '100%',
  },
  listThumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listThumbFallbackText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.secondary,
  },
  listBody: {
    flex: 1,
    gap: 3,
  },
  listTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  listMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
  },
  listStatusText: {
    ...THEME_TOKENS.typography.badge,
  },
  listProgressText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  listScoreText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.gold,
  },
  listGenresText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  listPlayButton: {
    width: 36,
    height: 36,
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listPlayText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  centeredBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: THEME_TOKENS.spacing.xl,
    gap: THEME_TOKENS.spacing.sm,
  },
  emptyCard: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.xl,
    alignItems: 'center',
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
    marginHorizontal: THEME_TOKENS.spacing.lg,
    marginTop: THEME_TOKENS.spacing.md,
    padding: THEME_TOKENS.spacing.md,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.accent.secondary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  errorText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.secondary,
    flex: 1,
  },
  retryText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.accent.primary,
  },
  pressedOpacity: {
    opacity: 0.85,
  },
});
