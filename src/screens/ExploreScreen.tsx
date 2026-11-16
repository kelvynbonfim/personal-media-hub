import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  CatalogFilter,
  CatalogFormat,
  CatalogSort,
  SeasonName,
} from '../catalog/types';
import {
  getMediaDisplayTitle,
  MediaPosterCard,
} from '../components/MediaPosterCard';
import {
  LibraryEntryRecord,
  MediaItemRecord,
  WATCH_STATUSES,
  WatchStatus,
} from '../db/schema';
import { useOptionalAppServices } from '../navigation/AppServicesContext';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';
import {
  BaseDiscoveryScreenProps,
  buildStatusByMediaId,
  navigateToAnimeDetails,
  persistLibraryStatus,
  resolveDiscoveryServices,
} from './discovery-helpers';

export type ExploreScreenProps = BaseDiscoveryScreenProps;

const SEARCH_DEBOUNCE_MS = 350;

const SORT_OPTIONS: ReadonlyArray<{ value: CatalogSort; label: string }> = [
  { value: 'TRENDING_MONTH', label: 'Em Alta' },
  { value: 'POPULARITY', label: 'Populares' },
  { value: 'SCORE', label: 'Melhor Nota' },
  { value: 'NEWEST', label: 'Mais Recentes' },
];

const FORMAT_OPTIONS: ReadonlyArray<{ value: CatalogFormat; label: string }> = [
  { value: 'TV', label: 'TV' },
  { value: 'MOVIE', label: 'Filme' },
  { value: 'OVA', label: 'OVA' },
];

const SEASON_OPTIONS: ReadonlyArray<{ value: SeasonName; label: string }> = [
  { value: 'WINTER', label: 'Inverno' },
  { value: 'SPRING', label: 'Primavera' },
  { value: 'SUMMER', label: 'Verão' },
  { value: 'FALL', label: 'Outono' },
];

const GENRE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Action', label: 'Ação' },
  { value: 'Adventure', label: 'Aventura' },
  { value: 'Comedy', label: 'Comédia' },
  { value: 'Drama', label: 'Drama' },
  { value: 'Fantasy', label: 'Fantasia' },
  { value: 'Mystery', label: 'Mistério' },
  { value: 'Romance', label: 'Romance' },
  { value: 'Sci-Fi', label: 'Sci-Fi' },
  { value: 'Slice of Life', label: 'Slice of Life' },
  { value: 'Sports', label: 'Esportes' },
  { value: 'Supernatural', label: 'Sobrenatural' },
];

function buildRecentYearOptions(): number[] {
  const currentYear = new Date().getFullYear();
  return [
    currentYear + 1,
    currentYear,
    currentYear - 1,
    currentYear - 2,
    currentYear - 3,
  ];
}

export function ExploreScreen(props: ExploreScreenProps = {}): React.JSX.Element {
  const { navigation, services: injectedServices } = props;
  const contextServices = useOptionalAppServices();
  const { catalogService, libraryRepository } = resolveDiscoveryServices(
    injectedServices,
    contextServices
  );
  const servicesReady = Boolean(catalogService && libraryRepository);

  const yearOptions = React.useMemo(() => buildRecentYearOptions(), []);

  const [searchInput, setSearchInput] = React.useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = React.useState<string>('');
  const [selectedGenres, setSelectedGenres] = React.useState<string[]>([]);
  const [sort, setSort] = React.useState<CatalogSort>('TRENDING_MONTH');
  const [format, setFormat] = React.useState<CatalogFormat | undefined>(undefined);
  const [seasonYear, setSeasonYear] = React.useState<number | undefined>(undefined);
  const [seasonName, setSeasonName] = React.useState<SeasonName | undefined>(
    undefined
  );
  const [hideCompleted, setHideCompleted] = React.useState<boolean>(false);

  const [bootstrapped, setBootstrapped] = React.useState<boolean>(false);
  const [loading, setLoading] = React.useState<boolean>(servicesReady);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<MediaItemRecord[]>([]);
  const [userEntries, setUserEntries] = React.useState<LibraryEntryRecord[]>([]);
  const [statusTargetItem, setStatusTargetItem] =
    React.useState<MediaItemRecord | null>(null);
  const [updatingStatus, setUpdatingStatus] = React.useState<boolean>(false);

  const isMountedRef = React.useRef<boolean>(true);
  const userEntriesRef = React.useRef<LibraryEntryRecord[]>([]);
  const requestSeqRef = React.useRef<number>(0);
  const hasLoadedOnceRef = React.useRef<boolean>(false);
  const userToggledHideCompletedRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    userEntriesRef.current = userEntries;
  }, [userEntries]);

  React.useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === debouncedQuery) {
      return undefined;
    }
    const timerId = setTimeout(() => {
      setDebouncedQuery(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timerId);
    };
  }, [searchInput, debouncedQuery]);

  React.useEffect(() => {
    if (!catalogService || !libraryRepository) {
      return undefined;
    }

    let cancelled = false;
    setLoading(true);

    const bootstrap = async () => {
      try {
        const settingsPromise =
          typeof libraryRepository.getSettings === 'function'
            ? libraryRepository.getSettings().catch(() => null)
            : Promise.resolve(null);
        const [entries, settings] = await Promise.all([
          libraryRepository.getAllLibraryEntries(),
          settingsPromise,
        ]);
        if (cancelled || !isMountedRef.current) {
          return;
        }
        userEntriesRef.current = entries;
        setUserEntries(entries);
        if (settings && !userToggledHideCompletedRef.current) {
          setHideCompleted(settings.hideCompletedInExplore);
        }
        setBootstrapped(true);
      } catch (error) {
        if (cancelled || !isMountedRef.current) {
          return;
        }
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Falha ao carregar biblioteca local.'
        );
        setBootstrapped(true);
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [catalogService, libraryRepository]);

  React.useEffect(() => {
    if (!navigation || typeof navigation.addListener !== 'function' || !libraryRepository) {
      return undefined;
    }
    return navigation.addListener('focus', () => {
      if (!hasLoadedOnceRef.current) {
        return;
      }
      const settingsPromise =
        typeof libraryRepository.getSettings === 'function'
          ? libraryRepository.getSettings().catch(() => null)
          : Promise.resolve(null);
      void Promise.all([libraryRepository.getAllLibraryEntries(), settingsPromise])
        .then(([entries, settings]) => {
          if (!isMountedRef.current) {
            return;
          }
          userEntriesRef.current = entries;
          setUserEntries(entries);
          if (settings) {
            setHideCompleted(settings.hideCompletedInExplore);
          }
        })
        .catch(() => undefined);
    });
  }, [navigation, libraryRepository]);

  const executeExplore = React.useCallback(async (): Promise<void> => {
    if (!catalogService || !bootstrapped) {
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setErrorMessage(null);

    const filter: CatalogFilter = {
      ...(debouncedQuery ? { query: debouncedQuery } : {}),
      ...(selectedGenres.length > 0 ? { genres: selectedGenres } : {}),
      sort,
      ...(seasonYear !== undefined ? { seasonYear } : {}),
      ...(seasonName !== undefined ? { seasonName } : {}),
      ...(format !== undefined ? { format } : {}),
      hideCompleted,
    };

    const completedMediaIds = new Set(
      userEntriesRef.current
        .filter((entry) => entry.status === 'COMPLETED')
        .map((entry) => entry.mediaItemId)
    );

    try {
      const items = await catalogService.exploreCatalog(filter, completedMediaIds);
      if (!isMountedRef.current || seq !== requestSeqRef.current) {
        return;
      }
      setResults(items);
      hasLoadedOnceRef.current = true;
    } catch (error) {
      if (!isMountedRef.current || seq !== requestSeqRef.current) {
        return;
      }
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Não foi possível buscar no catálogo.'
      );
    } finally {
      if (isMountedRef.current && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [
    bootstrapped,
    catalogService,
    debouncedQuery,
    format,
    hideCompleted,
    seasonName,
    seasonYear,
    selectedGenres,
    sort,
  ]);

  React.useEffect(() => {
    void executeExplore();
  }, [executeExplore]);

  const statusByMediaId = React.useMemo(
    () => buildStatusByMediaId(userEntries),
    [userEntries]
  );

  const toggleGenre = React.useCallback((genre: string) => {
    setSelectedGenres((prev) =>
      prev.includes(genre) ? prev.filter((item) => item !== genre) : [...prev, genre]
    );
  }, []);

  const handleToggleHideCompleted = React.useCallback(
    (nextValue: boolean) => {
      userToggledHideCompletedRef.current = true;
      setHideCompleted(nextValue);
      if (libraryRepository && typeof libraryRepository.saveSettings === 'function') {
        void libraryRepository
          .saveSettings({ hideCompletedInExplore: nextValue })
          .catch(() => undefined);
      }
    },
    [libraryRepository]
  );

  const handleSelectQuickStatus = React.useCallback(
    async (status: WatchStatus): Promise<void> => {
      if (!statusTargetItem || !libraryRepository || updatingStatus) {
        return;
      }
      const target = statusTargetItem;
      setUpdatingStatus(true);
      try {
        const updatedEntry = await persistLibraryStatus(
          libraryRepository,
          target,
          status
        );
        if (!isMountedRef.current) {
          return;
        }
        setUserEntries((prev) => {
          const next = [
            updatedEntry,
            ...prev.filter((entry) => entry.mediaItemId !== target.id),
          ];
          userEntriesRef.current = next;
          return next;
        });
        if (hideCompleted && status === 'COMPLETED') {
          setResults((prev) => prev.filter((item) => item.id !== target.id));
        }
        setStatusTargetItem(null);
      } catch (error) {
        if (isMountedRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Não foi possível atualizar o status.'
          );
        }
      } finally {
        if (isMountedRef.current) {
          setUpdatingStatus(false);
        }
      }
    },
    [hideCompleted, libraryRepository, statusTargetItem, updatingStatus]
  );

  const clearFilters = React.useCallback(() => {
    setSearchInput('');
    setDebouncedQuery('');
    setSelectedGenres([]);
    setSort('TRENDING_MONTH');
    setFormat(undefined);
    setSeasonYear(undefined);
    setSeasonName(undefined);
  }, []);

  const targetCurrentStatus = statusTargetItem
    ? statusByMediaId.get(statusTargetItem.id)
    : undefined;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Catálogo</Text>
        <Text style={styles.headerSubtitle}>
          Busca instantânea e filtros avançados de animes.
        </Text>
      </View>

      {!servicesReady ? (
        <View style={styles.centeredBox}>
          <Text style={styles.emptySubtitle}>
            Conecte o serviço de catálogo para pesquisar e filtrar animes.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.controlsContainer}>
            <View style={styles.searchRow}>
              <TextInput
                value={searchInput}
                onChangeText={setSearchInput}
                placeholder="Buscar anime por título..."
                placeholderTextColor={THEME_TOKENS.text.secondary}
                autoCapitalize="none"
                autoCorrect={false}
                testID="explore-search-input"
                style={styles.searchInput}
              />
              {searchInput.length > 0 ? (
                <Pressable
                  onPress={() => {
                    setSearchInput('');
                    setDebouncedQuery('');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Limpar busca"
                  style={styles.clearButton}
                >
                  <Text style={styles.clearButtonText}>✕</Text>
                </Pressable>
              ) : null}
            </View>

            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Ocultar já concluídos</Text>
              <Switch
                value={hideCompleted}
                onValueChange={handleToggleHideCompleted}
                testID="explore-hide-completed-switch"
                trackColor={{
                  false: THEME_TOKENS.border.subtle,
                  true: THEME_TOKENS.accent.primary,
                }}
                thumbColor={THEME_TOKENS.text.primary}
              />
            </View>

            <View style={styles.filterGroup}>
              <Text style={styles.filterLabel}>Ordenação</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRail}
              >
                {SORT_OPTIONS.map((option) => {
                  const selected = sort === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setSort(option.value)}
                      testID={`sort-chip-${option.value}`}
                      accessibilityRole="button"
                      style={[styles.chip, selected && styles.chipSelected]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            <View style={styles.filterGroup}>
              <Text style={styles.filterLabel}>Gêneros</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRail}
              >
                {GENRE_OPTIONS.map((option) => {
                  const selected = selectedGenres.includes(option.value);
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => toggleGenre(option.value)}
                      testID={`genre-chip-${option.value}`}
                      accessibilityRole="button"
                      style={[styles.chip, selected && styles.chipSelected]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            <View style={styles.filterGroup}>
              <Text style={styles.filterLabel}>Formato · Temporada · Ano</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRail}
              >
                {FORMAT_OPTIONS.map((option) => {
                  const selected = format === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() =>
                        setFormat((prev) =>
                          prev === option.value ? undefined : option.value
                        )
                      }
                      testID={`format-chip-${option.value}`}
                      accessibilityRole="button"
                      style={[styles.chip, selected && styles.chipSelected]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}

                {SEASON_OPTIONS.map((option) => {
                  const selected = seasonName === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() =>
                        setSeasonName((prev) =>
                          prev === option.value ? undefined : option.value
                        )
                      }
                      testID={`season-chip-${option.value}`}
                      accessibilityRole="button"
                      style={[styles.chip, selected && styles.chipSelected]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}

                {yearOptions.map((year) => {
                  const selected = seasonYear === year;
                  return (
                    <Pressable
                      key={year}
                      onPress={() =>
                        setSeasonYear((prev) => (prev === year ? undefined : year))
                      }
                      testID={`year-chip-${year}`}
                      accessibilityRole="button"
                      style={[styles.chip, selected && styles.chipSelected]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}
                      >
                        {String(year)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          </View>

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{errorMessage}</Text>
              <Pressable onPress={() => void executeExplore()} accessibilityRole="button">
                <Text style={styles.retryLink}>Tentar novamente</Text>
              </Pressable>
            </View>
          ) : null}

          {loading && results.length > 0 ? (
            <View style={styles.inlineLoadingRow}>
              <ActivityIndicator size="small" color={THEME_TOKENS.accent.primary} />
              <Text style={styles.inlineLoadingText}>Atualizando resultados...</Text>
            </View>
          ) : null}

          {loading && results.length === 0 ? (
            <View style={styles.centeredBox}>
              <ActivityIndicator size="large" color={THEME_TOKENS.accent.primary} />
              <Text style={styles.emptySubtitle}>Buscando animes...</Text>
            </View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              numColumns={2}
              contentContainerStyle={styles.gridContent}
              columnWrapperStyle={styles.gridRow}
              renderItem={({ item }) => (
                <MediaPosterCard
                  item={item}
                  status={statusByMediaId.get(item.id)}
                  onPress={() => navigateToAnimeDetails(navigation, item)}
                  onLongPress={() => setStatusTargetItem(item)}
                  testID={`explore-card-${item.id}`}
                  style={styles.gridCard}
                />
              )}
              ListEmptyComponent={
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>Nenhum anime encontrado</Text>
                  <Text style={styles.emptySubtitle}>
                    Tente ajustar a busca ou limpar os filtros ativos.
                  </Text>
                  <Pressable
                    onPress={clearFilters}
                    accessibilityRole="button"
                    style={styles.resetButton}
                  >
                    <Text style={styles.resetButtonText}>Limpar filtros</Text>
                  </Pressable>
                </View>
              }
            />
          )}

          <Modal
            visible={statusTargetItem !== null}
            transparent
            animationType="fade"
            onRequestClose={() => setStatusTargetItem(null)}
            testID="explore-status-modal"
          >
            <View style={styles.modalBackdrop}>
              <View style={styles.modalSheet}>
                <Text style={styles.modalEyebrow}>Atalho rápido de biblioteca</Text>
                <Text style={styles.modalTitle} numberOfLines={2}>
                  {statusTargetItem ? getMediaDisplayTitle(statusTargetItem) : ''}
                </Text>

                <View style={styles.statusList}>
                  {WATCH_STATUSES.map((statusOption) => {
                    const meta = STATUS_META[statusOption];
                    const isCurrent = targetCurrentStatus === statusOption;
                    return (
                      <Pressable
                        key={statusOption}
                        disabled={updatingStatus}
                        onPress={() => void handleSelectQuickStatus(statusOption)}
                        accessibilityRole="button"
                        testID={`status-option-${statusOption}`}
                        style={({ pressed }) => [
                          styles.statusOptionButton,
                          isCurrent && {
                            borderColor: meta.color,
                            backgroundColor: meta.backgroundColor,
                          },
                          pressed && styles.pressedOpacity,
                        ]}
                      >
                        <Text
                          style={[
                            styles.statusOptionText,
                            { color: isCurrent ? meta.color : THEME_TOKENS.text.primary },
                          ]}
                        >
                          {meta.label}
                        </Text>
                        {isCurrent ? (
                          <Text style={[styles.statusCheck, { color: meta.color }]}>
                            Atual
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>

                <Pressable
                  onPress={() => setStatusTargetItem(null)}
                  accessibilityRole="button"
                  testID="explore-status-modal-cancel"
                  style={styles.modalCancelButton}
                >
                  <Text style={styles.modalCancelText}>Cancelar</Text>
                </Pressable>
              </View>
            </View>
          </Modal>
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
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.md,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
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
  controlsContainer: {
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingTop: THEME_TOKENS.spacing.md,
    paddingBottom: THEME_TOKENS.spacing.sm,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
    gap: THEME_TOKENS.spacing.sm,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
  },
  searchInput: {
    flex: 1,
    height: 42,
    color: THEME_TOKENS.text.primary,
    ...THEME_TOKENS.typography.body,
  },
  clearButton: {
    padding: THEME_TOKENS.spacing.xs,
  },
  clearButtonText: {
    color: THEME_TOKENS.text.secondary,
    fontSize: 16,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  filterGroup: {
    gap: THEME_TOKENS.spacing.xs,
  },
  filterLabel: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  chipRail: {
    gap: THEME_TOKENS.spacing.sm,
    paddingVertical: 2,
  },
  chip: {
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: 6,
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  chipSelected: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderColor: THEME_TOKENS.accent.primary,
  },
  chipText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  chipTextSelected: {
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
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
    gap: THEME_TOKENS.spacing.sm,
  },
  errorText: {
    flex: 1,
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.secondary,
  },
  retryLink: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
    fontWeight: '700',
  },
  inlineLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingTop: THEME_TOKENS.spacing.sm,
  },
  inlineLoadingText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  gridContent: {
    padding: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.md,
    paddingBottom: THEME_TOKENS.spacing.xxl,
  },
  gridRow: {
    gap: THEME_TOKENS.spacing.md,
  },
  gridCard: {
    flex: 1,
    maxWidth: '49%',
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
  resetButton: {
    marginTop: THEME_TOKENS.spacing.xs,
    backgroundColor: THEME_TOKENS.accent.primary,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
  },
  resetButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(8, 11, 12, 0.82)',
    justifyContent: 'flex-end',
    padding: THEME_TOKENS.spacing.lg,
  },
  modalSheet: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.xl,
    padding: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.md,
  },
  modalEyebrow: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
    textTransform: 'uppercase',
  },
  modalTitle: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.primary,
  },
  statusList: {
    gap: THEME_TOKENS.spacing.sm,
  },
  statusOptionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.md,
  },
  statusOptionText: {
    ...THEME_TOKENS.typography.cardTitle,
  },
  statusCheck: {
    ...THEME_TOKENS.typography.badge,
  },
  modalCancelButton: {
    alignItems: 'center',
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.bg.card,
  },
  modalCancelText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.secondary,
  },
  pressedOpacity: {
    opacity: 0.84,
  },
});
