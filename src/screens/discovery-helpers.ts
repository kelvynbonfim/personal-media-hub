import { parseGenresSafe } from '../catalog/types';
import { LibraryRepository } from '../db/library-repository';
import { LibraryEntryRecord, MediaItemRecord, WatchStatus } from '../db/schema';
import { AppServices } from '../navigation/AppServicesContext';

export interface DiscoveryNavigation {
  navigate: (routeName: string, params?: any) => void;
  addListener?: (event: string, callback: () => void) => () => void;
}

export interface BaseDiscoveryScreenProps {
  navigation?: DiscoveryNavigation;
  services?: Partial<AppServices>;
}

export interface WeekdayOption {
  index: number;
  shortLabel: string;
  fullLabel: string;
}

export const WEEKDAY_OPTIONS: readonly WeekdayOption[] = [
  { index: 1, shortLabel: 'Seg', fullLabel: 'Segunda-feira' },
  { index: 2, shortLabel: 'Ter', fullLabel: 'Terça-feira' },
  { index: 3, shortLabel: 'Qua', fullLabel: 'Quarta-feira' },
  { index: 4, shortLabel: 'Qui', fullLabel: 'Quinta-feira' },
  { index: 5, shortLabel: 'Sex', fullLabel: 'Sexta-feira' },
  { index: 6, shortLabel: 'Sáb', fullLabel: 'Sábado' },
  { index: 0, shortLabel: 'Dom', fullLabel: 'Domingo' },
] as const;

const WEEKDAY_SHORT_BY_INDEX = new Map<number, string>(
  WEEKDAY_OPTIONS.map((option) => [option.index, option.shortLabel])
);

export function getWeekdayShortLabel(weekdayIndex: number): string {
  return WEEKDAY_SHORT_BY_INDEX.get(weekdayIndex) ?? '';
}

export function formatAiringClock(airingAtUnix: number): string {
  const date = new Date(airingAtUnix * 1000);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatGenresPreview(genresJson: string, max = 3): string {
  return parseGenresSafe(genresJson).slice(0, max).join(' · ');
}

export function buildStatusByMediaId(
  entries: LibraryEntryRecord[]
): Map<string, WatchStatus> {
  return new Map(entries.map((entry) => [entry.mediaItemId, entry.status]));
}

export function resolveDiscoveryServices(
  injected?: Partial<AppServices>,
  fromContext?: AppServices | null
): {
  catalogService: AppServices['catalogService'] | null;
  libraryRepository: AppServices['libraryRepository'] | null;
} {
  return {
    catalogService: injected?.catalogService ?? fromContext?.catalogService ?? null,
    libraryRepository:
      injected?.libraryRepository ?? fromContext?.libraryRepository ?? null,
  };
}

/**
 * Persists a library status change, upserting the MediaItemRecord first if
 * an offline/mocked feed item is not yet stored in SQLite.
 */
export async function persistLibraryStatus(
  repo: LibraryRepository,
  media: MediaItemRecord,
  status: WatchStatus
): Promise<LibraryEntryRecord> {
  try {
    return await repo.setLibraryStatus(media.id, status);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (
      message.includes('Media item not found') &&
      typeof repo.upsertMediaItem === 'function'
    ) {
      await repo.upsertMediaItem(media);
      return repo.setLibraryStatus(media.id, status);
    }
    throw error;
  }
}

export function navigateToAnimeDetails(
  navigation: DiscoveryNavigation | undefined,
  media: Pick<MediaItemRecord, 'id' | 'anilistId'>
): void {
  navigation?.navigate('AnimeDetails', {
    anilistId: media.anilistId,
    mediaItemId: media.id,
  });
}

export function navigateToVideoPlayer(
  navigation: DiscoveryNavigation | undefined,
  mediaItemId: string,
  episodeNumber: number
): void {
  navigation?.navigate('VideoPlayer', {
    mediaItemId,
    episodeNumber,
  });
}
