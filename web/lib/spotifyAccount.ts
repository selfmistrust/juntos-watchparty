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

import { SERVER_URL } from '@/lib/socket';

/**
 * Endereço do servidor de salas.
 *
 * Vem de `SERVER_URL` e não de uma cópia da regra: o Spotify mora no Render e o
 * site na Vercel, e `location.assign` com caminho relativo ia procurar a rota do
 * servidor **no site**, que não existe. A primeira versão desta integração fez
 * exatamente isso e o botão de conectar respondeu 404 — que é a mesma assinatura
 * de um link quebrado e de um caminho no host errado.
 */

/** Pede a URL de login por fetch, que leva o cookie de sessão. Só o desktop usa. */
export async function spotifyStartUrl(returnTo: string): Promise<{ url: string } | { error: string }> {
  const r = await fetch(`${SERVER_URL}/api/spotify/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ returnTo }),
  });
  if (!r.ok) return { error: r.status === 503 ? 'not_configured' : 'start_failed' };
  return (await r.json()) as { url: string };
}

/**
 * URL que começa o login no navegador, e que a pessoa segue na mesma aba.
 *
 * `returnTo` viaja na query porque o fluxo é uma navegação: a pessoa sai do
 * site, autoriza no Spotify e volta. O servidor valida esse destino contra as
 * origens permitidas antes de guardá-lo no `state`, então a query não abre
 * brecha.
 */
export function spotifyConnectUrl(returnTo: string): string {
  return `${SERVER_URL}/api/spotify/oauth/start?returnTo=${encodeURIComponent(returnTo)}`;
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

/**
 * Erro do servidor, com o status do Spotify quando ele vem.
 *
 * O `statusDoSpotify` é o que separa "o Spotify disse 401" de "o Spotify disse
 * 400", e o painel usa isso para oferecer a ação certa: um `401` pede reconectar,
 * um `429` pede esperar, e um `403` de Development Mode pede uma coisa no painel
 * do Spotify que **ninguém** consegue adivinhar. Sem o status, os três viravam a
 * mesma frase e a pessoa ficava tentando a mesma coisa três vezes.
 */
export class SpotifyErro extends Error {
  readonly status: number;
  readonly statusDoSpotify?: number;

  constructor(mensagem: string, status: number, statusDoSpotify?: number) {
    super(mensagem);
    this.name = 'SpotifyErro';
    this.status = status;
    this.statusDoSpotify = statusDoSpotify;
  }
}

async function get<T>(caminho: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${SERVER_URL}${caminho}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    // Parâmetro vazio não vai: o Spotify responde 400 para `q=` sem termo, e a
    // validação do servidor já pegou o caso — mandar o vazio seria pedir um erro
    // que já sabemos que vem.
    if (v) url.searchParams.set(k, v);
  }
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) {
    let mensagem = `A busca não respondeu. Tente de novo. (${r.status})`;
    let statusDoSpotify: number | undefined;
    try {
      const corpo = (await r.json()) as { error?: unknown; statusDoSpotify?: unknown };
      if (typeof corpo?.error === 'string' && corpo.error) mensagem = corpo.error;
      if (typeof corpo?.statusDoSpotify === 'number') statusDoSpotify = corpo.statusDoSpotify;
    } catch {
      // Corpo não-JSON: uma indisponibilidade do Render chega como HTML, e
      // perder o status ali seria perder a única pista.
    }
    throw new SpotifyErro(mensagem, r.status, statusDoSpotify);
  }
  return (await r.json()) as T;
}

export async function fetchSpotifyStatus(): Promise<SpotifyStatus> {
  try {
    return await get<SpotifyStatus>('/api/spotify/status');
  } catch {
    return { configured: false, connected: false };
  }
}


export async function disconnectSpotify(): Promise<void> {
  const r = await fetch(`${SERVER_URL}/api/spotify/oauth/disconnect`, {
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
