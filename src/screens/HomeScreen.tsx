import React from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WeeklyScheduleEntry } from '../catalog/catalog-service';
import {
  getMediaDisplayTitle,
  MediaPosterCard,
} from '../components/MediaPosterCard';
import {
  EpisodeProgressRecord,
  LibraryEntryRecord,
  MediaItemRecord,
} from '../db/schema';
import { useOptionalAppServices } from '../navigation/AppServicesContext';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';
import {
  BaseDiscoveryScreenProps,
  buildStatusByMediaId,
  formatAiringClock,
  formatGenresPreview,
  getWeekdayShortLabel,
  navigateToAnimeDetails,
  navigateToVideoPlayer,
  persistLibraryStatus,
  resolveDiscoveryServices,
} from './discovery-helpers';

export type HomeScreenProps = BaseDiscoveryScreenProps;

interface ResumeComputation {
  episodeNumber: number;
  progressRatio: number;
  remainingText: string;
}

interface ContinueWatchingItem extends ResumeComputation {
  entry: LibraryEntryRecord;
  media: MediaItemRecord;
}

function computeResumeInfo(
  entry: LibraryEntryRecord,
  media: MediaItemRecord,
  progressRows: EpisodeProgressRecord[]
): ResumeComputation {
  const inProgress = [...progressRows]
    .filter(
      (row) =>
        !row.isCompleted && (row.positionSeconds > 0 || row.durationSeconds > 0)
    )
    .sort((a, b) => {
      const updatedDiff = b.updatedAt.localeCompare(a.updatedAt);
      return updatedDiff !== 0 ? updatedDiff : b.episodeNumber - a.episodeNumber;
    })[0];

  if (inProgress) {
    if (inProgress.durationSeconds > 0) {
      const ratio = Math.min(
        1,
        Math.max(0, inProgress.positionSeconds / inProgress.durationSeconds)
      );
      const remainingSeconds = Math.max(
        0,
        inProgress.durationSeconds - inProgress.positionSeconds
      );
      const remainingMinutes =
        remainingSeconds > 0 ? Math.max(1, Math.ceil(remainingSeconds / 60)) : 0;

      return {
        episodeNumber: inProgress.episodeNumber,
        progressRatio: ratio,
        remainingText:
          remainingMinutes > 0
            ? `${remainingMinutes} min restantes`
            : 'Quase concluído',
      };
    }

    return {
      episodeNumber: inProgress.episodeNumber,
      progressRatio: 0,
      remainingText: 'Em andamento',
    };
  }

  const nextEpisode =
    entry.currentEpisode <= 0
      ? 1
      : media.episodesTotal !== null && entry.currentEpisode >= media.episodesTotal
        ? media.episodesTotal
        : entry.currentEpisode + 1;

  if (media.episodesTotal !== null && media.episodesTotal > 0) {
    return {
      episodeNumber: nextEpisode,
      progressRatio: Math.min(
        1,
        Math.max(0, entry.currentEpisode / media.episodesTotal)
      ),
      remainingText: `${entry.currentEpisode}/${media.episodesTotal} ep`,
    };
  }

  return {
    episodeNumber: nextEpisode,
    progressRatio: 0,
    remainingText:
      entry.currentEpisode > 0
        ? `Ep. ${entry.currentEpisode} concluído`
        : 'Começar agora',
  };
}

function buildContinueWatchingList(
  activeWithMedia: Array<LibraryEntryRecord & { media: MediaItemRecord }>,
  allEntries: LibraryEntryRecord[],
  feedMedia: Array<MediaItemRecord | null>,
  allProgress: EpisodeProgressRecord[]
): ContinueWatchingItem[] {
  const progressByMediaId = new Map<string, EpisodeProgressRecord[]>();
  for (const row of allProgress) {
    const existing = progressByMediaId.get(row.mediaItemId);
    if (existing) {
      existing.push(row);
    } else {
      progressByMediaId.set(row.mediaItemId, [row]);
    }
  }

  const combined = new Map<
    string,
    { entry: LibraryEntryRecord; media: MediaItemRecord }
  >();

  for (const row of activeWithMedia) {
    combined.set(row.mediaItemId, { entry: row, media: row.media });
  }

  const mediaById = new Map<string, MediaItemRecord>();
  for (const item of feedMedia) {
    if (item) {
      mediaById.set(item.id, item);
    }
  }

  for (const entry of allEntries) {
    if (entry.status !== 'WATCHING' && entry.status !== 'REWATCHING') {
      continue;
    }
    if (combined.has(entry.mediaItemId)) {
      continue;
    }
    const matchedMedia = mediaById.get(entry.mediaItemId);
    if (matchedMedia) {
      combined.set(entry.mediaItemId, { entry, media: matchedMedia });
    }
  }

  return Array.from(combined.values())
    .sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .map(({ entry, media }) => ({
      entry,
      media,
      ...computeResumeInfo(entry, media, progressByMediaId.get(media.id) ?? []),
    }));
}

export function HomeScreen(props: HomeScreenProps = {}): React.JSX.Element {
  const { navigation, services: injectedServices } = props;
  const contextServices = useOptionalAppServices();
  const { catalogService, libraryRepository } = resolveDiscoveryServices(
    injectedServices,
    contextServices
  );
  const servicesReady = Boolean(catalogService && libraryRepository);

  const [loading, setLoading] = React.useState<boolean>(servicesReady);
  const [refreshing, setRefreshing] = React.useState<boolean>(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [hero, setHero] = React.useState<MediaItemRecord | null>(null);
  const [trendingMonth, setTrendingMonth] = React.useState<MediaItemRecord[]>([]);
  const [currentSeason, setCurrentSeason] = React.useState<MediaItemRecord[]>([]);
  const [continueWatching, setContinueWatching] = React.useState<
    ContinueWatchingItem[]
  >([]);
  const [weeklyUpcoming, setWeeklyUpcoming] = React.useState<WeeklyScheduleEntry[]>(
    []
  );
  const [userEntries, setUserEntries] = React.useState<LibraryEntryRecord[]>([]);
  const [addingHero, setAddingHero] = React.useState<boolean>(false);

  const isMountedRef = React.useRef<boolean>(true);
  const hasLoadedOnceRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadHomeData = React.useCallback(
    async (mode: 'initial' | 'refresh' = 'initial'): Promise<void> => {
      if (!catalogService || !libraryRepository) {
        return;
      }

      if (mode === 'refresh') {
        setRefreshing(true);
      } else if (!hasLoadedOnceRef.current) {
        setLoading(true);
      }
      setErrorMessage(null);

      try {
        const [entries, watchingEntries, rewatchingEntries, allProgress] =
          await Promise.all([
            libraryRepository.getAllLibraryEntries(),
            libraryRepository.getLibraryByStatus('WATCHING'),
            libraryRepository.getLibraryByStatus('REWATCHING'),
            libraryRepository.getAllEpisodeProgress(),
          ]);

        const [feed, weeklyMap] = await Promise.all([
          catalogService.getHomeFeed(entries),
          catalogService.getWeeklySchedule(entries).catch(() => null),
        ]);

        if (!isMountedRef.current) {
          return;
        }

        const activeWithMedia = [...watchingEntries, ...rewatchingEntries];
        const continueList = buildContinueWatchingList(
          activeWithMedia,
          entries,
          [feed.hero, ...feed.trendingMonth, ...feed.currentSeason],
          allProgress
        );

        const flattenedWeekly = weeklyMap
          ? Object.values(weeklyMap)
              .flat()
              .sort((a, b) => a.airingAtUnix - b.airingAtUnix)
              .slice(0, 12)
          : [];

        setUserEntries(entries);
        setHero(feed.hero);
        setTrendingMonth(feed.trendingMonth);
        setCurrentSeason(feed.currentSeason);
        setContinueWatching(continueList);
        setWeeklyUpcoming(flattenedWeekly);
        hasLoadedOnceRef.current = true;
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        const message =
          error instanceof Error && error.message
            ? error.message
            : 'Não foi possível carregar os destaques agora.';
        setErrorMessage(message);
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [catalogService, libraryRepository]
  );

  React.useEffect(() => {
    void loadHomeData('initial');
  }, [loadHomeData]);

  React.useEffect(() => {
    if (!navigation || typeof navigation.addListener !== 'function') {
      return undefined;
    }
    return navigation.addListener('focus', () => {
      if (hasLoadedOnceRef.current) {
        void loadHomeData('refresh');
      }
    });
  }, [navigation, loadHomeData]);

  const entryByMediaId = React.useMemo(
    () => new Map(userEntries.map((entry) => [entry.mediaItemId, entry])),
    [userEntries]
  );
  const statusByMediaId = React.useMemo(
    () => buildStatusByMediaId(userEntries),
    [userEntries]
  );

  const heroEntry = hero ? entryByMediaId.get(hero.id) : undefined;
  const heroContinueItem = hero
    ? continueWatching.find((item) => item.media.id === hero.id)
    : undefined;
  const heroIsActive =
    heroEntry?.status === 'WATCHING' || heroEntry?.status === 'REWATCHING';
  const heroResumeEpisode = heroContinueItem
    ? heroContinueItem.episodeNumber
    : heroEntry
      ? computeResumeInfo(heroEntry, hero!, []).episodeNumber
      : 1;

  const handleAddHeroToList = React.useCallback(async (): Promise<void> => {
    if (!hero || !libraryRepository || addingHero) {
      return;
    }
    setAddingHero(true);
    try {
      const updated = await persistLibraryStatus(
        libraryRepository,
        hero,
        'PLAN_TO_WATCH'
      );
      if (!isMountedRef.current) {
        return;
      }
      setUserEntries((prev) => {
        const filtered = prev.filter((item) => item.mediaItemId !== hero.id);
        return [updated, ...filtered];
      });
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Não foi possível adicionar à lista.'
        );
      }
    } finally {
      if (isMountedRef.current) {
        setAddingHero(false);
      }
    }
  }, [addingHero, hero, libraryRepository]);

  const handleHeroPrimaryAction = React.useCallback(() => {
    if (!hero) {
      return;
    }
    if (heroIsActive || heroEntry) {
      navigateToVideoPlayer(navigation, hero.id, heroResumeEpisode);
      return;
    }
    void handleAddHeroToList();
  }, [
    handleAddHeroToList,
    hero,
    heroEntry,
    heroIsActive,
    heroResumeEpisode,
    navigation,
  ]);

  const topTenTrending = React.useMemo(
    () => trendingMonth.slice(0, 10),
    [trendingMonth]
  );

  const heroImageUrl = hero ? hero.bannerUrl || hero.coverUrl : '';
  const heroTitle = hero ? getMediaDisplayTitle(hero) : '';
  const heroGenres = hero ? formatGenresPreview(hero.genresJson) : '';
  const heroMetaParts: string[] = [];
  if (hero?.seasonYear) {
    heroMetaParts.push(String(hero.seasonYear));
  }
  if (hero?.episodesTotal) {
    heroMetaParts.push(`${hero.episodesTotal} ep`);
  }
  if (heroGenres) {
    heroMetaParts.push(heroGenres);
  }
  const heroBadgeLabel = heroIsActive
    ? 'Em andamento'
    : hero && trendingMonth[0]?.id === hero.id
      ? '#1 Em Alta no Mês'
      : 'Em Destaque';

  const hasAnyHomeContent =
    Boolean(hero) ||
    continueWatching.length > 0 ||
    topTenTrending.length > 0 ||
    currentSeason.length > 0 ||
    weeklyUpcoming.length > 0;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Início</Text>
          <Text style={styles.headerSubtitle}>
            Streaming & biblioteca em Ardósia Mineral
          </Text>
        </View>
        <Pressable
          onPress={() => navigation?.navigate('Settings')}
          accessibilityRole="button"
          accessibilityLabel="Configurações"
          testID="home-settings-button"
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
          <Text style={styles.emptyTitle}>Início</Text>
          <Text style={styles.emptySubtitle}>
            Destaques, continuar assistindo e temporada atual em Ardósia Mineral & Menta.
          </Text>
        </View>
      ) : loading && !hero && trendingMonth.length === 0 ? (
        <View style={styles.centeredBox}>
          <ActivityIndicator size="large" color={THEME_TOKENS.accent.primary} />
          <Text style={styles.emptySubtitle}>Carregando destaques...</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void loadHomeData('refresh')}
              tintColor={THEME_TOKENS.accent.primary}
            />
          }
        >
          {errorMessage && !hero && trendingMonth.length === 0 ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorTitle}>Modo offline / erro de catálogo</Text>
              <Text style={styles.errorBody}>{errorMessage}</Text>
              <Pressable
                onPress={() => void loadHomeData('initial')}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.pressedOpacity,
                ]}
              >
                <Text style={styles.primaryButtonText}>Tentar novamente</Text>
              </Pressable>
            </View>
          ) : null}

          {errorMessage && (hero || trendingMonth.length > 0) ? (
            <View style={styles.inlineWarning}>
              <Text style={styles.inlineWarningText}>{errorMessage}</Text>
            </View>
          ) : null}

          {!errorMessage && !hasAnyHomeContent ? (
            <View style={styles.errorCard}>
              <Text style={styles.emptyTitle}>Nenhum destaque disponível</Text>
              <Text style={styles.emptySubtitle}>
                Puxe para atualizar ou pesquise títulos na aba Catálogo.
              </Text>
              <Pressable
                onPress={() => void loadHomeData('refresh')}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.pressedOpacity,
                ]}
              >
                <Text style={styles.primaryButtonText}>Atualizar</Text>
              </Pressable>
            </View>
          ) : null}

          {hero ? (
            <View style={styles.heroCard}>
              <Pressable
                onPress={() => navigateToAnimeDetails(navigation, hero)}
                accessibilityRole="button"
                style={({ pressed }) => [pressed && styles.pressedOpacity]}
              >
                <View style={styles.heroMediaBox}>
                  {heroImageUrl.trim().length > 0 ? (
                    <Image
                      source={{ uri: heroImageUrl }}
                      style={styles.heroImage}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={styles.heroImageFallback}>
                      <Text style={styles.heroFallbackText}>
                        {heroTitle.slice(0, 2).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <View style={styles.heroBadgeRow}>
                    <View
                      style={[
                        styles.heroTag,
                        heroIsActive ? styles.heroTagMint : styles.heroTagCoral,
                      ]}
                    >
                      <Text style={[styles.heroTagText, styles.heroTagTextDark]}>
                        {heroBadgeLabel}
                      </Text>
                    </View>
                    {heroEntry ? (
                      <View
                        style={[
                          styles.heroStatusPill,
                          {
                            backgroundColor:
                              STATUS_META[heroEntry.status].backgroundColor,
                            borderColor: STATUS_META[heroEntry.status].color,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.heroStatusText,
                            { color: STATUS_META[heroEntry.status].color },
                          ]}
                        >
                          {STATUS_META[heroEntry.status].label}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>

                <View style={styles.heroInfoBody}>
                  <Text style={styles.heroTitle}>{heroTitle}</Text>
                  {heroMetaParts.length > 0 ? (
                    <Text style={styles.heroMeta} numberOfLines={1}>
                      {heroMetaParts.join(' · ')}
                    </Text>
                  ) : null}
                  {hero.synopsis ? (
                    <Text style={styles.heroSynopsis} numberOfLines={2}>
                      {hero.synopsis}
                    </Text>
                  ) : null}
                </View>
              </Pressable>

              <View style={styles.heroActions}>
                <Pressable
                  onPress={handleHeroPrimaryAction}
                  disabled={addingHero}
                  accessibilityRole="button"
                  testID="home-hero-cta"
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.pressedOpacity,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {heroIsActive
                      ? `▶ Continuar Ep. ${heroResumeEpisode}`
                      : heroEntry
                        ? `▶ Assistir Ep. ${heroResumeEpisode}`
                        : '+ Adicionar à Lista'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => navigateToAnimeDetails(navigation, hero)}
                  accessibilityRole="button"
                  testID="home-hero-details"
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressedOpacity,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Detalhes</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {continueWatching.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Continuar Assistindo</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.horizontalRail}
              >
                {continueWatching.map((item) => {
                  const title = getMediaDisplayTitle(item.media);
                  const widthPercent = `${Math.round(item.progressRatio * 100)}%`;
                  return (
                    <Pressable
                      key={item.media.id}
                      onPress={() =>
                        navigateToVideoPlayer(
                          navigation,
                          item.media.id,
                          item.episodeNumber
                        )
                      }
                      accessibilityRole="button"
                      testID={`continue-card-${item.media.id}`}
                      style={({ pressed }) => [
                        styles.continueCard,
                        pressed && styles.pressedOpacity,
                      ]}
                    >
                      <View style={styles.continueThumbFrame}>
                        {item.media.coverUrl.trim().length > 0 ? (
                          <Image
                            source={{ uri: item.media.coverUrl }}
                            style={styles.continueThumb}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={styles.continueThumbFallback}>
                            <Text style={styles.continueThumbFallbackText}>
                              {title.slice(0, 2).toUpperCase()}
                            </Text>
                          </View>
                        )}
                      </View>
                      <View style={styles.continueInfo}>
                        <Text style={styles.continueTitle} numberOfLines={2}>
                          {title}
                        </Text>
                        <Text style={styles.continueEpisode}>
                          {`Ep. ${item.episodeNumber}`}
                        </Text>
                        <Text style={styles.continueRemaining} numberOfLines={1}>
                          {item.remainingText}
                        </Text>
                        <View style={styles.progressTrack}>
                          <View
                            testID={`continue-progress-fill-${item.media.id}`}
                            style={[
                              styles.progressFill,
                              {
                                width: widthPercent as `${number}%`,
                                backgroundColor: THEME_TOKENS.accent.primary,
                              },
                            ]}
                          />
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          {topTenTrending.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Mais Assistidos no Mês</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.horizontalRail}
              >
                {topTenTrending.map((item, index) => (
                  <MediaPosterCard
                    key={item.id}
                    item={item}
                    rankBadge={index + 1}
                    status={statusByMediaId.get(item.id)}
                    onPress={() => navigateToAnimeDetails(navigation, item)}
                    testID={`trending-card-${item.id}`}
                    style={styles.railPosterCard}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {currentSeason.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Temporada Atual</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.horizontalRail}
              >
                {currentSeason.map((item) => (
                  <MediaPosterCard
                    key={item.id}
                    item={item}
                    status={statusByMediaId.get(item.id)}
                    onPress={() => navigateToAnimeDetails(navigation, item)}
                    testID={`season-card-${item.id}`}
                    style={styles.railPosterCard}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {weeklyUpcoming.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Próximos Episódios da Semana</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.horizontalRail}
              >
                {weeklyUpcoming.map((entry) => {
                  const title = getMediaDisplayTitle(entry.media);
                  const scheduleMeta = `${getWeekdayShortLabel(entry.weekdayIndex)} · ${formatAiringClock(entry.airingAtUnix)}`;
                  return (
                    <Pressable
                      key={`${entry.media.id}-${entry.episodeNumber}-${entry.airingAtUnix}`}
                      onPress={() =>
                        navigateToAnimeDetails(navigation, entry.media)
                      }
                      accessibilityRole="button"
                      testID={`home-weekly-card-${entry.media.id}-${entry.episodeNumber}`}
                      style={({ pressed }) => [
                        styles.weeklyCard,
                        entry.inUserActiveList && styles.weeklyCardActive,
                        pressed && styles.pressedOpacity,
                      ]}
                    >
                      <View style={styles.weeklyHeaderRow}>
                        <Text style={styles.weeklyTime}>{scheduleMeta}</Text>
                        <Text style={styles.weeklyEpisode}>
                          {`Ep. ${entry.episodeNumber}`}
                        </Text>
                      </View>
                      <Text style={styles.weeklyTitle} numberOfLines={2}>
                        {title}
                      </Text>
                      {entry.inUserActiveList ? (
                        <View style={styles.activeListPill}>
                          <Text style={styles.activeListPillText}>
                            Na sua lista
                          </Text>
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}
        </ScrollView>
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
    width: 40,
    height: 40,
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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.xl,
    paddingBottom: THEME_TOKENS.spacing.xxl,
  },
  centeredBox: {
    flex: 1,
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
  errorCard: {
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
  inlineWarning: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.accent.gold,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    padding: THEME_TOKENS.spacing.md,
  },
  inlineWarningText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.gold,
  },
  heroCard: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.xl,
    overflow: 'hidden',
  },
  heroMediaBox: {
    position: 'relative',
    width: '100%',
    height: 190,
    backgroundColor: THEME_TOKENS.bg.surface,
  },
  heroImage: {
    width: '100%',
    height: '100%',
  },
  heroImageFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME_TOKENS.bg.surface,
  },
  heroFallbackText: {
    ...THEME_TOKENS.typography.heroTitle,
    color: THEME_TOKENS.text.secondary,
  },
  heroBadgeRow: {
    position: 'absolute',
    top: THEME_TOKENS.spacing.md,
    left: THEME_TOKENS.spacing.md,
    right: THEME_TOKENS.spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
  },
  heroTag: {
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
    borderRadius: THEME_TOKENS.radius.pill,
  },
  heroTagMint: {
    backgroundColor: THEME_TOKENS.accent.primary,
  },
  heroTagCoral: {
    backgroundColor: THEME_TOKENS.accent.secondary,
  },
  heroTagText: {
    ...THEME_TOKENS.typography.badge,
  },
  heroTagTextDark: {
    color: THEME_TOKENS.bg.canvas,
  },
  heroStatusPill: {
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
    borderRadius: THEME_TOKENS.radius.pill,
    borderWidth: 1,
  },
  heroStatusText: {
    ...THEME_TOKENS.typography.badge,
  },
  heroInfoBody: {
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingTop: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.sm,
  },
  heroTitle: {
    ...THEME_TOKENS.typography.heroTitle,
    color: THEME_TOKENS.text.primary,
  },
  heroMeta: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
  },
  heroSynopsis: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.text.secondary,
  },
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingTop: THEME_TOKENS.spacing.md,
    paddingBottom: THEME_TOKENS.spacing.lg,
  },
  primaryButton: {
    backgroundColor: THEME_TOKENS.accent.primary,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
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
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
  },
  secondaryButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  section: {
    gap: THEME_TOKENS.spacing.md,
  },
  sectionTitle: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.primary,
  },
  horizontalRail: {
    gap: THEME_TOKENS.spacing.md,
  },
  railPosterCard: {
    width: 148,
  },
  continueCard: {
    width: 248,
    flexDirection: 'row',
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    overflow: 'hidden',
  },
  continueThumbFrame: {
    width: 82,
    height: 112,
    backgroundColor: THEME_TOKENS.bg.surface,
  },
  continueThumb: {
    width: '100%',
    height: '100%',
  },
  continueThumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  continueThumbFallbackText: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.secondary,
  },
  continueInfo: {
    flex: 1,
    padding: THEME_TOKENS.spacing.md,
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.xs,
  },
  continueTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  continueEpisode: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
    fontWeight: '700',
  },
  continueRemaining: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  progressTrack: {
    height: 5,
    width: '100%',
    borderRadius: THEME_TOKENS.radius.pill,
    backgroundColor: THEME_TOKENS.border.subtle,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: THEME_TOKENS.radius.pill,
  },
  weeklyCard: {
    width: 204,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.sm,
  },
  weeklyCardActive: {
    borderColor: THEME_TOKENS.accent.primary,
  },
  weeklyHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  weeklyTime: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  weeklyEpisode: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.gold,
  },
  weeklyTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  activeListPill: {
    alignSelf: 'flex-start',
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
    borderColor: THEME_TOKENS.accent.primary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.pill,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 2,
  },
  activeListPillText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  pressedOpacity: {
    opacity: 0.84,
  },
});
