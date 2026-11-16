# UniTV Phase 2 Diagnostic (Search, Episodes & Native ExoPlayer Probe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `UniTvDiagnosticScreen` on branch `diagnostico/unitvwebs` so the user can capture sanitized DOM metadata on `/search/vod` and `/vod/details/...`, capture sanitized media stream requests after `/captcha` + login, and test native `ExoPlayer` (`react-native-video`) playback inside the isolated diagnostic APK.

**Architecture:** Keep the initial WebView completely free of injected scripts and `window.ReactNativeWebView` (`onMessage={undefined}`) during `/captcha` and manual login. Only when the user triggers a post-login probe action (`Capturar DOM Atual` or `Armar Captura de Stream`), bind `onMessage` (performing a single reload if needed so Android `addJavascriptInterface` attaches to the page), parse sanitized DOM/stream payloads in a dedicated pure module (`src/diagnostics/unitv-phase2-probe.ts`), and feed any captured `http(s)` candidate in-memory into an embedded `<Video>` (`ExoPlayer`) test panel while never logging credentials, input values, cookies, or URL query tokens.

**Tech Stack:** TypeScript (`~5.8.3`), React Native (`0.76.9`), Expo (`~52.0.49`), `react-native-webview` (`13.12.5`), `react-native-video` (`^6.19.3`), Jest + `@testing-library/react-native`.

**Spec:** `docs/superpowers/specs/2026-11-16-unitv-phase2-diagnostic-design.md`

## Global Constraints

- Work strictly on branch `diagnostico/unitvwebs`; never push, merge, tag, or modify `main`, `version.json`, or release `v1.1.0`.
- Preserve package isolation (`com.personal.mediahub.diag`, `PMH Diag UniTV`, `EXPO_PUBLIC_UNITV_DIAGNOSTIC=1`) and build workflow without release publishing.
- Do not create a second diagnostic screen; extend `src/screens/UniTvDiagnosticScreen.tsx` and keep touch targets ≥ 44 px with `THEME_TOKENS`.
- Keep WebView completely uninjected (`injectedJavaScript={undefined}`, `injectedJavaScriptBeforeContentLoaded={undefined}`, `onMessage={undefined}`) before the user explicitly triggers post-login inspection.
- Never include passwords, input `.value`, `document.cookie`, `localStorage`, `Cookie`/`Authorization` headers, or query tokens in displayed, logged, or shared diagnostic output.
- Never treat HTTP 200 or simulated/stopwatch ticks as `ExoPlayer` playback proof; require real `onLoad`, `onProgress`, and manual confirmation.

## Review Focus

- Toggling `onMessage` from `undefined` to a callback on an already-loaded Android `WebView` calls `addJavascriptInterface`, which does not populate `window.ReactNativeWebView` until the current page finishes a reload — pending DOM/stream actions triggered from cold state must wait for that single reload's `onLoadEnd` before calling `injectJavaScript`.
- DOM snapshot scripts encountering `<input type="password">` or pre-filled search inputs must omit `.value` completely so passwords or search tokens never cross the bridge.
- Media capture hooks encountering `blob:https://...` (MSE) or non-`http(s)` URLs must record a sanitized `[STREAM_BLOB]` diagnostic event without attempting to mount `<Video>` on an unplayable `blob:` URI.
- Stream URLs carrying auth query params (`?token=...`) must be preserved strictly in React state memory for `<Video source={{ uri }}>` while every log/share string strips query strings and fragments via `sanitizeDiagnosticUrl`.
- Mounting `<Video>` (`ExoPlayer`) and later closing or changing candidate URLs must reset `durationSeconds`, `currentSeconds`, `resolutionLabel`, and `errorDetail` cleanly and fall back gracefully on `onError` without crashing the diagnostic screen.

---

### Task 1: Pure Phase 2 DOM & Stream Sanitization + Probe Parsing Module

**Files:**
- Create: `src/diagnostics/unitv-phase2-probe.ts`
- Modify: `src/diagnostics/unitv-diagnostic.ts` (keep untouched or reuse `sanitizeDiagnosticUrl` exported from it)
- Test: `tests/diagnostics/unitv-phase2-probe.test.ts`

**Interfaces:**
- Consumes: `sanitizeDiagnosticUrl(rawUrl: string): string` from `src/diagnostics/unitv-diagnostic.ts`
- Produces:
  - `Phase2DomInput`, `Phase2DomAction`, `Phase2VideoInfo`, `Phase2DomSnapshot`
  - `Phase2StreamLogEntry`, `Phase2StreamCandidate`, `ExoPlayerTestState`
  - `PHASE2_DOM_INSPECT_SCRIPT: string`
  - `PHASE2_STREAM_CAPTURE_SCRIPT: string`
  - `createInitialExoPlayerState(): ExoPlayerTestState`
  - `parsePhase2WebViewMessage(rawJson: string): { kind: 'DOM'; snapshot: Phase2DomSnapshot } | { kind: 'STREAM_CANDIDATE'; entry: Phase2StreamLogEntry; candidate: Phase2StreamCandidate } | { kind: 'STREAM_BLOB'; entry: Phase2StreamLogEntry } | null`
  - `formatPhase2ReportSection(params: { domSnapshots: Phase2DomSnapshot[]; streamLogs: Phase2StreamLogEntry[]; exoState: ExoPlayerTestState }): string`

- [ ] **Step 1: Write the failing unit tests for Phase 2 probe parsing, sanitization, and script safety**

Create `tests/diagnostics/unitv-phase2-probe.test.ts` with tests covering:
1. `PHASE2_DOM_INSPECT_SCRIPT` and `PHASE2_STREAM_CAPTURE_SCRIPT` parse as valid JS (`new Function(script)`) and contain neither `document.cookie` nor `localStorage` nor `.value`.
2. `parsePhase2WebViewMessage` parses `DIAG_PHASE2_DOM`, strips query/hash/userinfo from `url` and every `action.hrefPath`, truncates action `text` to 80 chars, caps inputs (15) and actions (40), and strips any unexpected `value`/`cookie` keys.
3. `parsePhase2WebViewMessage` parses `DIAG_PHASE2_STREAM` for `https://cdn.example.com/live/master.m3u8?token=secret123` into `{ kind: 'STREAM_CANDIDATE', entry: { sanitizedUrl: 'https://cdn.example.com/live/master.m3u8', ... }, candidate: { streamUrl: 'https://cdn.example.com/live/master.m3u8?token=secret123', referer: 'https://www.unitvwebs.com/vod/details/0/ABC', ... } }` where `entry.sanitizedUrl` has NO `token=secret123` and `candidate.referer` strips query strings.
4. `parsePhase2WebViewMessage` classifies `blob:https://www.unitvwebs.com/1234` as `{ kind: 'STREAM_BLOB', entry: { sanitizedUrl: 'blob://[redacted]', ... } }` without producing a playable `candidate`.
5. `formatPhase2ReportSection` formats DOM snapshots, stream logs, and `ExoPlayerTestState` without ever leaking query tokens, cookies, or credentials.

- [ ] **Step 2: Run the new test file to verify RED**

Run: `npx jest tests/diagnostics/unitv-phase2-probe.test.ts`
Expected: FAIL because `src/diagnostics/unitv-phase2-probe.ts` does not exist yet.

- [ ] **Step 3: Implement `src/diagnostics/unitv-phase2-probe.ts`**

Implement:
- `PHASE2_DOM_INSPECT_SCRIPT`: idempotent IIFE reading only `location.href`, `document.title`, `input, textarea, select` structural attributes (`tagName`, `type`, `name`, `id`, `placeholder` — never `.value`), clickable/episode/card elements (`a[href], button, [role="button"], [class*="ep"], [class*="episode"], [class*="vod"], [class*="item"], [class*="card"]` — `tagName`, `id`, `className`, `getAttribute('href')`, trimmed `textContent` up to 80 chars), and `document.querySelector('#v-player_html5_api, #v-player video, video')` structural properties (`id`, `currentSrc || src`, `readyState`, `videoWidth`, `videoHeight`, `duration`, `paused`, `textTracks.length`), posting JSON via `window.ReactNativeWebView.postMessage`.
- `PHASE2_STREAM_CAPTURE_SCRIPT`: idempotent IIFE (`window.__UNITV_DIAG_CAPTURE_INSTALLED__`) hooking `window.fetch`, `XMLHttpRequest.prototype.open`, `HTMLMediaElement` `loadstart` + `MediaSource` / `URL.createObjectURL` to emit `DIAG_PHASE2_STREAM` messages for URLs matching media/manifest/blob patterns (`\.(m3u8|mp4|mpd|ts)(\b|$)|master|playlist|manifest|hls|stream|video|^blob:` excluding images/fonts/css/js).
- `parsePhase2WebViewMessage`, `createInitialExoPlayerState`, `formatPhase2ReportSection` matching the exact interfaces above.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx jest tests/diagnostics/unitv-phase2-probe.test.ts`
Expected: PASS (all tests green, zero warnings).

- [ ] **Step 5: Commit Task 1**

```bash
git add src/diagnostics/unitv-phase2-probe.ts tests/diagnostics/unitv-phase2-probe.test.ts
git commit -m "feat(diagnostics): add Phase 2 DOM and stream probe sanitizer"
```

---

### Task 2: Integrate Phase 2 Probes, ExoPlayer Test Block & Share into `UniTvDiagnosticScreen`

**Files:**
- Modify: `src/screens/UniTvDiagnosticScreen.tsx`
- Modify: `tests/setup.ts` (add `Share` mock to `react-native` test mock)
- Test: `tests/diagnostics/unitv-diagnostic.test.tsx`

**Interfaces:**
- Consumes: `PHASE2_DOM_INSPECT_SCRIPT`, `PHASE2_STREAM_CAPTURE_SCRIPT`, `parsePhase2WebViewMessage`, `createInitialExoPlayerState`, `formatPhase2ReportSection` from `src/diagnostics/unitv-phase2-probe.ts`; `Video` from `react-native-video`; `Share` from `react-native`.
- Produces: Updated `UniTvDiagnosticScreen` keeping all existing `testID`s intact and adding:
  - `diagnostic-capture-dom-button`
  - `diagnostic-arm-stream-button`
  - `diagnostic-test-exoplayer-button`
  - `diagnostic-exoplayer-video` (when ExoPlayer test is mounted)
  - `diagnostic-exoplayer-status`
  - `diagnostic-exoplayer-ok` / `diagnostic-exoplayer-fail`
  - `diagnostic-share-report-button`

- [ ] **Step 1: Write failing tests in `tests/diagnostics/unitv-diagnostic.test.tsx` for Phase 2 UI flows**

Add tests covering:
1. Initial mount of `UniTvDiagnosticScreen` has `onMessage === undefined`, `injectedJavaScript === undefined`, `injectedJavaScriptBeforeContentLoaded === undefined` (still completely clean during `/captcha` & login).
2. Clicking `diagnostic-capture-dom-button` enables `onMessage`, reloads once when `onMessage` was previously unbound, and on subsequent `onLoadEnd` injects `PHASE2_DOM_INSPECT_SCRIPT`; once `onMessage` is bound, subsequent taps inject immediately without reloading.
3. Receiving a `DIAG_PHASE2_DOM` message and a `DIAG_PHASE2_STREAM` message (`https://cdn.unitv.example/ep1/master.m3u8?token=secret999`) updates `diagnostic-report-preview` with sanitized paths/structure (`token=secret999` absent) and enables `diagnostic-test-exoplayer-button`.
4. Pressing `diagnostic-test-exoplayer-button` mounts `<Video testID="diagnostic-exoplayer-video">` with `source.uri === 'https://cdn.unitv.example/ep1/master.m3u8?token=secret999'` and `Referer` header; simulating `onLoad` (`duration: 1420`, `videoTracks: [{ index: 0, width: 1920, height: 1080, bitrate: 5000000 }]`) + `onProgress` (`currentTime: 12`) updates `diagnostic-exoplayer-status`, and simulating `onError` records sanitized error state without crashing.
5. Pressing `diagnostic-share-report-button` calls `Share.share` with the sanitized summary text (containing no query tokens).

- [ ] **Step 2: Run diagnostic screen tests to verify RED**

Run: `npx jest tests/diagnostics/unitv-diagnostic.test.tsx`
Expected: FAIL because the Phase 2 buttons/handlers are not yet in `UniTvDiagnosticScreen.tsx`.

- [ ] **Step 3: Implement Phase 2 controls and ExoPlayer test panel in `src/screens/UniTvDiagnosticScreen.tsx`**

Implement:
- `postLoginToolsEnabled` state (`false` initially) + `bridgeCommittedRef` / `pendingInjectionsRef` so enabling `postLoginToolsEnabled` from `false` -> `true` schedules a single `webViewRef.current?.reload()` in `useEffect` and runs queued `DOM` / `STREAM_CAPTURE` injections on `onLoadEnd` once `messagingEnabled` is bound.
- `handleWebViewMessage(event)` delegating to `parsePhase2WebViewMessage(event.nativeEvent.data)` to store sanitized `domSnapshots` (latest 6), `streamLogs` (latest 20), and latest `streamCandidate` in memory.
- Compact Phase 2 card inside the collapsible `panelOpen` drawer with ≥ 44 px buttons (`Capturar DOM Atual`, `Armar Captura de Stream`, `Testar no ExoPlayer`, `Compartilhar Resumo`), selectable `diagnostic-report-preview`, and embedded `<Video testID="diagnostic-exoplayer-video">` card with `onLoad`, `onProgress`, `onError`, `ExoPlayer OK`, and `ExoPlayer Falhou`.
- Keep all existing Phase 1 layout, `testID`s, `SafeAreaInsets`, and sanitized reporting intact.

- [ ] **Step 4: Run TypeScript and the full Jest suite to verify GREEN**

Run: `EXPO_PUBLIC_UNITV_DIAGNOSTIC=1 npx tsc --noEmit && EXPO_PUBLIC_UNITV_DIAGNOSTIC=1 npx jest`
Expected: `npx tsc --noEmit` exit 0; all test suites pass (12/12 suites, 0 warnings).

- [ ] **Step 5: Commit Task 2 on `diagnostico/unitvwebs` and rebuild Phase 2 diagnostic APK via Actions**

```bash
git add src/screens/UniTvDiagnosticScreen.tsx tests/diagnostics/unitv-diagnostic.test.tsx
git commit -m "feat(diagnostics): add post-login DOM/stream capture and ExoPlayer test panel"
git push origin diagnostico/unitvwebs
gh workflow run android-apk.yml --ref diagnostico/unitvwebs
```
Wait for run completion, download artifact into `release-apk/diagnostico-unitv/`, and verify `com.personal.mediahub.diag`, v2 signature, `PMH Diag UniTV`, and embedded JS bundle.

---

## Self-Review

- **Spec coverage:** All 4 post-login diagnostic actions (`Capturar DOM Atual`, `Armar Captura de Stream`, `Testar no ExoPlayer`, `Compartilhar Resumo`), pre-login clean WebView guarantee, `com.personal.mediahub.diag` isolation, and zero credential/token logging are explicitly assigned to Tasks 1–2.
- **Type consistency:** `Phase2DomSnapshot`, `Phase2StreamLogEntry`, `Phase2StreamCandidate`, `ExoPlayerTestState`, `parsePhase2WebViewMessage`, and `formatPhase2ReportSection` match identically between Task 1 and Task 2.
- **Test setup check:** Confirm `tests/setup.ts` mocks `Share` from `react-native` if absent (`tests/setup.ts` currently mocks `Alert`, `Linking`, `BackHandler`, `AppState` — check and add `Share: { share: jest.fn(async () => ({ action: 'sharedAction' })) }` inside Task 2's test file or `tests/setup.ts` if needed!).
