import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { THEME_TOKENS } from '../theme/tokens';
import { UniTvCredentials } from './credentials-store';
import { PlaybackErrorCode } from './types';
import {
  CLEAN_WEBVIEW_INJECT_SCRIPT,
  isDirectWebViewPortalUrl,
  parseCleanWebViewStreamMessage,
  UniTvSessionBridge,
} from './unitv-adapter';
import {
  buildPortalUrl,
  classifyProbeOutcome,
  UniTvProbeResult,
} from './unitv-probe';

export type VerifySessionResult =
  | { ok: true }
  | { errorCode: PlaybackErrorCode; message?: string };

export type BridgeSearchResult =
  | { vodId: string; title: string; watchPath: string }
  | { errorCode: PlaybackErrorCode }
  | null;

type BridgePendingTask =
  | {
      id: number;
      kind: 'AUTH';
      url: string;
      portalUrl: string;
      directPortal: boolean;
      credentials: UniTvCredentials;
      authSubmitted: boolean;
      modalVisible: boolean;
      canAutofill: boolean;
      bannerText: string | null;
      resolve: (value: { ok: boolean; errorCode?: PlaybackErrorCode }) => void;
      timerId: ReturnType<typeof setTimeout>;
    }
  | {
      id: number;
      kind: 'VERIFY';
      url: string;
      portalUrl: string;
      credentials: UniTvCredentials | null;
      modalVisible: boolean;
      canAutofill: boolean;
      bannerText: string | null;
      resolve: (value: VerifySessionResult) => void;
      timerId: ReturnType<typeof setTimeout>;
    }
  | {
      id: number;
      kind: 'SEARCH';
      url: string;
      portalUrl: string;
      directPortal: boolean;
      queryCandidates: string[];
      modalVisible: boolean;
      canAutofill: boolean;
      bannerText: string | null;
      resolve: (value: BridgeSearchResult) => void;
      timerId: ReturnType<typeof setTimeout>;
    }
  | {
      id: number;
      kind: 'EXTRACT';
      url: string;
      fallbackUrl: string;
      modalVisible: false;
      canAutofill: false;
      bannerText: null;
      resolve: (
        value:
          | { streamUrl: string; headers?: Record<string, string> }
          | { timedOut: true; webViewUrl: string }
          | { errorCode: PlaybackErrorCode }
      ) => void;
      timerId: ReturnType<typeof setTimeout>;
    };

export interface BridgeHostViewState {
  task: BridgePendingTask | null;
  modalVisible: boolean;
  modalTitle: string;
  bannerText: string | null;
  canAutofill: boolean;
}

interface HostListener {
  onStateChange: (state: BridgeHostViewState) => void;
}

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const INTERACTIVE_MODAL_TIMEOUT_MS = 5 * 60_000;

function extractPathname(rawUrl: string | undefined): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }
  try {
    return new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return rawUrl.split('?')[0].split('#')[0].toLowerCase();
  }
}

export function extractVodDetailsPath(rawUrl: string | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }
  try {
    const pathname = rawUrl.startsWith('/')
      ? rawUrl.split('?')[0].split('#')[0]
      : new URL(rawUrl).pathname;
    if (/^\/vod\/details\/[^\s?#]+/i.test(pathname)) {
      return pathname.replace(/\/+$/, '');
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizePortalTitle(
  rawTitle: string | undefined,
  fallbackTitle: string
): string {
  const cleaned = (rawTitle ?? '')
    .replace(/\s*[-|–]\s*UniTV.*$/i, '')
    .trim();
  if (!cleaned || /^unitv$/i.test(cleaned)) {
    return fallbackTitle;
  }
  return cleaned;
}

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
  var path = (window.location && window.location.pathname ? window.location.pathname : '').toLowerCase();
  var bodyText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
  if (/limite de telas|concurrent|muitas telas|outro dispositivo/.test(bodyText)) {
    post({ type: 'BRIDGE_AUTH_RESULT', ok: false, errorCode: 'CONCURRENT_SCREEN_LIMIT' });
    return true;
  }
  if (path.indexOf('/captcha') !== -1) {
    post({ type: 'BRIDGE_AUTH_STATE', state: 'CAPTCHA', url: path });
    return true;
  }
  var passInput = document.querySelector('input[type="password"]');
  var userInput = document.querySelector('input[type="email"], input[name*="user"], input[name*="email"], input[type="text"]');
  if (!passInput) {
    var hasLogoutOrVod = path.indexOf('/vod/') === 0 || path.indexOf('/search/vod') === 0 || /sair|logout|perfil|minha conta|epis[oó]dio|watch/.test(bodyText) || Boolean(document.querySelector('a[href*="vod"], a[href*="watch"]'));
    post({ type: 'BRIDGE_AUTH_RESULT', ok: hasLogoutOrVod, errorCode: hasLogoutOrVod ? undefined : 'AUTH_FAILED' });
    return true;
  }
  if (!${JSON.stringify(Boolean(credentials.username && credentials.password))}) {
    post({ type: 'BRIDGE_AUTH_STATE', state: 'LOGIN', hasPassword: true, url: path });
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
  if (window.__UNITV_AUTH_TIMER__) {
    clearTimeout(window.__UNITV_AUTH_TIMER__);
    window.__UNITV_AUTH_TIMER__ = null;
  }
  window.__UNITV_AUTH_TIMER__ = setTimeout(function () {
    var nextPath = (window.location && window.location.pathname ? window.location.pathname : '').toLowerCase();
    var nextText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
    if (nextPath.indexOf('/captcha') !== -1) {
      post({ type: 'BRIDGE_AUTH_STATE', state: 'CAPTCHA', url: nextPath });
      return;
    }
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

function buildAuthVerificationScript(allowInteractiveModal: boolean): string {
  return `
(function () {
  if (window.__UNITV_AUTH_TIMER__) {
    clearTimeout(window.__UNITV_AUTH_TIMER__);
    window.__UNITV_AUTH_TIMER__ = null;
  }
  var post = function (payload) {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };
  var path = (window.location && window.location.pathname ? window.location.pathname : '').toLowerCase();
  var bodyText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
  if (/limite de telas|concurrent|muitas telas|outro dispositivo/.test(bodyText)) {
    post({ type: 'BRIDGE_AUTH_RESULT', ok: false, errorCode: 'CONCURRENT_SCREEN_LIMIT' });
    return true;
  }
  if (path.indexOf('/captcha') !== -1) {
    post({ type: 'BRIDGE_AUTH_STATE', state: 'CAPTCHA', url: path });
    return true;
  }
  if (/senha incorreta|invalid|inv[aá]lid|erro ao entrar|unauthorized/.test(bodyText)) {
    post({ type: 'BRIDGE_AUTH_RESULT', ok: false, errorCode: 'AUTH_FAILED' });
    return true;
  }
  var stillHasPass = Boolean(document.querySelector('input[type="password"]'));
  if (stillHasPass && ${JSON.stringify(allowInteractiveModal)}) {
    post({ type: 'BRIDGE_AUTH_STATE', state: 'LOGIN', hasPassword: true, url: path });
    return true;
  }
  post({ type: 'BRIDGE_AUTH_RESULT', ok: !stillHasPass, errorCode: stillHasPass ? 'AUTH_FAILED' : undefined });
})();
true;
`.trim();
}

function buildAutofillScript(credentials: UniTvCredentials): string {
  const userJson = JSON.stringify(credentials.username);
  const passJson = JSON.stringify(credentials.password);
  return `
(function () {
  var setNativeValue = function (el, val) {
    if (!el) return;
    var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement && window.HTMLInputElement.prototype, 'value');
    if (desc && desc.set) {
      desc.set.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  var passInput = document.querySelector('input[type="password"]');
  var userInput = document.querySelector('input[type="email"], input[name*="user"], input[name*="email"], input[type="text"]');
  if (userInput) setNativeValue(userInput, ${userJson});
  if (passInput) setNativeValue(passInput, ${passJson});
})();
true;
`.trim();
}

function buildSearchInjectionScript(
  candidates: string[],
  directPortal: boolean
): string {
  const candidatesJson = JSON.stringify(candidates);
  return `
(function () {
  var post = function (payload) {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };
  var path = (window.location && window.location.pathname ? window.location.pathname : '').toLowerCase();
  var detailsMatch = path.match(/^(\\/vod\\/details\\/[^\\s?#]+)/i);
  if (detailsMatch) {
    post({
      type: 'BRIDGE_SEARCH_RESULT',
      match: {
        vodId: detailsMatch[1],
        title: (document.title || ${JSON.stringify(candidates[0] ?? 'Anime')}).trim(),
        watchPath: detailsMatch[1]
      }
    });
    return true;
  }
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
        var detailsHref = href.match(/(?:https?:\\/\\/[^/?#]+)?(\\/vod\\/details\\/[^\\s?#]+)/i);
        var vodId = detailsHref ? detailsHref[1].replace(/\\/+$/, '') : (idMatch ? idMatch[1] : href.replace(/[^a-zA-Z0-9_-]/g, ''));
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
  if (${JSON.stringify(directPortal)}) {
    var searchInput = document.querySelector('label.q-field.q-input input[type="text"], input[type="search"], input[type="text"]');
    var q = candidates[0] || '';
    if (searchInput && q && !searchInput.__pmhFilled) {
      searchInput.__pmhFilled = true;
      var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement && window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) {
        desc.set.call(searchInput, q);
      } else {
        searchInput.value = q;
      }
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    post({
      type: 'BRIDGE_SEARCH_NEEDS_SELECTION',
      hasCaptcha: path.indexOf('/captcha') !== -1,
      title: document.title || ''
    });
    return true;
  }
  post({ type: 'BRIDGE_SEARCH_RESULT', match: null });
})();
true;
`.trim();
}

/**
 * Coordinates UniTvSessionBridge calls through a persistent runtime WebView host
 * that stays hidden unless human interaction (/captcha, login, or Quasar search) is required.
 */
export class RuntimeWebViewBridgeController implements UniTvSessionBridge {
  private listener: HostListener | null = null;
  private activeTask: BridgePendingTask | null = null;
  private queue: Promise<void> = Promise.resolve();
  private nextTaskId = 1;

  private buildHostState(task: BridgePendingTask | null): BridgeHostViewState {
    if (!task) {
      return {
        task: null,
        modalVisible: false,
        modalTitle: 'Sessão UniTV',
        bannerText: null,
        canAutofill: false,
      };
    }

    const modalTitle =
      task.kind === 'SEARCH' ? 'Selecionar na UniTV' : 'Sessão UniTV';
    return {
      task,
      modalVisible: task.modalVisible,
      modalTitle,
      bannerText: task.bannerText,
      canAutofill: task.canAutofill,
    };
  }

  attachHost(listener: HostListener): () => void {
    this.listener = listener;
    listener.onStateChange(this.buildHostState(this.activeTask));
    return () => {
      if (this.listener === listener) {
        this.listener = null;
      }
      this.cancelActiveTask('UNMOUNT');
    };
  }

  private refreshTaskTimeout(
    task: BridgePendingTask,
    timeoutMs: number
  ): void {
    clearTimeout(task.timerId);
    const taskId = task.id;
    task.timerId = setTimeout(() => {
      if (this.activeTask?.id !== taskId) {
        return;
      }
      this.cancelActiveTask('TIMEOUT');
    }, timeoutMs);
  }

  private cancelActiveTask(
    reason: 'UNMOUNT' | 'USER_CANCEL' | 'TIMEOUT'
  ): void {
    const task = this.activeTask;
    if (!task) {
      return;
    }
    this.activeTask = null;
    clearTimeout(task.timerId);

    if (task.kind === 'AUTH') {
      task.resolve({
        ok: false,
        errorCode:
          reason === 'USER_CANCEL' || task.modalVisible
            ? 'USER_CANCELLED'
            : 'AUTH_FAILED',
      });
    } else if (task.kind === 'VERIFY') {
      task.resolve({
        errorCode:
          reason === 'TIMEOUT' ? 'CAPTCHA_REQUIRED' : 'USER_CANCELLED',
      });
    } else if (task.kind === 'SEARCH') {
      task.resolve(
        reason === 'USER_CANCEL' || task.modalVisible
          ? { errorCode: 'USER_CANCELLED' }
          : null
      );
    } else {
      task.resolve({ timedOut: true, webViewUrl: task.fallbackUrl });
    }

    this.listener?.onStateChange(this.buildHostState(null));
  }

  cancelInteractiveModal(): void {
    this.cancelActiveTask('USER_CANCEL');
  }

  triggerAutofill(inject: (script: string) => void): void {
    const task = this.activeTask;
    if (!task) {
      return;
    }
    const creds =
      task.kind === 'AUTH' || task.kind === 'VERIFY' ? task.credentials : null;
    if (!creds || (!creds.username && !creds.password)) {
      return;
    }
    inject(buildAutofillScript(creds));
  }

  confirmInteractiveSession(inject: (script: string) => void): void {
    const task = this.activeTask;
    if (!task) {
      return;
    }
    if (task.kind === 'AUTH' || task.kind === 'VERIFY') {
      inject(buildAuthVerificationScript(true));
    }
  }

  private promoteModal(bannerText: string | null): void {
    const task = this.activeTask;
    if (!task || task.kind === 'EXTRACT') {
      return;
    }
    const creds =
      task.kind === 'AUTH' || task.kind === 'VERIFY' ? task.credentials : null;
    const canAutofill = Boolean(
      creds && (creds.username.trim().length > 0 || creds.password.length > 0)
    );
    const changed =
      !task.modalVisible ||
      task.bannerText !== bannerText ||
      task.canAutofill !== canAutofill;
    task.modalVisible = true;
    task.bannerText = bannerText;
    task.canAutofill = canAutofill;
    this.refreshTaskTimeout(task, INTERACTIVE_MODAL_TIMEOUT_MS);
    if (changed) {
      this.listener?.onStateChange(this.buildHostState(task));
    }
  }

  private enqueueTask<T>(factory: (done: () => void) => Promise<T>): Promise<T> {
    const run = this.queue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          factory(() => undefined).then(resolve, reject);
        })
    );
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private setActiveTask(task: BridgePendingTask | null): void {
    this.activeTask = task;
    this.listener?.onStateChange(this.buildHostState(task));
  }

  handleNavigationStateChange(navUrl?: string, navTitle?: string): void {
    const task = this.activeTask;
    if (!task || !navUrl) {
      return;
    }
    const pathname = extractPathname(navUrl);

    if (task.kind === 'AUTH' || task.kind === 'VERIFY') {
      if (pathname.includes('/captcha')) {
        this.promoteModal(
          'Resolva a verificação de segurança e faça login para continuar.'
        );
        return;
      }

      if (
        pathname.startsWith('/vod/') ||
        pathname.startsWith('/search/vod')
      ) {
        clearTimeout(task.timerId);
        this.setActiveTask(null);
        task.resolve({ ok: true });
        return;
      }
    }

    if (task.kind === 'SEARCH') {
      const watchPath = extractVodDetailsPath(navUrl);
      if (watchPath) {
        clearTimeout(task.timerId);
        this.setActiveTask(null);
        const title = sanitizePortalTitle(
          navTitle,
          task.queryCandidates[0] ?? 'Anime'
        );
        task.resolve({
          vodId: watchPath,
          title,
          watchPath,
        });
        return;
      }

      if (pathname.includes('/captcha')) {
        this.promoteModal(
          'Conclua a verificação de segurança e toque no anime desejado.'
        );
      }
    }
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

    if (
      (task.kind === 'AUTH' || task.kind === 'VERIFY') &&
      payload.type === 'BRIDGE_AUTH_STATE'
    ) {
      const state = typeof payload.state === 'string' ? payload.state : '';
      const pathUrl = typeof payload.url === 'string' ? payload.url : '';
      if (state === 'CAPTCHA' || extractPathname(pathUrl).includes('/captcha')) {
        this.promoteModal(
          'Resolva o /captcha na UniTV e conclua o acesso para validar a sessão.'
        );
        return;
      }
      if (state === 'LOGIN') {
        this.promoteModal(
          'Entre com sua conta UniTV abaixo e toque em Confirmar Sessão após entrar.'
        );
        return;
      }
      if (state === 'AUTHENTICATED') {
        clearTimeout(task.timerId);
        this.setActiveTask(null);
        task.resolve({ ok: true });
        return;
      }
    }

    if (
      (task.kind === 'AUTH' || task.kind === 'VERIFY') &&
      payload.type === 'BRIDGE_AUTH_RESULT'
    ) {
      clearTimeout(task.timerId);
      const isConcurrent =
        payload.errorCode === 'CONCURRENT_SCREEN_LIMIT';
      const isOk = Boolean(payload.ok);
      if (isOk) {
        this.setActiveTask(null);
        task.resolve({ ok: true });
        return;
      }

      if (
        task.kind === 'VERIFY' &&
        !isConcurrent &&
        payload.errorCode !== 'AUTH_FAILED'
      ) {
        this.promoteModal(
          'Confirme o acesso ao portal UniTV na janela abaixo.'
        );
        return;
      }

      this.setActiveTask(null);
      if (task.kind === 'AUTH') {
        task.resolve({
          ok: false,
          errorCode: isConcurrent ? 'CONCURRENT_SCREEN_LIMIT' : 'AUTH_FAILED',
        });
      } else {
        task.resolve({
          errorCode: isConcurrent ? 'CONCURRENT_SCREEN_LIMIT' : 'AUTH_FAILED',
        });
      }
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
      task.kind === 'SEARCH' &&
      payload.type === 'BRIDGE_SEARCH_NEEDS_SELECTION'
    ) {
      const hasCaptcha = Boolean(payload.hasCaptcha);
      this.promoteModal(
        hasCaptcha
          ? 'Resolva a verificação de segurança e toque no anime desejado.'
          : 'Toque no anime desejado para vincular automaticamente.'
      );
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
      return task.authSubmitted
        ? buildAuthVerificationScript(task.directPortal)
        : buildAuthInjectionScript(task.credentials);
    }
    if (task.kind === 'VERIFY') {
      return buildAuthVerificationScript(true);
    }
    if (task.kind === 'SEARCH') {
      return buildSearchInjectionScript(task.queryCandidates, task.directPortal);
    }
    return CLEAN_WEBVIEW_INJECT_SCRIPT;
  }

  handleLoadEnd(
    taskId: number,
    inject: (script: string) => void,
    loadedUrl?: string,
    loadedTitle?: string
  ): void {
    const task = this.activeTask;
    if (!task || task.id !== taskId) {
      return;
    }
    if (loadedUrl) {
      this.handleNavigationStateChange(loadedUrl, loadedTitle);
      if (this.activeTask?.id !== taskId) {
        return;
      }
    }
    const script = this.getInjectionScriptForTask(task);
    if (task.kind === 'AUTH' && !task.authSubmitted) {
      task.authSubmitted = true;
    }
    inject(script);
  }

  authenticate(
    portalUrl: string,
    credentials: UniTvCredentials
  ): Promise<{ ok: boolean; errorCode?: PlaybackErrorCode }> {
    if (!this.listener) {
      return Promise.resolve({ ok: false, errorCode: 'AUTH_FAILED' });
    }
    const directPortal = isDirectWebViewPortalUrl(portalUrl);
    const startUrl = directPortal
      ? buildPortalUrl(portalUrl, '')
      : buildPortalUrl(portalUrl, 'login');

    return this.enqueueTask(
      () =>
        new Promise((resolve) => {
          if (!this.listener) {
            resolve({ ok: false, errorCode: 'AUTH_FAILED' });
            return;
          }
          const taskId = this.nextTaskId++;
          const timerId = setTimeout(() => {
            if (this.activeTask?.id === taskId) {
              this.cancelActiveTask('TIMEOUT');
            }
          }, DEFAULT_STEP_TIMEOUT_MS);

          this.setActiveTask({
            id: taskId,
            kind: 'AUTH',
            url: startUrl,
            portalUrl,
            directPortal,
            credentials,
            authSubmitted: false,
            modalVisible: false,
            canAutofill: Boolean(
              credentials.username.trim() || credentials.password
            ),
            bannerText: null,
            resolve,
            timerId,
          });
        })
    );
  }

  verifySession(
    portalUrl: string,
    credentials: UniTvCredentials | null
  ): Promise<VerifySessionResult> {
    if (!this.listener) {
      return Promise.resolve({ errorCode: 'AUTH_FAILED' });
    }
    const basePortalUrl = buildPortalUrl(portalUrl, '');
    if (!basePortalUrl) {
      return Promise.resolve({ errorCode: 'AUTH_FAILED' });
    }

    return this.enqueueTask(
      () =>
        new Promise((resolve) => {
          if (!this.listener) {
            resolve({ errorCode: 'USER_CANCELLED' });
            return;
          }
          const taskId = this.nextTaskId++;
          const timerId = setTimeout(() => {
            if (this.activeTask?.id === taskId) {
              this.promoteModal(
                'Conclua a verificação ou login na janela abaixo e toque em Confirmar Sessão.'
              );
            }
          }, DEFAULT_STEP_TIMEOUT_MS);

          this.setActiveTask({
            id: taskId,
            kind: 'VERIFY',
            url: basePortalUrl,
            portalUrl: basePortalUrl,
            credentials,
            modalVisible: false,
            canAutofill: Boolean(
              credentials &&
                (credentials.username.trim() || credentials.password)
            ),
            bannerText: null,
            resolve,
            timerId,
          });
        })
    );
  }

  searchVod(
    portalUrl: string,
    queryCandidates: string[]
  ): Promise<BridgeSearchResult> {
    if (!this.listener || queryCandidates.length === 0) {
      return Promise.resolve(null);
    }
    const directPortal = isDirectWebViewPortalUrl(portalUrl);
    const primaryQuery = encodeURIComponent(queryCandidates[0]);
    const searchUrl = directPortal
      ? buildPortalUrl(portalUrl, 'search/vod')
      : buildPortalUrl(portalUrl, `search?q=${primaryQuery}`);

    return this.enqueueTask(
      () =>
        new Promise((resolve) => {
          if (!this.listener) {
            resolve(null);
            return;
          }
          const taskId = this.nextTaskId++;
          const timerId = setTimeout(() => {
            if (this.activeTask?.id === taskId) {
              this.cancelActiveTask('TIMEOUT');
            }
          }, DEFAULT_STEP_TIMEOUT_MS);

          this.setActiveTask({
            id: taskId,
            kind: 'SEARCH',
            url: searchUrl,
            portalUrl,
            directPortal,
            queryCandidates,
            modalVisible: false,
            canAutofill: false,
            bannerText: null,
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
          if (!this.listener) {
            resolve({ timedOut: true, webViewUrl: fallbackUrl });
            return;
          }
          const taskId = this.nextTaskId++;
          const timerId = setTimeout(() => {
            if (this.activeTask?.id === taskId) {
              this.setActiveTask(null);
              resolve({ timedOut: true, webViewUrl: fallbackUrl });
            }
          }, params.timeoutMs);

          this.setActiveTask({
            id: taskId,
            kind: 'EXTRACT',
            url: fallbackUrl,
            fallbackUrl,
            modalVisible: false,
            canAutofill: false,
            bannerText: null,
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
    if (!basePortalUrl) {
      return classifyProbeOutcome({
        extractedUrl: null,
        authSucceeded: false,
        pageBlockedByBot: false,
      });
    }

    const credentials: UniTvCredentials | null =
      params.username.trim() || params.password
        ? { username: params.username.trim(), password: params.password }
        : null;

    if (isDirectWebViewPortalUrl(basePortalUrl) || !credentials) {
      const verified = await this.verifySession(basePortalUrl, credentials);
      if ('ok' in verified && verified.ok) {
        return {
          status: 'WEBVIEW_ONLY',
          reason: 'Conexão OK · Sessão UniTV verificada na WebView.',
        };
      }
      return {
        status: 'BLOCKED',
        reason:
          'errorCode' in verified && verified.errorCode === 'USER_CANCELLED'
            ? 'Verificação cancelada antes de confirmar sessão na WebView.'
            : 'Sessão não confirmada ou /captcha pendente na WebView.',
      };
    }

    const authRes = await this.authenticate(basePortalUrl, credentials);
    return classifyProbeOutcome({
      extractedUrl: null,
      authSucceeded: authRes.ok,
      pageBlockedByBot:
        authRes.errorCode === 'CONCURRENT_SCREEN_LIMIT' ||
        authRes.errorCode === 'CAPTCHA_REQUIRED',
    });
  }
}

export function RuntimeWebViewBridgeHost({
  controller,
}: {
  controller: RuntimeWebViewBridgeController;
}): React.JSX.Element | null {
  const webViewRef = React.useRef<WebView>(null);
  const [viewState, setViewState] = React.useState<BridgeHostViewState>({
    task: null,
    modalVisible: false,
    modalTitle: 'Sessão UniTV',
    bannerText: null,
    canAutofill: false,
  });

  React.useEffect(() => {
    return controller.attachHost({
      onStateChange: (nextState) => setViewState(nextState),
    });
  }, [controller]);

  if (!viewState.task) {
    return null;
  }

  const activeTask = viewState.task;
  const isModal = viewState.modalVisible;

  return (
    <View
      testID={isModal ? 'runtime-bridge-modal' : 'runtime-bridge-hidden'}
      pointerEvents={isModal ? 'auto' : 'none'}
      style={isModal ? styles.modalOverlay : styles.hiddenContainer}
    >
      {isModal ? (
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle} numberOfLines={1}>
            {viewState.modalTitle}
          </Text>
          <View style={styles.headerActions}>
            {viewState.canAutofill ? (
              <Pressable
                onPress={() =>
                  controller.triggerAutofill((script) => {
                    webViewRef.current?.injectJavaScript(script);
                  })
                }
                accessibilityRole="button"
                testID="runtime-bridge-autofill"
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Preencher login</Text>
              </Pressable>
            ) : null}
            {activeTask.kind !== 'SEARCH' ? (
              <Pressable
                onPress={() =>
                  controller.confirmInteractiveSession((script) => {
                    webViewRef.current?.injectJavaScript(script);
                  })
                }
                accessibilityRole="button"
                testID="runtime-bridge-confirm"
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Confirmar Sessão</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => controller.cancelInteractiveModal()}
              accessibilityRole="button"
              testID="runtime-bridge-cancel"
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {isModal && viewState.bannerText ? (
        <View style={styles.bannerBar}>
          <Text style={styles.bannerText}>{viewState.bannerText}</Text>
        </View>
      ) : null}

      <View style={isModal ? styles.webViewModalBody : styles.hiddenWebViewBox}>
        <WebView
          key="runtime-bridge-webview"
          ref={webViewRef}
          source={{ uri: activeTask.url }}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          thirdPartyCookiesEnabled={true}
          mixedContentMode="compatibility"
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) =>
            /^https?:\/\//i.test(request.url)
          }
          injectedJavaScriptBeforeContentLoaded={
            activeTask.kind === 'EXTRACT' ? CLEAN_WEBVIEW_INJECT_SCRIPT : undefined
          }
          onNavigationStateChange={(navState) => {
            controller.handleNavigationStateChange(navState?.url, navState?.title);
          }}
          onLoadEnd={(event) => {
            const loadedUrl =
              (
                event as
                  | { nativeEvent?: { url?: string; title?: string } }
                  | undefined
              )?.nativeEvent?.url;
            const loadedTitle =
              (
                event as
                  | { nativeEvent?: { url?: string; title?: string } }
                  | undefined
              )?.nativeEvent?.title;
            controller.handleLoadEnd(
              activeTask.id,
              (script) => {
                webViewRef.current?.injectJavaScript(script);
              },
              loadedUrl,
              loadedTitle
            );
          }}
          onMessage={(event: WebViewMessageEvent) => {
            controller.handleWebViewMessage(event.nativeEvent.data);
          }}
        />
      </View>
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
  hiddenWebViewBox: {
    width: 1,
    height: 1,
  },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 24,
    backgroundColor: THEME_TOKENS.bg.canvas,
  },
  modalHeader: {
    paddingTop: THEME_TOKENS.spacing.lg,
    paddingBottom: THEME_TOKENS.spacing.sm,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    backgroundColor: THEME_TOKENS.bg.surface,
    borderBottomWidth: 1,
    borderBottomColor: THEME_TOKENS.border.subtle,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: THEME_TOKENS.spacing.sm,
  },
  modalTitle: {
    ...THEME_TOKENS.typography.sectionTitle,
    color: THEME_TOKENS.text.primary,
  },
  headerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: THEME_TOKENS.spacing.xs,
  },
  primaryButton: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: THEME_TOKENS.accent.primary,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
  },
  primaryButtonText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.bg.canvas,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: THEME_TOKENS.bg.card,
    borderColor: THEME_TOKENS.border.subtle,
    borderWidth: 1,
    borderRadius: THEME_TOKENS.radius.md,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.xs,
  },
  secondaryButtonText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.text.primary,
  },
  bannerBar: {
    backgroundColor: THEME_TOKENS.bg.card,
    borderBottomWidth: 1,
    borderBottomColor: THEME_TOKENS.accent.primary,
    paddingHorizontal: THEME_TOKENS.spacing.md,
    paddingVertical: THEME_TOKENS.spacing.sm,
  },
  bannerText: {
    ...THEME_TOKENS.typography.caption,
    color: THEME_TOKENS.accent.primary,
  },
  webViewModalBody: {
    flex: 1,
  },
});
