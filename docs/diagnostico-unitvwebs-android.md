# Diagnóstico Técnico Delimitado — `https://www.unitvwebs.com` em WebView Android

**Data:** 2026-11-16  
**Status atual:** **Execução em aparelho Android PENDENTE (bloqueada por ausência de ADB / dispositivo ou emulador e toolchain Android local)**  
**Conclusão delimitada:** Ainda **não** é possível declarar *"reprodução em WebView Android comprovada"*. A tela de ensaio isolada foi implementada e validada via TypeScript e testes unitários; a execução manual real no aparelho Android e a compatibilidade com o player nativo permanecem pendentes.

---

## 1. Preservação do Projeto (Estado Git Inicial e Final)

- **Branch:** `main` (sincronizada com `origin/main` no início do trabalho)
- **Commit base:** `63d7a81742e3d0fdcf303e7b59d052e91b0a0e60` (`63d7a81` — `feat(updates): add automatic in-app update banner and GitHub Releases APK publishing (v1.1.0)`)
- **`git status` inicial:** `nothing to commit, working tree clean`
- **Restrições preservadas:**
  - Nenhum `git push`, tag ou release executado.
  - `version.json` mantido intacto (`1.1.0`, `buildNumber: 2`).
  - Fluxo normal de produção do aplicativo (`MainTabs`, `HomeTab`, `AnimeDetails`, `VideoPlayer`, `Settings`) mantido inalterado.
  - `release-apk/app-release.apk` (77.657.487 bytes) preservado sem alterações.

---

## 2. Ambiente Utilizado e Bloqueios Detectados

| Componente | Observado no Ambiente | Impacto |
|---|---|---|
| **Sistema operacional** | Windows | Host de desenvolvimento |
| **Node.js** | `v26.13.0` | OK para `tsc` e `jest` |
| **Stack do projeto** | `expo` `~52.0.49`, `react-native` `0.76.9`, `react-native-webview` `13.12.5`, `typescript` `~5.8.3` | OK |
| **ADB (`adb.exe`)** | **Não encontrado** (`where.exe adb` falhou; `%LOCALAPPDATA%\Android\Sdk` inexistente; `ANDROID_HOME` e `ANDROID_SDK_ROOT` vazios) | Bloqueia detecção de aparelho e instalação via ADB |
| **Aparelho / Emulador** | **Nenhum dispositivo Android/ADB/MTP conectado** (`Get-PnpDevice -PresentOnly` sem dispositivo Android; sem emulador nem WSL instalados). Apenas `PhoneExperienceHost` / `YourPhoneAppProxyHost` (Vincular ao Celular) em execução | Vincular ao Celular não comprova conexão ADB; impossível instalar/executar no aparelho a partir desta máquina |
| **Java / JDK** | Apenas Oracle JRE `1.8.0_511` (`C:\Program Files\Java\jre1.8.0_511`); **sem JDK 17** | Gradle Android (Expo SDK 52 / RN 0.76) exige JDK 17 |
| **Projeto nativo `android/`** | Inexistente no workspace (`android/` está no `.gitignore` e é gerado via `expo prebuild` no CI) | Compilação local de APK não executável sem JDK 17 + Android SDK |
| **EAS / Expo CLI global** | `where.exe eas` e `where.exe expo` não encontrados globalmente | Sem CLI global instalada |

**Caminho do APK de diagnóstico:** **Não gerado.** Não há JDK 17 nem Android SDK/build-tools instalados localmente, e disparo de build via `push` em `main` é proibido para não publicar APK em produção.

---

## 3. O Que Foi Preparado (Ensaio Isolado)

1. **Módulo de configuração, sanitização e avaliação (`src/diagnostics/unitv-diagnostic.ts`):**
   - Define `UNITV_DIAGNOSTIC_PORTAL_URL = 'https://www.unitvwebs.com'` e `UNITV_DIAGNOSTIC_PACKAGE_ID = 'com.personal.mediahub.diag'`.
   - `isUniTvDiagnosticAvailable()` libera o acesso apenas em `__DEV__` ou quando `EXPO_PUBLIC_UNITV_DIAGNOSTIC === '1'` (oculto em builds normais de produção).
   - `sanitizeDiagnosticUrl()` remove query strings, fragmentos `#` e credenciais (`user:pass@`), e redige esquemas não-HTTP(S) como `<scheme>://[redacted]`.
   - `classifyWebViewNavigationTarget()` permite navegação `http(s)` dentro da WebView (registrando acessos top-frame fora de `unitvwebs.com` como `EXTERNAL_HOST`) e bloqueia esquemas externos (`intent://`, `market://`, `unitv://`, etc.) como `BLOCKED_SCHEME`.
   - `evaluateDiagnosticConclusion()` só retorna `'reprodução em WebView Android comprovada'` quando todas as etapas manuais obrigatórias forem marcadas como `OK` **e** `adOrRedirectObserved` for `'NONE'`. Se qualquer etapa obrigatória for `false` ou `adOrRedirectObserved` for `'OBSERVED'`, retorna `FAILED`; se a observação de publicidade estiver indefinida (`null`), mantém `PENDING`. O cronômetro auxiliar manual é explicitamente rotulado como ferramenta de apoio que não comprova reprodução automaticamente.

2. **Tela de diagnóstico visível (`src/screens/UniTvDiagnosticScreen.tsx`):**
   - Usa `react-native-webview` (`13.12.5`) já adotada pelo projeto.
   - Abre diretamente `https://www.unitvwebs.com` em WebView visível (`flex: 1`, `minHeight: 320`), com `javaScriptEnabled={true}`, `domStorageEnabled={true}`, `thirdPartyCookiesEnabled={true}`, `allowsFullscreenVideo={true}`, `mediaPlaybackRequiresUserAction={false}`, `setSupportMultipleWindows={false}` e `javaScriptCanOpenWindowsAutomatically={false}`.
   - **Sem injeção de scripts genéricos:** `injectedJavaScript`, `injectedJavaScriptBeforeContentLoaded`, `injectedJavaScriptObject` e `onMessage` não são utilizados.
   - **Sem suposições de rotas ou auth:** não navega para `/login`, `/search` ou `/vod/{id}`, não copia cookies/credenciais do Chrome, não registra dados de autenticação e não trata ausência de campo de senha ou HTTP 200 como login/reprodução concluídos.
   - Inclui painel recolhível com cronômetro auxiliar de 60 segundos e checklist manual para o usuário registrar imagem/áudio, avanço contínuo ≥ 60s, pausa/retomada/seek, permanência no app e publicidade/redirecionamentos, além de log sanitizado de navegação, erros HTTP (`onHttpError`), erros de carregamento (`onError`) e queda de renderer (`onRenderProcessGone`).

3. **Isolamento de pacote e navegação (`app.config.ts`, `src/navigation/RootNavigator.tsx`, `src/screens/SettingsScreen.tsx`):**
   - `app.config.ts`: mantém `Personal Media Hub` / `com.personal.mediahub` por padrão; somente quando `EXPO_PUBLIC_UNITV_DIAGNOSTIC=1` altera para `PMH Diag UniTV` / `com.personal.mediahub.diag` para coexistir lado a lado com o APK instalado sem desinstalá-lo, limpar seus dados ou alterar sua assinatura de produção.
   - `RootNavigator.tsx`: registra a rota `UniTvDiagnostic` somente quando `isUniTvDiagnosticAvailable()` é verdadeiro e mantém `MainTabs` como rota inicial padrão (abrindo direto em `UniTvDiagnostic` apenas no build dedicado `EXPO_PUBLIC_UNITV_DIAGNOSTIC=1`).
   - `SettingsScreen.tsx`: exibe o card `"Diagnóstico UniTV (Dev)"` somente quando `isUniTvDiagnosticAvailable()` é verdadeiro.

---

## 4. Resultado de Cada Verificação

| Verificação | Status | Evidência / Observação |
|---|---|---|
| Preservação de branch, commit, `version.json` e fluxo normal | **CONCLUÍDA** | Branch `main`, commit `63d7a81`, sem `push`/tag/release, `version.json` intacto |
| Consulta prévia a `C:\Users\Kekel\Documents\Templates\AGENTS.md` | **CONCLUÍDA** | Consultados `AGENTS.md`, `REGRAS.md`, `GUIA-DE-DECISAO.md`, índices e fichas (`plausible-io`, `modulify-sales-crm`) |
| Verificação de aparelho / emulador via ADB | **BLOQUEADA (SEM ADB/DISPOSITIVO)** | Sem `adb`, sem Android SDK, sem emulador; apenas Vincular ao Celular ativo no Windows |
| Tela de diagnóstico isolada em dev e sem scripts genéricos | **VALIDADA EM TESTE UNITÁRIO** | `npx tsc --noEmit` (exit 0) e `tests/diagnostics/unitv-diagnostic.test.tsx` (7/7 testes passando) |
| Coexistência por pacote separado (`com.personal.mediahub.diag`) | **VALIDADA EM CONFIGURAÇÃO** | Verificado em `app.config.ts` e teste unitário; APK não compilado localmente |
| Abertura real de `https://www.unitvwebs.com` + autenticação manual no Android | **PENDENTE** | Aguarda aparelho/emulador via ADB ou build em máquina com JDK 17 + Android SDK |
| Confirmação de Naruto Temp. 1, Episódio 1 no portal | **PENDENTE** | Execução manual no aparelho ainda não realizada |
| Imagem e áudio reais na WebView Android | **PENDENTE** | Sem execução em aparelho real |
| Avanço contínuo por ≥ 60 segundos | **PENDENTE** | Sem execução em aparelho real |
| Pausa, retomada e busca (seek) | **PENDENTE** | Sem execução em aparelho real |
| Permanência no app, publicidade/redirecionamentos e erros HTTP reais | **PENDENTE** | Sem execução em aparelho real |
| Compatibilidade com player nativo (`react-native-video` / ExoPlayer) | **PENDENTE** | Fora do escopo desta primeira prova e ainda não avaliada após WebView |

---

## 5. Arquivos Alterados e Criados

- **Criados:**
  - `src/diagnostics/unitv-diagnostic.ts`
  - `src/screens/UniTvDiagnosticScreen.tsx`
  - `tests/diagnostics/unitv-diagnostic.test.tsx`
  - `docs/diagnostico-unitvwebs-android.md`
- **Alterados:**
  - `app.config.ts`
  - `src/navigation/RootNavigator.tsx`
  - `src/screens/SettingsScreen.tsx`

---

## 6. Comandos Executados

| Comando | Resultado |
|---|---|
| `git status; git branch --show-current; git log -n 5 --oneline` | Branch `main`, commit `63d7a81`, working tree limpo no início |
| `adb devices -l; where.exe adb` | Falha (`adb` não reconhecido / ausente no sistema) |
| Verificação de diretórios Android SDK / JDK / WSL / PnP (`Get-PnpDevice`, `java -version`, `wsl --list --quiet`, `where.exe eas`, `where.exe expo`) | Sem Android SDK, sem emulador, sem WSL, apenas Oracle JRE `1.8.0_511`, sem dispositivo Android/ADB conectado |
| `npx tsc --noEmit` (após edição final) | Exit code `0` (sem erros de TypeScript) |
| `npx jest` (suíte completa após edição final) | **11 suites passed, 118 tests passed** (incluindo 7 testes em `tests/diagnostics/unitv-diagnostic.test.tsx`) |

---

## 7. Próximos Passos para Concluir a Prova no Aparelho

1. Conectar um aparelho Android com **Depuração USB (ADB)** ativada (ou emulador) e instalar Android SDK `platform-tools` + JDK 17 caso vá gerar o APK localmente (ou usar Metro dev server com um dev client já compatível com `react-native-webview` `13.12.5`).
2. Para gerar APK diagnóstico coexistente sem alterar `com.personal.mediahub` nem a assinatura de produção:
   - Executar `EXPO_PUBLIC_UNITV_DIAGNOSTIC=1 npx expo prebuild --platform android` e `./gradlew assembleDebug` (ou `assembleRelease` com keystore de debug/separado) em ambiente com JDK 17 + Android SDK, gerando o pacote `com.personal.mediahub.diag`.
3. Abrir a tela de diagnóstico, autenticar manualmente em `https://www.unitvwebs.com`, navegar até **Naruto Temp. 1 · Episódio 1** e preencher o checklist real (60s contínuos, imagem/áudio, pausa/retomada/seek, redirecionamentos e erros HTTP sanitizados) antes de decidir qualquer integração definitiva.
