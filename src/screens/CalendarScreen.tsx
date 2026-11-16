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
import {
  UpcomingSeasonEntry,
  WeeklyScheduleEntry,
} from '../catalog/catalog-service';
import { getMediaDisplayTitle } from '../components/MediaPosterCard';
import { LibraryEntryRecord } from '../db/schema';
import { useOptionalAppServices } from '../navigation/AppServicesContext';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';
import {
  BaseDiscoveryScreenProps,
  buildStatusByMediaId,
  formatAiringClock,
  formatGenresPreview,
  navigateToAnimeDetails,
  resolveDiscoveryServices,
  WEEKDAY_OPTIONS,
} from './discovery-helpers';

export interface CalendarScreenProps extends BaseDiscoveryScreenProps {
  nowFn?: () => Date;
}

type CalendarMode = 'WEEKLY' | 'UPCOMING';

const EMPTY_WEEKLY_SCHEDULE: Record<number, WeeklyScheduleEntry[]> = {
  0: [],
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
};

export function CalendarScreen(
  props: CalendarScreenProps = {}
): React.JSX.Element {
  const { navigation, services: injectedServices, nowFn } = props;
  const contextServices = useOptionalAppServices();
  const { catalogService, libraryRepository } = resolveDiscoveryServices(
    injectedServices,
    contextServices
  );
  const servicesReady = Boolean(catalogService && libraryRepository);

  const todayWeekdayIndex = React.useMemo(
    () => (nowFn ? nowFn() : new Date()).getDay(),
    [nowFn]
  );

  const [mode, setMode] = React.useState<CalendarMode>('WEEKLY');
  const [selectedWeekday, setSelectedWeekday] =
    React.useState<number>(todayWeekdayIndex);
  const [weeklySchedule, setWeeklySchedule] = React.useState<
    Record<number, WeeklyScheduleEntry[]>
  >(EMPTY_WEEKLY_SCHEDULE);
  const [upcomingSeasons, setUpcomingSeasons] = React.useState<
    UpcomingSeasonEntry[]
  >([]);
  const [userEntries, setUserEntries] = React.useState<LibraryEntryRecord[]>([]);
  const [loading, setLoading] = React.useState<boolean>(servicesReady);
  const [refreshing, setRefreshing] = React.useState<boolean>(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const isMountedRef = React.useRef<boolean>(true);
  const hasLoadedOnceRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadCalendarData = React.useCallback(
    async (loadType: 'initial' | 'refresh' = 'initial'): Promise<void> => {
      if (!catalogService || !libraryRepository) {
        return;
      }

      if (loadType === 'refresh') {
        setRefreshing(true);
      } else if (!hasLoadedOnceRef.current) {
        setLoading(true);
      }
      setErrorMessage(null);

      try {
        const entries = await libraryRepository.getAllLibraryEntries();
        const [weekly, upcoming] = await Promise.all([
          catalogService.getWeeklySchedule(entries),
          catalogService.getUpcomingSeasonsRadar(entries),
        ]);

        if (!isMountedRef.current) {
          return;
        }

        setUserEntries(entries);
        setWeeklySchedule(weekly);
        setUpcomingSeasons(upcoming);
        hasLoadedOnceRef.current = true;
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Não foi possível carregar o calendário.'
        );
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
    void loadCalendarData('initial');
  }, [loadCalendarData]);

  React.useEffect(() => {
    if (!navigation || typeof navigation.addListener !== 'function') {
      return undefined;
    }
    return navigation.addListener('focus', () => {
      if (hasLoadedOnceRef.current) {
        void loadCalendarData('refresh');
      }
    });
  }, [navigation, loadCalendarData]);

  const statusByMediaId = React.useMemo(
    () => buildStatusByMediaId(userEntries),
    [userEntries]
  );

  const activeDayEntries = weeklySchedule[selectedWeekday] ?? [];

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Calendário</Text>
        <Text style={styles.headerSubtitle}>
          Grade semanal de lançamentos e radar de próximas temporadas.
        </Text>
      </View>

      {!servicesReady ? (
        <View style={styles.centeredBox}>
          <Text style={styles.emptySubtitle}>
            Conecte o serviço de catálogo para acompanhar episódios e temporadas futuras.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.segmentedBar}>
            <Pressable
              onPress={() => setMode('WEEKLY')}
              accessibilityRole="button"
              testID="calendar-mode-weekly"
              style={[
                styles.segmentButton,
                mode === 'WEEKLY' && styles.segmentButtonActive,
              ]}
            >
              <Text
                style={[
                  styles.segmentButtonText,
                  mode === 'WEEKLY' && styles.segmentButtonTextActive,
                ]}
              >
                Grade da Semana
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setMode('UPCOMING')}
              accessibilityRole="button"
              testID="calendar-mode-upcoming"
              style={[
                styles.segmentButton,
                mode === 'UPCOMING' && styles.segmentButtonActive,
              ]}
            >
              <Text
                style={[
                  styles.segmentButtonText,
                  mode === 'UPCOMING' && styles.segmentButtonTextActive,
                ]}
              >
                Próximas Temporadas
              </Text>
            </Pressable>
          </View>

          {mode === 'WEEKLY' ? (
            <View style={styles.weekdayBarContainer}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.weekdayRail}
              >
                {WEEKDAY_OPTIONS.map((day) => {
                  const isSelected = selectedWeekday === day.index;
                  const isToday = todayWeekdayIndex === day.index;
                  const dayCount = (weeklySchedule[day.index] ?? []).length;

                  return (
                    <Pressable
                      key={day.index}
                      onPress={() => setSelectedWeekday(day.index)}
                      accessibilityRole="button"
                      testID={`weekday-chip-${day.index}`}
                      style={[
                        styles.weekdayChip,
                        isToday && !isSelected && styles.weekdayChipToday,
                        isSelected && styles.weekdayChipSelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.weekdayChipText,
                          isSelected && styles.weekdayChipTextSelected,
                        ]}
                      >
                        {day.shortLabel}
                      </Text>
                      {isToday ? (
                        <Text
                          style={[
                            styles.todayTag,
                            isSelected && styles.todayTagSelected,
                          ]}
                        >
                          Hoje
                        </Text>
                      ) : dayCount > 0 ? (
                        <Text
                          style={[
                            styles.countTag,
                            isSelected && styles.todayTagSelected,
                          ]}
                        >
                          {String(dayCount)}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          {loading ? (
            <View style={styles.centeredBox}>
              <ActivityIndicator size="large" color={THEME_TOKENS.accent.primary} />
              <Text style={styles.emptySubtitle}>Carregando programação...</Text>
            </View>
          ) : (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => void loadCalendarData('refresh')}
                  tintColor={THEME_TOKENS.accent.primary}
                />
              }
            >
              {errorMessage ? (
                <View style={styles.errorCard}>
                  <Text style={styles.errorText}>{errorMessage}</Text>
                  <Pressable
                    onPress={() => void loadCalendarData('initial')}
                    accessibilityRole="button"
                    style={styles.retryButton}
                  >
                    <Text style={styles.retryButtonText}>Tentar novamente</Text>
                  </Pressable>
                </View>
              ) : null}

              {mode === 'WEEKLY' ? (
                activeDayEntries.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>Dia tranquilo</Text>
                    <Text style={styles.emptySubtitle}>
                      Nenhum episódio previsto para este dia.
                    </Text>
                  </View>
                ) : (
                  activeDayEntries.map((entry) => {
                    const title = getMediaDisplayTitle(entry.media);
                    const userStatus = statusByMediaId.get(entry.media.id);
                    const statusLabel = userStatus
                      ? STATUS_META[userStatus].label
                      : null;

                    return (
                      <Pressable
                        key={`${entry.media.id}-${entry.episodeNumber}-${entry.airingAtUnix}`}
                        onPress={() =>
                          navigateToAnimeDetails(navigation, entry.media)
                        }
                        accessibilityRole="button"
                        testID={`schedule-card-${entry.media.id}-${entry.episodeNumber}`}
                        style={({ pressed }) => [
                          styles.itemCard,
                          entry.inUserActiveList && styles.itemCardActiveMint,
                          pressed && styles.pressedOpacity,
                        ]}
                      >
                        <View style={styles.thumbFrame}>
                          {entry.media.coverUrl.trim().length > 0 ? (
                            <Image
                              source={{ uri: entry.media.coverUrl }}
                              style={styles.thumbImage}
                              resizeMode="cover"
                            />
                          ) : (
                            <View style={styles.thumbFallback}>
                              <Text style={styles.thumbFallbackText}>
                                {title.slice(0, 2).toUpperCase()}
                              </Text>
                            </View>
                          )}
                        </View>

                        <View style={styles.itemBody}>
                          <View style={styles.badgeRow}>
                            <Text style={styles.clockText}>
                              {formatAiringClock(entry.airingAtUnix)}
                            </Text>
                            <Text style={styles.episodeText}>
                              {`Ep. ${entry.episodeNumber}`}
                            </Text>
                            {entry.inUserActiveList ? (
                              <View style={styles.mintPill}>
                                <Text style={styles.mintPillText}>
                                  Na sua lista
                                </Text>
                              </View>
                            ) : null}
                          </View>

                          <Text style={styles.itemTitle} numberOfLines={2}>
                            {title}
                          </Text>

                          {userStatus && statusLabel ? (
                            <Text
                              style={[
                                styles.statusSubText,
                                { color: STATUS_META[userStatus].color },
                              ]}
                            >
                              {statusLabel}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })
                )
              ) : upcomingSeasons.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>Radar vazio</Text>
                  <Text style={styles.emptySubtitle}>
                    Nenhuma próxima temporada catalogada no momento.
                  </Text>
                </View>
              ) : (
                upcomingSeasons.map((entry) => {
                  const title = getMediaDisplayTitle(entry.media);
                  const genresLine = formatGenresPreview(entry.media.genresJson);

                  return (
                    <Pressable
                      key={entry.media.id}
                      onPress={() =>
                        navigateToAnimeDetails(navigation, entry.media)
                      }
                      accessibilityRole="button"
                      testID={`upcoming-card-${entry.media.id}`}
                      style={({ pressed }) => [
                        styles.itemCard,
                        entry.isSequelToLibraryItem &&
                          styles.itemCardSequelCoral,
                        pressed && styles.pressedOpacity,
                      ]}
                    >
                      <View style={styles.thumbFrame}>
                        {entry.media.coverUrl.trim().length > 0 ? (
                          <Image
                            source={{ uri: entry.media.coverUrl }}
                            style={styles.thumbImage}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={styles.thumbFallback}>
                            <Text style={styles.thumbFallbackText}>
                              {title.slice(0, 2).toUpperCase()}
                            </Text>
                          </View>
                        )}
                      </View>

                      <View style={styles.itemBody}>
                        <View style={styles.badgeRow}>
                          <View style={styles.releasePill}>
                            <Text style={styles.releasePillText}>
                              {entry.releaseLabel}
                            </Text>
                          </View>
                          {entry.isSequelToLibraryItem ? (
                            <View style={styles.coralPill}>
                              <Text style={styles.coralPillText}>
                                Nova temporada de algo que você viu!
                              </Text>
                            </View>
                          ) : null}
                        </View>

                        <Text style={styles.itemTitle} numberOfLines={2}>
                          {title}
                        </Text>

                        {genresLine ? (
                          <Text style={styles.genresText} numberOfLines={1}>
                            {genresLine}
                          </Text>
                        ) : null}

                        {entry.media.synopsis ? (
                          <Text style={styles.synopsisText} numberOfLines={2}>
                            {entry.media.synopsis}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
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
  segmentedBar: {
    flexDirection: 'row',
    gap: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.md,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
  },
  segmentButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
  },
  segmentButtonActive: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderColor: THEME_TOKENS.accent.primary,
  },
  segmentButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.secondary,
  },
  segmentButtonTextActive: {
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  weekdayBarContainer: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomColor: THEME_TOKENS.border.subtle,
    borderBottomWidth: 1,
  },
  weekdayRail: {
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    gap: THEME_TOKENS.spacing.sm,
  },
  weekdayChip: {
    minWidth: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    gap: 2,
  },
  weekdayChipToday: {
    borderColor: THEME_TOKENS.accent.primary,
  },
  weekdayChipSelected: {
    backgroundColor: THEME_TOKENS.accent.primary,
    borderColor: THEME_TOKENS.accent.primary,
  },
  weekdayChipText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  weekdayChipTextSelected: {
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  todayTag: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  countTag: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.text.secondary,
  },
  todayTagSelected: {
    color: THEME_TOKENS.bg.canvas,
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
  errorCard: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.accent.secondary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    padding: THEME_TOKENS.spacing.lg,
    gap: THEME_TOKENS.spacing.sm,
  },
  errorText: {
    ...THEME_TOKENS.typography.body,
    color: THEME_TOKENS.accent.secondary,
  },
  retryButton: {
    alignSelf: 'flex-start',
    backgroundColor: THEME_TOKENS.accent.primary,
    paddingHorizontal: THEME_TOKENS.spacing.lg,
    paddingVertical: THEME_TOKENS.spacing.sm,
    borderRadius: THEME_TOKENS.radius.md,
  },
  retryButtonText: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  itemCard: {
    flexDirection: 'row',
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    overflow: 'hidden',
  },
  itemCardActiveMint: {
    borderColor: THEME_TOKENS.accent.primary,
  },
  itemCardSequelCoral: {
    borderColor: THEME_TOKENS.accent.secondary,
  },
  thumbFrame: {
    width: 84,
    minHeight: 112,
    backgroundColor: THEME_TOKENS.bg.surface,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  thumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbFallbackText: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.secondary,
  },
  itemBody: {
    flex: 1,
    padding: THEME_TOKENS.spacing.md,
    gap: THEME_TOKENS.spacing.xs,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.sm,
  },
  clockText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.text.primary,
  },
  episodeText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.gold,
  },
  mintPill: {
    backgroundColor: STATUS_META.WATCHING.backgroundColor,
    borderColor: THEME_TOKENS.accent.primary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.pill,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 2,
  },
  mintPillText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  releasePill: {
    backgroundColor: THEME_TOKENS.bg.surface,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.pill,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 2,
  },
  releasePillText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.primary,
  },
  coralPill: {
    backgroundColor: STATUS_META.DROPPED.backgroundColor,
    borderColor: THEME_TOKENS.accent.secondary,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.pill,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 2,
  },
  coralPillText: {
    ...THEME_TOKENS.typography.badge,
    color: THEME_TOKENS.accent.secondary,
  },
  itemTitle: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  statusSubText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
  },
  genresText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  synopsisText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
  pressedOpacity: {
    opacity: 0.84,
  },
});
