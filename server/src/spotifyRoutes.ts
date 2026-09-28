import type { Express, Request, Response } from 'express';
import {
  CLIENT_ORIGINS,
  ensureSessionId,
  isTrustedOrigin,
  readSessionId,
  safeReturnUrl,
  sessionConfigured,
  setSessionCookie,
} from './session.js';
import {
  completeOAuth,
  createAuthUrl,
  disconnect,
  getStatus,
  getValidAccessToken,
  listTracks,
  search,
  spotifyConfigured,
  takePending,
} from './spotifyOAuth.js';

function jsonError(res: Response, http: number, error: string) {
  res.status(http).json({ error });
}

/**
 * Rotas do Spotify.
 *
 * A superfície é a mesma do YouTube, de propósito: `status`, `oauth/start`,
 * `oauth/callback`, `oauth/disconnect` e `search`. Duas rotas a mais, e as duas
 * existem por uma limitação da plataforma, não por conveniência:
 *
 *  - `access-token`, porque o Web Playback SDK chama `getOAuthToken` **na
 *    página** e não há como entregar token por outro caminho. O refresh token
 *    continua preso aqui.
 *  - `album/:uri/tracks`, porque álbum e playlist são containers: quem escolhe
 *    um disco na busca quer as faixas dele, e não o disco como uma faixa só.
 */
/**
 * Corpo comum aos dois inícios de OAuth.
 *
 * Fica antes do `registerSpotifyRoutes` porque é uma função de uso único, e
 * declará-la no meio do registro de rotas deixa a leitura fingir que acabou ali.
 */
async function iniciarOAuth(req: Request, res: Response, returnToBruto: string): Promise<void> {
  try {
    if (!spotifyConfigured()) {
      res.status(503).send('spotify_not_configured');
      return;
    }
    const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
    if (!sessionId) {
      res.status(400).send('session_required');
      return;
    }
    const returnTo = safeReturnUrl(returnToBruto);
    const url = await createAuthUrl(sessionId, returnTo);
    if (!url) {
      res.status(503).send('spotify_not_configured');
      return;
    }
    if (sessionConfigured()) setSessionCookie(res, sessionId);
    res.redirect(url);
  } catch (err) {
    console.error('[spotify] oauth/start falhou', err);
    res.status(500).send('spotify_oauth_start_failed');
  }
}

export function registerSpotifyRoutes(app: Express): void {
  app.get('/api/spotify/status', async (req, res) => {
    try {
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      res.json(await getStatus(sessionId));
    } catch (err) {
      console.error('[spotify] status falhou', err);
      res.status(500).json({ error: 'spotify_status_failed' });
    }
  });

  app.post('/api/spotify/oauth/start', async (req, res) => {
    /*
     * O `POST` existe para o **desktop**: ele pede a URL por fetch, que leva o
     * cookie de sessão, e entrega só a URL ao navegador do sistema. O navegador
     * do sistema não tem esse cookie, então navegar para cá criaria uma sessão
     * nova e a conta ficaria ligada a ela.
     *
     * Aqui a resposta é o mesmo redirect do `GET`. A diferença é que o chamador
     * do `POST` já está em fetch e trata o corpo; devolver a URL em JSON exigiria
     * duas implementações da mesma coisa, e quem chamasse o `POST` do jeito
     * errado receberia um redirect no lugar do JSON.
     */
    await iniciarOAuth(req, res, '');
  });

  /**
   * O mesmo início, por `GET`.
   *
   * No navegador a pessoa é levada ao login com `location.assign`, e isso é um
   * `GET` — não dá para pedir um `POST` com `location`. É o mesmo motivo pelo
   * qual o YouTube tem as duas rotas.
   *
   * O destino de volta vem da query porque num `GET` não há corpo; `safeReturnUrl`
   * valida a origem nos dois caminhos, então a query não abre brecha.
   */
  app.get('/api/spotify/oauth/start', async (req, res) => {
    await iniciarOAuth(req, res, String(req.query.returnTo ?? ''));
  });

  /**
   * O callback do Spotify vem abrir em nova aba, e essa aba não tem o cookie de
   * sessão de primeira partida. Por isso a sessão viaja no `state`, guardado no
   * Redis no passo do `start` — é o mesmo mecanismo do YouTube, e ele existe
   * pelo mesmo motivo: sem ele, o callback não saberia de quem é a autorização.
   */
  app.get('/api/spotify/oauth/callback', async (req, res) => {
    try {
      const state = String(req.query.state ?? '');
      const code = String(req.query.code ?? '');
      const erro = String(req.query.error ?? '');
      const pending = await takePending(state);

      if (!pending) {
        return jsonError(res, 400, 'spotify_state_invalid');
      }
      if (erro) {
        res.redirect(pending.returnTo || '/');
        return;
      }
      if (!code) return jsonError(res, 400, 'spotify_code_missing');

      const result = await completeOAuth({
        sessionId: pending.sessionId,
        code,
        codeVerifier: pending.codeVerifier,
      });
      if (!result.ok) {
        console.error('[spotify] oauth falhou:', result.error);
        res.redirect(pending.returnTo || '/');
        return;
      }
      res.redirect(pending.returnTo || '/');
    } catch (err) {
      console.error('[spotify] callback falhou', err);
      res.status(500).json({ error: 'spotify_callback_failed' });
    }
  });

  app.post('/api/spotify/oauth/disconnect', async (req: Request, res: Response) => {
    try {
      if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden');
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      if (!sessionId) return jsonError(res, 400, 'session_required');
      await disconnect(sessionId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[spotify] disconnect falhou', err);
      res.status(500).json({ error: 'spotify_disconnect_failed' });
    }
  });

  /**
   * Access token curto, para o SDK na página.
   *
   * É a única rota daqui que entrega um segredo ao navegador, e ela existe só
   * porque o `getOAuthToken` do Web Playback SDK roda no cliente. O token vive
   * uma hora e renova sozinho; o refresh token nunca sai daqui.
   */
  app.get('/api/spotify/access-token', async (req, res) => {
    try {
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      if (!sessionId) return jsonError(res, 400, 'session_required');
      const result = await getValidAccessToken(sessionId);
      if (!result.ok) return jsonError(res, result.reason === 'revoked' ? 401 : 403, result.reason);
      res.json({ token: result.token });
    } catch (err) {
      console.error('[spotify] access-token falhou', err);
      res.status(500).json({ error: 'spotify_token_failed' });
    }
  });

  app.get('/api/spotify/search', async (req, res) => {
    try {
      const term = String(req.query.q ?? '').trim();
      if (term.length < 2) return res.json({ items: [] });
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      if (!sessionId) return jsonError(res, 400, 'session_required');
      const result = await search(sessionId, term);
      if (!result.ok) return jsonError(res, 403, result.reason);
      res.json({ items: result.items });
    } catch (err) {
      console.error('[spotify] search falhou', err);
      res.status(502).json({ error: 'spotify_search_failed' });
    }
  });

  app.get('/api/spotify/tracks', async (req, res) => {
    try {
      const uri = String(req.query.uri ?? '').trim();
      // Só o que a Web API de catálogo devolve. Um `uri` de outro host viria do
      // cliente, e sem esta trava ele viraria um proxy SSRF genérico.
      if (!/^spotify:(album|playlist):[A-Za-z0-9]+$/.test(uri)) {
        return jsonError(res, 400, 'spotify_uri_invalid');
      }
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      if (!sessionId) return jsonError(res, 400, 'session_required');
      const result = await listTracks(sessionId, uri);
      if (!result.ok) return jsonError(res, 403, result.reason);
      res.json({ items: result.items });
    } catch (err) {
      console.error('[spotify] tracks falhou', err);
      res.status(502).json({ error: 'spotify_tracks_failed' });
    }
  });
}
