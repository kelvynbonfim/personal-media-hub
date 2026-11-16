import { MediaItemRecord, UniTvLinkRecord } from '../db/schema';

export type PlaybackMode = 'EXOPLAYER_HLS' | 'CLEAN_WEBVIEW';

export type PlaybackErrorCode =
  | 'CONCURRENT_SCREEN_LIMIT'
  | 'NOT_FOUND_IN_CATALOG'
  | 'AUTH_FAILED';

export interface PlaybackResolution {
  mode: PlaybackMode;
  streamUrl?: string;
  headers?: Record<string, string>;
  webViewUrl?: string;
  matchedTitle?: string;
  vodId?: string;
  errorCode?: PlaybackErrorCode;
}

export interface PlaybackResolveParams {
  media: MediaItemRecord;
  episodeNumber: number;
  existingLink: UniTvLinkRecord | null;
  portalUrl: string;
}

export interface PlaybackSourceAdapter {
  resolveEpisodePlayback(params: PlaybackResolveParams): Promise<PlaybackResolution>;
}
