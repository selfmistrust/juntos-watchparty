import crypto from 'node:crypto';
import { customAlphabet } from 'nanoid';

/**
 * As peças genéricas do OAuth do Google, compartilhadas pelo YouTube e pelo
 * Drive.
 *
 * ## O que está aqui e o que não está
 *
 * Aqui fica só o que é **puro**: o PKCE, a troca de código por token, e como
 * classificar um erro do Google. Não há chave no Redis, nem sessão, nem chamada
 * de API de produto.
 *
 * Cada integração continua com o seu token — chave, forma, prazo, e a API que
 * consulta. Isso é deliberado: os dois fluxos diferem no escopo, no que guardam
 * e no que precisam buscar depois de conectar, e o que é realmente igual já
 * estava em um lugar só. Duplicar duzentas linhas de encanamento de OAuth para
 * ganhar uma abstração é como os dois fluxos divergem sem ninguém perceber.
 */

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';

/**
 * O mesmo alfabeto que o YouTube já usava, de propósito: mudar isso junto com
 * o refactor mudaria o formato do `state` de um fluxo que está no ar, e o
 * `state` é opaco — só precisa ser único e não adivinhável.
 */
export const newState = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 32);

export type AuthFailure =
  | 'not_connected'
  | 'not_configured'
  | 'revoked'
  /**
   * A autorização existe mas não renova, e o Google não disse que foi revogada.
   *
   * Separado de `temporary` porque a consequência para a pessoa é oposta: aqui
   * só reconectar resolve, e insistir não adianta. Dizer "tente de novo" para
   * quem precisa reconectar é pior do que dizer "conecte de novo" para quem
   * esperava cinco segundos.
   */
  | 'expired'
  /** Falha passageira do Google. Vale tentar de novo sem mexer na conta. */
  | 'temporary'
  | 'denied'
  | 'api_error';

export function clientId(): string {
  return process.env.GOOGLE_CLIENT_ID ?? '';
}

export function clientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET ?? '';
}

/** 10 minutos é o tempo de tela de consentimento mais plausível. */
export const PENDING_TTL_SEC = 10 * 60;

export function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * O `redirect_uri` de uma integração.
 *
 * Cada uma precisa do seu, porque o Google casa o callback por caminho: um
 * `/api/youtube/oauth/callback` registrado no client **não** aceita um
 * `/api/drive/oauth/callback`. Por isso a variável é por integração, e cair no
 * default local é apenas para o `npm run dev` não quebrar.
 */
export function redirectUriDe(chave: 'youtube' | 'drive'): string {
  const variavel = chave === 'drive' ? 'GOOGLE_DRIVE_REDIRECT_URI' : 'GOOGLE_REDIRECT_URI';
  const padrao =
    chave === 'drive' ? '/api/drive/oauth/callback' : '/api/youtube/oauth/callback';
  return process.env[variavel] ?? `http://localhost:${process.env.PORT ?? 4000}${padrao}`;
}

export function oauthConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && process.env.SESSION_SECRET);
}

/**
 * Confere a **forma** da configuração do Google no boot e registra o resultado.
 *
 * ## Por que isso existe
 *
 * Client ID errado, segredo de outro projeto e `redirect_uri` divergente
 * produzem o mesmo sintoma no painel — "não foi possível conectar" — e só
 * falham depois que a pessoa já autorizou tudo na tela do Google. O
 * consentimento abre, o botão parece funcionar, e a falha só aparece na troca
 * do código, com um `invalid_client` que ninguém consegue ligar à variável de
 * ambiente errada.
 *
 * ## O que NÃO é registrado
 *
 * Nenhum valor de segredo, nem fragmento dele. Só a forma: se está setado, o
 * tamanho, o prefixo, se o sufixo bate, e se há caractere invisível. Isso basta
 * para achar quase toda configuração errada, e não serve para vazar nada —
 * quem lê o log já tem acesso ao deploy.
 *
 * ## O caractere invisível
 *
 * É a causa mais provável e a mais invisível: colar uma credencial traz um `\n`
 * do clipboard, o Render guarda o `\n` junto, e o valor *parece* certo na tela.
 * Detectar isso é o motivo de a comparação existir.
 */
export function logGoogleConfigShape(): void {
  const id = clientId();
  const secret = clientSecret();
  const problemas: string[] = [];

  if (!id) problemas.push('GOOGLE_CLIENT_ID ausente');
  if (!secret) problemas.push('GOOGLE_CLIENT_SECRET ausente');
  if (!process.env.SESSION_SECRET) problemas.push('SESSION_SECRET ausente');

  for (const [nome, valor] of [
    ['GOOGLE_CLIENT_ID', id],
    ['GOOGLE_CLIENT_SECRET', secret],
    ['GOOGLE_REDIRECT_URI', process.env.GOOGLE_REDIRECT_URI ?? ''],
    ['GOOGLE_DRIVE_REDIRECT_URI', process.env.GOOGLE_DRIVE_REDIRECT_URI ?? ''],
  ] as const) {
    if (!valor) continue;
    // A comparação de `trim` pega espaço e quebra de linha nas pontas, que é
    // onde o paste de credencial costuma sujar o valor.
    if (valor !== valor.trim()) problemas.push(`${nome} tem espaço ou quebra de linha na borda`);
  }

  if (id && !id.endsWith('.apps.googleusercontent.com')) {
    problemas.push('GOOGLE_CLIENT_ID não termina em .apps.googleusercontent.com');
  }
  if (id && !/^\d{6,}-/.test(id)) {
    problemas.push('GOOGLE_CLIENT_ID não começa com o número do projeto');
  }
  // O prefixo `GOCSPX-` marca credencial de cliente web criada em 2022 em
  // diante. Não é obrigatório pelo Google, mas diverge dele é forte sinal de
  // que o valor colado veio de outro lugar.
  if (secret && !secret.startsWith('GOCSPX-')) {
    problemas.push('GOOGLE_CLIENT_SECRET não começa com GOCSPX-');
  }

  /*
   * `variavel` e `chave` são coisas diferentes: a chave diz qual integração é,
   * para `redirectUriDe` escolher o callback, e a variável é o nome no ambiente.
   * Confundir as duas faz a verificação acusar "ausente" em toda configuração
   * boa, que é o pior defeito possível num alarme: o alarme que mente.
   */
  const integracoes: { nome: string; chave: 'youtube' | 'drive'; variavel: string; esperado: string }[] = [
    { nome: 'youtube', chave: 'youtube', variavel: 'GOOGLE_REDIRECT_URI', esperado: '/api/youtube/oauth/callback' },
    { nome: 'drive', chave: 'drive', variavel: 'GOOGLE_DRIVE_REDIRECT_URI', esperado: '/api/drive/oauth/callback' },
  ];
  for (const { nome, chave, variavel, esperado } of integracoes) {
    const uri = redirectUriDe(chave);
    if (!process.env[variavel]) {
      problemas.push(`${nome}: ${variavel} ausente, caindo no default local`);
    } else if (!uri.endsWith(esperado)) {
      problemas.push(`${nome}: ${variavel} não termina em ${esperado}`);
    }
    // `localhost` em produção é a causa clássica de callback quebrado, e não
    // aparece em lugar nenhum da tela do Render.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(uri) && process.env.NODE_ENV === 'production') {
      problemas.push(`${nome}: ${variavel} aponta para localhost em produção`);
    }
  }

  if (problemas.length === 0) {
    console.log('[google-oauth] configuração com a forma esperada (client id e redirect uri conferidos)');
    return;
  }
  for (const problema of problemas) console.error(`[google-oauth] ${problema}`);
}

export type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  _httpStatus?: number;
  _body?: string;
};

export async function exchangeToken(body: Record<string, string>): Promise<GoogleTokenResponse> {
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
      /*
       * O Google responde o código do erro OAuth no corpo, inclusive em 4xx —
       * `invalid_grant` para um refresh token revogado chega como HTTP 400.
       *
       * Reportar só `http_400` escondia esse código, e a consequência era séria:
       * uma revogação real deixava de ser reconhecida, o registro do token não
       * era apagado, e o status continuava dizendo "conta conectada" para
       * sempre, com cada chamada repetindo uma renovação que jamais ia
       * funcionar. O `http_<status>` continua valendo como recurso quando o
       * corpo não é JSON.
       */
      let codigo = `http_${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (typeof parsed.error === 'string' && parsed.error) codigo = parsed.error;
      } catch {
        // Corpo não-JSON: o status já diz o bastante.
      }
      return { error: codigo, _httpStatus: response.status, _body: text };
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

/** O token foi revogado, ou a credencial do app não vale mais. Não tem Retry. */
export function isInvalidGrant(err: string | undefined): boolean {
  return err === 'invalid_grant' || err === 'unauthorized_client' || err === 'invalid_token';
}

/** Falha passageira: vale tentar de novo, e vale mostrar como "tente de novo". */
export function isTemporaryError(err: string | undefined, httpStatus?: number): boolean {
  if (!err) return false;
  if (httpStatus === 429) return true;
  if (httpStatus !== undefined && httpStatus >= 500) return true;
  return err === 'temporarily_unavailable' || err === 'timeout' || err === 'server_error';
}

/**
 * Quanto tempo o access token vale, com uma folga.
 *
 * O Google manda `expires_in` em segundos, normalmente 3600. A folga de 60s é
 * para o token não vencer no meio de um download de vídeo, que pode levar
 * minutos em um arquivo grande.
 */
export function expiraEmMs(expiresIn: number | undefined): number {
  const seg = Math.max(30, Math.min(Number(expiresIn ?? 3600), 7200) - 60);
  return seg * 1000;
}
