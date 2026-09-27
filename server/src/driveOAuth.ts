import { redis } from './redis.js';
import { decryptSecret, encryptSecret } from './secretBox.js';
import {
  GOOGLE_AUTH,
  GOOGLE_REVOKE,
  PENDING_TTL_SEC,
  clientId,
  clientSecret,
  exchangeToken,
  expiraEmMs,
  isInvalidGrant,
  isTemporaryError,
  newState,
  oauthConfigured,
  pkce,
  redirectUriDe,
  type AuthFailure,
} from './googleOAuth.js';

/**
 * Google Drive: conectar a conta, autorizar a leitura dos arquivos escolhidos
 * explicitamente pela pessoa no Google Picker, e compartilhar o escolhido com
 * quem mais está na sala.
 *
 * ## Como o vídeo chega a cada participante
 *
 * **Não passa pelo nosso servidor.** Quem assiste baixa direto do Google, com
 * o token da própria conta, por um service worker que injeta o cabeçalho
 * `Authorization` na requisição do `<video>` — assim `Range` e seek funcionam
 * de verdade, e o Render não vê byte de vídeo. O R2 também não entra: o
 * caminho do Drive nunca grava cópia no bucket.
 *
 * ## O que o Drive exige de cada pessoa
 *
 * O escopo `drive.file` só dá acesso a arquivo que a pessoa escolheu no
 * Picker. Conceder `reader` no arquivo **não** é suficiente: quem não o escolheu
 * recebe 404. Por isso cada participante confirma o arquivo uma vez, e o Picker
 * é aberto já filtrado só para ele, com `setFileIds`. É o preço de manter um
 * escopo não sensível, que dispensa a avaliação de segurança anual.
 *
 * ## O `userinfo.email`, e por que ele é necessário
 *
 * `permissions.create` exige um e-mail, e nem `drive.file` nem `about.get` o
 * devolvem. `userinfo.email` é o escopo mínimo para isso, e é não sensível: a
 * tela de consentimento mostra "seu endereço de e-mail", e nada mais.
 */
const SCOPE = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

/**
 * O que aceitamos voltar do Google. O ponto é rejeitar os escopos amplos: uma
 * autorização antiga, vinda de quando o projeto usava `drive.readonly`, não
 * pode voltar a valer, e o `userinfo.email` é o único acréscimo aceito.
 */
const PERMITIDOS = new Set([SCOPE.split(' ')[0], SCOPE.split(' ')[1]]);
const LEGACY_WIDE_SCOPES = new Set([
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
]);
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const TOKEN_KEY = (sessionId: string) => `drive:tokens:${sessionId}`;
const PENDING_KEY = (state: string) => `drive:oauth:${state}`;
const PICKER_KEY = (sessionId: string, requestId: string) => `drive:picker:${sessionId}:${requestId}`;
const REFRESH_LOCK = (sessionId: string) => `drive:refreshlock:${sessionId}`;
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

export type DrivePickerResult =
  | { status: 'pending' }
  | { status: 'picked'; fileId: string }
  | { status: 'cancelled' }
  | { status: 'error' };

type PickerRequest = {
  oauthState: string;
  result: DrivePickerResult;
};

export type DrivePublicStatus = {
  configured: boolean;
  connected: boolean;
};

type TokenRecord = {
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  scope: string;
  /**necessário para compartilhar o arquivo com os demais. Vazio se o Google não disser. */
  email: string;
  connectedAt: number;
  generation: number;
};

type PendingOAuth = {
  sessionId: string;
  codeVerifier: string;
  returnTo: string;
  /** Mesma ideia do YouTube: o desktop pede a tela de conclusão do servidor. */
  voltarComo: 'app' | 'pagina';
  /** Pedido de seleção, vinculado à sessão que abriu o navegador do sistema. */
  pickerId?: string;
};

export function driveOAuthConfigured(): boolean {
  return oauthConfigured();
}

export function redirectUri(): string {
  return redirectUriDe('drive');
}

async function saveTokens(
  sessionId: string,
  record: TokenRecord,
  expectedGeneration?: number,
): Promise<void> {
  if (expectedGeneration !== undefined) {
    const current = await loadTokens(sessionId);
    if (!current || current.generation !== expectedGeneration) {
      throw new Error('generation_mismatch');
    }
  }
  await redis.set(TOKEN_KEY(sessionId), encryptSecret(JSON.stringify(record)), 'EX', TOKEN_TTL_SEC);
}

async function loadTokens(sessionId: string): Promise<TokenRecord | null> {
  const raw = await redis.get(TOKEN_KEY(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decryptSecret(raw));
    if (
      !parsed.refreshToken ||
      !parsed.accessToken ||
      typeof parsed.accessExpiresAt !== 'number' ||
      typeof parsed.connectedAt !== 'number' ||
      typeof parsed.generation !== 'number'
    ) {
      await redis.del(TOKEN_KEY(sessionId));
      return null;
    }
    // `email` passou a existir depois do primeiro deploy; um registro antigo sem
    // ele continua válido, só não pode compartilhar.
    return { ...(parsed as TokenRecord), email: parsed.email ?? '' };
  } catch {
    await redis.del(TOKEN_KEY(sessionId));
    return null;
  }
}

export async function deleteTokens(sessionId: string): Promise<void> {
  await redis.del(TOKEN_KEY(sessionId));
}

export async function getPublicStatus(sessionId: string | null): Promise<DrivePublicStatus> {
  const configured = driveOAuthConfigured();
  if (!configured || !sessionId) return { configured, connected: false };
  const record = await loadTokens(sessionId);
  if (!record) return { configured, connected: false };
  if (!hasLimitedDriveScope(record.scope)) {
    // Tokens criados antes do Picker podiam ler o Drive inteiro. Revoga-os e
    // pede que a pessoa reconecte para receber apenas drive.file.
    await revokeAndDelete(sessionId);
    return { configured, connected: false };
  }
  return { configured, connected: true };
}

function hasLimitedDriveScope(scope: string | undefined): boolean {
  if (!scope) return false;
  const scopes = scope.split(/\s+/).filter(Boolean);
  return (
    scopes.includes('https://www.googleapis.com/auth/drive.file') &&
    scopes.every((item) => PERMITIDOS.has(item)) &&
    !scopes.some((item) => LEGACY_WIDE_SCOPES.has(item))
  );
}

export async function createAuthUrl(
  sessionId: string,
  returnTo: string,
  voltarComo: PendingOAuth['voltarComo'] = 'app',
  pickerId?: string,
): Promise<string | null> {
  if (!driveOAuthConfigured()) return null;
  const existing = await loadTokens(sessionId);
  if (existing && !hasLimitedDriveScope(existing.scope)) {
    await revokeAndDelete(sessionId);
  }
  const { verifier, challenge } = pkce();
  const state = newState();
  const pending: PendingOAuth = { sessionId, codeVerifier: verifier, returnTo, voltarComo, pickerId };
  await redis.set(PENDING_KEY(state), JSON.stringify(pending), 'EX', PENDING_TTL_SEC);
  if (pickerId) {
    const request: PickerRequest = { oauthState: state, result: { status: 'pending' } };
    await redis.set(PICKER_KEY(sessionId, pickerId), JSON.stringify(request), 'EX', PENDING_TTL_SEC);
  }

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  // `consent` é necessário para obter um refresh token no fluxo do servidor.
  url.searchParams.set('prompt', 'consent');
  // O Picker externo aceita somente drive.file, sem agregar escopos anteriores.
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (pickerId) {
    url.searchParams.set('trigger_onepick', 'true');
    url.searchParams.set('allow_multiple', 'false');
    url.searchParams.set('mimetypes', [
      'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
      'video/x-msvideo', 'video/mpeg', 'video/ogg', 'video/3gpp', 'video/x-ms-wmv',
    ].join(','));
  }
  return url.toString();
}

export async function createPickerRequest(sessionId: string, returnTo: string): Promise<{
  url: string;
  requestId: string;
  expiresAt: number;
} | null> {
  const requestId = newState();
  const url = await createAuthUrl(sessionId, returnTo, 'pagina', requestId);
  if (!url) return null;
  return { url, requestId, expiresAt: Date.now() + PENDING_TTL_SEC * 1000 };
}

async function loadPickerRequest(sessionId: string, requestId: string): Promise<PickerRequest | null> {
  if (!/^[a-z0-9]{32}$/.test(requestId)) return null;
  const raw = await redis.get(PICKER_KEY(sessionId, requestId));
  return raw ? JSON.parse(raw) as PickerRequest : null;
}

export async function getPickerResult(sessionId: string, requestId: string): Promise<DrivePickerResult | null> {
  return (await loadPickerRequest(sessionId, requestId))?.result ?? null;
}

export async function finishPickerRequest(
  sessionId: string,
  requestId: string,
  result: Exclude<DrivePickerResult, { status: 'pending' }>,
): Promise<boolean> {
  const request = await loadPickerRequest(sessionId, requestId);
  if (!request || request.result.status !== 'pending') return false;
  // XX evita ressuscitar uma seleção cancelada enquanto a troca do código
  // OAuth estava em andamento. O resultado pode ser relido após falha de rede.
  const saved = await redis.set(
    PICKER_KEY(sessionId, requestId), JSON.stringify({ ...request, result }),
    'EX', PENDING_TTL_SEC, 'XX',
  );
  return saved === 'OK';
}

export async function cancelPickerRequest(sessionId: string, requestId: string): Promise<void> {
  const request = await loadPickerRequest(sessionId, requestId);
  if (!request) return;
  await redis.del(PICKER_KEY(sessionId, requestId), PENDING_KEY(request.oauthState));
}

export async function takePending(state: string): Promise<PendingOAuth | null> {
  if (!/^[a-z0-9]{32}$/.test(state)) return null;
  const raw = await redis.getdel(PENDING_KEY(state));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingOAuth;
    if (!parsed.sessionId || !parsed.codeVerifier || !parsed.returnTo) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * O e-mail da conta conectada.
 *
 * É o identificador que o `permissions.create` exige, e é a única forma de o
 * Juntos compartilhar o arquivo escolhido com quem está na sala. Uma chamada
 * só, no momento da conexão — nunca durante a reprodução, que é a hora em que
 * um erro custaria a todo mundo.
 */
async function fetchEmail(accessToken: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return '';
    const data = (await response.json()) as { email?: string; email_verified?: boolean };
    // Sem verificação de domínio o Google não confirma a caixa; ainda assim é
    // o único identificador que temos, e quem usa é o dono da conta.
    return typeof data.email === 'string' && data.email.includes('@') ? data.email : '';
  } catch {
    clearTimeout(timeout);
    return '';
  }
}

/** O e-mail guardado, para o módulo de compartilhamento. */
export async function emailDaSessao(sessionId: string): Promise<string | null> {
  const record = await loadTokens(sessionId);
  if (!record) return null;
  return record.email || null;
}

export async function completeOAuth(params: {
  sessionId: string;
  code: string;
  codeVerifier: string;
}): Promise<{ ok: true } | { ok: false; reason: AuthFailure }> {
  const token = await exchangeToken({
    client_id: clientId(),
    client_secret: clientSecret(),
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
  });

  if (token.error || !token.access_token) {
    const err = token.error ?? 'token_error';
    if (err === 'access_denied') return { ok: false, reason: 'denied' };
    if (isTemporaryError(err, token._httpStatus)) {
      console.error('[drive-oauth] erro temporário na troca de código:', err);
      return { ok: false, reason: 'api_error' };
    }
    console.error('[drive-oauth] troca de código recusada:', err);
    return { ok: false, reason: 'api_error' };
  }

  const grantedScope = token.scope ?? SCOPE;
  if (!hasLimitedDriveScope(grantedScope)) {
    console.error('[drive-oauth] token retornado com escopo além de drive.file');
    await revokeGoogleToken(token.refresh_token || token.access_token);
    return { ok: false, reason: 'api_error' };
  }

  const existing = await loadTokens(params.sessionId);
  const refreshToken = token.refresh_token || existing?.refreshToken;
  if (!refreshToken) {
    console.error('[drive-oauth] Google não devolveu refresh token');
    return { ok: false, reason: 'api_error' };
  }

  const email = await fetchEmail(token.access_token);

  await saveTokens(params.sessionId, {
    refreshToken,
    accessToken: token.access_token,
    accessExpiresAt: Date.now() + expiraEmMs(token.expires_in),
    scope: grantedScope,
    email: email || existing?.email || '',
    connectedAt: existing?.connectedAt ?? Date.now(),
    generation: (existing?.generation ?? 0) + 1,
  });
  return { ok: true };
}

/**
 * Renova o access token, preservando o motivo da falha.
 *
 * Antes isto devolvia só `TokenRecord | null`, e o chamador tinha de inventar um
 * motivo a partir da ausência. Isso jogava fora a única informação que
 * interessa: o Google já havia dito *por que* recusou, e a diferença entre "a
 * conta morreu" e "o Google está having a bad day" é justamente o que decide se
 * a pessoa reconecta ou espera cinco segundos.
 */
async function refreshAccessToken(
  sessionId: string,
  record: TokenRecord,
): Promise<{ record: TokenRecord } | { reason: AuthFailure }> {
  const lockKey = REFRESH_LOCK(sessionId);
  const lockOwner = `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const locked = await redis.set(lockKey, lockOwner, 'EX', 30, 'NX');
  if (!locked) {
    // Outra renovação está em curso: esperar e ler o resultado dela evita duas
    // chamadas ao Google para o mesmo token.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const current = await loadTokens(sessionId);
      if (current && current.accessExpiresAt > Date.now() + 15_000) return { record: current };
    }
    const atual = await loadTokens(sessionId);
    return atual ? { record: atual } : { reason: 'not_connected' };
  }
  try {
    const token = await exchangeToken({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: record.refreshToken,
      grant_type: 'refresh_token',
    });
    if (token.error || !token.access_token) {
      const err = token.error ?? 'refresh_error';
      console.error('[drive-oauth] refresh recusado:', err);
      if (isInvalidGrant(err)) {
        await deleteTokens(sessionId);
        return { reason: 'revoked' };
      }
      // `isTemporaryError` olha o status HTTP, não só o nome do erro: o Google
      // responde `http_503` quando o endpoint está sobrecarregado, e esse erro
      // não tem nome nenhum para casar.
      return {
        reason: isTemporaryError(err, token._httpStatus) ? 'temporary' : 'expired',
      };
    }
    const next: TokenRecord = {
      ...record,
      accessToken: token.access_token,
      accessExpiresAt: Date.now() + expiraEmMs(token.expires_in),
      refreshToken: token.refresh_token || record.refreshToken,
      scope: token.scope ?? record.scope,
      generation: record.generation + 1,
    };
    if (!hasLimitedDriveScope(next.scope)) {
      await revokeAndDelete(sessionId);
      return { reason: 'not_connected' };
    }
    await saveTokens(sessionId, next, record.generation);
    return { record: next };
  } finally {
    const lua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
    await redis.eval(lua, 1, lockKey, lockOwner);
  }
}

export async function getValidAccessToken(
  sessionId: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; reason: AuthFailure }> {
  const record = await loadTokens(sessionId);
  if (!record) return { ok: false, reason: 'not_connected' };
  if (!hasLimitedDriveScope(record.scope)) {
    await revokeAndDelete(sessionId);
    return { ok: false, reason: 'not_connected' };
  }
  if (record.accessExpiresAt > Date.now() + 15_000) {
    return { ok: true, accessToken: record.accessToken };
  }
  const refreshed = await refreshAccessToken(sessionId, record);
  if ('reason' in refreshed) return { ok: false, reason: refreshed.reason };
  return { ok: true, accessToken: refreshed.record.accessToken };
}

async function revokeGoogleToken(token: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch {
    // A remoção local continua valendo mesmo se a revogação remota falhar.
  }
}

export async function revokeAndDelete(sessionId: string): Promise<void> {
  const record = await loadTokens(sessionId);
  await deleteTokens(sessionId);
  if (record) await revokeGoogleToken(record.refreshToken);
}
