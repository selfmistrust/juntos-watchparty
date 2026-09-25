import crypto from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';
import { decryptSecret, encryptSecret } from './secretBox.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const YT_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const YT_SEARCH = 'https://www.googleapis.com/youtube/v3/search';

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const TOKEN_KEY = (sessionId: string) => `yt:tokens:${sessionId}`;
const PENDING_KEY = (state: string) => `yt:oauth:${state}`;
const REFRESH_LOCK = (sessionId: string) => `yt:refreshlock:${sessionId}`;

const PENDING_TTL_SEC = 10 * 60;
const newState = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 32);

export type YoutubePublicStatus = {
  configured: boolean;
  connected: boolean;
  channelTitle?: string;
  channelId?: string;
};

type TokenRecord = {
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  scope: string;
  channelId: string;
  channelTitle: string;
  connectedAt: number;
  generation: number;
};

const TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

async function saveTokens(sessionId: string, record: TokenRecord, expectedGeneration?: number): Promise<void> {
  if (expectedGeneration !== undefined) {
    const current = await loadTokens(sessionId);
    if (!current || current.generation !== expectedGeneration) {
      throw new Error('generation_mismatch');
    }
  }
  await redis.set(TOKEN_KEY(sessionId), encryptSecret(JSON.stringify(record)), 'EX', TOKEN_TTL_SEC);
}

type PendingOAuth = {
  sessionId: string;
  codeVerifier: string;
  returnTo: string;
};

export type AuthFailure =
  | 'not_connected'
  | 'not_configured'
  | 'revoked'
  | 'expired'
  | 'denied'
  | 'api_error';

function clientId(): string {
  return process.env.GOOGLE_CLIENT_ID ?? '';
}

function clientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET ?? '';
}

export function redirectUri(): string {
  return (
    process.env.GOOGLE_REDIRECT_URI ??
    `http://localhost:${process.env.PORT ?? 4000}/api/youtube/oauth/callback`
  );
}

export function youtubeOAuthConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && process.env.SESSION_SECRET);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function loadTokens(sessionId: string): Promise<TokenRecord | null> {
  const raw = await redis.get(TOKEN_KEY(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decryptSecret(raw));
    if (!parsed.refreshToken || !parsed.accessToken || typeof parsed.accessExpiresAt !== 'number' ||
        !parsed.channelId || !parsed.channelTitle || typeof parsed.connectedAt !== 'number' ||
        typeof parsed.generation !== 'number') {
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

export async function getPublicStatus(sessionId: string | null): Promise<YoutubePublicStatus> {
  const configured = youtubeOAuthConfigured();
  if (!configured || !sessionId) return { configured, connected: false };
  const record = await loadTokens(sessionId);
  if (!record) return { configured, connected: false };
  return {
    configured,
    connected: true,
    channelTitle: record.channelTitle,
    channelId: record.channelId,
  };
}

export async function createAuthUrl(sessionId: string, returnTo: string): Promise<string | null> {
  if (!youtubeOAuthConfigured()) return null;
  const { verifier, challenge } = pkce();
  const state = newState();
  const pending: PendingOAuth = { sessionId, codeVerifier: verifier, returnTo };
  await redis.set(PENDING_KEY(state), JSON.stringify(pending), 'EX', PENDING_TTL_SEC);

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function takePending(state: string): Promise<PendingOAuth | null> {
  if (!state) return null;
  const key = PENDING_KEY(state);
  const raw = await redis.getdel(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingOAuth;
    if (!parsed.sessionId || !parsed.codeVerifier || !parsed.returnTo) return null;
    return parsed;
  } catch {
    return null;
  }
}

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  _httpStatus?: number;
  _body?: string;
};

async function exchangeToken(body: Record<string, string>): Promise<GoogleTokenResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { error: `http_${response.status}`, _httpStatus: response.status, _body: text };
    }
    const data = (await response.json()) as GoogleTokenResponse;
    if (data.error) {
      return { error: data.error, _httpStatus: response.status };
    }
    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') return { error: 'timeout' };
    return { error: 'invalid_response' };
  }
}

async function fetchChannel(accessToken: string): Promise<{ id: string; title: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL(YT_CHANNELS);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('mine', 'true');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      items?: { id: string; snippet?: { title?: string } }[];
    };
    const item = data.items?.[0];
    if (!item) return null;
    return { id: item.id, title: item.snippet?.title || 'YouTube' };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

function isInvalidGrant(err: string | undefined): boolean {
  return err === 'invalid_grant' || err === 'unauthorized_client' || err === 'invalid_token';
}

function isTemporaryError(err: string | undefined, httpStatus?: number): boolean {
  if (!err) return false;
  if (httpStatus === 429) return true;
  if (httpStatus !== undefined && httpStatus >= 500) return true;
  return err === 'temporarily_unavailable' || err === 'timeout' || err === 'server_error';
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
      console.error('[youtube-oauth] erro temporário na troca de código:', err);
      return { ok: false, reason: 'api_error' };
    }
    console.error('[youtube-oauth] troca de código recusada:', err);
    return { ok: false, reason: 'api_error' };
  }

  const existing = await loadTokens(params.sessionId);
  const refreshToken = token.refresh_token || existing?.refreshToken;
  if (!refreshToken) {
    console.error('[youtube-oauth] Google não devolveu refresh token');
    return { ok: false, reason: 'api_error' };
  }

  const channel = await fetchChannel(token.access_token);
  if (!channel) {
    console.error('[youtube-oauth] não foi possível ler o canal do usuário');
    return { ok: false, reason: 'api_error' };
  }

  const expiresIn = Number(token.expires_in ?? 3600);
  const expiresInMs = Math.max(30, Math.min(expiresIn, 7200) - 60) * 1000;
  const nextGeneration = (existing?.generation ?? 0) + 1;
  await saveTokens(params.sessionId, {
    refreshToken,
    accessToken: token.access_token,
    accessExpiresAt: Date.now() + expiresInMs,
    scope: token.scope ?? SCOPE,
    channelId: channel.id,
    channelTitle: channel.title,
    connectedAt: existing?.connectedAt ?? Date.now(),
    generation: nextGeneration,
  });
  return { ok: true };
}

async function refreshAccessToken(sessionId: string, record: TokenRecord): Promise<TokenRecord | null> {
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
      console.error('[youtube-oauth] refresh recusado:', err);
      if (isInvalidGrant(err)) {
        await deleteTokens(sessionId);
        return null;
      }
      if (isTemporaryError(err, token._httpStatus)) {
        return null;
      }
      return null;
    }
    const expiresIn = Number(token.expires_in ?? 3600);
    const expiresInMs = Math.max(30, Math.min(expiresIn, 7200) - 60) * 1000;
    const next: TokenRecord = {
      ...record,
      accessToken: token.access_token,
      accessExpiresAt: Date.now() + expiresInMs,
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

export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; kind: 'revoked' | 'expired' | 'temporary' | 'forbidden' };

export async function getValidAccessTokenDetailed(
  sessionId: string,
): Promise<RefreshResult> {
  const record = await loadTokens(sessionId);
  if (!record) return { ok: false, kind: 'revoked' };

  if (record.accessExpiresAt > Date.now() + 15_000) {
    return { ok: true, accessToken: record.accessToken };
  }

  const refreshed = await refreshAccessToken(sessionId, record);
  if (!refreshed) {
    const still = await loadTokens(sessionId);
    if (!still) return { ok: false, kind: 'revoked' };
    return { ok: false, kind: 'expired' };
  }
  return { ok: true, accessToken: refreshed.accessToken };
}

export async function revokeAndDelete(sessionId: string): Promise<{ ok: true } | { ok: false; reason: 'revoke_failed' }> {
  const record = await loadTokens(sessionId);
  await deleteTokens(sessionId);
  const token = record?.refreshToken || record?.accessToken;
  if (!token) return { ok: true };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(GOOGLE_REVOKE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.error('[youtube-oauth] revogação falhou:', response.status);
      return { ok: false, reason: 'revoke_failed' };
    }
    return { ok: true };
  } catch {
    console.error('[youtube-oauth] falha ao revogar no Google (token local já apagado)');
    return { ok: false, reason: 'revoke_failed' };
  }
}

export type SearchItem = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
};

function mapSearchItems(data: {
  items?: {
    id?: { videoId?: string };
    snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string } } };
  }[];
}): SearchItem[] {
  return (data.items ?? [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      videoId: item.id!.videoId!,
      title: item.snippet?.title ?? 'Vídeo',
      channel: item.snippet?.channelTitle ?? '',
      thumbnail: item.snippet?.thumbnails?.medium?.url ?? '',
    }));
}

async function searchWithBearer(accessToken: string, q: string): Promise<{ ok: true; items: SearchItem[] } | { status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL(YT_SEARCH);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '12');
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('q', q);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return { status: response.status };
    const data = (await response.json()) as Parameters<typeof mapSearchItems>[0];
    return { ok: true, items: mapSearchItems(data) };
  } catch {
    clearTimeout(timeout);
    return { status: 502 };
  }
}

async function searchWithApiKey(q: string): Promise<SearchItem[] | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL(YT_SEARCH);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '12');
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('q', q);
    url.searchParams.set('key', key);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = (await response.json()) as Parameters<typeof mapSearchItems>[0];
    return mapSearchItems(data);
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export async function searchYoutube(
  sessionId: string | null,
  q: string,
): Promise<
  | { ok: true; items: SearchItem[] }
  | { ok: false; http: number; error: string }
> {
  if (sessionId && youtubeOAuthConfigured()) {
    const token = await getValidAccessTokenDetailed(sessionId);
    if (token.ok) {
      let result = await searchWithBearer(token.accessToken, q);
      if ('status' in result && result.status === 401) {
        const detailed = await getValidAccessTokenDetailed(sessionId);
        if (detailed.ok) result = await searchWithBearer(detailed.accessToken, q);
      }
      if ('ok' in result && result.ok) return { ok: true, items: result.items };
      const status = 'status' in result ? result.status : 502;
      if (status === 401) {
        await deleteTokens(sessionId);
        return { ok: false, http: 401, error: 'youtube_reauth_required' };
      }
      if (status === 403) return { ok: false, http: 403, error: 'youtube_forbidden' };
      if (status === 429) return { ok: false, http: 429, error: 'youtube_rate_limited' };
      return { ok: false, http: 502, error: 'youtube_unavailable' };
    }
    if (token.kind === 'revoked' || token.kind === 'expired') {
      return { ok: false, http: 401, error: 'youtube_reauth_required' };
    }
    if (token.kind === 'temporary') {
      return { ok: false, http: 503, error: 'youtube_temporarily_unavailable' };
    }
    if (token.kind === 'forbidden') {
      return { ok: false, http: 403, error: 'youtube_forbidden' };
    }
  }

  const fallback = await searchWithApiKey(q);
  if (fallback) return { ok: true, items: fallback };

  if (youtubeOAuthConfigured()) {
    return { ok: false, http: 401, error: 'youtube_not_connected' };
  }
  return { ok: false, http: 501, error: 'no_api_key' };
}
