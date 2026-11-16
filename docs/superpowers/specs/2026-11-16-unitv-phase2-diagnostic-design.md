# Design Curto — Diagnóstico Fase 2: Busca, Episódios e Player Nativo UniTV (`diagnostico/unitvwebs`)

**Data:** 2026-11-16  
**Branch alvo:** `diagnostico/unitvwebs` (pacote separado `com.personal.mediahub.diag` / `PMH Diag UniTV`)  
**Tamanho:** Mudança pequena (extensão do `UniTvDiagnosticScreen` já existente)

---

## 1. Intenção e Por Quê
Confirmamos no aparelho que `https://www.unitvwebs.com` reproduz episódios na `react-native-webview` após `/captcha` e login manual. Antes de publicar a `v1.2.0` definitiva na `main` (com UniTV exclusivo e interface própria), precisamos capturar três fatos reais da sessão autenticada para não chutar seletores nem quebrar o player no canal de atualização automática:
1. Estrutura DOM sanitizada da busca (`/search/vod`) e dos resultados.
2. Estrutura DOM sanitizada de seleção de temporada/episódio em `/vod/details/...`.
3. Se `v-player` / `v-player_html5_api` expõe uma URL de mídia (`.m3u8`/`.mp4` ou manifest) que o player nativo (`ExoPlayer` via `react-native-video`) reproduz diretamente no Android.

## 2. Objetivos, Não-Objetivos e Anti-Objetivos
- **Objetivos:**
  - Manter a tela `UniTvDiagnosticScreen` existente (sem criar segunda tela), estendendo o painel de verificações com inspeção sob demanda acionada pelo usuário **somente após** `/captcha` e login manual.
  - Capturar estrutura DOM sanitizada (tags, ids, classes, placeholders, atributos `href` apenas como caminho sem query/hash, textos curtos de UI e propriedades do `<video id="v-player_html5_api">`).
  - Armar captura opcional de requisições de mídia (`fetch` / `XMLHttpRequest` / `video.src` / `MediaSource`) pós-login para detectar o formato real do stream e testar reprodução direta em um bloco `<Video>` (`ExoPlayer`) visível dentro do próprio painel diagnóstico.
  - Permitir copiar/compartilhar o resumo sanitizado pelo celular (`Share`) além da visualização selecionável na tela.
- **Não-objetivos:**
  - Não modificar `main`, `version.json`, a release `v1.1.0`, nem implementar ainda a integração definitiva na v1.2.
  - Não contornar `/captcha`, não copiar cookies/credenciais do Chrome e não injetar scripts automaticamente antes do login manual.
- **Anti-objetivos:**
  - Nunca registrar senhas, valores digitados em inputs, `document.cookie`, headers `Cookie`/`Authorization` ou query strings/tokens de URLs no relatório ou logs exibidos na tela.

## 3. Restrições
- Preservar `com.personal.mediahub.diag` (`EXPO_PUBLIC_UNITV_DIAGNOSTIC=1`), build somente via `workflow_dispatch` sem publicação de release, seguindo os tokens visuais atuais (`THEME_TOKENS`) e controles ≥ 44 px.
- Não usar HTTP 200 ou eventos simulados como prova do `ExoPlayer`: exigir `onLoad` (duração/resolução reais), avanço de `onProgress` e confirmação manual de imagem/áudio no teste nativo.

## 4. Abordagens Avaliadas
- **Abordagem A (Escolhida):** Estender `UniTvDiagnosticScreen` na branch `diagnostico/unitvwebs` para capturar DOM de `/search/vod` e `/vod/details/...` + testar stream no `<Video>` nativo (`ExoPlayer`), gerando mais 1 APK diagnóstico via Actions antes de atualizar a `main` para `v1.2.0`.
- **Abordagem B (Descartada):** Publicar `v1.2.0` direto na `main` supondo seletores de busca/episódio e tentando ExoPlayer às cegas (risco alto de quebrar a atualização automática).
- **Abordagem C (Reserva caso ExoPlayer falhe):** Controlar `<video id="v-player_html5_api">` via UI própria sobre WebView limpa na `v1.2.0` — decisão que sairá diretamente do resultado deste diagnóstico.

## 5. Como Funciona na Tela (Decisões Fixadas)
1. **Fluxo inicial preservado:** A WebView continua abrindo `https://www.unitvwebs.com` limpa e visível, **sem** injeção prévia durante `/captcha` e login.
2. **Ações manuais no painel `Verificações` (após login):**
   - `Capturar DOM Atual`: injeta inspeção pontual somente leitura (`inspectDomOnce`) e adiciona ao resumo sanitizado os seletores estruturais (inputs de busca, links/cards de resultado, lista de episódios e estado do `v-player`).
   - `Armar Captura de Stream`: ativa listener de rede/mídia (`fetch`, `XHR`, `video.currentSrc`, `MediaSource`) apenas quando o usuário tocar no botão antes de dar Play; registra domínio+extensão/MIME sanitizados e guarda o último candidato de stream **apenas em memória** para o teste do ExoPlayer.
   - `Testar no ExoPlayer`: monta um `<Video>` (`react-native-video`) visível no painel usando o candidato capturado em memória (com `Referer`/`User-Agent`), exibe eventos reais (`onLoad` com dimensões/faixas, `onProgress`, `onError` sanitizado) e botões manuais `ExoPlayer OK` / `ExoPlayer Falhou`.
   - `Compartilhar Resumo`: aciona `Share.share` com o texto sanitizado completo (e `<Text selectable>` para cópia manual).

## 6. Escopo de Planejamento e Testes
- Módulo puro para sanitização de snapshots DOM, eventos de captura de stream (sem vazar tokens/cookies) e conclusão de compatibilidade ExoPlayer.
- Testes Jest cobrindo sanitização de inputs/URLs/cookies, ausência de injeção automática no boot da WebView, disparo manual de captura DOM/stream e estados `onLoad` / `onError` do teste ExoPlayer, além de `npx tsc --noEmit` e novo build diagnóstico via `workflow_dispatch`.
