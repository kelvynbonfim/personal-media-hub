import React from 'react';
import {
  Image,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { MediaItemRecord, WatchStatus } from '../db/schema';
import { STATUS_META, THEME_TOKENS } from '../theme/tokens';

export interface MediaPosterCardProps {
  item: MediaItemRecord;
  status?: WatchStatus;
  progressLabel?: string;
  rankBadge?: number;
  onPress: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Resolves the preferred localized title (`titlePt ?? titleEnglish ?? titleRomaji`).
 */
export function getMediaDisplayTitle(
  item: Pick<MediaItemRecord, 'titlePt' | 'titleEnglish' | 'titleRomaji'>
): string {
  return item.titlePt?.trim() || item.titleEnglish?.trim() || item.titleRomaji.trim();
}

function buildMetadataLine(item: MediaItemRecord): string | null {
  const parts: string[] = [];
  if (item.seasonYear !== null) {
    parts.push(String(item.seasonYear));
  }
  if (item.episodesTotal !== null) {
    parts.push(`${item.episodesTotal} ep`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function MediaPosterCard({
  item,
  status,
  progressLabel,
  rankBadge,
  onPress,
  onLongPress,
  style,
  testID,
}: MediaPosterCardProps): React.JSX.Element {
  const title = getMediaDisplayTitle(item);
  const statusMeta = status ? STATUS_META[status] : undefined;
  const trimmedProgress = progressLabel?.trim() || undefined;
  const metadataLine = buildMetadataLine(item);
  const hasCover = item.coverUrl.trim().length > 0;
  const isTopRank = rankBadge === 1;

  const accessibilityParts = [title];
  if (rankBadge !== undefined) {
    accessibilityParts.push(`posição #${rankBadge}`);
  }
  if (statusMeta) {
    accessibilityParts.push(`status ${statusMeta.label}`);
  }
  if (trimmedProgress) {
    accessibilityParts.push(trimmedProgress);
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityParts.join(', ')}
      testID={testID}
      style={({ pressed }) => [
        styles.card,
        pressed && styles.cardPressed,
        style,
      ]}
    >
      <View style={styles.posterFrame}>
        {hasCover ? (
          <Image
            source={{ uri: item.coverUrl }}
            style={styles.posterImage}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.posterFallback}>
            <Text style={styles.posterFallbackText} numberOfLines={2}>
              {title.slice(0, 2).toUpperCase()}
            </Text>
          </View>
        )}

        {rankBadge !== undefined ? (
          <View
            style={[
              styles.rankBadge,
              isTopRank ? styles.rankBadgeTop : styles.rankBadgeDefault,
            ]}
          >
            <Text
              style={[
                styles.rankBadgeText,
                isTopRank ? styles.rankBadgeTextTop : styles.rankBadgeTextDefault,
              ]}
            >
              #{rankBadge}
            </Text>
          </View>
        ) : null}

        {statusMeta ? (
          <View
            style={[
              styles.statusBadge,
              {
                backgroundColor: statusMeta.backgroundColor,
                borderColor: statusMeta.color,
              },
            ]}
          >
            <Text style={[styles.statusBadgeText, { color: statusMeta.color }]}>
              {statusMeta.shortLabel}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {trimmedProgress ? (
          <Text style={styles.progressText} numberOfLines={1}>
            {trimmedProgress}
          </Text>
        ) : null}
        {metadataLine ? (
          <Text style={styles.metaText} numberOfLines={1}>
            {metadataLine}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.lg,
    overflow: 'hidden',
  },
  cardPressed: {
    opacity: 0.85,
  },
  posterFrame: {
    position: 'relative',
    width: '100%',
    aspectRatio: 2 / 3,
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
    padding: THEME_TOKENS.spacing.sm,
    backgroundColor: THEME_TOKENS.bg.surface,
  },
  posterFallbackText: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.secondary,
  },
  rankBadge: {
    position: 'absolute',
    top: THEME_TOKENS.spacing.sm,
    left: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 3,
    borderRadius: THEME_TOKENS.radius.sm,
    borderWidth: 1,
  },
  rankBadgeTop: {
    backgroundColor: THEME_TOKENS.accent.secondary,
    borderColor: THEME_TOKENS.accent.secondary,
  },
  rankBadgeDefault: {
    backgroundColor: 'rgba(8, 11, 12, 0.88)',
    borderColor: THEME_TOKENS.border.subtle,
  },
  rankBadgeText: {
    ...THEME_TOKENS.typography.badge,
  },
  rankBadgeTextTop: {
    color: THEME_TOKENS.bg.canvas,
  },
  rankBadgeTextDefault: {
    color: THEME_TOKENS.accent.gold,
  },
  statusBadge: {
    position: 'absolute',
    top: THEME_TOKENS.spacing.sm,
    right: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.sm,
    paddingVertical: 3,
    borderRadius: THEME_TOKENS.radius.pill,
    borderWidth: 1,
  },
  statusBadgeText: {
    ...THEME_TOKENS.typography.badge,
  },
  body: {
    padding: THEME_TOKENS.spacing.sm,
    gap: 3,
  },
  title: {
    ...THEME_TOKENS.typography.cardTitle,
    color: THEME_TOKENS.text.primary,
  },
  progressText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
    fontWeight: '600',
  },
  metaText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.secondary,
  },
});
