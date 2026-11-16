import React from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { UniTvCredentials } from './credentials-store';
import { PlaybackErrorCode } from './types';
import {
  CLEAN_WEBVIEW_INJECT_SCRIPT,
  parseCleanWebViewStreamMessage,
  UniTvSessionBridge,
} from './unitv-adapter';
import {
  buildPortalUrl,
  classifyProbeOutcome,
  UniTvProbeResult,
} from './unitv-probe';

type BridgePendingTask =
  | {
      kind: 'AUTH';
      url: string;
      credentials: UniTvCredentials;
      resolve: (value: {
        ok: boolean;
        errorCode?: 'CONCURRENT_SCREEN_LIMIT' | 'AUTH_FAILED';
      }) => void;
      timerId: ReturnType<typeof setTimeout>;
    }
  | {
      kind: 'SEARCH';
      url: string;
      queryCandidates: string[];
      resolve: (
        value: { vodId: string; title: string; watchPath: string } | null
      ) => void;
      timerId: ReturnType<typeof setTimeout>;
    }
  | {
      kind: 'EXTRACT';
      url: string;
      fallbackUrl: string;
      resolve: (
        value:
          | { streamUrl: string; headers?: Record<string, string> }
          | { timedOut: true; webViewUrl: string }
          | { errorCode: PlaybackErrorCode }
      ) => void;
      timerId: ReturnType<typeof setTimeout>;
    };

interface HostListener {
  onTaskChange: (task: BridgePendingTask | null) => void;
}

const DEFAULT_STEP_TIMEOUT_MS = 10_000;

function buildAuthInjectionScript(credentials: UniTvCredentials): string {
  const userJson = JSON.stringify(credentials.username);
  const passJson = JSON.stringify(credentials.password);
  return `
(function () {
  var post = function (payload) {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };
  var bodyText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
  if (/limite de telas|concurrent|muitas telas|outro dispositivo/.test(bodyText)) {
    post({ type: 'BRIDGE_AUTH_RESULT', ok: false, errorCode: 'CONCURRENT_SCREEN_LIMIT' });
    return true;
  }
  var passInput = document.querySelector('input[type="password"]');
  var userInput = document.querySelector('input[type="email"], input[name*="user"], input[name*="email"], input[type="text"]');
  if (!passInput) {
    var hasLogoutOrVod = /sair|logout|perfil|minha conta|epis[oó]dio|watch/.test(bodyText) || Boolean(document.querySelector('a[href*="vod"], a[href*="watch"]'));
    post({ type: 'BRIDGE_AUTH_RESULT', ok: hasLogoutOrVod, errorCode: hasLogoutOrVod ? undefined : 'AUTH_FAILED' });
    return true;
  }
  if (userInput) {
    userInput.value = ${userJson};
    userInput.dispatchEvent(new Event('input', { bubbles: true }));
    userInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  passInput.value = ${passJson};
  passInput.dispatchEvent(new Event('input', { bubbles: true }));
  passInput.dispatchEvent(new Event('change', { bubbles: true }));
  var submitBtn = document.querySelector('button[type="submit"], input[type="submit"], form button');
  if (submitBtn) {
    submitBtn.click();
  } else if (passInput.form) {
    passInput.form.submit();
  }
  setTimeout(function () {
    var nextText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
    if (/limite de telas|concurrent|muitas telas|outro dispositivo/.test(nextText)) {
      post({ type: 'BRIDGE_AUTH_RESULT', ok: false, errorCode: 'CONCURRENT_SCREEN_LIMIT' });
      return;
    }
    if (/senha incorreta|invalid|inv[aá]lid|erro ao entrar|unauthorized/.test(nextText)) {
      post({ type: 'BRIDGE_AUTH_RESULT', ok: false, errorCode: 'AUTH_FAILED' });
      return;
    }
    var stillHasPass = Boolean(document.querySelector('input[type="password"]'));
    post({ type: 'BRIDGE_AUTH_RESULT', ok: !stillHasPass, errorCode: stillHasPass ? 'AUTH_FAILED' : undefined });
  }, 1500);
})();
true;
`.trim();
}

function buildSearchInjectionScript(candidates: string[]): string {
  const candidatesJson = JSON.stringify(candidates);
  return `
(function () {
  var post = function (payload) {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };
  var candidates = ${candidatesJson};
  var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
  var normalize = function (value) {
    return String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
  };
  for (var i = 0; i < candidates.length; i++) {
    var target = normalize(candidates[i]);
    if (!target) continue;
    for (var j = 0; j < anchors.length; j++) {
      var a = anchors[j];
      var href = a.getAttribute('href') || '';
      var label = normalize(a.textContent || a.getAttribute('title') || '');
      if (!href || !label) continue;
      if (label.indexOf(target) !== -1 || target.indexOf(label) !== -1) {
        var idMatch = href.match(/\\/(?:vod|watch|anime)\\/([^/?#]+)/i);
        var vodId = idMatch ? idMatch[1] : href.replace(/[^a-zA-Z0-9_-]/g, '');
        post({
          type: 'BRIDGE_SEARCH_RESULT',
          match: {
            vodId: vodId || 'vod-match',
            title: (a.textContent || candidates[i]).trim(),
            watchPath: href
          }
        });
        return true;
      }
    }
  }
  post({ type: 'BRIDGE_SEARCH_RESULT', match: null });
})();
true;
`.trim();
}

/**
 * Coordinates UniTvSessionBridge calls through a hidden runtime WebView host.
 */
export class RuntimeWebViewBridgeController implements UniTvSessionBridge {
  private listener: HostListener | null = null;
  private activeTask: BridgePendingTask | null = null;
  private queue: Promise<void> = Promise.resolve();

  attachHost(listener: HostListener): () => void {
    this.listener = listener;
    if (this.activeTask) {
      listener.onTaskChange(this.activeTask);
    }
    return () => {
      if (this.listener === listener) {
        this.listener = null;
      }
      this.cancelActiveTask();
    };
  }

  private cancelActiveTask(): void {
    const task = this.activeTask;
    if (!task) {
      return;
    }
    this.activeTask = null;
    clearTimeout(task.timerId);
    if (task.kind === 'AUTH') {
      task.resolve({ ok: false, errorCode: 'AUTH_FAILED' });
    } else if (task.kind === 'SEARCH') {
      task.resolve(null);
    } else {
      task.resolve({ timedOut: true, webViewUrl: task.fallbackUrl });
    }
    this.listener?.onTaskChange(null);
  }

  private enqueueTask<T>(factory: (done: () => void) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => new Promise<T>((resolve, reject) => {
      factory(() => undefined).then(resolve, reject);
    }));
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private setActiveTask(task: BridgePendingTask | null): void {
    this.activeTask = task;
    this.listener?.onTaskChange(task);
  }

  handleWebViewMessage(rawData: string): void {
    const task = this.activeTask;
    if (!task) {
      return;
    }

    if (task.kind === 'EXTRACT') {
      const captured = parseCleanWebViewStreamMessage(rawData);
      if (captured) {
        clearTimeout(task.timerId);
        this.setActiveTask(null);
        task.resolve({
          streamUrl: captured.streamUrl,
          headers: captured.headers,
        });
        return;
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    const payload = parsed as Record<string, unknown>;

    if (task.kind === 'AUTH' && payload.type === 'BRIDGE_AUTH_RESULT') {
      clearTimeout(task.timerId);
      this.setActiveTask(null);
      task.resolve({
        ok: Boolean(payload.ok),
        ...(payload.errorCode === 'CONCURRENT_SCREEN_LIMIT' ||
        payload.errorCode === 'AUTH_FAILED'
          ? { errorCode: payload.errorCode }
          : {}),
      });
      return;
    }

    if (task.kind === 'SEARCH' && payload.type === 'BRIDGE_SEARCH_RESULT') {
      clearTimeout(task.timerId);
      this.setActiveTask(null);
      const rawMatch = payload.match as Record<string, unknown> | null | undefined;
      if (
        rawMatch &&
        typeof rawMatch.vodId === 'string' &&
        typeof rawMatch.title === 'string' &&
        typeof rawMatch.watchPath === 'string'
      ) {
        task.resolve({
          vodId: rawMatch.vodId,
          title: rawMatch.title,
          watchPath: rawMatch.watchPath,
        });
      } else {
        task.resolve(null);
      }
      return;
    }

    if (
      task.kind === 'EXTRACT' &&
      payload.type === 'BRIDGE_ERROR' &&
      payload.errorCode === 'CONCURRENT_SCREEN_LIMIT'
    ) {
      clearTimeout(task.timerId);
      this.setActiveTask(null);
      task.resolve({ errorCode: 'CONCURRENT_SCREEN_LIMIT' });
    }
  }

  getInjectionScriptForTask(task: BridgePendingTask): string {
    if (task.kind === 'AUTH') {
      return buildAuthInjectionScript(task.credentials);
    }
    if (task.kind === 'SEARCH') {
      return buildSearchInjectionScript(task.queryCandidates);
    }
    return CLEAN_WEBVIEW_INJECT_SCRIPT;
  }

  authenticate(
    portalUrl: string,
    credentials: UniTvCredentials
  ): Promise<{
    ok: boolean;
    errorCode?: 'CONCURRENT_SCREEN_LIMIT' | 'AUTH_FAILED';
  }> {
    if (!this.listener) {
      return Promise.resolve({ ok: false, errorCode: 'AUTH_FAILED' });
    }
    return this.enqueueTask(
      () =>
        new Promise((resolve) => {
          const timerId = setTimeout(() => {
            if (this.activeTask?.kind === 'AUTH') {
              this.setActiveTask(null);
              resolve({ ok: false, errorCode: 'AUTH_FAILED' });
            }
          }, DEFAULT_STEP_TIMEOUT_MS);

          this.setActiveTask({
            kind: 'AUTH',
            url: buildPortalUrl(portalUrl, 'login'),
            credentials,
            resolve,
            timerId,
          });
        })
    );
  }

  searchVod(
    portalUrl: string,
    queryCandidates: string[]
  ): Promise<{ vodId: string; title: string; watchPath: string } | null> {
    if (!this.listener || queryCandidates.length === 0) {
      return Promise.resolve(null);
    }
    return this.enqueueTask(
      () =>
        new Promise((resolve) => {
          const timerId = setTimeout(() => {
            if (this.activeTask?.kind === 'SEARCH') {
              this.setActiveTask(null);
              resolve(null);
            }
          }, DEFAULT_STEP_TIMEOUT_MS);

          const primaryQuery = encodeURIComponent(queryCandidates[0]);
          this.setActiveTask({
            kind: 'SEARCH',
            url: buildPortalUrl(portalUrl, `search?q=${primaryQuery}`),
            queryCandidates,
            resolve,
            timerId,
          });
        })
    );
  }

  extractEpisodeStream(params: {
    portalUrl: string;
    vodId: string;
    watchPath?: string;
    episodeNumber: number;
    timeoutMs: number;
  }): Promise<
    | { streamUrl: string; headers?: Record<string, string> }
    | { timedOut: true; webViewUrl: string }
    | { errorCode: PlaybackErrorCode }
  > {
    const fallbackUrl = buildPortalUrl(
      params.portalUrl,
      params.watchPath ||
        `vod/${encodeURIComponent(params.vodId)}?ep=${params.episodeNumber}`
    );

    if (!this.listener) {
      return Promise.resolve({
        timedOut: true,
        webViewUrl: fallbackUrl,
      });
    }

    return this.enqueueTask(
      () =>
        new Promise((resolve) => {
          const timerId = setTimeout(() => {
            if (this.activeTask?.kind === 'EXTRACT') {
              this.setActiveTask(null);
              resolve({ timedOut: true, webViewUrl: fallbackUrl });
            }
          }, params.timeoutMs);

          this.setActiveTask({
            kind: 'EXTRACT',
            url: fallbackUrl,
            fallbackUrl,
            resolve,
            timerId,
          });
        })
    );
  }

  async testConnection(params: {
    portalUrl: string;
    username: string;
    password: string;
  }): Promise<UniTvProbeResult> {
    const basePortalUrl = buildPortalUrl(params.portalUrl, '');
    if (!basePortalUrl || !params.username.trim() || !params.password.trim()) {
      return classifyProbeOutcome({
        extractedUrl: null,
        authSucceeded: false,
        pageBlockedByBot: false,
      });
    }

    const authRes = await this.authenticate(basePortalUrl, {
      username: params.username.trim(),
      password: params.password,
    });
    return classifyProbeOutcome({
      extractedUrl: null,
      authSucceeded: authRes.ok,
      pageBlockedByBot: authRes.errorCode === 'CONCURRENT_SCREEN_LIMIT',
    });
  }
}

export function RuntimeWebViewBridgeHost({
  controller,
}: {
  controller: RuntimeWebViewBridgeController;
}): React.JSX.Element | null {
  const webViewRef = React.useRef<WebView>(null);
  const [task, setTask] = React.useState<BridgePendingTask | null>(null);

  React.useEffect(() => {
    return controller.attachHost({
      onTaskChange: (nextTask) => setTask(nextTask),
    });
  }, [controller]);

  if (!task) {
    return null;
  }

  return (
    <View style={styles.hiddenContainer} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ uri: task.url }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        injectedJavaScriptBeforeContentLoaded={
          task.kind === 'EXTRACT' ? CLEAN_WEBVIEW_INJECT_SCRIPT : undefined
        }
        onLoadEnd={() => {
          webViewRef.current?.injectJavaScript(
            controller.getInjectionScriptForTask(task)
          );
        }}
        onMessage={(event: WebViewMessageEvent) => {
          controller.handleWebViewMessage(event.nativeEvent.data);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hiddenContainer: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    left: -100,
    top: -100,
    overflow: 'hidden',
  },
});
