import { TextStyle } from 'react-native';
import { WatchStatus } from '../db/schema';

export interface TypographyToken extends Pick<
  TextStyle,
  'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing'
> {
  fontSize: number;
  lineHeight: number;
  fontWeight: NonNullable<TextStyle['fontWeight']>;
}

export const THEME_TOKENS = {
  bg: {
    canvas: '#080B0C',
    surface: '#0D1214',
    card: '#131B1F',
  },
  border: {
    subtle: '#1E2C30',
  },
  accent: {
    primary: '#2DD4BF',
    secondary: '#FB7185',
    gold: '#FBBF24',
  },
  text: {
    primary: '#F0FDFA',
    secondary: '#94A3B8',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 14,
    xl: 20,
    pill: 999,
  },
  typography: {
    heroTitle: {
      fontSize: 24,
      lineHeight: 30,
      fontWeight: '700',
      letterSpacing: -0.3,
    },
    sectionTitle: {
      fontSize: 18,
      lineHeight: 24,
      fontWeight: '700',
      letterSpacing: -0.2,
    },
    cardTitle: {
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '600',
    },
    body: {
      fontSize: 14,
      lineHeight: 20,
      fontWeight: '400',
    },
    caption: {
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '500',
    },
    badge: {
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '700',
    },
  } satisfies Record<string, TypographyToken>,
} as const;

export interface WatchStatusMeta {
  label: string;
  shortLabel: string;
  color: string;
  backgroundColor: string;
}

export const STATUS_META: Record<WatchStatus, WatchStatusMeta> = {
  WATCHING: {
    label: 'Assistindo',
    shortLabel: 'Vendo',
    color: THEME_TOKENS.accent.primary,
    backgroundColor: 'rgba(13, 40, 38, 0.92)',
  },
  PLAN_TO_WATCH: {
    label: 'Pretendo assistir',
    shortLabel: '+ Fila',
    color: THEME_TOKENS.text.secondary,
    backgroundColor: 'rgba(19, 27, 31, 0.92)',
  },
  COMPLETED: {
    label: 'Concluído',
    shortLabel: '✓ Visto',
    color: THEME_TOKENS.text.primary,
    backgroundColor: 'rgba(16, 48, 44, 0.92)',
  },
  PAUSED: {
    label: 'Pausado',
    shortLabel: 'Pausado',
    color: THEME_TOKENS.accent.gold,
    backgroundColor: 'rgba(41, 32, 14, 0.92)',
  },
  DROPPED: {
    label: 'Dropado',
    shortLabel: 'Dropado',
    color: THEME_TOKENS.accent.secondary,
    backgroundColor: 'rgba(46, 20, 27, 0.92)',
  },
  REWATCHING: {
    label: 'Reassistindo',
    shortLabel: 'Reassist.',
    color: THEME_TOKENS.accent.primary,
    backgroundColor: 'rgba(19, 36, 44, 0.92)',
  },
};
