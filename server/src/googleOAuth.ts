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
  | 'expired'
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
