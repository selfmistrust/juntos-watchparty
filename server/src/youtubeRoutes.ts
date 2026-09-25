import type { Express, Request, Response } from 'express';
import {
  CLIENT_ORIGINS,
  ensureSessionId,
  isTrustedOrigin,
  readSessionId,
  safeReturnUrl,
  sessionConfigured,
  setSessionCookie,
  withYoutubeQuery,
} from './session.js';
import {
  completeOAuth,
  createAuthUrl,
  getPublicStatus,
  revokeAndDelete,
  searchYoutube,
  takePending,
  youtubeOAuthConfigured,
} from './youtubeOAuth.js';

function jsonError(res: Response, http: number, error: string) {
  res.status(http).json({ error });
}

export function registerYoutubeRoutes(app: Express): void {
  app.get('/api/youtube/status', async (req, res) => {
    try {
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      const status = await getPublicStatus(sessionId);
      res.set('Cache-Control', 'private, no-store');
      res.json(status);
    } catch {
      jsonError(res, 500, 'status_unavailable');
    }
  });

  app.get('/api/youtube/oauth/start', async (req, res) => {
    const returnTo = safeReturnUrl(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
    if (!youtubeOAuthConfigured() || !sessionConfigured()) {
      return res.redirect(withYoutubeQuery(returnTo, 'not_configured'));
    }
    try {
      const sessionId = ensureSessionId(req, res);
      const url = await createAuthUrl(sessionId, returnTo);
      if (!url) return res.redirect(withYoutubeQuery(returnTo, 'not_configured'));
      res.redirect(302, url);
    } catch {
      console.error('[youtube-oauth] falha ao iniciar autorização');
      res.redirect(withYoutubeQuery(returnTo, 'error'));
    }
  });

  app.get('/api/youtube/oauth/callback', async (req, res) => {
    const fallback = CLIENT_ORIGINS[0] ?? 'http://localhost:3000';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';

    const pending = await takePending(state);
    const returnTo = pending?.returnTo ?? fallback;

    if (errorParam === 'access_denied') {
      return res.redirect(withYoutubeQuery(returnTo, 'denied'));
    }
    if (errorParam) {
      console.error('[youtube-oauth] Google recusou a autorização:', errorParam);
      return res.redirect(withYoutubeQuery(returnTo, 'error'));
    }
    if (!pending || !code) {
      return res.redirect(withYoutubeQuery(returnTo, 'error'));
    }

    const cookieSession = readSessionId(req);
    if (!cookieSession || cookieSession !== pending.sessionId) {
      console.error('[youtube-oauth] sessão do callback inválida ou ausente');
      return res.redirect(withYoutubeQuery(returnTo, 'error'));
    }

    setSessionCookie(res, pending.sessionId);

    try {
      const result = await completeOAuth({
        sessionId: pending.sessionId,
        code,
        codeVerifier: pending.codeVerifier,
      });
      if (!result.ok) {
        return res.redirect(withYoutubeQuery(returnTo, result.reason === 'denied' ? 'denied' : 'error'));
      }
      res.redirect(withYoutubeQuery(returnTo, 'connected'));
    } catch {
      console.error('[youtube-oauth] falha inesperada no callback');
      res.redirect(withYoutubeQuery(returnTo, 'error'));
    }
  });

  app.post('/api/youtube/oauth/disconnect', async (req: Request, res: Response) => {
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) {
      res.json({ connected: false });
      return;
    }
    try {
      const result = await revokeAndDelete(sessionId);
      if (!result.ok) return jsonError(res, 500, 'disconnect_failed');
      res.json({ connected: false });
    } catch {
      jsonError(res, 500, 'disconnect_failed');
    }
  });

  app.get('/api/youtube/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ items: [] });
    const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
    try {
      const result = await searchYoutube(sessionId, q);
      if (result.ok) return res.json({ items: result.items });
      jsonError(res, result.http, result.error);
    } catch {
      jsonError(res, 502, 'youtube_unavailable');
    }
  });
}
