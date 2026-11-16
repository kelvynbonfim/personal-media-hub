# Personal Media Hub (V1: Animes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir um aplicativo Android nativo pessoal (React Native / Expo Prebuild) que combina uma plataforma completa de streaming e descoberta de animes com controle pessoal integrado (6 status, progresso automático/manual, calendário semanal, radar de continuações), reprodução interna em Full HD via sessão do UniTV Web Player (com fallback em WebView limpa), persistência offline-first em SQLite e sincronização gratuita no Supabase.

**Architecture:** Aplicação *Local-First* em TypeScript onde o SQLite é a fonte de verdade imediata no aparelho, alimentado pelas APIs gratuitas AniList GraphQL + Jikan v4 (e TMDB opcional para `pt-BR`) com cache local e sincronização assíncrona no Supabase Free Tier + exportação/importação de backup `.json`. A reprodução passa por uma interface desacoplada (`PlaybackSourceAdapter`) cujo adaptador principal (`UniTvPlaybackAdapter`) usa uma `WebView` autenticada com portal configurável para entregar streams `.m3u8`/`.mp4` em 1080p ao Media3 `ExoPlayer` nativo, com fallback automático em `WebView` fullscreen limpa se a extração falhar dentro de 8 segundos.

**Tech Stack:** TypeScript, React Native (Expo Prebuild / `expo-dev-client` + Gradle local / GitHub Actions Free para `.apk`), `expo-sqlite`, `expo-secure-store`, `@react-navigation/native` + bottom tabs, `react-native-video` (Media3 ExoPlayer), `react-native-webview`, `@supabase/supabase-js`, Jest + `@testing-library/react-native`.

**Spec:** [2026-11-16-personal-media-hub-design.md](file:///c:/Users/Kekel/Documents/App%20M%C3%ADdia/docs/superpowers/specs/2026-11-16-personal-media-hub-design.md)

## Global Constraints

- **Custo adicional R$ 0,00:** Nenhuma biblioteca paga, nenhum trial pago, nenhum cartão de crédito obrigatório; compilação `.apk` via Gradle local ou GitHub Actions Free (2.000 min/mês Linux privado / ilimitado público).
- **Plataforma prioritária Android (base pronta para iOS futuro):** Pacote nativo Android instalável diretamente via `.apk`/ADB sem Play Store paga; zero infraestrutura backend própria além do Supabase Free Tier.
- **Identidade Visual fixa ("Ardósia Mineral & Menta Bioluminescente"):** `bg.canvas = '#080B0C'`, `bg.surface = '#0D1214'`, `bg.card = '#131B1F'`, `border.subtle = '#1E2C30'`, `accent.primary = '#2DD4BF'`, `accent.secondary = '#FB7185'`, `accent.gold = '#FBBF24'`, `text.primary = '#F0FDFA'`, `text.secondary = '#94A3B8'`.
- **Regras de catálogo e limites gratuitos:** AniList máximo 90 req/min; Jikan v4 máximo 3 req/s e 60 req/min; TMDB estritamente opcional na V1 com atribuição obrigatória na tela "Sobre" quando ativa.
- **Regras de reprodução e progresso:** Nunca redirecionar para o app externo do UniTV; URL do portal UniTV configurável em `app_settings`; credenciais UniTV exclusivamente no Android Keystore (`expo-secure-store`), nunca no SQLite ou nuvem; salvar posição do vídeo a cada **10 segundos**; marcar episódio como concluído automaticamente ao cruzar **85%** da duração.
- **Gate da Fase 1:** A Task 1 inclui o Spike obrigatório de viabilidade do UniTV Web Player antes da construção completa das telas de reprodução; se houver bloqueio total da conta/CAPTCHA/DRM no Spike, pausar e alinhar pivô via `PlaybackSourceAdapter`.

## Review Focus

1. **Projeto Supabase pausado (após 7 dias sem uso) ou celular offline:** O motor de sincronização deve capturar falhas HTTP 5xx/rede sem quebrar escritas locais no SQLite, mantendo `dirty = 1` para reenvio posterior e permitindo exportação `.json` offline a qualquer momento (testado na Task 4).
2. **Troca de domínio do Web Player UniTV ou timeout na extração da stream (> 8s):** `UniTvPlaybackAdapter` deve ler a URL base dinamicamente de `app_settings.unitv_portal_url` e comutar automaticamente para `CLEAN_WEBVIEW` quando nenhuma stream `.m3u8`/`.mp4` for interceptada em 8.000 ms (testado nas Tasks 1 e 5).
3. **Rate limit HTTP 429 ou ausência de rede no AniList / Jikan:** `CatalogService` deve aplicar debounce de 350 ms na busca, servir o cache SQLite existente ou fazer fallback para Jikan v4 quando o AniList responder 429/erro de rede (testado na Task 3).
4. **Fronteira de 85% de conclusão e proteção contra regressão ao reassistir:** Cruzar `positionSeconds / durationSeconds >= 0.85` deve marcar `is_completed = true` e avançar `current_episode` apenas para `max(current_episode, episode_number)`, sem retroceder progresso se o usuário rever um episódio anterior (testado na Task 2).
5. **Ordenação cronológica de franquias e detecção de continuações no Radar:** `CatalogService` deve ordenar relações (`PREQUEL` → atual → `SEQUEL` / `SIDE_STORY`) e marcar `isSequelToLibraryItem = true` no Radar quando o `PREQUEL` de uma estreia futura já existir em `library_entries` (testado na Task 3).

---

## File Structure

- `package.json`, `tsconfig.json`, `app.config.ts`, `jest.config.js`, `.gitignore` — Configuração TypeScript, Expo Prebuild Android, testes Jest e exclusão de `.superpowers/`.
- `.github/workflows/android-apk.yml` — Workflow gratuito opcional para gerar `.apk` Android via Gradle em runners Linux.
- `src/playback/unitv-probe.ts` — Script injetado e analisador de payloads/estados da sessão web do UniTV para o Spike da Fase 1.
- `src/db/schema.ts` — Definição das tabelas SQLite (`media_items`, `library_entries`, `episode_progress`, `watch_history`, `unitv_links`, `app_settings`) e abstração `DatabaseAdapter`.
- `src/db/library-repository.ts` — Operações Local-First de biblioteca, status (6 categorias), notas, progresso (regra 85%), histórico, vínculos UniTV e configurações.
- `src/db/backup-service.ts` — Exportação e importação completa de backup `.json`.
- `src/catalog/types.ts` — Tipos de catálogo, filtros, grade semanal, radar de próximas temporadas e linha do tempo de franquia.
- `src/catalog/anilist-client.ts` — Cliente GraphQL do AniList (Home, Catálogo, AiringSchedule, Próximas Temporadas, Relações).
- `src/catalog/jikan-client.ts` — Cliente REST Jikan v4 com controle de throttle (fallback e sinônimos).
- `src/catalog/tmdb-client.ts` — Cliente opcional TMDB para busca e sinopses em `pt-BR`.
- `src/catalog/catalog-service.ts` — Orquestrador Cache-First com fallback 429, filtro "ocultar concluídos", agrupamento semanal e cruzamento de continuações.
- `supabase/schema.sql` — Esquema Postgres espelho com políticas RLS por `auth.uid()`.
- `src/sync/supabase-sync.ts` — Motor de sync bidirecional com fila `dirty`, resolução LWW por `updated_at` e resiliência a projeto pausado/offline.
- `src/playback/types.ts` — Interface desacoplada `PlaybackSourceAdapter` e resultados de reprodução.
- `src/playback/credentials-store.ts` — Armazenamento seguro das credenciais UniTV exclusivamente no `expo-secure-store`.
- `src/playback/hls-track-selector.ts` — Seleção da faixa de vídeo de maior resolução/bitrate (1080p Full HD).
- `src/playback/unitv-adapter.ts` — Implementação do `UniTvPlaybackAdapter` (casamento de título, `unitv_links`, ponte `WebView`, timeout 8s → `CLEAN_WEBVIEW`, tratamento de limite de telas).
- `src/theme/tokens.ts` — Paleta oficial "Ardósia Mineral & Menta Bioluminescente" e tokens tipográficos/espaçamento.
- `src/components/MediaPosterCard.tsx` — Card de pôster reutilizável com selos de status/progresso e toque longo.
- `src/navigation/RootNavigator.tsx` — Navegação principal em 4 abas + telas empilhadas de Detalhes, Player e Configurações.
- `src/screens/HomeScreen.tsx` — Aba 1: Hero, Continuar Assistindo, Top do Mês, Temporada Atual e Próximos da Semana.
- `src/screens/ExploreScreen.tsx` — Aba 2: Busca com debounce 350ms, filtros combináveis e toggle "Ocultar já concluídos".
- `src/screens/CalendarScreen.tsx` — Aba 3: Grade Semanal (Segunda–Domingo) e Radar de Próximas Temporadas.
- `src/screens/LibraryScreen.tsx` — Aba 4: 6 categorias, alternância Grade/Lista, ordenação e botão `"🎲 Escolher por mim"`.
- `src/screens/AnimeDetailsScreen.tsx` — Tela Única Direta (Opção A): status, nota `0..10`, linha do tempo da franquia, sinopse, notas pessoais, lista de episódios (`▶ Play` / `✓`).
- `src/screens/VideoPlayerScreen.tsx` — Player paisagem Full HD (ExoPlayer + fallback `CLEAN_WEBVIEW`, ticker 10s, botão Próximo Episódio nos últimos 90s).
- `src/screens/SettingsScreen.tsx` — Credenciais UniTV, URL configurável do Web Player, chave opcional TMDB, status Supabase, Exportar/Importar `.json` e atribuições "Sobre".
- `tests/**` — Suítes Jest cobrindo todas as regras e cenários do Review Focus.

---

### Task 1: Project Scaffolding & Phase 1 UniTV Web Player Viability Spike (Decision Gate)

**Files:**
- Create: `package.json`, `tsconfig.json`, `jest.config.js`, `app.config.ts`, `.gitignore`, `.github/workflows/android-apk.yml`
- Create: `src/playback/unitv-probe.ts`
- Test: `tests/playback/unitv-probe.test.ts`

**Interfaces:**
- Produces in `src/playback/unitv-probe.ts`:
  - `export type UniTvProbeStatus = 'STREAM_READY' | 'WEBVIEW_ONLY' | 'BLOCKED';`
  - `export interface UniTvProbeResult { status: UniTvProbeStatus; streamUrl?: string; headers?: Record<string, string>; reason?: string; }`
  - `export const UNITV_STREAM_HOOK_SCRIPT: string`
  - `export function buildPortalUrl(baseUrl: string, path: string): string`
  - `export function parseInjectedStreamPayload(rawJson: string): { url: string; headers: Record<string, string> } | null`
  - `export function classifyProbeOutcome(input: { extractedUrl: string | null; authSucceeded: boolean; pageBlockedByBot: boolean }): UniTvProbeResult`

- [ ] **Step 1: Write the failing test**

Create `tests/playback/unitv-probe.test.ts`:
```ts
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

    const ignored = parseInjectedStreamPayload(
      JSON.stringify({ type: 'STREAM_CAPTURED', url: 'https://cdn.example.com/poster.jpg' })
    );
    expect(ignored).toBeNull();
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

    expect(
      classifyProbeOutcome({ extractedUrl: null, authSucceeded: true, pageBlockedByBot: false }).status
    ).toBe('WEBVIEW_ONLY');

    expect(
      classifyProbeOutcome({ extractedUrl: null, authSucceeded: false, pageBlockedByBot: true }).status
    ).toBe('BLOCKED');
  });

  it('provides a JS injection hook targeting video elements, fetch, and XHR', () => {
    expect(UNITV_STREAM_HOOK_SCRIPT).toContain('.m3u8');
    expect(UNITV_STREAM_HOOK_SCRIPT).toContain('ReactNativeWebView.postMessage');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/playback/unitv-probe.test.ts`
Expected: FAIL because project dependencies / `src/playback/unitv-probe.ts` do not exist yet.

- [ ] **Step 3: Initialize project scaffolding & implement `src/playback/unitv-probe.ts`**

Create `package.json` (Expo SDK 52+, React Native, TypeScript, `expo-sqlite`, `expo-secure-store`, `react-native-video`, `react-native-webview`, `@supabase/supabase-js`, `@react-navigation/native`, `@react-navigation/bottom-tabs`, `jest`, `ts-jest`, `@testing-library/react-native`), `tsconfig.json`, `jest.config.js`, `app.config.ts` (Android package name + landscape support for player), `.gitignore` (ignoring `node_modules/`, `.expo/`, `android/`, `ios/`, `.superpowers/`), and `.github/workflows/android-apk.yml` (Gradle release APK build on Linux runner).
Implement `buildPortalUrl`, `parseInjectedStreamPayload`, `classifyProbeOutcome`, and `UNITV_STREAM_HOOK_SCRIPT` (intercepting `fetch`, `XMLHttpRequest`, and `<video>.src`/`currentSrc` for `.m3u8`/`.mp4` URLs) in `src/playback/unitv-probe.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm install && npx jest tests/playback/unitv-probe.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Execute Phase 1 Decision Gate Spike & Commit**

Run an interactive spike check on a real Android emulator/device (or local Expo Dev Client test harness) with the user's UniTV Web Player credentials and current portal URL to verify whether the outcome is `STREAM_READY`, `WEBVIEW_ONLY`, or `BLOCKED`.
- If `BLOCKED` (e.g., activation-code plan without web access or hard anti-bot block), **STOP here per Global Constraints** and present the diagnostic to the user before continuing Tasks 5–8.
- Otherwise commit scaffolding and probe:
```bash
git init
git add .gitignore package.json tsconfig.json jest.config.js app.config.ts .github/workflows/android-apk.yml src/playback/unitv-probe.ts tests/playback/unitv-probe.test.ts
git commit -m "chore: scaffold Expo Prebuild app and Phase 1 UniTV probe"
```

---

### Task 2: Local-First SQLite Database, Repositories & JSON Backup Engine

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/library-repository.ts`
- Create: `src/db/backup-service.ts`
- Test: `tests/db/library-repository.test.ts`

**Interfaces:**
- Produces in `src/db/schema.ts`:
  - `export type MediaType = 'ANIME' | 'MOVIE' | 'SERIES';`
  - `export type WatchStatus = 'WATCHING' | 'PLAN_TO_WATCH' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'REWATCHING';`
  - `export interface MediaItemRecord { id: string; mediaType: MediaType; anilistId: number; malId: number | null; tmdbId: number | null; titleRomaji: string; titleEnglish: string | null; titlePt: string | null; synopsis: string | null; coverUrl: string; bannerUrl: string | null; genresJson: string; seasonYear: number | null; seasonName: string | null; episodesTotal: number | null; statusAiring: string; nextAiringAt: number | null; nextAiringEp: number | null; relationsJson: string; cachedAt: string; }`
  - `export interface LibraryEntryRecord { id: string; mediaItemId: string; status: WatchStatus; personalScore: number | null; currentEpisode: number; notes: string; rewatchCount: number; startedAt: string | null; completedAt: string | null; updatedAt: string; dirty: number; }`
  - `export interface EpisodeProgressRecord { id: string; mediaItemId: string; episodeNumber: number; positionSeconds: number; durationSeconds: number; isCompleted: boolean; watchedVia: 'APP_PLAYER' | 'MANUAL'; updatedAt: string; dirty: number; }`
  - `export interface WatchHistoryRecord { id: string; mediaItemId: string; episodeNumber: number; action: 'STARTED' | 'COMPLETED' | 'STATUS_CHANGED'; occurredAt: string; dirty: number; }`
  - `export interface UniTvLinkRecord { mediaItemId: string; unitvVodId: string; unitvTitle: string; unitvSeasonTag: string | null; preferredAudioOrSub: string | null; lastVerifiedAt: string; }`
  - `export interface AppSettingsRecord { unitvPortalUrl: string; preferMaxQuality: boolean; hideCompletedInExplore: boolean; tmdbApiKey: string | null; lastSyncAt: string | null; }`
  - `export interface DatabaseAdapter { execute(sql: string, params?: unknown[]): Promise<void>; query<T>(sql: string, params?: unknown[]): Promise<T[]>; }`
  - `export async function initializeDatabase(db: DatabaseAdapter): Promise<void>`
- Produces in `src/db/library-repository.ts`:
  - `export class LibraryRepository` with methods: `upsertMediaItem`, `setLibraryStatus`, `updatePersonalScore`, `updateNotes`, `recordPlaybackProgress`, `toggleEpisodeManual`, `getLibraryByStatus`, `getAllLibraryEntries`, `getEpisodeProgressList`, `pickRandomPlanToWatch`, `getSettings`, `saveSettings`, `saveUniTvLink`, `getUniTvLink`.
- Produces in `src/db/backup-service.ts`:
  - `export class BackupService` with `exportBackupJson(): Promise<string>` and `importBackupJson(jsonPayload: string): Promise<{ importedEntries: number; importedProgress: number }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/library-repository.test.ts` testing:
1. All 6 statuses (`WATCHING`, `PLAN_TO_WATCH`, `COMPLETED`, `PAUSED`, `DROPPED`, `REWATCHING`), score `0..10` validation, and notes persistence.
2. **Review Focus #4 (85% completion boundary & non-regression):** `recordPlaybackProgress` with `positionSeconds: 1224, durationSeconds: 1440` (exactly 85%) marks `isCompleted = true`, increments `currentEpisode` from `5` to `6`, logs `COMPLETED` in `watch_history`, and when rewatching `episodeNumber: 2`, keeps `currentEpisode` at `6` (never regresses).
3. Reaching `episodesTotal` on `recordPlaybackProgress` or `toggleEpisodeManual` returns `seasonCompletedPrompt: true`.
4. `pickRandomPlanToWatch` respects optional `genreFilter` and returns `null` when empty.
5. `BackupService.exportBackupJson()` followed by `importBackupJson()` on a clean database restores entries, progress, history, settings (without credentials), and `unitv_links`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/db/library-repository.test.ts`
Expected: FAIL with "Cannot find module '../../src/db/schema'".

- [ ] **Step 3: Implement `src/db/schema.ts`, `src/db/library-repository.ts`, and `src/db/backup-service.ts`**

Create SQLite DDL for the 6 tables in `src/db/schema.ts` with default `unitvPortalUrl = 'https://www.uvwebs.info'` and `preferMaxQuality = true`. Implement `LibraryRepository` (marking `dirty = 1` on local writes and enforcing `Math.max(existing.currentEpisode, episodeNumber)` on forward completion) and `BackupService` with JSON schema validation (`version: 1`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/db/library-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/library-repository.ts src/db/backup-service.ts tests/db/library-repository.test.ts
git commit -m "feat(db): implement local-first SQLite repositories and JSON backup"
```

---

### Task 3: Catalog, Calendar & Franchise Service (AniList + Jikan v4 + Optional TMDB `pt-BR`)

**Files:**
- Create: `src/catalog/types.ts`
- Create: `src/catalog/anilist-client.ts`
- Create: `src/catalog/jikan-client.ts`
- Create: `src/catalog/tmdb-client.ts`
- Create: `src/catalog/catalog-service.ts`
- Test: `tests/catalog/catalog-service.test.ts`

**Interfaces:**
- Consumes: `MediaItemRecord`, `LibraryEntryRecord`, `WatchStatus` from `src/db/schema.ts`; `LibraryRepository` from `src/db/library-repository.ts`.
- Produces in `src/catalog/types.ts` & `src/catalog/catalog-service.ts`:
  - `export interface CatalogFilter { query?: string; genres?: string[]; sort?: 'TRENDING_MONTH' | 'POPULARITY' | 'SCORE' | 'NEWEST'; seasonYear?: number; seasonName?: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL'; format?: 'TV' | 'MOVIE' | 'OVA'; hideCompleted?: boolean; }`
  - `export interface WeeklyScheduleEntry { media: MediaItemRecord; episodeNumber: number; airingAtUnix: number; weekdayIndex: number; inUserActiveList: boolean; }`
  - `export interface UpcomingSeasonEntry { media: MediaItemRecord; releaseLabel: string; isSequelToLibraryItem: boolean; }`
  - `export interface FranchiseNode { anilistId: number; title: string; format: string; relationType: 'PREQUEL' | 'CURRENT' | 'SEQUEL' | 'SIDE_STORY'; userStatus?: WatchStatus; }`
  - `export class CatalogService` with `getHomeFeed`, `exploreCatalog`, `getWeeklySchedule`, `getUpcomingSeasonsRadar`, `buildFranchiseTimeline`, `enrichWithPortugueseIfConfigured`.

- [ ] **Step 1: Write the failing test**

Create `tests/catalog/catalog-service.test.ts` testing:
1. **Review Focus #3 (HTTP 429 / offline fallback):** When `AniListClient` throws an HTTP `429` error, `exploreCatalog` falls back to `JikanClient` (if online) or returns cached SQLite `MediaItemRecord[]` without throwing.
2. `exploreCatalog` with `hideCompleted: true` removes titles whose IDs are in `completedMediaIds`.
3. **Review Focus #5 (Weekly schedule & Franchise/Sequel Radar):**
   - `getWeeklySchedule` groups episodes into weekdays `0..6` (Sunday–Saturday) using local weekday calculation and sets `inUserActiveList = true` only for `WATCHING` / `PLAN_TO_WATCH` entries.
   - `getUpcomingSeasonsRadar` sets `isSequelToLibraryItem = true` when an upcoming `NOT_YET_RELEASED` anime lists a `PREQUEL` `anilistId` that exists in `userEntries`.
   - `buildFranchiseTimeline` orders `[PREQUEL, CURRENT, SEQUEL, SIDE_STORY]` deterministically and attaches `userStatus` when present.
4. Optional TMDB `pt-BR`: When `tmdbApiKey` is `null`, search skips TMDB without errors; when `tmdbApiKey` is provided, Portuguese query terms resolve localized title/synopsis and populate `titlePt`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/catalog/catalog-service.test.ts`
Expected: FAIL because catalog modules do not exist yet.

- [ ] **Step 3: Implement catalog clients and `CatalogService`**

Implement GraphQL queries in `src/catalog/anilist-client.ts` (trending/top month, airing schedule window, `NOT_YET_RELEASED` upcoming seasons, media relations), rate-limited REST client (<= 3 req/s queue) in `src/catalog/jikan-client.ts`, optional `pt-BR` lookup in `src/catalog/tmdb-client.ts`, and `CatalogService` caching responses into `media_items` via `LibraryRepository`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/catalog/catalog-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/ tests/catalog/catalog-service.test.ts
git commit -m "feat(catalog): implement AniList, Jikan fallback, optional TMDB, calendar and franchise timeline"
```

---

### Task 4: Cloud Sync Engine (Supabase Free Tier + Offline Queue & Paused-Project Resilience)

**Files:**
- Create: `supabase/schema.sql`
- Create: `src/sync/supabase-sync.ts`
- Test: `tests/sync/supabase-sync.test.ts`

**Interfaces:**
- Consumes: `DatabaseAdapter`, `LibraryEntryRecord`, `EpisodeProgressRecord`, `WatchHistoryRecord` from `src/db/schema.ts`.
- Produces in `src/sync/supabase-sync.ts`:
  - `export interface SyncResult { status: 'SYNCED' | 'DEFERRED_OFFLINE_OR_PAUSED'; pushedCount: number; pulledCount: number; errorMessage?: string; }`
  - `export function resolveConflictByUpdatedAt<T extends { updatedAt: string }>(local: T, remote: T): T`
  - `export class SupabaseSyncEngine` with `syncNow(userId: string): Promise<SyncResult>` and `getDirtyCount(): Promise<number>`.

- [ ] **Step 1: Write the failing test**

Create `tests/sync/supabase-sync.test.ts` testing:
1. `resolveConflictByUpdatedAt` preserves whichever record has the newer ISO timestamp.
2. Pushing dirty rows clears `dirty = 0` and updates `app_settings.lastSyncAt` when Supabase responds cleanly.
3. **Review Focus #1 (Paused Supabase project / offline):** When the Supabase client returns HTTP 503/540 ("project paused") or a network error, `syncNow` does **not** throw, returns `{ status: 'DEFERRED_OFFLINE_OR_PAUSED', pushedCount: 0, pulledCount: 0, errorMessage: ... }`, and leaves all local rows with `dirty = 1` intact.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/sync/supabase-sync.test.ts`
Expected: FAIL because `src/sync/supabase-sync.ts` does not exist.

- [ ] **Step 3: Implement `supabase/schema.sql` and `src/sync/supabase-sync.ts`**

Create `supabase/schema.sql` defining the mirror tables (`user_id uuid references auth.users not null`, `media_items`, `library_entries`, `episode_progress`, `watch_history`, `unitv_links`) with `ENABLE ROW LEVEL SECURITY` and policies `auth.uid() = user_id`. Implement `SupabaseSyncEngine` pushing `dirty = 1` rows, pulling changes newer than `lastSyncAt`, and guarding every call with safe offline/paused error handling.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/sync/supabase-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql src/sync/supabase-sync.ts tests/sync/supabase-sync.test.ts
git commit -m "feat(sync): add Supabase free-tier sync engine with offline/paused resilience"
```

---

### Task 5: `PlaybackSourceAdapter`, `UniTvPlaybackAdapter` & 1080p HLS Track Selector

**Files:**
- Create: `src/playback/types.ts`
- Create: `src/playback/credentials-store.ts`
- Create: `src/playback/hls-track-selector.ts`
- Create: `src/playback/unitv-adapter.ts`
- Test: `tests/playback/unitv-adapter.test.ts`

**Interfaces:**
- Consumes: `MediaItemRecord`, `UniTvLinkRecord` (`src/db/schema.ts`), `LibraryRepository` (`src/db/library-repository.ts`), `buildPortalUrl` & `parseInjectedStreamPayload` (`src/playback/unitv-probe.ts`).
- Produces:
  - `export interface HlsVariant { index: number; width: number; height: number; bitrate: number; }`
  - `export function selectBestHlsTrack(variants: HlsVariant[]): { index: number; label: string } | null`
  - `export interface PlaybackResolution { mode: 'EXOPLAYER_HLS' | 'CLEAN_WEBVIEW'; streamUrl?: string; headers?: Record<string, string>; webViewUrl?: string; matchedTitle?: string; errorCode?: 'CONCURRENT_SCREEN_LIMIT' | 'NOT_FOUND_IN_CATALOG' | 'AUTH_FAILED'; }`
  - `export interface PlaybackSourceAdapter { resolveEpisodePlayback(params: { media: MediaItemRecord; episodeNumber: number; existingLink: UniTvLinkRecord | null; portalUrl: string }): Promise<PlaybackResolution>; }`
  - `export class CredentialsStore` (`saveUniTvCredentials`, `getUniTvCredentials`, `clearUniTvCredentials` backed by `expo-secure-store`)
  - `export class UniTvPlaybackAdapter implements PlaybackSourceAdapter`

- [ ] **Step 1: Write the failing test**

Create `tests/playback/unitv-adapter.test.ts` testing:
1. `selectBestHlsTrack` picks `1920x1080` over `1280x720` and breaks resolution ties by highest `bitrate` (returning `'1080p'`).
2. `UniTvPlaybackAdapter.resolveEpisodePlayback` uses `existingLink` when present, passes `portalUrl` dynamically (never hardcoded), and returns `mode: 'EXOPLAYER_HLS'` when stream extraction succeeds within 8,000 ms.
3. **Review Focus #2 (8s extraction timeout fallback):** When stream capture times out after 8,000 ms (with fake timers), `resolveEpisodePlayback` returns `mode: 'CLEAN_WEBVIEW'` with `webViewUrl` inside the configured `portalUrl`.
4. Concurrent single-screen rejection returns `errorCode: 'CONCURRENT_SCREEN_LIMIT'` without crashing.
5. `CredentialsStore` writes/reads credentials via injected `SecureStore` abstraction and never stores secrets in plain settings.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/playback/unitv-adapter.test.ts`
Expected: FAIL because playback modules do not exist yet.

- [ ] **Step 3: Implement `types.ts`, `credentials-store.ts`, `hls-track-selector.ts`, and `unitv-adapter.ts`**

Implement `selectBestHlsTrack` sorting descending by `height` then `bitrate`, `CredentialsStore` wrapping `expo-secure-store`, and `UniTvPlaybackAdapter` with title candidate normalization (`titlePt`, `titleEnglish`, `titleRomaji`), `unitv_links` reuse, 8,000 ms timeout fallback to `CLEAN_WEBVIEW`, and CSS selector list for hiding web chrome in fallback mode.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/playback/unitv-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/playback/ tests/playback/unitv-adapter.test.ts
git commit -m "feat(playback): add PlaybackSourceAdapter, UniTv adapter with 8s fallback, and 1080p selector"
```

---

### Task 6: Design System ("Ardósia Mineral & Menta Bioluminescente") & Navigation Shell

**Files:**
- Create: `src/theme/tokens.ts`
- Create: `src/components/MediaPosterCard.tsx`
- Create: `src/navigation/RootNavigator.tsx`
- Create: `App.tsx`
- Test: `tests/theme/tokens.test.ts`

**Interfaces:**
- Consumes: `MediaItemRecord`, `WatchStatus` (`src/db/schema.ts`).
- Produces:
  - `export const THEME_TOKENS` (with exact spec hex values and readable status labels/colors for all 6 `WatchStatus` values)
  - `export function MediaPosterCard(props: { item: MediaItemRecord; status?: WatchStatus; progressLabel?: string; rankBadge?: number; onPress: () => void; onLongPress?: () => void }): JSX.Element`
  - `export type RootStackParamList = { MainTabs: undefined; AnimeDetails: { anilistId: number; mediaItemId?: string }; VideoPlayer: { mediaItemId: string; episodeNumber: number }; Settings: undefined }`
  - `export function RootNavigator(): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `tests/theme/tokens.test.ts` testing:
1. Exact spec hex tokens (`#080B0C`, `#0D1214`, `#131B1F`, `#1E2C30`, `#2DD4BF`, `#FB7185`, `#FBBF24`, `#F0FDFA`, `#94A3B8`).
2. `STATUS_META` maps all 6 `WatchStatus` enum values to Portuguese labels (`Assistindo`, `Pretendo assistir`, `Concluído`, `Pausado`, `Dropado`, `Reassistindo`).
3. `MediaPosterCard` renders title, optional `#rankBadge`, and user status badge, and fires `onPress` / `onLongPress`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/theme/tokens.test.ts`
Expected: FAIL because theme/components do not exist yet.

- [ ] **Step 3: Implement `tokens.ts`, `MediaPosterCard.tsx`, `RootNavigator.tsx`, and `App.tsx`**

Define `THEME_TOKENS` & `STATUS_META`, build `MediaPosterCard` with dark mineral styling and menta/coral badges, configure React Navigation 4-tab bottom bar (`Início`, `Catálogo`, `Calendário`, `Biblioteca`) plus modal/stack screens (`AnimeDetails`, `VideoPlayer`, `Settings`), and wire SQLite + services context in `App.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/theme/tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add App.tsx src/theme/ src/components/ src/navigation/ tests/theme/tokens.test.ts
git commit -m "feat(ui): implement Mineral Slate & Bioluminescent Mint theme and navigation shell"
```

---

### Task 7: Streaming Home, Catalog Explorer & Release Calendar Screens (Tabs 1, 2, 3)

**Files:**
- Create: `src/screens/HomeScreen.tsx`
- Create: `src/screens/ExploreScreen.tsx`
- Create: `src/screens/CalendarScreen.tsx`
- Test: `tests/screens/discovery-screens.test.tsx`

**Interfaces:**
- Consumes: `CatalogService` (`src/catalog/catalog-service.ts`), `LibraryRepository` (`src/db/library-repository.ts`), `MediaPosterCard` (`src/components/MediaPosterCard.tsx`), `THEME_TOKENS` (`src/theme/tokens.ts`).
- Produces: `HomeScreen`, `ExploreScreen`, `CalendarScreen`.

- [ ] **Step 1: Write the failing test**

Create `tests/screens/discovery-screens.test.tsx` testing:
1. `HomeScreen` renders the Hero resume CTA (`Continuar Ep.`), the `"Continuar Assistindo"` rail with progress bar, `"Mais Assistidos no Mês"`, `"Temporada Atual"`, and `"Próximos Episódios da Semana"`.
2. `ExploreScreen` debounces search input by 350 ms and toggles `"Ocultar já concluídos"` so completed titles are omitted from the grid.
3. `CalendarScreen` switches between `"Grade da Semana"` (Mon–Sun selector highlighting active user items) and `"Próximas Temporadas"` (highlighting items with `isSequelToLibraryItem` using the coral badge `"Nova temporada de algo que você viu!"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/screens/discovery-screens.test.tsx`
Expected: FAIL because screens do not exist yet.

- [ ] **Step 3: Implement `HomeScreen.tsx`, `ExploreScreen.tsx`, and `CalendarScreen.tsx`**

Implement all 3 streaming discovery tabs adhering strictly to `THEME_TOKENS`, including long-press quick status action sheet on `MediaPosterCard`, multi-genre/year/sort filter bar in `ExploreScreen`, and weekly/seasonal view switch in `CalendarScreen`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/screens/discovery-screens.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/HomeScreen.tsx src/screens/ExploreScreen.tsx src/screens/CalendarScreen.tsx tests/screens/discovery-screens.test.tsx
git commit -m "feat(screens): implement Streaming Home, Catalog Explorer, and Release Calendar tabs"
```

---

### Task 8: Personal Library, Direct Anime Details (Option A), Internal Video Player & Settings Screens

**Files:**
- Create: `src/screens/LibraryScreen.tsx`
- Create: `src/screens/AnimeDetailsScreen.tsx`
- Create: `src/screens/VideoPlayerScreen.tsx`
- Create: `src/screens/SettingsScreen.tsx`
- Test: `tests/screens/library-and-player.test.tsx`

**Interfaces:**
- Consumes: `LibraryRepository`, `BackupService`, `CatalogService`, `SupabaseSyncEngine`, `UniTvPlaybackAdapter`, `CredentialsStore`, `selectBestHlsTrack`, `THEME_TOKENS`.
- Produces: `LibraryScreen`, `AnimeDetailsScreen`, `VideoPlayerScreen`, `SettingsScreen`.

- [ ] **Step 1: Write the failing test**

Create `tests/screens/library-and-player.test.tsx` testing:
1. `LibraryScreen` switches across the 6 status chips, toggles Grid/List layout, and triggers `"🎲 Escolher por mim"` to pick an entry from `PLAN_TO_WATCH`.
2. `AnimeDetailsScreen` (Option A unified view) displays status selector, `0..10` half-step score picker, franchise chronological timeline (`buildFranchiseTimeline`), expandable synopsis, personal notes editor, and episode rows with both `▶ Play` and manual `✓` buttons.
3. `VideoPlayerScreen` renders `Video` (ExoPlayer) when `mode === 'EXOPLAYER_HLS'`, saves progress every 10,000 ms via fake timers, shows `"Próximo Episódio"` prompt during the last 90 seconds, and switches to clean fullscreen `WebView` with floating `Concluir Episódio ✓` button when `mode === 'CLEAN_WEBVIEW'`.
4. `SettingsScreen` edits `unitvPortalUrl`, saves UniTV credentials via `CredentialsStore`, triggers `"Testar Conexão & Sessão"`, runs Supabase sync, exports/imports `.json` backup, and displays TMDB attribution when a TMDB key is configured.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/screens/library-and-player.test.tsx`
Expected: FAIL because screens do not exist yet.

- [ ] **Step 3: Implement `LibraryScreen.tsx`, `AnimeDetailsScreen.tsx`, `VideoPlayerScreen.tsx`, and `SettingsScreen.tsx`**

Implement all 4 screens matching the Option A direct layout, landscape immersive player with 10s interval persistence and 85% completion trigger, manual UniTV link modal when a title isn't auto-matched, and full Settings/Backup/About screen.

- [ ] **Step 4: Run full test suite & typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: Zero TypeScript errors and all test suites PASS.

- [ ] **Step 5: Build Android APK locally (or verify Gradle prebuild) & Commit**

Run: `npx expo prebuild --platform android` (verify clean Android project generation; when Android SDK is configured locally or via GitHub Actions workflow, generate release `.apk`).
```bash
git add src/screens/LibraryScreen.tsx src/screens/AnimeDetailsScreen.tsx src/screens/VideoPlayerScreen.tsx src/screens/SettingsScreen.tsx tests/screens/library-and-player.test.tsx
git commit -m "feat(app): implement Library, Option A Details, Full HD Player, and Settings screens"
```
