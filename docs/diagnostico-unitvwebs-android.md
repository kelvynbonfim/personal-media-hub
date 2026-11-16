# Diagnóstico Técnico Delimitado — `https://www.unitvwebs.com` em WebView Android

**Data:** 2026-11-16  
**Branch:** `diagnostico/unitvwebs` (commit de build do APK: `34184e5`)  
**Status atual:** **Execução manual concluída no aparelho Android**  
**Conclusão delimitada:** **reprodução em WebView Android comprovada**.  
**Pendência:** **A compatibilidade com o player nativo continua pendente.**

---

## 1. Preservação do Projeto

- **Branch base preservada:** `main` permanece intacta em `63d7a81742e3d0fdcf303e7b59d052e91b0a0e60`.
- **Tag / Release preservados:** `v1.1.0` (`63d7a81`) e [version.json](../version.json) (`1.1.0`, `buildNumber: 2`) inalterados.
- **Pacote separado:** `com.personal.mediahub.diag` (`PMH Diag UniTV`), coexistindo no aparelho sem desinstalar `com.personal.mediahub` nem alterar dados ou assinatura de produção.
- **Workflow isolado na branch:** `.github/workflows/android-apk.yml` restrito a `workflow_dispatch`, `permissions: contents: read`, `EXPO_PUBLIC_UNITV_DIAGNOSTIC: '1'` e sem publicação de release.

---

## 2. Ambiente e Artefato Utilizados

| Componente | Detalhe Verificado |
|---|---|
| **Build CI (GitHub Actions)** | Run `43927983262` (`success`) — https://github.com/kelvynbonfim/personal-media-hub/actions/runs/43927983262 |
| **Artifact gerado** | `personal-media-hub-diag-unitv-34184e5dad361d2e4c93d63efe04803cedb0284b` |
| **APK local** | `release-apk/diagnostico-unitv/app-release.apk` (`77.666.087` bytes) |
| **Package ID / Nome no APK** | `com.personal.mediahub.diag` (`AndroidManifest.xml`) · `PMH Diag UniTV` (`resources.arsc`) |
| **Assinatura do APK** | APK Signature Scheme v2 (`0x7109871a`) válido (`rsaSignatureValid: true`, `apkContentDigestMatches: true`, `CN=Android Debug`) |
| **Bundle JS embutido** | `assets/index.android.bundle` (`1.940.884` bytes, Hermes bytecode, independente de Metro) |
| **WebView adotada** | `react-native-webview` `13.12.5` (sem scripts genéricos de auth/captura injetados) |
| **Execução real** | Aparelho Android físico do usuário (instalação manual do APK separado) |

---

## 3. Resultado de Cada Verificação (Execução Real no Aparelho)

| Verificação | Resultado | Evidência Observada |
|---|---|---|
| Abertura de `https://www.unitvwebs.com` em WebView visível | **PASSOU (`OK`)** | Portal carregou normalmente com JS e armazenamento habilitados |
| Autenticação e verificações manuais no aparelho | **PASSOU (`OK`)** | Passou por `/captcha` e login manual dentro da própria WebView |
| Seleção de **Naruto Temp. 1, Episódio 1** | **PASSOU (`OK`)** | Confirmado em `https://www.unitvwebs.com/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC` |
| Imagem e áudio ativos | **PASSOU (`OK`)** | Confirmado manualmente no aparelho |
| Avanço contínuo por ≥ 60 segundos | **PASSOU (`OK`)** | `63s` marcados no cronômetro auxiliar manual durante reprodução contínua |
| Pausa, retomada e busca (`seek`) | **PASSOU (`OK`)** | Controles de pausa, retomada e avanço/busca funcionaram |
| Permanência dentro do aplicativo | **PASSOU (`OK`)** | Nenhum redirecionamento externo para fora do app |
| Publicidade ou redirecionamentos observados | **NENHUM OBSERVADO** | Marcado `Nenhum observado`; nenhum `EXTERNAL_HOST` nem `BLOCKED_SCHEME` registrado |
| Erros de carregamento / HTTP | **NENHUM REGISTRADO** | Nenhum `HTTP_ERROR`, `LOAD_ERROR` ou `RENDER_CRASH` nos eventos sanitizados |
| Compatibilidade com player nativo (`react-native-video` / ExoPlayer) | **PENDENTE** | Fora do escopo desta primeira prova em WebView |

---

## 4. Evidências Reais Coletadas e Impacto para a Próxima Etapa

### Sequência real de navegação sanitizada observada no aparelho
1. `https://www.unitvwebs.com/captcha` (`[NAVIGATION] Página carregada`)
2. `https://www.unitvwebs.com/vod/uvweb_free/84911` (`[NAVIGATION] Página carregada`)
3. `https://www.unitvwebs.com/search/vod` (`[NAVIGATION] Página carregada`)
4. `https://www.unitvwebs.com/vod/details/0/DD045854FEB0BE6B0ABBD9ABF6A302CC` (`[NAVIGATION] Página carregada`)

### Achados técnicos relevantes antes de integrar na v1.1
- **Por que a ponte oculta da v1.1 falhava:**
  1. Em sessão nova na WebView Android, o portal apresentou `/captcha` antes do catálogo/login. Uma WebView oculta (`1x1`, `opacity: 0` em `RuntimeWebViewBridgeHost`) impede que o usuário veja ou conclua `/captcha`, e a heurística de ausência de `input[type="password"]` classificava a tela incorretamente como `AUTH_FAILED`.
  2. As rotas reais observadas no portal são `/captcha`, `/vod/uvweb_free/...`, `/search/vod` e `/vod/details/...` (e não `/login`, `/search?q=...` ou `/vod/{id}?ep=...` assumidos anteriormente).
- **O que está comprovado agora:** a `react-native-webview` `13.12.5` visível reproduz episódios completos de `https://www.unitvwebs.com` no Android com imagem, áudio, `seek`, pausa/retomada e sessão persistida sem publicidade nem saída do aplicativo.
- **O que continua pendente:** validar se o stream de `v-player` / `v-player_html5_api` pode ser extraído e reproduzido pelo player nativo (`ExoPlayer` via `react-native-video`) ou se a integração definitiva na v1.1 deve usar a WebView autenticada como fluxo principal (ou fallback imediato) para `unitvwebs.com`.

---

## 5. Arquivos Alterados / Criados na Branch `diagnostico/unitvwebs`

- `src/diagnostics/unitv-diagnostic.ts`
- `src/screens/UniTvDiagnosticScreen.tsx`
- `src/screens/discovery-helpers.ts`
- `src/navigation/RootNavigator.tsx`
- `src/screens/SettingsScreen.tsx`
- `app.config.ts`
- `tests/setup.ts`
- `tests/diagnostics/unitv-diagnostic.test.tsx`
- `.github/workflows/android-apk.yml` (adaptado apenas nesta branch para build diagnóstico sem publicação)
- `docs/diagnostico-unitvwebs-android.md`

---

## 6. Comandos e Verificações Executados

| Verificação | Resultado |
|---|---|
| `EXPO_PUBLIC_UNITV_DIAGNOSTIC=1` + `npx tsc --noEmit` (local e CI `43927983262`) | Exit `0` |
| `EXPO_PUBLIC_UNITV_DIAGNOSTIC=1` + `npx jest` (local e CI `43927983262`) | **11 suites passed, 118 tests passed** |
| `./gradlew assembleRelease` (CI `43927983262`) | Concluído com sucesso; APK verificado em `release-apk/diagnostico-unitv/app-release.apk` |
| Teste manual no aparelho (`PMH Diag UniTV`) | **63s** contínuos + imagem/áudio + pausa/retomada/seek + sem anúncios/redirects |
