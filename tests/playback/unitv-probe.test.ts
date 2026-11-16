import {
  buildPortalUrl,
  classifyProbeOutcome,
  parseInjectedStreamPayload,
  UNITV_STREAM_HOOK_SCRIPT,
} from '../../src/playback/unitv-probe';

describe('unitv-probe', () => {
  it('normalizes configurable UniTV portal URLs without trailing slash bugs', () => {
    expect(buildPortalUrl('https://www.uvwebs.info/', '/vod/anime/12')).toBe(
      'https://www.uvwebs.info/vod/anime/12'
    );
    expect(buildPortalUrl('https://mirror.unitv.example', 'login')).toBe(
      'https://mirror.unitv.example/login'
    );
    expect(buildPortalUrl('https://www.uvwebs.info///', '///')).toBe(
      'https://www.uvwebs.info'
    );
  });

  it('extracts valid m3u8 or mp4 stream payloads and ignores ads/thumbnails', () => {
    const valid = parseInjectedStreamPayload(
      JSON.stringify({
        type: 'STREAM_CAPTURED',
        url: 'https://cdn.example.com/solo-s2/ep06/1080p/index.m3u8',
        headers: { Referer: 'https://www.uvwebs.info/' },
      })
    );
    expect(valid).toEqual({
      url: 'https://cdn.example.com/solo-s2/ep06/1080p/index.m3u8',
      headers: { Referer: 'https://www.uvwebs.info/' },
    });

    const validMp4WithQuery = parseInjectedStreamPayload(
      JSON.stringify({
        type: 'STREAM_CAPTURED',
        url: 'https://cdn.example.com/episodes/ep01.mp4?token=abc123',
      })
    );
    expect(validMp4WithQuery).toEqual({
      url: 'https://cdn.example.com/episodes/ep01.mp4?token=abc123',
      headers: {},
    });

    const ignored = parseInjectedStreamPayload(
      JSON.stringify({ type: 'STREAM_CAPTURED', url: 'https://cdn.example.com/poster.jpg' })
    );
    expect(ignored).toBeNull();

    expect(parseInjectedStreamPayload('not-valid-json')).toBeNull();
    expect(
      parseInjectedStreamPayload(
        JSON.stringify({ type: 'OTHER_EVENT', url: 'https://cdn.example.com/video.m3u8' })
      )
    ).toBeNull();
  });

  it('classifies probe outcomes for Phase 1 Spike Decision Gate', () => {
    expect(
      classifyProbeOutcome({
        extractedUrl: 'https://cdn.example.com/video.m3u8',
        authSucceeded: true,
        pageBlockedByBot: false,
      })
    ).toEqual({
      status: 'STREAM_READY',
      streamUrl: 'https://cdn.example.com/video.m3u8',
    });

    const webViewOnly = classifyProbeOutcome({
      extractedUrl: null,
      authSucceeded: true,
      pageBlockedByBot: false,
    });
    expect(webViewOnly.status).toBe('WEBVIEW_ONLY');

    const blockedByBot = classifyProbeOutcome({
      extractedUrl: null,
      authSucceeded: false,
      pageBlockedByBot: true,
    });
    expect(blockedByBot.status).toBe('BLOCKED');

    const blockedAuth = classifyProbeOutcome({
      extractedUrl: null,
      authSucceeded: false,
      pageBlockedByBot: false,
    });
    expect(blockedAuth.status).toBe('BLOCKED');
  });

  it('provides a JS injection hook targeting video elements, fetch, and XHR', () => {
    expect(UNITV_STREAM_HOOK_SCRIPT).toContain('.m3u8');
    expect(UNITV_STREAM_HOOK_SCRIPT).toContain('.mp4');
    expect(UNITV_STREAM_HOOK_SCRIPT).toContain('ReactNativeWebView.postMessage');
    expect(UNITV_STREAM_HOOK_SCRIPT).toContain('fetch');
    expect(UNITV_STREAM_HOOK_SCRIPT).toContain('XMLHttpRequest');
    expect(UNITV_STREAM_HOOK_SCRIPT).toContain('video');
    expect(() => new Function(UNITV_STREAM_HOOK_SCRIPT)).not.toThrow();
  });
});
