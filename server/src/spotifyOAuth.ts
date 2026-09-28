import crypto from 'node:crypto';
import { redis } from './redis.js';
import { decryptSecret, encryptSecret } from './secretBox.js';

/**
 * Spotify: conta, busca e token de reprodução.
 *
 * ## O que este módulo faz e o que ele deliberadamente não faz
 *
 * Faz: guarda a conta de quem conectou, busca músicas/álbuns/playlists pela Web
 * API, e emite um **access token** curto para o navegador.
 *
 * Não faz, e não vai fazer: escrever na biblioteca de ninguém, criar playlist,
 * salvar faixa. Os scopes pedidos são só de leitura e de reprodução —
 * `user-read-email` e `user-read-private` (exigidos pelo SDK) e `streaming`.
 * Sem `playlist-modify-private` nem `user-library-modify`, é impossível para
 * este código tocar no que a pessoa tem salvo, e essa é a razão de a lista de
 * scopes ser curta e não negociável.
 *
 * ## O refresh token nunca sai daqui
 *
 * O Web Playback SDK chama `getOAuthToken` **dentro da página**, então o access
 * token tem que chegar ao navegador — não há como evitar. O refresh token não
 * precisa: ele fica cifrado no Redis (`secretBox`) e é usado só aqui. Se a
 * página vazar um access token, o dano é de uma hora; se vazar o refresh token,
 * é a conta.
 *
 * ## `product: "premium"` não prova Premium
 *
 * A Web API devolve `product: "premium"` para contas Spotify Lite e Premium Mini,
 * que são planos **só de celular** — e o Web Playback SDK não funciona nelas. A
 * falha só aparece na hora de tocar, como `account_error` do próprio SDK.
 *
 * Consequência de projeto: o servidor devolve o `product` porque é o que ele
 * sabe, e a interface **não** pode tratar isso como prova. Quem decide se o áudio
 * toca é o SDK, e o card tem de conseguir dizer "Premium necessário" a partir
 * desse erro — não a partir do `/me`.
 */

const TOKEN_KEY = (sessionId: string) => `spotify:tok:${sessionId}`;
const PENDING_KEY = (state: string) => `spotify:pend:${state}`;
const PENDING_TTL_SEC = 10 * 60;

/**
 * Scopes do pedido.
 *
 * `user-read-birthdate` foi exigido pelo SDK no passado e hoje está deprecado;
 * a documentação atual pede `streaming`, `user-read-email` e
 * `user-read-private`. Os três aparecem aqui porque a validação de Premium do SDK
 * usa os dados de perfil.
 */
const SCOPE = ['streaming', 'user-read-email', 'user-read-private'].join(' ');

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

function clientId(): string {
  return (process.env.SPOTIFY_CLIENT_ID ?? '').trim();
}
function clientSecret(): string {
  return (process.env.SPOTIFY_CLIENT_SECRET ?? '').trim();
}
function redirectUri(): string {
  return (process.env.SPOTIFY_REDIRECT_URI ?? '').trim();
}

/** `true` quando o servidor tem o que fazer login. Sem isso, a fonte não existe. */
export function spotifyConfigured(): boolean {
  return clientId().length > 0 && clientSecret().length > 0 && redirectUri().length > 0;
}

/**
 * Diagnóstico do boot, no mesmo formato do `logGoogleConfigShape`.
 *
 * ## Por que isto existe
 *
 * "A integração não está configurada no servidor" é o mesmo sintoma para quatro
 * causas diferentes: variável com nome errado, valor colado com espaço na borda,
 * variável salva no ambiente errado do Render, e variável que existe mas nunca
 * chegou no processo. Do lado de cá, todas produzem exatamente
 * `configured: false`, e o log dizia só "faltam credenciais" — que não aponta
 * para nada.
 *
 * O caso que motivou isto: as três variáveis estavam no Render, o serviço
 * reiniciou (uptime de 2 minutos), e `configured` continuava `false`. A causa
 * só aparece quando o log diz **qual** das três não chegou.
 *
 * ## O que NÃO é registrado
 *
 * Nenhum valor de segredo, nem fragmento, nem tamanho. Só **o nome** da
 * variável que falta, e se o valor tem caractere invisível na borda. Isso
 * localiza o erro sem servir para vazar nada — quem lê o log já tem acesso ao
 * deploy.
 */
export function logSpotifyConfigShape(): void {
  const valores = [
    ['SPOTIFY_CLIENT_ID', clientId()],
    ['SPOTIFY_CLIENT_SECRET', clientSecret()],
    ['SPOTIFY_REDIRECT_URI', redirectUri()],
  ] as const;

  const problemas: string[] = [];
  for (const [nome, valor] of valores) {
    if (!valor) {
      problemas.push(`${nome} ausente ou vazia`);
      continue;
    }
    /*
     * O `trim` pega espaço e quebra de linha nas pontas, que é onde o paste de
     * credencial costuma sujar o valor. O Render guarda o `\n` do clipboard e o
     * valor *parece* certo na tela — e o código inteiro se comporta como se
     * estivesse configurado quando não está.
     */
    if (valor !== valor.trim()) problemas.push(`${nome} tem espaço ou quebra de linha na borda`);
  }

  const uri = redirectUri();
  if (uri && !/^https:\/\//.test(uri)) {
    /*
     * O Spotify exige https fora de localhost, e recusar aqui é muito mais
     * barato do que descobrir isso depois de a pessoa ter autorizado tudo.
     */
    problemas.push('SPOTIFY_REDIRECT_URI não começa com https://');
  }

  if (problemas.length === 0) {
    console.log(`[spotify] as tres variaveis chegaram (${uri})`);
    return;
  }
  console.warn(`[spotify] fonte DESLIGADA — ${problemas.join('; ')}`);
}

interface TokenRecord {
  accessToken: string;
  /** O Spotify **não** devolve refresh token em toda renovação; o antigo continua valendo. */
  refreshToken: string;
  accessExpiresAt: number;
  connectedAt: number;
  product: string | null;
  displayName: string | null;
  email: string | null;
}

interface PendingOAuth {
  sessionId: string;
  codeVerifier: string;
  returnTo: string;
}

async function loadTokens(sessionId: string): Promise<TokenRecord | null> {
  const raw = await redis.get(TOKEN_KEY(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decryptSecret(raw)) as Partial<TokenRecord>;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.accessExpiresAt !== 'number'
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

async function saveTokens(sessionId: string, record: TokenRecord): Promise<void> {
  // Sem TTL: quem conectou continua conectado até desconectar. Um TTL faria a
  // conta "cair" sozinha depois de um tempo, e o `refresh token` ainda valeria.
  await redis.set(TOKEN_KEY(sessionId), encryptSecret(JSON.stringify(record)));
}

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  /** `premium` | `free` | o que a API disser. **Não** é prova de Premium — ver o topo. */
  product?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export async function getStatus(sessionId: string | null): Promise<SpotifyStatus> {
  const configured = spotifyConfigured();
  if (!configured || !sessionId) return { configured, connected: false };
  const record = await loadTokens(sessionId);
  if (!record) return { configured, connected: false };
  return {
    configured,
    connected: true,
    product: record.product,
    displayName: record.displayName,
    email: record.email,
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function createAuthUrl(sessionId: string, returnTo: string): Promise<string | null> {
  if (!spotifyConfigured()) return null;
  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(16).toString('base64url');
  await redis.set(
    PENDING_KEY(state),
    JSON.stringify({ sessionId, codeVerifier: verifier, returnTo } satisfies PendingOAuth),
    'EX',
    PENDING_TTL_SEC,
  );

  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // `show_dialog` força a tela de login: reconectar a mesma conta numa sessão
  // nova reaproveita a sessão do Spotify e pula a tela, e aí a pessoa não sabe
  // em que conta está conectando.
  url.searchParams.set('show_dialog', 'true');
  return url.toString();
}

export async function takePending(state: string): Promise<PendingOAuth | null> {
  const raw = await redis.get(PENDING_KEY(state));
  if (!raw) return null;
  await redis.del(PENDING_KEY(state));
  try {
    return JSON.parse(raw) as PendingOAuth;
  } catch {
    return null;
  }
}

async function spotifyFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) {
    throw new Error(`spotify_${r.status}`);
  }
  return (await r.json()) as T;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

interface MeResponse {
  product?: string;
  display_name?: string | null;
  email?: string | null;
}

export async function completeOAuth(params: {
  sessionId: string;
  code: string;
  codeVerifier: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: redirectUri(),
      code_verifier: params.codeVerifier,
    }).toString();

    const token = await spotifyFetch<TokenResponse>(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!token.refresh_token) {
      // Sem refresh token a conexão morre em uma hora, e a pessoa teria que
      // reconectar. Melhor recusar agora do que fingir que está tudo certo.
      return { ok: false, error: 'spotify_no_refresh_token' };
    }

    const me = await fetchMe(token.access_token);

    await saveTokens(params.sessionId, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAt: Date.now() + token.expires_in * 1000,
      connectedAt: Date.now(),
      product: me?.product ?? null,
      displayName: me?.display_name ?? null,
      email: me?.email ?? null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function fetchMe(accessToken: string): Promise<MeResponse | null> {
  try {
    const r = await fetch(`${API}/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return null;
    return (await r.json()) as MeResponse;
  } catch {
    return null;
  }
}

/**
 * Access token válido, renovando quando preciso.
 *
 * Renovar com uma margem de 60s: o token vive uma hora, e a busca ou a reprodução
 * começando do mesmo instante em que ele vence é o jeito mais comum de o Spotify
 * responder 401 numa operação que a pessoa fez normalmente.
 */
export async function getValidAccessToken(
  sessionId: string,
): Promise<{ ok: true; token: string } | { ok: false; reason: 'not_connected' | 'revoked' }> {
  const record = await loadTokens(sessionId);
  if (!record) return { ok: false, reason: 'not_connected' };

  if (record.accessExpiresAt > Date.now() + 60_000) {
    return { ok: true, token: record.accessToken };
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
    }).toString();

    const token = await spotifyFetch<TokenResponse>(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    // Na renovação o Spotify omite `refresh_token` quando nada mudou. Descartar o
    // antigo aqui derrubaria a conexão na primeira renovação — que é a mais
    // comum de todas.
    const refreshed: TokenRecord = {
      ...record,
      accessToken: token.access_token,
      accessExpiresAt: Date.now() + token.expires_in * 1000,
      refreshToken: token.refresh_token ?? record.refreshToken,
    };
    await saveTokens(sessionId, refreshed);
    return { ok: true, token: refreshed.accessToken };
  } catch (err) {
    const status = Number((err as Error).message.split('_')[1]);
    if (status === 400 || status === 401) {
      // `invalid_grant`: o refresh token foi revogado ou a pessoa desautorizou o
      // app. Não adianta tentar de novo, e deixar o registro só faria o card
      // continuar dizendo "conectado" para uma conta que não funciona mais.
      await redis.del(TOKEN_KEY(sessionId));
      return { ok: false, reason: 'revoked' };
    }
    return { ok: false, reason: 'not_connected' };
  }
}

export async function disconnect(sessionId: string): Promise<void> {
  const record = await loadTokens(sessionId);
  if (record) {
    // Revogar no Spotify é o que faz a pessoa não ter mais o app autorizado na
    // conta. Sem isso, o app continua aparecendo em "aplicativos conectados" e o
    // botão "desconectar" da nossa UI mente.
    try {
      await fetch(`${API}/me/player`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${record.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ device_ids: [], play: false }),
      });
    } catch {
      // Revogar é melhor-esforço. Apagar o token local já tira o acesso daqui.
    }
  }
  await redis.del(TOKEN_KEY(sessionId));
}

export type SpotifySearchKind = 'track' | 'album' | 'playlist';

export interface SpotifySearchItem {
  id: string;
  kind: SpotifySearchKind;
  title: string;
  subtitle: string;
  artwork?: string | null;
  /** Só em álbum e playlist: por onde a busca anda. */
  uri?: string;
  /** Só em faixa: o que o player do SDK toca. */
  trackUri?: string;
  artists?: string;
  durationMs?: number;
}

interface SearchResponse {
  tracks?: {
    items?: Array<{
      id: string;
      uri: string;
      name: string;
      duration_ms: number;
      artists?: Array<{ name: string }>;
      album?: { images?: Array<{ url: string }> };
    }>;
  };
  albums?: {
    items?: Array<{
      id: string;
      uri: string;
      name: string;
      artists?: Array<{ name: string }>;
      images?: Array<{ url: string }>;
    }>;
  };
  playlists?: {
    items?: Array<{
      id: string;
      uri: string;
      name: string;
      owner?: { display_name?: string | null };
      images?: Array<{ url: string }>;
    }>;
  };
}

/**
 * Busca por termo, em faixas, álbuns e playlists.
 *
 * O Spotify indexa por relevância, e a diferença entre os três é o que muda a
 * intenção de quem procura: `album` traz o disco para dar play em sequência,
 * `playlist` traz a curadoria de alguém, e `track` traz a música.
 */
export async function search(
  sessionId: string,
  term: string,
): Promise<{ ok: true; items: SpotifySearchItem[] } | { ok: false; reason: string }> {
  const auth = await getValidAccessToken(sessionId);
  if (!auth.ok) return { ok: false, reason: auth.reason };

  const url = new URL(`${API}/search`);
  url.searchParams.set('q', term);
  url.searchParams.set('type', 'track,album,playlist');
  url.searchParams.set('limit', '12');

  const r = await fetch(url, { headers: { authorization: `Bearer ${auth.token}` } });
  if (!r.ok) return { ok: false, reason: `spotify_${r.status}` };
  const data = (await r.json()) as SearchResponse;

  const items: SpotifySearchItem[] = [];

  for (const t of data.tracks?.items ?? []) {
    items.push({
      id: t.id,
      kind: 'track',
      title: t.name,
      subtitle: (t.artists ?? []).map((a) => a.name).join(', ') || 'Artista desconhecido',
      artists: (t.artists ?? []).map((a) => a.name).join(', '),
      artwork: t.album?.images?.[0]?.url ?? null,
      trackUri: t.uri,
      durationMs: t.duration_ms,
    });
  }

  for (const a of data.albums?.items ?? []) {
    items.push({
      id: a.id,
      kind: 'album',
      title: a.name,
      subtitle: `Álbum · ${(a.artists ?? []).map((x) => x.name).join(', ') || 'artista desconhecido'}`,
      artwork: a.images?.[0]?.url ?? null,
      uri: a.uri,
    });
  }

  for (const p of data.playlists?.items ?? []) {
    items.push({
      id: p.id,
      kind: 'playlist',
      title: p.name,
      subtitle: `Playlist · ${p.owner?.display_name || 'de alguém'}`,
      artwork: p.images?.[0]?.url ?? null,
      uri: p.uri,
    });
  }

  return { ok: true, items };
}

/** Detalhes de um álbum ou playlist: as faixas, na ordem. */
export async function listTracks(
  sessionId: string,
  uri: string,
): Promise<{ ok: true; items: SpotifySearchItem[] } | { ok: false; reason: string }> {
  const auth = await getValidAccessToken(sessionId);
  if (!auth.ok) return { ok: false, reason: auth.reason };

  const r = await fetch(`${API}/${uri.replace(/^spotify:/, '')}/tracks?limit=50`, {
    headers: { authorization: `Bearer ${auth.token}` },
  });
  if (!r.ok) return { ok: false, reason: `spotify_${r.status}` };
  const data = (await r.json()) as {
    items?: Array<{
      track?: {
        id: string;
        uri: string;
        name: string;
        duration_ms: number;
        artists?: Array<{ name: string }>;
        album?: { images?: Array<{ url: string }> };
      } | null;
    }>;
  };

  const items: SpotifySearchItem[] = [];
  for (const row of data.items ?? []) {
    const t = row.track;
    if (!t) continue; // faixa local do dono da playlist não tem preview nem player
    items.push({
      id: t.id,
      kind: 'track',
      title: t.name,
      subtitle: (t.artists ?? []).map((a) => a.name).join(', ') || 'Artista desconhecido',
      artwork: t.album?.images?.[0]?.url ?? null,
      trackUri: t.uri,
      durationMs: t.duration_ms,
    });
  }
  return { ok: true, items };
}
