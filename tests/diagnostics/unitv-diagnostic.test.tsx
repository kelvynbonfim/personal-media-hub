import React from 'react';
import { Share } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import Video from 'react-native-video';
import { WebView } from 'react-native-webview';
import appConfigFactory from '../../app.config';
import {
  classifyWebViewNavigationTarget,
  createInitialDiagnosticChecks,
  evaluateDiagnosticConclusion,
  isStandaloneUniTvDiagnosticMode,
  isUniTvDiagnosticAvailable,
  sanitizeDiagnosticUrl,
  UNITV_DIAGNOSTIC_PACKAGE_ID,
  UNITV_DIAGNOSTIC_PORTAL_URL,
} from '../../src/diagnostics/unitv-diagnostic';
import { LibraryRepository } from '../../src/db/library-repository';
import { DEFAULT_APP_SETTINGS } from '../../src/db/schema';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { UniTvDiagnosticScreen } from '../../src/screens/UniTvDiagnosticScreen';

function makeMockRepo(): Partial<LibraryRepository> {
  return {
    getSettings: jest.fn(async () => ({ ...DEFAULT_APP_SETTINGS })),
    saveSettings: jest.fn(async (patch) => ({
      ...DEFAULT_APP_SETTINGS,
      ...patch,
    })),
  };
}

describe('UniTV WebView Android bounded diagnostic', () => {
  const originalEnv = process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC;
  const originalDev = (globalThis as Record<string, unknown>).__DEV__;

  afterEach(() => {
    jest.useRealTimers();
    if (originalEnv === undefined) {
      delete process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC;
    } else {
      process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC = originalEnv;
    }
    (globalThis as Record<string, unknown>).__DEV__ = originalDev;
  });

  it('sanitizes URLs removing credentials, query strings, hashes, and non-http payloads', () => {
    expect(
      sanitizeDiagnosticUrl(
        'https://user:secret@www.unitvwebs.com/vod/details/123?token=abc#player'
      )
    ).toBe('https://www.unitvwebs.com/vod/details/123');
    expect(sanitizeDiagnosticUrl('intent://watch/123?token=xyz#Intent')).toBe(
      'intent://[redacted]'
    );
    expect(sanitizeDiagnosticUrl('unitv://open?secret=1')).toBe(
      'unitv://[redacted]'
    );
    expect(sanitizeDiagnosticUrl('')).toBe('[empty-url]');
  });

  it('classifies portal, external hosts, and blocks external schemes', () => {
    expect(
      classifyWebViewNavigationTarget('https://www.unitvwebs.com/vod/details/100')
    ).toEqual({
      allowInWebView: true,
      kind: 'PORTAL',
      sanitizedUrl: 'https://www.unitvwebs.com/vod/details/100',
      host: 'www.unitvwebs.com',
    });

    expect(
      classifyWebViewNavigationTarget('https://ad.tracker.example/pop?click=1')
    ).toEqual({
      allowInWebView: true,
      kind: 'EXTERNAL_HOST',
      sanitizedUrl: 'https://ad.tracker.example/pop',
      host: 'ad.tracker.example',
    });

    expect(
      classifyWebViewNavigationTarget('intent://app#Intent;package=com.foo;end')
    ).toEqual({
      allowInWebView: false,
      kind: 'BLOCKED_SCHEME',
      sanitizedUrl: 'intent://[redacted]',
      host: null,
    });
  });

  it('keeps native player pending and requires all manual checks plus adOrRedirectObserved === NONE before declaring proof', () => {
    const checks = createInitialDiagnosticChecks();
    expect(evaluateDiagnosticConclusion(checks).status).toBe('PENDING');

    const allRequiredTrue = {
      portalOpenedAndManualAuth: true,
      episodeSelectedConfirmed: true,
      videoAndAudioActive: true,
      continuous60sPlayback: true,
      pauseResumeAndSeekOk: true,
      stayedInsideApp: true,
    };

    // Unverified ad/redirect status must remain PENDING even when all 6 checks pass
    expect(
      evaluateDiagnosticConclusion({
        ...allRequiredTrue,
        adOrRedirectObserved: null,
      }).status
    ).toBe('PENDING');

    // Observed ad or redirect fails the diagnostic goal even when playback checks pass
    expect(
      evaluateDiagnosticConclusion({
        ...allRequiredTrue,
        adOrRedirectObserved: 'OBSERVED',
      }).status
    ).toBe('FAILED');

    // Observed ad or redirect fails even while other checks are still pending
    expect(
      evaluateDiagnosticConclusion({
        ...checks,
        adOrRedirectObserved: 'OBSERVED',
      }).status
    ).toBe('FAILED');

    // Any required check marked false fails even when no ads were observed
    expect(
      evaluateDiagnosticConclusion({
        ...allRequiredTrue,
        videoAndAudioActive: false,
        adOrRedirectObserved: 'NONE',
      }).status
    ).toBe('FAILED');

    const proven = evaluateDiagnosticConclusion({
      ...allRequiredTrue,
      adOrRedirectObserved: 'NONE',
    });
    expect(proven).toEqual({
      status: 'PROVEN',
      statement: 'reprodução em WebView Android comprovada',
      nativePlayerPending: 'A compatibilidade com o player nativo continua pendente.',
    });
  });

  it('isolates diagnostic APK package ID and hides dev entry in production builds', async () => {
    const configContext = {
      projectRoot: '.',
      staticConfigPath: null,
      packageJsonPath: null,
      config: {} as any,
    } as any;

    delete process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC;
    const prodConfig = appConfigFactory(configContext);
    expect(prodConfig.android?.package).toBe('com.personal.mediahub');
    expect(prodConfig.name).toBe('Personal Media Hub');

    process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC = '1';
    const diagConfig = appConfigFactory(configContext);
    expect(diagConfig.android?.package).toBe(UNITV_DIAGNOSTIC_PACKAGE_ID);
    expect(diagConfig.name).toBe('PMH Diag UniTV');
    expect(isStandaloneUniTvDiagnosticMode()).toBe(true);

    delete process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC;
    (globalThis as Record<string, unknown>).__DEV__ = false;
    expect(isUniTvDiagnosticAvailable()).toBe(false);

    const navigate = jest.fn();
    const { queryByTestId } = render(
      <SettingsScreen
        navigation={{ navigate }}
        services={{ libraryRepository: makeMockRepo() as LibraryRepository }}
      />
    );

    await waitFor(() => {
      expect(queryByTestId('settings-save-unitv-button')).toBeTruthy();
    });
    expect(queryByTestId('settings-unitv-diagnostic-card')).toBeNull();
  });

  it('opens diagnostic route from Settings only when dev diagnostic mode is enabled', async () => {
    (globalThis as Record<string, unknown>).__DEV__ = true;
    const navigate = jest.fn();

    const { getByTestId } = render(
      <SettingsScreen
        navigation={{ navigate }}
        services={{ libraryRepository: makeMockRepo() as LibraryRepository }}
      />
    );

    await waitFor(() => {
      expect(getByTestId('settings-open-unitv-diagnostic-button')).toBeTruthy();
    });

    fireEvent.press(getByTestId('settings-open-unitv-diagnostic-button'));
    expect(navigate).toHaveBeenCalledWith('UniTvDiagnostic');
  });

  it('keeps normal RootNavigator flow on MainTabs unless standalone diagnostic flag is set', () => {
    delete process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC;
    (globalThis as Record<string, unknown>).__DEV__ = false;
    const normalNav = render(<RootNavigator />);
    expect(normalNav.getAllByText('Início').length).toBeGreaterThan(0);

    process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC = '1';
    const diagNav = render(<RootNavigator />);
    expect(diagNav.getByTestId('unitv-diagnostic-webview')).toBeTruthy();
  });

  it('renders visible WebView on https://www.unitvwebs.com without generic injection scripts and sanitizes telemetry', () => {
    jest.useFakeTimers();

    const navigate = jest.fn();
    const { getByTestId, UNSAFE_getByType } = render(
      <UniTvDiagnosticScreen navigation={{ navigate }} />
    );

    const webView = UNSAFE_getByType(WebView);
    expect(webView.props.source).toEqual({ uri: UNITV_DIAGNOSTIC_PORTAL_URL });
    expect(webView.props.javaScriptEnabled).toBe(true);
    expect(webView.props.domStorageEnabled).toBe(true);
    expect(webView.props.allowsFullscreenVideo).toBe(true);
    expect(webView.props.mediaPlaybackRequiresUserAction).toBe(false);
    expect(webView.props.setSupportMultipleWindows).toBe(false);
    expect(webView.props.javaScriptCanOpenWindowsAutomatically).toBe(false);

    // Must NOT inject generic auth/capture scripts or install ReactNativeWebView bridge
    expect(webView.props.injectedJavaScript).toBeUndefined();
    expect(webView.props.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
    expect(webView.props.injectedJavaScriptObject).toBeUndefined();
    expect(webView.props.onMessage).toBeUndefined();

    // Allow portal HTTPS route, block external scheme without leaking query/tokens
    let allowedPortal = false;
    let blockedIntent = true;
    let allowedExternal = false;
    act(() => {
      allowedPortal = webView.props.onShouldStartLoadWithRequest({
        url: 'https://www.unitvwebs.com/vod/details/9876?auth=secret_token',
        isTopFrame: true,
      });
      blockedIntent = webView.props.onShouldStartLoadWithRequest({
        url: 'intent://launch?secret=abc#Intent',
        isTopFrame: true,
      });
      allowedExternal = webView.props.onShouldStartLoadWithRequest({
        url: 'https://ads.external.test/pop?click=secret',
        isTopFrame: true,
      });
    });
    expect(allowedPortal).toBe(true);
    expect(blockedIntent).toBe(false);
    expect(allowedExternal).toBe(true);

    act(() => {
      webView.props.onNavigationStateChange({
        url: 'https://www.unitvwebs.com/vod/details/9876?session=topsecret',
        loading: false,
        title: 'Naruto',
        canGoBack: true,
        canGoForward: false,
        lockIdentifier: 1,
        navigationType: 'other',
      });
      webView.props.onHttpError({
        nativeEvent: {
          url: 'https://www.unitvwebs.com/api/check?token=123',
          statusCode: 403,
          description: 'Forbidden',
          loading: false,
          title: '',
          canGoBack: true,
          canGoForward: false,
          lockIdentifier: 2,
        },
      });
      webView.props.onError({
        nativeEvent: {
          url: 'https://www.unitvwebs.com/player?key=hidden',
          code: -2,
          description: 'net::ERR_NAME_NOT_RESOLVED',
          loading: false,
          title: '',
          canGoBack: true,
          canGoForward: false,
          lockIdentifier: 3,
        },
      });
      webView.props.onRenderProcessGone({
        nativeEvent: {
          didCrash: true,
        },
      });
    });

    expect(getByTestId('diagnostic-sanitized-url').props.children).toBe(
      'https://www.unitvwebs.com/vod/details/9876'
    );

    // Open verification panel and check stopwatch does not auto-pass playback
    fireEvent.press(getByTestId('diagnostic-toggle-panel-button'));
    fireEvent.press(getByTestId('diagnostic-timer-toggle-button'));

    act(() => {
      jest.advanceTimersByTime(60_000);
    });

    expect(getByTestId('diagnostic-timer-value').props.children).toBe(
      '01:00 (60s / 60s)'
    );
    expect(getByTestId('diagnostic-conclusion-text').props.children).toContain(
      'Verificação manual em andamento'
    );

    const preview = getByTestId('diagnostic-report-preview').props.children as string;
    expect(preview).toContain('https://www.unitvwebs.com/vod/details/9876');
    expect(preview).toContain('https://ads.external.test/pop');
    expect(preview).toContain('HTTP 403');
    expect(preview).toContain('ERR_NAME_NOT_RESOLVED');
    expect(preview).toContain('RENDER_CRASH');
    expect(preview).toContain('intent://[redacted]');
    expect(preview).not.toContain('topsecret');
    expect(preview).not.toContain('secret_token');
    expect(preview).not.toContain('token=123');
    expect(preview).not.toContain('click=secret');
    expect(preview).not.toContain('key=hidden');

    // Manual confirmation of all 6 checks without ad check stays PENDING
    fireEvent.press(getByTestId('diagnostic-check-portalOpenedAndManualAuth-ok'));
    fireEvent.press(getByTestId('diagnostic-check-episodeSelectedConfirmed-ok'));
    fireEvent.press(getByTestId('diagnostic-check-videoAndAudioActive-ok'));
    fireEvent.press(getByTestId('diagnostic-check-continuous60sPlayback-ok'));
    fireEvent.press(getByTestId('diagnostic-check-pauseResumeAndSeekOk-ok'));
    fireEvent.press(getByTestId('diagnostic-check-stayedInsideApp-ok'));

    expect(getByTestId('diagnostic-conclusion-text').props.children).toContain(
      'Verificação manual em andamento'
    );
    expect(getByTestId('diagnostic-timer-label').props.children).toContain(
      'não comprova reprodução'
    );

    // Observing ads or redirects marks the run FAILED
    fireEvent.press(getByTestId('diagnostic-ad-observed'));
    expect(getByTestId('diagnostic-conclusion-text').props.children).toContain(
      'Falha registrada'
    );

    // Confirming no ads/redirects transitions to PROVEN
    fireEvent.press(getByTestId('diagnostic-ad-none'));
    expect(getByTestId('diagnostic-conclusion-text').props.children).toBe(
      'reprodução em WebView Android comprovada'
    );

    // Pressing Voltar navigates to MainTabs when standalone cannot goBack
    const canGoBackNav = jest.fn(() => false);
    const goBackNav = jest.fn();
    const standaloneNav = jest.fn();
    const standalone = render(
      <UniTvDiagnosticScreen
        navigation={{
          navigate: standaloneNav,
          goBack: goBackNav,
          canGoBack: canGoBackNav,
        }}
      />
    );
    fireEvent.press(standalone.getByTestId('diagnostic-back-button'));
    expect(goBackNav).not.toHaveBeenCalled();
    expect(standaloneNav).toHaveBeenCalledWith('MainTabs');
  });

  it('activates post-login bridge on demand, captures sanitized DOM/stream, tests ExoPlayer, and shares report', async () => {
    const shareSpy = jest.spyOn(Share, 'share');
    const { getByTestId, queryByTestId, UNSAFE_getByType } = render(
      <UniTvDiagnosticScreen navigation={{ navigate: jest.fn() }} />
    );

    const initialWebView = UNSAFE_getByType(WebView);
    expect(initialWebView.props.onMessage).toBeUndefined();
    expect(initialWebView.props.injectedJavaScript).toBeUndefined();
    expect(
      initialWebView.props.injectedJavaScriptBeforeContentLoaded
    ).toBeUndefined();

    fireEvent.press(getByTestId('diagnostic-toggle-panel-button'));

    // ExoPlayer test button disabled/hidden until an HTTP stream candidate exists
    expect(queryByTestId('diagnostic-exoplayer-video')).toBeNull();

    // First post-login DOM capture enables onMessage and queues capture after reload onLoadEnd
    fireEvent.press(getByTestId('diagnostic-capture-dom-button'));

    const boundWebView = UNSAFE_getByType(WebView);
    expect(typeof boundWebView.props.onMessage).toBe('function');

    act(() => {
      boundWebView.props.onLoadEnd?.();
      boundWebView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'DIAG_PHASE2_DOM',
            payload: {
              url: 'https://www.unitvwebs.com/search/vod?q=Naruto&sid=secret_sid',
              title: 'Busca VOD',
              inputs: [
                {
                  tag: 'INPUT',
                  type: 'search',
                  name: 'keyword',
                  id: 'search-input',
                  placeholder: 'Pesquisar',
                },
              ],
              actions: [
                {
                  tag: 'A',
                  id: 'vod-naruto',
                  className: 'vod-item',
                  href: '/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC?token=abc',
                  text: 'Naruto',
                },
              ],
              video: {
                found: true,
                id: 'v-player_html5_api',
                src: 'blob:https://www.unitvwebs.com/1111-2222',
                readyState: 4,
                videoWidth: 1920,
                videoHeight: 1080,
                duration: 1420,
                paused: false,
                textTrackCount: 1,
              },
            },
          }),
        },
      });
    });

    // Arm stream capture and receive candidate with auth token in query, followed by .ts segment
    fireEvent.press(getByTestId('diagnostic-arm-stream-button'));
    act(() => {
      boundWebView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'DIAG_PHASE2_STREAM',
            url: 'https://cdn.unitv.example/ep1/master.m3u8?token=secret999',
            referer: 'https://www.unitvwebs.com/vod/details/0/DD04?sid=topsecret',
            userAgent: 'AndroidWebViewTest',
            sourceTag: 'fetch',
            mimeHint: 'application/vnd.apple.mpegurl',
          }),
        },
      });
      boundWebView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'DIAG_PHASE2_STREAM',
            url: 'https://cdn.unitv.example/ep1/seg_0001.ts?token=seg_secret',
            referer: 'https://www.unitvwebs.com/vod/details/0/DD04',
            userAgent: 'AndroidWebViewTest',
            sourceTag: 'xhr',
            mimeHint: null,
          }),
        },
      });
    });

    const preview = getByTestId('diagnostic-report-preview').props.children as string;
    expect(preview).toContain('https://www.unitvwebs.com/search/vod');
    expect(preview).toContain('search-input');
    expect(preview).toContain('https://cdn.unitv.example/ep1/master.m3u8');
    expect(preview).toContain('STREAM_SEGMENT');
    expect(preview).not.toContain('secret999');
    expect(preview).not.toContain('seg_secret');
    expect(preview).not.toContain('secret_sid');
    expect(preview).not.toContain('topsecret');

    // Mount ExoPlayer test player with manifest candidate (not overwritten by .ts segment)
    fireEvent.press(getByTestId('diagnostic-test-exoplayer-button'));
    const exoVideo = UNSAFE_getByType(Video);
    expect(exoVideo.props.source).toEqual({
      uri: 'https://cdn.unitv.example/ep1/master.m3u8?token=secret999',
      headers: {
        Referer: 'https://www.unitvwebs.com/vod/details/0/DD04',
        'User-Agent': 'AndroidWebViewTest',
      },
    });

    // While ExoPlayer test is active, another manifest capture does not interrupt/replace active Video URI
    act(() => {
      boundWebView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'DIAG_PHASE2_STREAM',
            url: 'https://cdn.unitv.example/ep2/master.m3u8?token=other',
            referer: 'https://www.unitvwebs.com/vod/details/0/DD04',
            userAgent: 'AndroidWebViewTest',
            sourceTag: 'fetch',
            mimeHint: null,
          }),
        },
      });
    });
    expect(UNSAFE_getByType(Video).props.source.uri).toBe(
      'https://cdn.unitv.example/ep1/master.m3u8?token=secret999'
    );

    act(() => {
      exoVideo.props.onLoad({
        duration: 1420,
        currentTime: 0,
        naturalSize: { width: 1920, height: 1080, orientation: 'landscape' },
        videoTracks: [{ index: 0, width: 1920, height: 1080, bitrate: 5_000_000 }],
        audioTracks: [],
        textTracks: [],
      });
      exoVideo.props.onProgress({
        currentTime: 12,
        playableDuration: 60,
        seekableDuration: 1420,
      });
    });

    expect(getByTestId('diagnostic-exoplayer-status').props.children).toContain(
      'PLAYING'
    );
    expect(getByTestId('diagnostic-exoplayer-status').props.children).toContain(
      '1080p'
    );

    fireEvent.press(getByTestId('diagnostic-exoplayer-ok'));

    // Trigger Share and confirm no query secret leaks into shared payload
    fireEvent.press(getByTestId('diagnostic-share-report-button'));
    await waitFor(() => {
      expect(shareSpy).toHaveBeenCalledTimes(1);
    });
    const sharedMessage = shareSpy.mock.calls[0][0].message as string;
    expect(sharedMessage).toContain('ExoPlayer: PLAYING');
    expect(sharedMessage).not.toContain('secret999');

    // Simulate ExoPlayer error clears stale resolution/duration
    act(() => {
      exoVideo.props.onError({
        error: {
          errorString: 'HTTP 403 Forbidden',
          errorCode: '22004',
        },
      });
    });
    const errorStatus = getByTestId('diagnostic-exoplayer-status').props.children as string;
    expect(errorStatus).toContain('ERROR');
    expect(errorStatus).not.toContain('1080p');
    expect(errorStatus).not.toContain('1420s');

    // Closing ExoPlayer test resets telemetry cleanly
    fireEvent.press(getByTestId('diagnostic-exoplayer-close'));
    expect(queryByTestId('diagnostic-exoplayer-video')).toBeNull();
    const afterClosePreview = getByTestId('diagnostic-report-preview').props
      .children as string;
    expect(afterClosePreview).toContain('ExoPlayer: IDLE');
    expect(afterClosePreview).not.toContain('Erro ExoPlayer:');
    expect(afterClosePreview).not.toContain('1080p');
  });
});
