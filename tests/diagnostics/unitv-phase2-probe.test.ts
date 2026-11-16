import {
  createInitialExoPlayerState,
  formatPhase2ReportSection,
  parsePhase2WebViewMessage,
  PHASE2_DOM_INSPECT_SCRIPT,
  PHASE2_STREAM_CAPTURE_SCRIPT,
} from '../../src/diagnostics/unitv-phase2-probe';

describe('unitv-phase2-probe', () => {
  it('provides valid JS probes that never access document.cookie, localStorage, sessionStorage, or input values', () => {
    expect(() => new Function(PHASE2_DOM_INSPECT_SCRIPT)).not.toThrow();
    expect(() => new Function(PHASE2_STREAM_CAPTURE_SCRIPT)).not.toThrow();

    for (const script of [PHASE2_DOM_INSPECT_SCRIPT, PHASE2_STREAM_CAPTURE_SCRIPT]) {
      expect(script).not.toMatch(/document\.cookie/i);
      expect(script).not.toMatch(/localStorage/i);
      expect(script).not.toMatch(/sessionStorage/i);
      expect(script).not.toMatch(/\.value\b/);
    }

    expect(PHASE2_DOM_INSPECT_SCRIPT).toContain('DIAG_PHASE2_DOM');
    expect(PHASE2_DOM_INSPECT_SCRIPT).toContain('v-player_html5_api');
    expect(PHASE2_STREAM_CAPTURE_SCRIPT).toContain('DIAG_PHASE2_STREAM');
    expect(PHASE2_STREAM_CAPTURE_SCRIPT).toContain('XMLHttpRequest');
  });

  it('parses and sanitizes DOM snapshots, stripping queries/hashes and truncating oversized lists', () => {
    const oversizedInputs = Array.from({ length: 20 }, (_, i) => ({
      tag: 'INPUT',
      type: i === 0 ? 'password' : 'search',
      name: `field-${i}`,
      id: `input-${i}`,
      placeholder: 'Buscar anime',
      value: 'super-secret-password',
    }));
    const oversizedActions = Array.from({ length: 45 }, (_, i) => ({
      tag: 'A',
      id: `item-${i}`,
      className: 'vod-card',
      href: `https://www.unitvwebs.com/vod/details/0/ABC${i}?token=secret${i}#frag`,
      text: `Episódio ${i} - ${'x'.repeat(120)}`,
    }));

    const parsed = parsePhase2WebViewMessage(
      JSON.stringify({
        type: 'DIAG_PHASE2_DOM',
        payload: {
          url: 'https://user:pass@www.unitvwebs.com/search/vod?q=Naruto&sid=999#top',
          title: 'UniTV Busca',
          inputs: oversizedInputs,
          actions: oversizedActions,
          video: {
            found: true,
            id: 'v-player_html5_api',
            src: 'https://cdn.example.com/naruto/ep1/master.m3u8?auth=secret_key',
            readyState: 4,
            videoWidth: 1920,
            videoHeight: 1080,
            duration: 1440,
            paused: false,
            textTrackCount: 1,
          },
        },
      })
    );

    expect(parsed?.kind).toBe('DOM');
    if (parsed?.kind !== 'DOM') {
      throw new Error('Expected DOM result');
    }

    expect(parsed.snapshot.url).toBe('https://www.unitvwebs.com/search/vod');
    expect(parsed.snapshot.inputs).toHaveLength(15);
    expect(JSON.stringify(parsed.snapshot.inputs)).not.toContain('super-secret-password');
    expect(parsed.snapshot.actions).toHaveLength(40);
    expect(parsed.snapshot.actions[0].hrefPath).toBe(
      'https://www.unitvwebs.com/vod/details/0/ABC0'
    );
    expect(parsed.snapshot.actions[0].text.length).toBeLessThanOrEqual(80);
    expect(parsed.snapshot.video).toEqual({
      found: true,
      id: 'v-player_html5_api',
      srcKind: 'HTTP_STREAM',
      srcSanitized: 'https://cdn.example.com/naruto/ep1/master.m3u8',
      readyState: 4,
      videoWidth: 1920,
      videoHeight: 1080,
      duration: 1440,
      paused: false,
      textTrackCount: 1,
    });
    expect(JSON.stringify(parsed.snapshot)).not.toContain('secret_key');
    expect(JSON.stringify(parsed.snapshot)).not.toContain('sid=999');
  });

  it('parses stream candidates keeping secret query tokens only on in-memory candidate and classifies blob: URLs safely', () => {
    const candidateParsed = parsePhase2WebViewMessage(
      JSON.stringify({
        type: 'DIAG_PHASE2_STREAM',
        url: 'https://cdn.example.com/live/master.m3u8?token=secret123&exp=999',
        referer: 'https://www.unitvwebs.com/vod/details/0/ABC?session=private',
        userAgent: 'AndroidTestUA/1.0',
        sourceTag: 'fetch',
        mimeHint: 'application/vnd.apple.mpegurl',
      })
    );

    expect(candidateParsed?.kind).toBe('STREAM_CANDIDATE');
    if (candidateParsed?.kind !== 'STREAM_CANDIDATE') {
      throw new Error('Expected STREAM_CANDIDATE');
    }

    expect(candidateParsed.entry.sanitizedUrl).toBe(
      'https://cdn.example.com/live/master.m3u8'
    );
    expect(candidateParsed.entry.sanitizedUrl).not.toContain('secret123');
    expect(candidateParsed.candidate.streamUrl).toBe(
      'https://cdn.example.com/live/master.m3u8?token=secret123&exp=999'
    );
    expect(candidateParsed.candidate.referer).toBe(
      'https://www.unitvwebs.com/vod/details/0/ABC'
    );

    const blobParsed = parsePhase2WebViewMessage(
      JSON.stringify({
        type: 'DIAG_PHASE2_STREAM',
        url: 'blob:https://www.unitvwebs.com/550e8400-e29b-41d4-a716-446655440000',
        referer: 'https://www.unitvwebs.com/vod/details/0/ABC',
        userAgent: 'AndroidTestUA/1.0',
        sourceTag: 'video.src',
        mimeHint: null,
      })
    );

    expect(blobParsed?.kind).toBe('STREAM_BLOB');
    if (blobParsed?.kind !== 'STREAM_BLOB') {
      throw new Error('Expected STREAM_BLOB');
    }
    expect(blobParsed.entry.sanitizedUrl).toBe('blob://[redacted]');
  });

  it('formats sanitized Phase 2 report including DOM, stream logs, and ExoPlayer state without tokens', () => {
    const domRes = parsePhase2WebViewMessage(
      JSON.stringify({
        type: 'DIAG_PHASE2_DOM',
        payload: {
          url: 'https://www.unitvwebs.com/vod/details/0/ABC?token=hidden',
          title: 'Naruto Ep 1',
          inputs: [{ tag: 'INPUT', type: 'search', name: 'kw', id: 'searchBox', placeholder: 'Buscar' }],
          actions: [{ tag: 'BUTTON', id: 'ep1', className: 'ep-btn', href: null, text: 'Ep 1' }],
          video: {
            found: true,
            id: 'v-player_html5_api',
            src: 'blob:https://www.unitvwebs.com/abc-123',
            readyState: 4,
            videoWidth: 1280,
            videoHeight: 720,
            duration: 1420,
            paused: false,
            textTrackCount: 1,
          },
        },
      })
    );
    const streamRes = parsePhase2WebViewMessage(
      JSON.stringify({
        type: 'DIAG_PHASE2_STREAM',
        url: 'https://cdn.example.com/ep1/index.m3u8?token=very_secret',
        referer: 'https://www.unitvwebs.com/vod/details/0/ABC',
        userAgent: 'AndroidTestUA/1.0',
        sourceTag: 'xhr',
        mimeHint: 'application/x-mpegURL',
      })
    );
    if (domRes?.kind !== 'DOM' || streamRes?.kind !== 'STREAM_CANDIDATE') {
      throw new Error('Unexpected test parse result');
    }

    const exoState = {
      ...createInitialExoPlayerState(),
      status: 'PLAYING' as const,
      durationSeconds: 1420,
      currentSeconds: 15,
      resolutionLabel: '1080p',
      manualConfirm: true,
    };

    const report = formatPhase2ReportSection({
      domSnapshots: [domRes.snapshot],
      streamLogs: [streamRes.entry],
      exoState,
    });

    expect(report).toContain('https://www.unitvwebs.com/vod/details/0/ABC');
    expect(report).toContain('searchBox');
    expect(report).toContain('v-player_html5_api');
    expect(report).toContain('https://cdn.example.com/ep1/index.m3u8');
    expect(report).toContain('ExoPlayer: PLAYING');
    expect(report).toContain('1080p');
    expect(report).not.toContain('very_secret');
    expect(report).not.toContain('token=hidden');
  });
});
