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
 * Google Drive: conectar a conta, listar os vídeos, e autorizar a leitura de um
 * arquivo escolhido.
 *
 * ## O que o Drive entrega, e o que ele não entrega
 *
 * Não existe URL de vídeo reproduzível no navegador para um arquivo do Drive.
 * O `https://drive.google.com/uc?export=download&id=...` redireciona para uma
 * página HTML de confirmação ("Google Drive não consegue fazer a varredura de
 * arquivos vírus") assim que o arquivo passa de algumas dezenas de MB — e é
 * justamente o tamanho de um episódio que a gente quer assistir.
 *
 * Por isso a integração **não** coloca o Drive na fila. O arquivo é copiado para
 * o bucket da sala, pelo navegador de quem escolheu, e a faixa entra como
 * `kind: 'file'` com a URL do R2 — igual a um envio comum. Ninguém mais precisa
 * de token, ninguém precisa de permissão de compartilhamento, e o player não
 * ganha um modo novo.
 *
 * O comentário antigo no card do Drive falava em "proxy no servidor, com
 * autenticação por sala", que é a solução para a outra abordagem — deixar a
 * faixa apontar para o Drive. Aqui a faixa não aponta para o Drive, então o
 * proxy não é necessário e o Render não vê o vídeo.
 */

const DRIVE_ABOUT = 'https://www.googleapis.com/drive/v3/about';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_DOWNLOAD = 'https://www.googleapis.com/drive/v3/files';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_KEY = (sessionId: string) => `drive:tokens:${sessionId}`;
const PENDING_KEY = (state: string) => `drive:oauth:${state}`;
const REFRESH_LOCK = (sessionId: string) => `drive:refreshlock:${sessionId}`;
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

export type DrivePublicStatus = {
  configured: boolean;
  connected: boolean;
  /** Nome de exibição da conta, para o card não ficar anônimo. */
  displayName?: string;
  email?: string;
};

type TokenRecord = {
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  scope: string;
  displayName: string;
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
};

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes, quando o Drive informa. */
  size?: number;
  /** Milissegundos, quando o Drive sabe extrair do arquivo. */
  durationMs?: number;
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
    return parsed as TokenRecord;
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
  return {
    configured,
    connected: true,
    displayName: record.displayName || undefined,
    email: record.email || undefined,
  };
}

export async function createAuthUrl(
  sessionId: string,
  returnTo: string,
  voltarComo: PendingOAuth['voltarComo'] = 'app',
): Promise<string | null> {
  if (!driveOAuthConfigured()) return null;
  const { verifier, challenge } = pkce();
  const state = newState();
  const pending: PendingOAuth = { sessionId, codeVerifier: verifier, returnTo, voltarComo };
  await redis.set(PENDING_KEY(state), JSON.stringify(pending), 'EX', PENDING_TTL_SEC);

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  // `consent` de propósito, como no YouTube: sem ele o Google só devolve o
  // refresh token na primeira vez, e um segundo login silenciosamente falha.
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function takePending(state: string): Promise<PendingOAuth | null> {
  if (!state) return null;
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
 * Quem é a pessoa conectada.
 *
 * O `about` é a única chamada que devolve identidade. O e-mail fica guardado
 * porque é o que a pessoa reconhece como "a conta que conectei" — e o card
 * mostra o nome, não o e-mail.
 */
async function fetchAbout(accessToken: string): Promise<{ displayName: string; email: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL(DRIVE_ABOUT);
    url.searchParams.set('fields', 'user(displayName,emailAddress)');
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return { displayName: '', email: '' };
    const data = (await response.json()) as {
      user?: { displayName?: string; emailAddress?: string };
    };
    return {
      displayName: data.user?.displayName ?? '',
      email: data.user?.emailAddress ?? '',
    };
  } catch {
    clearTimeout(timeout);
    // A identidade é secundária: sem ela a conexão funciona igual, e um timeout no `about` não pode custar o login inteiro.
    return { displayName: '', email: '' };
  }
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

  const existing = await loadTokens(params.sessionId);
  const refreshToken = token.refresh_token || existing?.refreshToken;
  if (!refreshToken) {
    console.error('[drive-oauth] Google não devolveu refresh token');
    return { ok: false, reason: 'api_error' };
  }

  const about = await fetchAbout(token.access_token);

  await saveTokens(params.sessionId, {
    refreshToken,
    accessToken: token.access_token,
    accessExpiresAt: Date.now() + expiraEmMs(token.expires_in),
    scope: token.scope ?? SCOPE,
    displayName: about.displayName || existing?.displayName || '',
    email: about.email || existing?.email || '',
    connectedAt: existing?.connectedAt ?? Date.now(),
    generation: (existing?.generation ?? 0) + 1,
  });
  return { ok: true };
}

async function refreshAccessToken(
  sessionId: string,
  record: TokenRecord,
): Promise<TokenRecord | null> {
  const lockKey = REFRESH_LOCK(sessionId);
  const lockOwner = `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const locked = await redis.set(lockKey, lockOwner, 'EX', 30, 'NX');
  if (!locked) {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const current = await loadTokens(sessionId);
      if (current && current.accessExpiresAt > Date.now() + 15_000) return current;
    }
    return loadTokens(sessionId);
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
        return null;
      }
      return null;
    }
    const next: TokenRecord = {
      ...record,
      accessToken: token.access_token,
      accessExpiresAt: Date.now() + expiraEmMs(token.expires_in),
      refreshToken: token.refresh_token || record.refreshToken,
      scope: token.scope ?? record.scope,
      generation: record.generation + 1,
    };
    await saveTokens(sessionId, next, record.generation);
    return next;
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
  if (record.accessExpiresAt > Date.now() + 15_000) {
    return { ok: true, accessToken: record.accessToken };
  }
  const refreshed = await refreshAccessToken(sessionId, record);
  if (!refreshed) {
    const still = await loadTokens(sessionId);
    if (!still) return { ok: false, reason: 'revoked' };
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, accessToken: refreshed.accessToken };
}

/**
 * Os vídeos da conta, mais recentes primeiro.
 *
 * O filtro é por tipo MIME de vídeo, e não por extensão: o Drive conhece o
 * conteúdo de um `.mkv` mesmo quando o nome não diz nada, e `mimeType contains
 * 'video/'` pega também os formatos que o Google não lista no `video/mp4` de
 * propósito — um `.mkv` com codec estranho ainda é `video/x-matroska`.
 *
 * Sem `thumbnailLink`: os thumbnails do Drive são URLs temporárias que às vezes
 * exigem o mesmo token, e um `<img src>` não consegue mandar cabeçalho. Trocar
 * um thumbnail quebrado por um ícone de arquivo é o melhor negócio.
 */
export async function listarVideos(
  accessToken: string,
  busca?: string,
): Promise<{ ok: true; files: DriveFile[] } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const url = new URL(DRIVE_FILES);
    url.searchParams.set('q', "mimeType contains 'video/' and trashed = false");
    if (busca && busca.trim()) {
      // O `name contains` ignora maiúsculas no Drive, então não precisa do
      // truque de lower().
      url.searchParams.set(
        'q',
        `mimeType contains 'video/' and trashed = false and name contains '${busca.trim().replace(/'/g, "\\'")}'`,
      );
    }
    url.searchParams.set('fields', 'files(id,name,mimeType,size,videoMediaMetadata(durationMsec))');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('pageSize', '50');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (!response.ok) return { ok: false, reason: 'api_error' };

    const data = (await response.json()) as {
      files?: {
        id: string;
        name?: string;
        mimeType?: string;
        size?: string;
        videoMediaMetadata?: { durationMsec?: string };
      }[];
    };

    return {
      ok: true,
      files: (data.files ?? []).map((f) => ({
        id: f.id,
        name: f.name ?? 'Vídeo',
        mimeType: f.mimeType ?? 'application/octet-stream',
        size: f.size ? Number(f.size) : undefined,
        durationMs: f.videoMediaMetadata?.durationMsec
          ? Number(f.videoMediaMetadata.durationMsec)
          : undefined,
      })),
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'api_error' };
  }
}

/**
 * URL de download de um arquivo, e o nome do tipo de conteúdo.
 *
 * O `alt=media` faz o Google devolver os bytes em vez do JSON de metadados. A
 * leitura exige o `Authorization: Bearer`, e é por isso que o token chega ao
 * renderer — o `alt=media` não aceita URL assinada, e um proxy no servidor
 * puxaria o vídeo inteiro pelo Render, que é o oposto do motivo de esta
 * integração existir.
 *
 * O id do arquivo é validado aqui: o id vai para dentro de um caminho de URL, e
 * um id com `/` ou `..` mudaria o endpoint chamado.
 */
export function downloadUrlDe(fileId: string): { url: string } | { erro: 'bad_file' } {
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(fileId)) return { erro: 'bad_file' };
  const url = new URL(`${DRIVE_DOWNLOAD}/${fileId}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  return { url: url.toString() };
}

export async function revokeAndDelete(sessionId: string): Promise<void> {
  const record = await loadTokens(sessionId);
  await deleteTokens(sessionId);
  if (!record) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(record.refreshToken)}`, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch {
    // Revogar no Google é cortesia: o token local já saiu do Redis, e o
    // refresh token deixa de valer quando o app não o tem mais.
  }
}
