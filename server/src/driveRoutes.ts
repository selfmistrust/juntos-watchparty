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
  deleteTokens,
  downloadUrlDe,
  driveOAuthConfigured,
  getPublicStatus,
  getValidAccessToken,
  listarVideos,
  revokeAndDelete,
  takePending,
} from './driveOAuth.js';

function jsonError(res: Response, http: number, error: string) {
  res.status(http).json({ error });
}

/** Quantos vídeos uma busca devolve. O Drive pagina, e isto não é um DataGrid. */
const MAX_ARQUIVOS = 50;

export function registerDriveRoutes(app: Express): void {
  /*
   * Mesma regra do YouTube, e pelo mesmo motivo: o app desktop pede a URL em
   * JSON porque o `/start` dele não pode ser buscado pelo navegador do sistema,
   * que forjaria uma sessão nova e ligaria a conta a ela.
   */
  const destinoDe = (voltarComo: 'app' | 'pagina' | undefined, estado: string, returnTo: string) =>
    voltarComo === 'pagina'
      ? `/api/drive/oauth/concluido?estado=${encodeURIComponent(estado)}`
      : withYoutubeQuery(returnTo, estado);

  app.get('/api/drive/status', async (req, res) => {
    try {
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      const status = await getPublicStatus(sessionId);
      res.set('Cache-Control', 'private, no-store');
      res.json(status);
    } catch {
      jsonError(res, 500, 'status_unavailable');
    }
  });

  app.post('/api/drive/oauth/start', async (req, res) => {
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    if (!driveOAuthConfigured() || !sessionConfigured()) {
      return res.status(503).json({ error: 'not_configured' });
    }
    try {
      const body = (req.body ?? {}) as { returnTo?: unknown; voltar?: unknown };
      const returnTo = safeReturnUrl(
        typeof body.returnTo === 'string' ? body.returnTo : undefined,
      );
      const voltarComo = body.voltar === 'pagina' ? 'pagina' : 'app';
      const sessionId = ensureSessionId(req, res);
      const url = await createAuthUrl(sessionId, returnTo, voltarComo);
      if (!url) return res.status(503).json({ error: 'not_configured' });
      res.set('Cache-Control', 'no-store');
      res.json({ url });
    } catch (err) {
      console.error('[drive-oauth] falha ao iniciar autorização', err);
      res.status(500).json({ error: 'start_failed' });
    }
  });

  app.get('/api/drive/oauth/start', async (req, res) => {
    const returnTo = safeReturnUrl(
      typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined,
    );
    const voltarComo = req.query.voltar === 'pagina' ? 'pagina' : 'app';
    if (!driveOAuthConfigured() || !sessionConfigured()) {
      return res.redirect(destinoDe(voltarComo, 'not_configured', returnTo));
    }
    try {
      const sessionId = ensureSessionId(req, res);
      const url = await createAuthUrl(sessionId, returnTo, voltarComo);
      if (!url) return res.redirect(destinoDe(voltarComo, 'not_configured', returnTo));
      res.redirect(302, url);
    } catch {
      console.error('[drive-oauth] falha ao iniciar autorização');
      res.redirect(destinoDe(voltarComo, 'error', returnTo));
    }
  });

  app.get('/api/drive/oauth/callback', async (req, res) => {
    const fallback = CLIENT_ORIGINS[0] ?? 'http://localhost:3000';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';

    const pending = await takePending(state);
    const returnTo = pending?.returnTo ?? fallback;
    const voltarComo = pending?.voltarComo ?? 'app';

    if (errorParam === 'access_denied') {
      return res.redirect(destinoDe(voltarComo, 'denied', returnTo));
    }
    if (errorParam) {
      console.error('[drive-oauth] Google recusou a autorização:', errorParam);
      return res.redirect(destinoDe(voltarComo, 'error', returnTo));
    }
    if (!pending || !code) {
      return res.redirect(destinoDe(voltarComo, 'error', returnTo));
    }

    // A sessão vem do `pending`, e não do cookie deste request. Quem autentica é
    // o `state`, de uso único e com prazo, guardado junto do `code_verifier` do
    // PKCE. O mesmo raciocínio do YouTube, e pela mesma razão: no desktop a
    // autorização acontece no navegador do sistema, que não tem o cookie jar do
    // app.
    const cookieSession = readSessionId(req);
    if (cookieSession !== pending.sessionId) {
      console.log('[drive-oauth] callback sem o cookie da sessão; seguindo a do state');
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
      console.error('[drive-oauth] falha inesperada no callback');
      res.redirect(destinoDe(voltarComo, 'error', returnTo));
    }
  });

  /**
   * Os vídeos da conta.
   *
   * Só lista metadados. Os bytes não passam por aqui em momento nenhum — é o
   * navegador de quem escolheu que baixa do Drive e sobe no bucket da sala.
   */
  app.get('/api/drive/arquivos', async (req, res) => {
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) return jsonError(res, 401, 'no_session');

    const token = await getValidAccessToken(sessionId);
    if (!token.ok) return jsonError(res, token.reason === 'not_connected' ? 401 : 502, token.reason);

    const busca = typeof req.query.busca === 'string' ? req.query.busca.slice(0, 120) : undefined;
    const result = await listarVideos(token.accessToken, busca);
    if (!result.ok) {
      // Um 401 do Google aqui significa token revogado do lado de lá. Apagar o
      // local evita que o card fique mostrando "conectada" para sempre, que é o
      // que acontecia sem isto.
      if (result.reason === 'unauthorized') await deleteTokens(sessionId);
      return jsonError(res, result.reason === 'unauthorized' ? 401 : 502, result.reason);
    }
    res.set('Cache-Control', 'private, no-store');
    res.json({ files: result.files.slice(0, MAX_ARQUIVOS) });
  });

  /**
   * Access token e URL de download, para o navegador de quem escolheu o arquivo.
   *
   * ## Por que o token sai daqui
   *
   * O `alt=media` do Drive não aceita URL assinada: ou o caller manda o
   * `Authorization: Bearer`, ou ele não recebe os bytes. E a alternativa — o
   * servidor fazer proxy do download — puxaria o vídeo inteiro pelo Render, que
   * é exatamente o que esta integração existe para evitar.
   *
   * Então o token vai para o renderer. O que **não** vai é o refresh token: ele
   * fica no Redis, e o renderer recebe só o access token, que o Google expira em
   * uma hora. Um vazamento de token de leitura do Drive, com o `drive.readonly`,
   * é ruim; um vazamento de refresh token seria pior e não acontece.
   *
   * O arquivo escolhido é revalidado contra a lista antes de responder, para
   * que a URL não aceite um id que a pessoa não enxerga. Sem isso, o endpoint
   * seria um "baixe qualquer id que você souber".
   */
  app.post('/api/drive/arquivo/:id/baixar', async (req: Request, res: Response) => {
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) return jsonError(res, 401, 'no_session');

    const id = String(req.params.id ?? '');
    const alvo = downloadUrlDe(id);
    if ('erro' in alvo) return jsonError(res, 400, 'bad_file');

    const token = await getValidAccessToken(sessionId);
    if (!token.ok) return jsonError(res, token.reason === 'not_connected' ? 401 : 502, token.reason);

    // A lista é a única forma de confirmar que o arquivo é um vídeo desta
    // conta. Custa uma chamada e é o que impede este endpoint de virar um
    // "baixe qualquer coisa do meu Drive pelo id".
    const listados = await listarVideos(token.accessToken);
    if (!listados.ok) {
      if (listados.reason === 'unauthorized') await deleteTokens(sessionId);
      return jsonError(res, listados.reason === 'unauthorized' ? 401 : 502, listados.reason);
    }
    const arquivo = listados.files.find((f) => f.id === id);
    if (!arquivo) return jsonError(res, 404, 'not_found');

    res.set('Cache-Control', 'no-store');
    res.json({
      url: alvo.url,
      token: token.accessToken,
      name: arquivo.name,
      mimeType: arquivo.mimeType,
      size: arquivo.size,
      durationMs: arquivo.durationMs,
    });
  });

  app.get('/api/drive/oauth/concluido', (req, res) => {
    const { status, html } = paginaConcluido(
      typeof req.query.estado === 'string' ? req.query.estado : undefined,
    );
    res.status(status);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  });

  app.post('/api/drive/oauth/disconnect', async (req: Request, res: Response) => {
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) {
      res.json({ connected: false });
      return;
    }
    try {
      await revokeAndDelete(sessionId);
      res.set('Cache-Control', 'no-store');
      res.json({ connected: false });
    } catch {
      jsonError(res, 500, 'disconnect_failed');
    }
  });
}
