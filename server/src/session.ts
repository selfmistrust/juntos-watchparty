import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { customAlphabet } from 'nanoid';

const COOKIE = 'juntos_sid';
const ID_LEN = 24;
const ID_PATTERN = /^[a-z0-9]+$/;
const newId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', ID_LEN);

export const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? 'http://localhost:3000,http://localhost:3001')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function sessionSecret(): string {
  return process.env.SESSION_SECRET ?? '';
}

export function sessionConfigured(): boolean {
  return sessionSecret().length > 0;
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length === ID_LEN && ID_PATTERN.test(value);
}

function sign(id: string): string {
  const secret = sessionSecret();
  if (!secret) throw new Error('missing_session_secret');
  return crypto.createHmac('sha256', secret).update(id).digest('base64url');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      // Um cookie malformado não deve derrubar todas as requisições da API.
    }
  }
  return out;
}

function parseSigned(raw: string | undefined): string | null {
  if (!raw || !sessionSecret()) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!isValidSessionId(id)) return null;
  if (!timingSafeEqualStr(mac, sign(id))) return null;
  return id;
}

function cookieSameSiteAndSecure(): { sameSite: 'Lax' | 'None'; secure: boolean; useHostPrefix: boolean } {
  const redirect = process.env.GOOGLE_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 4000}`;
  let apiUrl: URL | null = null;
  try {
    apiUrl = new URL(redirect);
  } catch {
    // A configuração inválida será tratada quando a rota OAuth for usada.
  }

  const crossSite = CLIENT_ORIGINS.some((origin) => {
    try {
      const clientUrl = new URL(origin);
      // SameSite é schemeful: mudar http para https também torna a requisição
      // cross-site. A porta, por outro lado, não participa do conceito.
      return !apiUrl || clientUrl.hostname !== apiUrl.hostname || clientUrl.protocol !== apiUrl.protocol;
    } catch {
      return true;
    }
  });

  const secure = process.env.NODE_ENV === 'production' || apiUrl?.protocol === 'https:';
  if (crossSite) return { sameSite: 'None', secure: true, useHostPrefix: true };
  return { sameSite: 'Lax', secure, useHostPrefix: false };
}

export function setSessionCookie(res: Response, sessionId: string): void {
  if (!isValidSessionId(sessionId)) throw new Error('invalid_session_id');
  if (!sessionSecret()) throw new Error('missing_session_secret');

  const value = `${sessionId}.${sign(sessionId)}`;
  const { sameSite, secure, useHostPrefix } = cookieSameSiteAndSecure();
  const cookieName = useHostPrefix ? `__Host-${COOKIE}` : COOKIE;
  const parts = [
    `${cookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    'Max-Age=31536000',
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function readSessionId(req: Request): string | null {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const cookieName = CLIENT_ORIGINS.some((origin) => {
      try {
        const clientUrl = new URL(origin);
        const redirect = process.env.GOOGLE_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 4000}`;
        let apiUrl: URL | null = null;
        try { apiUrl = new URL(redirect); } catch {}
        return !apiUrl || clientUrl.hostname !== apiUrl.hostname || clientUrl.protocol !== apiUrl.protocol;
      } catch { return true; }
    }) ? `__Host-${COOKIE}` : COOKIE;
    return parseSigned(cookies[cookieName]);
  } catch {
    return null;
  }
}

export function ensureSessionId(req: Request, res: Response): string {
  const existing = readSessionId(req);
  if (existing) return existing;
  if (!sessionSecret()) throw new Error('missing_session_secret');
  const id = newId();
  setSessionCookie(res, id);
  return id;
}

export function isTrustedOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) return CLIENT_ORIGINS.includes(origin);

  const referer = req.headers.referer;
  if (typeof referer !== 'string' || !referer) return false;
  try {
    return CLIENT_ORIGINS.includes(new URL(referer).origin);
  } catch {
    return false;
  }
}

function fallbackClientUrl(): string {
  return CLIENT_ORIGINS[0] ?? 'http://localhost:3000';
}

export function safeReturnUrl(raw: string | undefined): string {
  if (!raw) return fallbackClientUrl();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallbackClientUrl();
    if (url.username || url.password) return fallbackClientUrl();
    if (!CLIENT_ORIGINS.includes(url.origin)) return fallbackClientUrl();
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return fallbackClientUrl();
  }
}

export function withYoutubeQuery(returnTo: string, value: string): string {
  try {
    const url = new URL(returnTo);
    url.searchParams.set('youtube', value);
    return url.toString();
  } catch {
    return withYoutubeQuery(fallbackClientUrl(), value);
  }
}

export { COOKIE as SESSION_COOKIE };
