import type { Express, Request, Response } from 'express';
import { paginaConcluido } from './youtubeConcluido.js';
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

  /*
   * Onde o navegador volta quando o fluxo termina.
   *
   * No app desktop o login roda no navegador do sistema — o Google recusa
   * autenticar dentro da janela do Electron — e sem isto o callback abriria ali
   * uma segunda cópia do app, que não é o que a pessoa está usando. Com isto, o
   * navegador mostra uma tela de conclusão e a janela do desktop se atualiza
   * quando recebe o foco.
   *
   * `pagina` é o nome que o cliente usa; qualquer outra coisa, ou a ausência do
   * parâmetro, mantém o comportamento de sempre, que é voltar para o app.
   */
  const destinoDe = (voltarComo: 'app' | 'pagina' | undefined, estado: string, returnTo: string) =>
    voltarComo === 'pagina'
      ? `/api/youtube/oauth/concluido?estado=${encodeURIComponent(estado)}`
      : withYoutubeQuery(returnTo, estado);

  app.get('/api/youtube/oauth/concluido', (req, res) => {
    const { status, html } = paginaConcluido(
      typeof req.query.estado === 'string' ? req.query.estado : undefined,
    );
    res.status(status);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  });

  /**
   * Cria o fluxo e devolve a URL do Google em JSON, em vez de redirecionar.
   *
   * ## Por que existe
   *
   * O app desktop precisa do Google no navegador do sistema, e o Google recusa
   * autenticar dentro da janela do Electron. Só que, se o `/start` for seguido
   * como redirecionamento a partir da janela, ele **também** vai para o
   * navegador do sistema — e o navegador do sistema não tem o cookie
   * `juntos_sid` do Electron. O `ensureSessionId` então forjava uma sessão nova,
   * o registro `pending` nasce com ela, e a conta é conectada **à sessão do
   * navegador**. A tela de conclusão dizia "conta conectada" e o app desktop
   * continuava sem conta nenhuma, porque estava perguntando à sessão dele.
   *
   * Pedindo a URL em JSON, o `/start` é feito **pelo renderer**, que tem o
   * cookie, e só a URL do Google é entregue ao navegador. O `pending` nasce com
   * a sessão do app, que é quem vai perguntar pelo estado depois.
   *
   * Efeito colateral bom: o navegador do sistema nunca recebe a sessão, então a
   * conta do YouTube não fica pendurada num cookie dele.
   */
  app.post('/api/youtube/oauth/start', async (req, res) => {
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    if (!youtubeOAuthConfigured() || !sessionConfigured()) {
      return res.status(503).json({ error: 'not_configured' });
    }
    try {
      const body = (req.body ?? {}) as { returnTo?: unknown; voltar?: unknown };
      const returnTo = safeReturnUrl(typeof body.returnTo === 'string' ? body.returnTo : undefined);
      const voltarComo = body.voltar === 'pagina' ? 'pagina' : 'app';
      const sessionId = ensureSessionId(req, res);
      const url = await createAuthUrl(sessionId, returnTo, voltarComo);
      if (!url) return res.status(503).json({ error: 'not_configured' });
      res.set('Cache-Control', 'no-store');
      res.json({ url });
    } catch (err) {
      console.error('[youtube-oauth] falha ao iniciar autorização', err);
      res.status(500).json({ error: 'start_failed' });
    }
  });

  app.get('/api/youtube/oauth/start', async (req, res) => {
    const returnTo = safeReturnUrl(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
    const voltarComo = req.query.voltar === 'pagina' ? 'pagina' : 'app';
    if (!youtubeOAuthConfigured() || !sessionConfigured()) {
      return res.redirect(destinoDe(voltarComo, 'not_configured', returnTo));
    }
    try {
      const sessionId = ensureSessionId(req, res);
      const url = await createAuthUrl(sessionId, returnTo, voltarComo);
      if (!url) return res.redirect(destinoDe(voltarComo, 'not_configured', returnTo));
      res.redirect(302, url);
    } catch {
      console.error('[youtube-oauth] falha ao iniciar autorização');
      res.redirect(destinoDe(voltarComo, 'error', returnTo));
    }
  });

  app.get('/api/youtube/oauth/callback', async (req, res) => {
    const fallback = CLIENT_ORIGINS[0] ?? 'http://localhost:3000';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';

    const pending = await takePending(state);
    const returnTo = pending?.returnTo ?? fallback;
    // Sem `pending` não há como saber se o cliente pediu a tela de conclusão, e
    // o `fallback` é um app: é para lá que um state inválido deve voltar.
    const voltarComo = pending?.voltarComo ?? 'app';

    if (errorParam === 'access_denied') {
      return res.redirect(destinoDe(voltarComo, 'denied', returnTo));
    }
    if (errorParam) {
      console.error('[youtube-oauth] Google recusou a autorização:', errorParam);
      return res.redirect(destinoDe(voltarComo, 'error', returnTo));
    }
    if (!pending || !code) {
      return res.redirect(destinoDe(voltarComo, 'error', returnTo));
    }

    /*
     * A sessão vem do registro `pending`, e não do cookie deste request.
     *
     * Quem autentica o callback é o `state`: 32 caracteres de alfabeto próprio,
     * guardados no Redis, de uso único e com prazo. Quem chega com um `state`
     * válido está continuando o fluxo que aquela mesma sessão começou — o
     * `code_verifier` do PKCE está no mesmo registro, e o Google só emite código
     * para o `client_id` cadastrado. É o que impede o CSRF clássico, em que
     * alguém tenta pendurar a conta dele na sessão da vítima.
     *
     * Antes o callback exigia que o cookie batesse com o `pending`, e isso
     * quebrava o app desktop. A autorização acontece no navegador do sistema,
     * que não tem o cookie jar do Electron: a conexão era guardada e logo em
     * seguida rejeitada, e a pessoa voltava para o app sem conta nenhuma. No
     * navegador funciona, porque lá o cookie viaja na mesma navegação — o bug
     * só aparecia no desktop, que é justamente onde o fluxo sai da janela.
     *
     * O cookie continua sendo gravado quando é o mesmo, para o navegador que
     * fez o fluxo ficar logado. Quando é outro — o caso do desktop — isso não
     * tem como ser coincidência de outra pessoa, e a sessão do `state` é a
     * certaina.
     */
    const cookieSession = readSessionId(req);
    if (cookieSession !== pending.sessionId) {
      console.log('[youtube-oauth] callback sem o cookie da sessão; seguindo a do state');
    }

    setSessionCookie(res, pending.sessionId);

    try {
      const result = await completeOAuth({
        sessionId: pending.sessionId,
        code,
        codeVerifier: pending.codeVerifier,
      });
      if (!result.ok) {
        return res.redirect(
          destinoDe(voltarComo, result.reason === 'denied' ? 'denied' : 'error', returnTo),
        );
      }
      res.redirect(destinoDe(voltarComo, 'connected', returnTo));
    } catch {
      console.error('[youtube-oauth] falha inesperada no callback');
      res.redirect(destinoDe(voltarComo, 'error', returnTo));
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
