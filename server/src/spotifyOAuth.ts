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
/** Marca de "`state` já usado", com a sessão que o usou. Ver `jaUsadoPorEstaSessao`. */
const PENDENTE_USADO = (state: string) => `spotify:usado:${state}`;
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

/** Os escopos que esta integração pede, na ordem do pedido de consentimento. */
export const SCOPES_NECESSARIOS: string[] = SCOPE.split(' ');

/**
 * Lê o registro de token sem passar por renovação nem escrita.
 *
 * A rota `/api/spotify/token-info` precisa disto para responder mesmo quando o
 * token está expirado: é justamente o caso em que a busca falha e o painel
 * precisa dizer por quê. `getValidAccessToken` renova, o que esconderia a causa.
 */
export async function peekTokens(sessionId: string): Promise<TokenRecord | null> {
  return loadTokens(sessionId);
}

/**
 * Escopos efetivamente concedidos, lidos do JWT.
 *
 * ## Por que ler o token e não confiar no `/me`
 *
 * O `product` do `/me` e o nome do e-mail continuam válidos quando o consentimento
 * muda, porque o Spotify devolve um `/me` para o token antigo. A busca usa o token
 * **novo**, e é por isso que o painel dizia "conectado" enquanto a busca recebia
 * 403. O campo `scope` do JWT é a única fonte que diz o que este token pode
 * fazer.
 *
 * A assinatura **não** é verificada, e isso é proposital: isto é leitura de
 * diagnóstico, não validação. O valor não sai daqui — só a lista de escopos, que
 * é pública e está na URL de autorização que a pessoa já aceitou.
 *
 * JWT sem padding de base64url: `atob` exige que o comprimento seja múltiplo de 4.
 */
export function scopesDoToken(accessToken: string): string[] {
  try {
    const [, payload] = accessToken.split('.');
    if (!payload) return [];
    const normalizado = payload.replace(/-/g, '+').replace(/_/g, '/');
    const comPadding = normalizado.padEnd(normalizado.length + ((4 - (normalizado.length % 4)) % 4), '=');
    const decodificado = JSON.parse(atob(comPadding)) as { scope?: unknown };
    return typeof decodificado.scope === 'string' ? decodificado.scope.split(' ') : [];
  } catch {
    return [];
  }
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

/**
 * Lê o registro `pending` de um `state`, **sem consumir**.
 *
 * ## Por que não apaga aqui
 *
 * A primeira versão fazia `get` e `del` nesta função, o que tornava o `state`
 * de uso único já no callback. O sintoma era uma conexão que às vezes não
 * existia: clicar em "Conectar" duas vezes criava dois registros, o navegador
 * voltava pelo `code` do fluxo antigo, e esse `state` já tinha sido apagado pelo
 * `del` de uma tentativa anterior. O callback respondia `spotify_state_invalid`
 * e a pessoa não tinha como saber que a culpa era de um clique a mais.
 *
 * O `state` do Spotify já é single-use por desenho — quem o repete é recusado
 * pelo próprio Spotify. Então **não é preciso** apagar para impedir replay: o
 * registro só é removido depois que a troca do `code` é feita, em `completeOAuth`.
 *
 * ## A janela de 10 minutos continua
 *
 * O TTL não muda. Um `state` guardado por 10 minutos é o que permite autorizar
 * sem pressa, e oSpotify invalida o `code` sozinho depois disso.
 */
export async function takePending(state: string): Promise<PendingOAuth | null> {
  if (!state) return null;
  const raw = await redis.get(PENDING_KEY(state));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingOAuth;
  } catch {
    await redis.del(PENDING_KEY(state));
    return null;
  }
}

/** Consome o registro depois de uma troca bem-sucedida. */
async function consumirPending(state: string): Promise<void> {
  await redis.del(PENDING_KEY(state));
}

/**
 * O `state` já foi usado, e o registro sumiu com ele.
 *
 * ## Por que isso existe
 *
 * O navegador pede o **mesmo** callback mais de uma vez com frequência: um
 * `prefetch`, o botão voltar, a aba restaurada, o proxy repetindo o pedido. No log
 * apareceu exatamente isso — duas linhas no mesmo segundo, a primeira gravando a
 * conta e a segunda recusando por não achar o registro.
 *
 * A pessoa autorizou, a conta ficou conectada, e ela viu "a autorização expirou".
 * O pior resultado possível: um aviso que contradiz o estado real.
 *
 * ## Por que isto não é um buraco
 *
 * O que o registro devolvia não é o `code` — é a sessão de quem começou o fluxo
 * e para onde voltar. E essa verificação é explícita: o chamador passa a sessão
 * **atual**, e só reaproveita se ela for a mesma que abriu o fluxo.
 *
 * Um `state` de outra sessão continua sem registro e continua recusado, que é o
 * comportamento certo: são duas pessoas, e a segunda não pode herdar o login da
 * primeira. É o mesmo princípio do `state` de CSRF — ele existe justamente para
 * ligar o callback a quem começou.
 *
 * O que **não** volta é nada de utilizável: nem `code`, nem token, nem a
 * possibilidade de trocar código. A autorização já aconteceu, e quem a fez foi a
 * pessoa que está nesta sessão.
 */
export async function jaUsadoPorEstaSessao(state: string, sessionId: string): Promise<string | null> {
  if (!state || !sessionId) return null;
  const chave = PENDENTE_USADO(state);
  const dono = await redis.get(chave);
  if (dono !== sessionId) return null;
  // A segunda janela serve o destino uma vez e depois o registro vai embora,
  // para não virar um destino guardado por dez minutos.
  await redis.del(chave);
  return (await redis.get(`${chave}:destino`)) ?? null;
}

/** Marca o `state` como usado por esta sessão, guardando o destino. */
export async function marcarPendingUsado(state: string, sessionId: string, destino: string): Promise<void> {
  await redis.set(PENDENTE_USADO(state), sessionId, 'EX', PENDING_TTL_SEC);
  await redis.set(`${PENDENTE_USADO(state)}:destino`, destino, 'EX', PENDING_TTL_SEC);
}

/**
 * Chama a Web API com o token da pessoa, e renova **uma vez** se o Spotify recusar.
 *
 * ## Por que repetir só uma vez
 *
 * A renovação acontece por margem de 60 segundos antes de o token vencer, então o
 * `401` aqui é raro — e quando vem, quase sempre é o token revogado de verdade,
 * não um token velho. Nesses casos repetir não ajuda.
 *
 * O laço de refresh é o modo de falha clássico dessa integração: renova, chama de
 * novo, o Spotify recusa de novo, renova de novo. Cada volta consome uma chamada
 * ao `/api/token` e um `invalid_grant` que **apaga o token guardado** — aí a
 * pessoa deixa de estar conectada por causa de um bug, e a correção passa a ser
 * "conecte de novo", que é o que ela já fez duas vezes.
 *
 * Por isso o `renovado` é uma flag de uma ida só. O segundo `401` vira erro, sem
 * tocar no token guardado.
 *
 * ## Só depois de um 401
 *
 * Um `403` **não** renova. Em Development Mode ele é a resposta normal de uma
 * conta que não está na lista, e renovar o token não muda nada — só queima uma
 * chamada e, no pior caso, invalida a sessão.
 */
async function chamarWebApi<T>(
  sessionId: string,
  caminhoEQuery: string,
  init: RequestInit = {},
): Promise<{ r: Response; tokenUsado: string }> {
  const auth = await getValidAccessToken(sessionId);
  if (!auth.ok) throw new Error(`spotify_sem_token:${auth.reason}`);

  const fazer = async (token: string) =>
    fetch(`https://api.spotify.com/v1${caminhoEQuery}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    });

  let token = auth.token;
  let r = await fazer(token);

  if (r.status === 401) {
    /*
     * Invalida o token guardado e força a renovação pelo refresh token. Sem o
     * `del`, `getValidAccessToken` devolveria o mesmo token — que é o que o
     * Spotify acabou de recusar — e o retry seria idêntico ao primeiro.
     */
    await redis.del(TOKEN_KEY(sessionId));
    const renovado = await getValidAccessToken(sessionId);
    if (!renovado.ok) throw new Error(`spotify_sem_token:${renovado.reason}`);
    token = renovado.token;
    r = await fazer(token);
  }

  return { r, tokenUsado: token };
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
  state: string;
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
      //
      // O registro só é consumido **depois** deste ponto de sucesso, e não antes:
      // uma falha aqui tem que deixar a porta aberta para a pessoa tentar de
      // novo sem começar o login inteiro.
      return { ok: false, error: 'spotify_no_refresh_token' };
    }

    const me = await fetchMe(token.access_token);

    // O token está guardado: agora o registro `pending` pode sumir.
    await consumirPending(params.state);

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
): Promise<
  | { ok: true; token: string }
  | { ok: false; reason: 'not_connected' | 'revoked' | 'renovacao_falhou' }
> {
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
    /*
     * `spotifyFetch` transforma resposta ruim em `spotify_<status>`, e aqui isso
     * vira a distinção que decide o que acontece com a conta.
     *
     * A primeira versão fazia `Number(mensagem.split('_')[1])` e caía em
     * `not_connected` para **qualquer** falha que não fosse 400 ou 401 — rede,
     * timeout, uma resposta sem corpo. E `not_connected` é o motivo que apaga o
     * token: o registro era destruído por um erro de rede, que é a pior das
     * combinações, porque a pessoa perdia a conta por causa de um instante sem
     * internet e a única correção era reconectar tudo.
     *
     * Só 400 e 401 apagam o token, e só porque são o Spotify dizendo que o
     * refresh token não vale mais. Qualquer outra coisa devolve
     * `renovacao_falhou`, que **mantém** a conta: o próximo clique tenta de novo
     * e, se a rede voltou, funciona.
     */
    const status = Number((err as Error).message.split('_')[1]);
    if (status === 400 || status === 401) {
      // `invalid_grant`: o refresh token foi revogado ou a pessoa desautorizou o
      // app. Não adianta tentar de novo, e deixar o registro só faria o card
      // continuar dizendo "conectado" para uma conta que não funciona mais.
      await redis.del(TOKEN_KEY(sessionId));
      console.warn(`[spotify] refresh token recusado (${status}); a conta foi desconectada`);
      return { ok: false, reason: 'revoked' };
    }
    console.warn(`[spotify] renovação falhou sem conseguir ler o motivo: ${(err as Error).message}`);
    return { ok: false, reason: 'renovacao_falhou' };
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

/**
 * Lê o corpo de erro do Spotify e escreve no log.
 *
 * ## Por que o corpo importa e o status não
 *
 * A busca responded `403`, e `403` sozinho não diz nada: no Spotify ele é ao
 * mesmo tempo "app em modo de desenvolvimento e você não está na lista" e
 * "scopes insuficientes" e "este app não pediu a Web API". Os três têm correção
 * diferente, e um código de status é o mesmo para os três.
 *
 * O corpo carrega o que importa: `error.status` vem com um valor legível
 * (`INSUFFICIENT_CLIENT_SCOPE`, `PREMIUM_REQUIRED`, ...) e a `message` diz o
 * motivo em texto.
 *
 * ## O que não é registrado
 *
 * O corpo de erro do Spotify não tem token nem credencial. O que **não** é
 * registrado aqui é a URL com a query, que em alguns endpoints carrega o
 * `market` e o `authorization` — e aí o log passaria a carregar segredo.
 */
/**
 * Converte a resposta de erro do Spotify em texto que a pessoa consiga agir.
 *
 * ## Por que o motivo do Spotify vem junto
 *
 * Um `400` do Spotify é quase sempre um pedido malformado, e o motivo está em
 * `error.status` — que a documentação nomeia, e que ninguém consegue adivinhar.
 * A primeira versão mostrava só "o Spotify respondeu 400. Tente de novo.", que
 * manda a pessoa repetir exatamente o que já falhou.
 *
 * ## As causas conhecidas, e o que a pessoa faz com cada uma
 *
 *   400 INVALID_REDIRECT_URI   o redirect_uri enviado não está no app. A correção
 *                              é no dashboard do Spotify, e nenhuma repetição
 *                              resolve.
 *   400 INVALID_CLIENT         client id ou secret não batem com o app. Mesmo
 *                              caso: dashboard, e reconfigurar o Render.
 *   401                        o token foi revogado. Reconectar resolve.
 *   403 INSUFFICIENT_CLIENT_SCOPE  o consentimento não cobriu o escopo pedido.
 *                              Desconectar e conectar de novo, autorizando tudo.
 *   403 (sem status)            app em modo de desenvolvimento e o e-mail fora
 *                              da lista, ou API não habilitada.
 *   429                        limite de pedidos. Esperar.
 *
 * O `status` do Spotify vai junto porque ele é o campo que a documentação usa, e
 * porque a página de erro da Spotify mostra o mesmo texto. A pessoa consegue
 * comparar os dois.
 */
function motivoDeErro(http: number, doSpotify: { status: string; mensagem: string }): string {
  const codigo = doSpotify.status.toUpperCase();

  if (codigo.includes('INVALID_REDIRECT_URI')) {
    return (
      'O Spotify recusou o endereço de redirecionamento. Confira em Settings, no ' +
      'painel do Spotify, se a URL de redirecionamento é exatamente ' +
      'https://juntos-watchparty.onrender.com/api/spotify/oauth/callback'
    );
  }
  if (codigo.includes('INVALID_CLIENT')) {
    return 'O Spotify recusou o Client ID ou o Client Secret deste app. Confira os dois no Render.';
  }
  if (codigo.includes('SCOPE')) {
    return (
      'A autorização não cobriu todos os escopos. Use "Trocar de conta" e ' +
      'autorize o app de novo, aceitando todas as permissões.'
    );
  }
  if (codigo.includes('INVALID_GRANT') || codigo.includes('INVALID_CODE')) {
    return 'A autorização expirou. Use "Trocar de conta" para começar de novo.';
  }

  /*
   * O 403 sem `status` do Spotify é o caso do Development Mode, e é o que esta
   * integração mais vai encontrar: em modo de desenvolvimento, só as contas
   * listadas em Settings → Users Management conseguem chamar a API, e o Spotify
   * responde 403 sem dizer isso.
   *
   * A mensagem cita o caminho exato do painel porque a correção está lá, e dizer
   * só "sem permissão" faz a pessoa procurar no lugar errado.
   */
  if (http === 403) {
    return (
      'Esta conta Spotify ainda não está autorizada a usar esta integração. ' +
      'Em Development Mode, só as contas em Settings → Users Management, no painel ' +
      'do Spotify, conseguem usar a API.'
    );
  }

  switch (http) {
    case 401:
      return 'A autorização do Spotify expirou. Use "Trocar de conta" para conectar de novo.';
    case 429:
      return 'O Spotify está limitando pedidos. Tente de novo em alguns minutos.';
    default:
      return doSpotify.mensagem
        ? `O Spotify respondeu ${http} (${doSpotify.mensagem}).`
        : `O Spotify respondeu ${http}. Tente de novo.`;
  }
}

/**
 * Lê o corpo de erro do Spotify e devolve o que ele diz.
 *
 * ## Por que isto é público
 *
 * A primeira versão escrevia o motivo no **log** do servidor. Isso exige abrir
 * o painel do Render, e a pessoa que está com um 403 na frente precisa da
 * resposta agora. Um diagnóstico que depende de acesso a deploy não é um
 * diagnóstico, é uma tarefa.
 *
 * O corpo de erro do Spotify é texto de status da API, com o motivo em campo
 * próprio (`error.status` e `error.message`). Não tem token nem credencial, e o
 * que se devolve é o mesmo que já vai para o log.
 */
async function registrarErroSpotify(rotulo: string, r: Response): Promise<{ status: string; mensagem: string }> {
  let status = '';
  let mensagem = '';
  let reason = '';
  let corpoCru = '';
  try {
    const texto = await r.text();
    corpoCru = texto.slice(0, 400);
    const corpo = JSON.parse(texto) as {
      error?: { status?: unknown; message?: unknown; reason?: unknown };
    };
    status = typeof corpo.error?.status === 'string' ? corpo.error.status : '';
    mensagem = typeof corpo.error?.message === 'string' ? corpo.error.message : '';
    // `reason` existe em resposta de reprodução e é onde o Spotify nomeia a causa
    // quando o `status` vem genérico. Nos dois casos é informação, e o registro
    // inteiro cabe numa linha.
    reason = typeof corpo.error?.reason === 'string' ? corpo.error.reason : '';
  } catch {
    // O Spotify devolveu algo que não é JSON. O código e o corpo truncado já
    // bastam, e o corpo bruto está na linha seguinte.
  }
  const detalhe = [status, reason, mensagem].filter(Boolean).join(' | ');
  console.warn(
    `[spotify] ${rotulo} -> ${r.status}` +
      `${detalhe ? ` | ${detalhe}` : ''}` +
      `${corpoCru && !detalhe ? ` | body=${corpoCru}` : ''}`,
  );
  return { status, mensagem };
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

/** O Spotify aceita no máximo 50, mas o app pede 10: é o que a tela mostra. */
const LIMITE_BUSCA = 10;

/**
 * Falta de token, com texto que a pessoa leia.
 *
 * São diferentes de `not_connected` e `revoked`, que são estados internos: o
 * painel precisa dizer "conecte a conta" e "o Spotify recusou sua autorização",
 * que têm ações opostas — a primeira se resolve conectando, a segunda
 * desconectando e conectando de novo.
 */
const TOKEN_AUSENTE =
  'Nenhuma conta do Spotify conectada nesta sessão. Use "Conectar Spotify" no painel.';
const TOKEN_REVOGADO =
  'O Spotify revogou a autorização desta conta. Use "Trocar de conta" para autorizar de novo.';
const TOKEN_RENOVACAO =
  'A conexão com o Spotify ficou sem resposta ao renovar a autorização. Sua conta continua ' +
  'conectada — tente a busca de novo em alguns instantes.';

/**
 * O motivo interno do token, virando texto.
 *
 * São três estados com três ações diferentes — conectar, reconectar, esperar — e
 * reduzi-los a um `not_connected` fazia a pessoa executar a ação errada: um
 * "conecte de novo" quando bastava esperar, e um "espere" quando a conta tinha
 * sido revogada de verdade.
 */
function fraseDoToken(motivo: string): string {
  if (motivo === 'revoked') return TOKEN_REVOGADO;
  if (motivo === 'renovacao_falhou') return TOKEN_RENOVACAO;
  return TOKEN_AUSENTE;
}

/**
 * Busca por termo, em faixas, álbuns e playlists.
 *
 * ## Por que `type=track,album,playlist` numa chamada só
 *
 * O Spotify indexa por relevância, e a diferença entre os três é o que muda a
 * intenção de quem procura: `album` traz o disco, `playlist` traz a curadoria de
 * alguém, e `track` traz a música. Uma chamada só evita que o painel faça três
 * pedidos e intercale os resultados — e em Development Mode cada requisição
 * conta para uma cota que é baixa.
 *
 * ## Um pedido por termo, com o termo validado
 *
 * `q` vazio é `400` no Spotify, e a validação acontece **antes** do fetch: uma
 * busca com um espaço só não deve custar uma chamada de rede para descobrir
 * algo que já se sabe. `trim` e o piso de 2 caracteres são do próprio endpoint de
 * busca, e é por isso que a rota devolve `items: []` nesse caso.
 *
 * ## `limit=10`, e não mais
 *
 * O Spotify aceita até 50, e 12 funcionava. Mas `limit` acima do que a tela
 * mostra só aumenta o custo de um Development Mode, que tem cota baixa, e o
 * scroll do painel é curto. O valor é uma constante nomeada porque volta em
 * lugar: a lista de faixas de um álbum usa outro, e misturar os dois é como
 * "12" acabou no lugar errado.
 */
export async function search(
  sessionId: string,
  term: string,
): Promise<{ ok: true; items: SpotifySearchItem[] } | { ok: false; reason: string; status?: number }> {
  const limpo = term.trim();
  if (limpo.length < 2) return { ok: true, items: [] };

  const url = new URL(`${API}/search`);
  url.searchParams.set('q', limpo);
  url.searchParams.set('type', 'track,album,playlist');
  url.searchParams.set('limit', String(LIMITE_BUSCA));

  let r: Response;
  try {
    ({ r } = await chamarWebApi<SearchResponse>(sessionId, `/search?${url.searchParams.toString()}`));
  } catch (err) {
    /*
     * `spotify_sem_token:<motivo>` é o único erro que `chamarWebApi` lança: não
     * há token para a pessoa, e isso **não** é erro do Spotify. A rota precisa
     * receber isso como `{ok:false}` e não como exceção, senão um clique sem conta
     * conectada viraria 500.
     */
    const motivo = String((err as Error).message).split(':')[1] ?? 'not_connected';
    return { ok: false, reason: fraseDoToken(motivo), status: 401 };
  }

  if (!r.ok) {
    const doSpotify = await registrarErroSpotify('busca GET /search', r);
    return { ok: false, reason: motivoDeErro(r.status, doSpotify), status: r.status };
  }
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
): Promise<
  { ok: true; items: SpotifySearchItem[] } | { ok: false; reason: string; status?: number }
> {
  // `50` aqui e não `LIMITE_BUSCA`: aqui a lista inteira é o conteúdo, e a tela
  // rola. São dois limites com finalidades diferentes, e por isso dois nomes.
  const alvo = uri.replace(/^spotify:/, '');
  let r: Response;
  try {
    ({ r } = await chamarWebApi(sessionId, `/${alvo}/tracks?limit=50`));
  } catch (err) {
    const motivo = String((err as Error).message).split(':')[1] ?? 'not_connected';
    return { ok: false, reason: fraseDoToken(motivo), status: 401 };
  }
  if (!r.ok) {
    const doSpotify = await registrarErroSpotify(`faixas GET /${alvo}/tracks`, r);
    return { ok: false, reason: motivoDeErro(r.status, doSpotify), status: r.status };
  }
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
