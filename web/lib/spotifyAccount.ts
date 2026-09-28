/**
 * Cliente do Spotify, do lado do navegador.
 *
 * ## Onde o segredo está, e onde não está
 *
 * O **client secret** nunca sai do servidor: a troca do código por token e a
 * renovação acontecem em `server/src/spotifyOAuth.ts`. Este arquivo só fala com
 * as rotas do nosso servidor, nunca com `accounts.spotify.com` diretamente.
 *
 * A única exceção é o access token, que a rota `/api/spotify/access-token`
 * devolve para a página — e isso não é escolha nossa: o Web Playback SDK chama
 * `getOAuthToken` **dentro do navegador**, e não existe SDK sem token na página.
 * O que continua preso no servidor é o refresh token, que é o que dá acesso
 * Longer-lived à conta.
 */

/** Endereço do servidor de salas. Mesma regra do resto do app. */
function base(): string {
  const bruto =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_SERVER_URL) || 'http://localhost:4000';
  return bruto.replace(/\/+$/, '');
}

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  /**
   * `premium` | `free` | `unknown` | o que a API disser.
   *
   * **Não é prova de Premium.** Contas Spotify Lite e Premium Mini devolvem
   * `premium` aqui e mesmo assim não reproduzem: são planos só de celular, e o
   * Web Playback SDK recusa. Quem decide é o `account_error` do SDK, em
   * `spotifyPlayback.ts`.
   */
  product?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export type SpotifyItemKind = 'track' | 'album' | 'playlist';

export interface SpotifyItem {
  id: string;
  kind: SpotifyItemKind;
  title: string;
  subtitle: string;
  artwork?: string | null;
  uri?: string;
  trackUri?: string;
  durationMs?: number;
}

async function get<T>(caminho: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${base()}${caminho}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`spotify_${r.status}`);
  return (await r.json()) as T;
}

export async function fetchSpotifyStatus(): Promise<SpotifyStatus> {
  try {
    return await get<SpotifyStatus>('/api/spotify/status');
  } catch {
    return { configured: false, connected: false };
  }
}

/** Pede a URL de login. `POST` porque é ela que leva o cookie de sessão. */
export async function spotifyStartUrl(returnTo: string): Promise<{ url: string } | { error: string }> {
  const r = await fetch(`${base()}/api/spotify/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ returnTo }),
  });
  if (!r.ok) return { error: r.status === 503 ? 'not_configured' : 'start_failed' };
  return (await r.json()) as { url: string };
}

export async function disconnectSpotify(): Promise<void> {
  const r = await fetch(`${base()}/api/spotify/oauth/disconnect`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!r.ok) throw new Error('disconnect_failed');
}

export async function searchSpotify(term: string): Promise<SpotifyItem[]> {
  const r = await get<{ items: SpotifyItem[] }>('/api/spotify/search', { q: term });
  return r.items ?? [];
}

export async function listSpotifyTracks(uri: string): Promise<SpotifyItem[]> {
  const r = await get<{ items: SpotifyItem[] }>('/api/spotify/tracks', { uri });
  return r.items ?? [];
}

/**
 * Access token curto para o SDK.
 *
 * Só é chamada pelo `getOAuthToken` do Web Playback SDK, e é a única rota daqui
 * que entrega um segredo ao navegador. Ver o topo do arquivo.
 */
export async function spotifyAccessToken(): Promise<string | null> {
  try {
    const r = await get<{ token: string }>('/api/spotify/access-token');
    return typeof r.token === 'string' ? r.token : null;
  } catch {
    return null;
  }
}

/**
 * Se este navegador tem o que reproduzir do Spotify.
 *
 * Três condições, e as três precisam valer:
 *
 * 1. contexto seguro (https ou localhost) — o SDK não carrega em http simples;
 * 2. `window.Spotify` existir depois do script — que é a forma como o SDK avisa
 *    que carregou, e a ausência cobre tanto bloqueio de script quanto rede;
 * 3. o app **não** estar no Electron.
 *
 * O terceiro merece explicação, porque é o ponto onde a maior parte das
 * integrações de Spotify quebra e o sintoma é silencioso. O SDK se anuncia como
 * um player "Spotify Connect" para o resto do sistema, e ele é feito para rodar
 * em uma aba de navegador. Dentro de um Electron ele aparece como um dispositivo
 * que o Spotify não reconhece, e a reprodução falha com `account_error` ou não
 * começa — sem erro de console que diga o motivo.
 *
 * A busca e a fila continuam funcionando no desktop, porque elas são só Web API.
 * O que não funciona é o áudio, e é honesto dizer isso no card em vez de
 * descobrir quando a música não toca.
 */
export function spotifyReproduzAqui(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  if (window.juntosDesktop) return false;
  return 'Spotify' in window;
}
