export interface HlsVariant {
  index: number;
  width: number;
  height: number;
  bitrate: number;
}

function normalizeMetric(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatQualityLabel(variant: HlsVariant): string {
  const height = normalizeMetric(variant.height);
  if (height > 0) {
    return `${Math.round(height)}p`;
  }

  const width = normalizeMetric(variant.width);
  if (width >= 3840) {
    return '2160p';
  }
  if (width >= 1920) {
    return '1080p';
  }
  if (width >= 1280) {
    return '720p';
  }
  if (width >= 854) {
    return '480p';
  }
  return width > 0 ? `${Math.round(width)}w` : 'auto';
}

/**
 * Selects the highest-resolution and highest-bitrate HLS video variant.
 */
export function selectBestHlsTrack(
  variants: HlsVariant[]
): { index: number; label: string } | null {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }

  const sorted = [...variants].sort((a, b) => {
    const heightDiff = normalizeMetric(b.height) - normalizeMetric(a.height);
    if (heightDiff !== 0) {
      return heightDiff;
    }

    const widthDiff = normalizeMetric(b.width) - normalizeMetric(a.width);
    if (widthDiff !== 0) {
      return widthDiff;
    }

    const bitrateDiff = normalizeMetric(b.bitrate) - normalizeMetric(a.bitrate);
    if (bitrateDiff !== 0) {
      return bitrateDiff;
    }

    return a.index - b.index;
  });

  const best = sorted[0];
  return {
    index: best.index,
    label: formatQualityLabel(best),
  };
}
