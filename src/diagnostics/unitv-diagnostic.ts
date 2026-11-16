export const UNITV_DIAGNOSTIC_PORTAL_URL = 'https://www.unitvwebs.com';
export const UNITV_DIAGNOSTIC_PACKAGE_ID = 'com.personal.mediahub.diag';

export type DiagnosticCheckValue = boolean | null;
export type AdObservationValue = 'NONE' | 'OBSERVED' | null;

export interface UniTvDiagnosticChecks {
  portalOpenedAndManualAuth: DiagnosticCheckValue;
  episodeSelectedConfirmed: DiagnosticCheckValue;
  videoAndAudioActive: DiagnosticCheckValue;
  continuous60sPlayback: DiagnosticCheckValue;
  pauseResumeAndSeekOk: DiagnosticCheckValue;
  stayedInsideApp: DiagnosticCheckValue;
  adOrRedirectObserved: AdObservationValue;
}

export type DiagnosticEventKind =
  | 'NAVIGATION'
  | 'EXTERNAL_HOST'
  | 'BLOCKED_SCHEME'
  | 'HTTP_ERROR'
  | 'LOAD_ERROR'
  | 'RENDER_CRASH';

export interface UniTvDiagnosticEvent {
  id: string;
  timestampIso: string;
  kind: DiagnosticEventKind;
  sanitizedUrl: string;
  detail: string;
}

export interface DiagnosticConclusion {
  status: 'PENDING' | 'PROVEN' | 'FAILED';
  statement: string;
  nativePlayerPending: string;
}

export interface NavigationClassification {
  allowInWebView: boolean;
  kind: 'PORTAL' | 'EXTERNAL_HOST' | 'BLOCKED_SCHEME';
  sanitizedUrl: string;
  host: string | null;
}

const REQUIRED_CHECK_KEYS: ReadonlyArray<
  Exclude<keyof UniTvDiagnosticChecks, 'adOrRedirectObserved'>
> = [
  'portalOpenedAndManualAuth',
  'episodeSelectedConfirmed',
  'videoAndAudioActive',
  'continuous60sPlayback',
  'pauseResumeAndSeekOk',
  'stayedInsideApp',
];

export const NATIVE_PLAYER_PENDING_NOTE =
  'A compatibilidade com o player nativo continua pendente.';

/**
 * Returns true when running in development mode or an isolated diagnostic APK build.
 */
export function isUniTvDiagnosticAvailable(): boolean {
  if (process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC === '1') {
    return true;
  }
  return typeof __DEV__ !== 'undefined' && Boolean(__DEV__);
}

/**
 * Returns true only for dedicated diagnostic builds that use the separate package ID.
 */
export function isStandaloneUniTvDiagnosticMode(): boolean {
  return process.env.EXPO_PUBLIC_UNITV_DIAGNOSTIC === '1';
}

export function createInitialDiagnosticChecks(): UniTvDiagnosticChecks {
  return {
    portalOpenedAndManualAuth: null,
    episodeSelectedConfirmed: null,
    videoAndAudioActive: null,
    continuous60sPlayback: null,
    pauseResumeAndSeekOk: null,
    stayedInsideApp: null,
    adOrRedirectObserved: null,
  };
}

/**
 * Strips query parameters, hashes, and userinfo so tokens/credentials are never logged.
 */
export function sanitizeDiagnosticUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return '[empty-url]';
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/i.exec(trimmed);
  if (!schemeMatch) {
    return '[relative-or-invalid-url]';
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return `${scheme}://[redacted]`;
  }

  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname || '/';
    return `${parsed.origin}${pathname}`;
  } catch {
    return `${scheme}://[invalid-url]`;
  }
}

function isPortalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'unitvwebs.com' || normalized.endsWith('.unitvwebs.com');
}

/**
 * Allows http/https inside the WebView while blocking external app schemes and flagging off-domain hosts.
 */
export function classifyWebViewNavigationTarget(
  rawUrl: string
): NavigationClassification {
  const sanitizedUrl = sanitizeDiagnosticUrl(rawUrl);
  if (!/^https?:\/\//i.test(rawUrl.trim())) {
    return {
      allowInWebView: false,
      kind: 'BLOCKED_SCHEME',
      sanitizedUrl,
      host: null,
    };
  }

  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    return {
      allowInWebView: true,
      kind: isPortalHostname(host) ? 'PORTAL' : 'EXTERNAL_HOST',
      sanitizedUrl,
      host,
    };
  } catch {
    return {
      allowInWebView: false,
      kind: 'BLOCKED_SCHEME',
      sanitizedUrl,
      host: null,
    };
  }
}

export function evaluateDiagnosticConclusion(
  checks: UniTvDiagnosticChecks
): DiagnosticConclusion {
  const hasRequiredFailure = REQUIRED_CHECK_KEYS.some(
    (key) => checks[key] === false
  );
  const hasObservedAdOrRedirect = checks.adOrRedirectObserved === 'OBSERVED';

  if (hasRequiredFailure || hasObservedAdOrRedirect) {
    return {
      status: 'FAILED',
      statement: hasObservedAdOrRedirect
        ? 'Falha registrada: publicidade ou redirecionamento observado neste ensaio.'
        : 'Falha registrada na prova técnica em WebView Android; revise a etapa marcada como falha.',
      nativePlayerPending: NATIVE_PLAYER_PENDING_NOTE,
    };
  }

  const allPassed =
    REQUIRED_CHECK_KEYS.every((key) => checks[key] === true) &&
    checks.adOrRedirectObserved === 'NONE';
  if (allPassed) {
    return {
      status: 'PROVEN',
      statement: 'reprodução em WebView Android comprovada',
      nativePlayerPending: NATIVE_PLAYER_PENDING_NOTE,
    };
  }

  return {
    status: 'PENDING',
    statement:
      'Verificação manual em andamento; conclua todos os itens no aparelho antes de concluir.',
    nativePlayerPending: NATIVE_PLAYER_PENDING_NOTE,
  };
}

function formatCheckLabel(value: DiagnosticCheckValue): string {
  if (value === true) {
    return 'OK';
  }
  if (value === false) {
    return 'FALHOU';
  }
  return 'PENDENTE';
}

/**
 * Formats a credential-free diagnostic summary suitable for documentation review.
 */
export function formatSanitizedDiagnosticReport(params: {
  checks: UniTvDiagnosticChecks;
  elapsedSeconds: number;
  currentSanitizedUrl: string;
  events: UniTvDiagnosticEvent[];
}): string {
  const conclusion = evaluateDiagnosticConclusion(params.checks);
  const adStatus =
    params.checks.adOrRedirectObserved === 'NONE'
      ? 'Nenhum observado'
      : params.checks.adOrRedirectObserved === 'OBSERVED'
        ? 'Anúncio ou redirecionamento observado'
        : 'PENDENTE';

  const lines = [
    `Portal alvo: ${UNITV_DIAGNOSTIC_PORTAL_URL}`,
    `URL atual (sanitizada): ${params.currentSanitizedUrl}`,
    `Cronômetro auxiliar manual (não comprova reprodução): ${params.elapsedSeconds}s`,
    `Conclusão: ${conclusion.statement}`,
    `Pendência: ${conclusion.nativePlayerPending}`,
    '',
    'Checklist manual:',
    `- Portal + login manual: ${formatCheckLabel(params.checks.portalOpenedAndManualAuth)}`,
    `- Naruto Temp. 1 Ep. 1 selecionado: ${formatCheckLabel(params.checks.episodeSelectedConfirmed)}`,
    `- Imagem e áudio ativos: ${formatCheckLabel(params.checks.videoAndAudioActive)}`,
    `- Avanço contínuo >= 60s: ${formatCheckLabel(params.checks.continuous60sPlayback)}`,
    `- Pausa, retomada e busca (seek): ${formatCheckLabel(params.checks.pauseResumeAndSeekOk)}`,
    `- Permaneceu no app: ${formatCheckLabel(params.checks.stayedInsideApp)}`,
    `- Publicidade/redirecionamentos: ${adStatus}`,
  ];

  if (params.events.length > 0) {
    lines.push('', 'Eventos sanitizados:');
    for (const event of params.events.slice(-15)) {
      lines.push(`- [${event.kind}] ${event.sanitizedUrl} (${event.detail})`);
    }
  }

  return lines.join('\n');
}
