import type { Express, Request, Response } from 'express';
import { paginaDriveConcluido } from './driveConcluido.js';
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
  cancelPickerRequest,
  completeOAuth,
  createAuthUrl,
  createPickerRequest,
  driveOAuthConfigured,
  finishPickerRequest,
  getPickerResult,
  getPublicStatus,
  getValidAccessToken,
  revokeAndDelete,
  takePending,
  type DrivePickerResult,
} from './driveOAuth.js';

import {
  apagarStream,
  abrirArquivo,
  corpoComoStream,
  criarStream,
  extrairTokenDeSrc,
  lerStream,
  rangeDe,
  repassarCabecalhos,
  type DriveStreamFailure,
} from './driveStream.js';

/** Motivo de recusa virado em resposta HTTP, para o painel saber o que dizer. */
function motivoDe(reason: DriveStreamFailure): { http: number; error: string } {
  switch (reason) {
    case 'not_connected':
      return { http: 401, error: 'not_connected' };
    case 'bad_file':
      return { http: 400, error: 'bad_file' };
    case 'not_a_video':
      return { http: 422, error: 'not_a_video' };
    case 'no_download':
      return { http: 422, error: 'no_download' };
    default:
      return { http: 502, error: 'drive_unreachable' };
  }
}

function jsonError(res: Response, http: number, error: string) {
  res.status(http).json({ error });
}

export function registerDriveRoutes(app: Express): void {
  /*
   * Mesma regra do YouTube, e pelo mesmo motivo: o app desktop pede a URL em
   * JSON porque o `/start` dele não pode ser buscado pelo navegador do sistema,
   * que forjaria uma sessão nova e ligaria a conta a ela.
   */
  const destinoDe = (voltarComo: 'app' | 'pagina', estado: string, returnTo: string) => {
    if (voltarComo === 'pagina') return `/api/drive/oauth/concluido?estado=${encodeURIComponent(estado)}`;
    const url = new URL(returnTo);
    url.searchParams.set('drive', estado);
    return url.toString();
  };

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

  // O POST nasce no app com seu cookie. O navegador recebe apenas a URL do
  // Google; os cookies dele não identificam a sessão que receberá a seleção.
  app.post('/api/drive/picker/start', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    if (!driveOAuthConfigured() || !sessionConfigured()) return jsonError(res, 503, 'not_configured');
    try {
      const sessionId = ensureSessionId(req, res);
      const returnTo = safeReturnUrl(typeof req.body?.returnTo === 'string' ? req.body.returnTo : undefined);
      const picker = await createPickerRequest(sessionId, returnTo);
      if (!picker) return jsonError(res, 503, 'not_configured');
      res.json(picker);
    } catch {
      jsonError(res, 500, 'picker_start_failed');
    }
  });

  app.get('/api/drive/picker/:id', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) return jsonError(res, 401, 'no_session');
    try {
      const result = await getPickerResult(sessionId, req.params.id);
      if (!result) return jsonError(res, 410, 'picker_expired');
      res.json(result);
    } catch {
      jsonError(res, 500, 'picker_status_failed');
    }
  });

  app.delete('/api/drive/picker/:id', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) return jsonError(res, 401, 'no_session');
    try {
      await cancelPickerRequest(sessionId, req.params.id);
      res.sendStatus(204);
    } catch {
      jsonError(res, 500, 'picker_cancel_failed');
    }
  });

  app.get('/api/drive/oauth/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const fallback = CLIENT_ORIGINS[0] ?? 'http://localhost:3000';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';

    let pending: Awaited<ReturnType<typeof takePending>> = null;
    try {
      pending = await takePending(state);
      if (!pending) return res.redirect(destinoDe('pagina', 'expired', fallback));
      const { sessionId, returnTo, voltarComo, pickerId } = pending;
      const concluir = async (estado: string, result: Exclude<DrivePickerResult, { status: 'pending' }>) => {
        if (pickerId && !(await finishPickerRequest(sessionId, pickerId, result))) estado = 'expired';
        return res.redirect(destinoDe(voltarComo, estado, returnTo));
      };

      if (pickerId && (await getPickerResult(sessionId, pickerId))?.status !== 'pending') {
        return res.redirect(destinoDe('pagina', 'expired', returnTo));
      }
      if (errorParam === 'access_denied') {
        return await concluir(pickerId ? 'cancelled' : 'denied', { status: 'cancelled' });
      }
      if (errorParam || !code) return await concluir('error', { status: 'error' });

      const fileId = typeof req.query.picked_file_ids === 'string' ? req.query.picked_file_ids : '';
      if (pickerId) {
        if (!fileId) return await concluir('cancelled', { status: 'cancelled' });
        // O Picker externo pede um único vídeo. O ID será consultado na Drive
        // API com o token da sessão antes de qualquer cópia para a sala.
        if (!/^[A-Za-z0-9_-]{10,256}$/.test(fileId)) return await concluir('error', { status: 'error' });
      }

      const result = await completeOAuth({
        sessionId,
        code,
        codeVerifier: pending.codeVerifier,
      });
      if (!result.ok) {
        return await concluir(result.reason === 'denied' ? 'denied' : 'error', { status: 'error' });
      }
      // No desktop, o state identifica o app e o navegador mantém a própria
      // sessão. No fluxo web, o callback restaura o cookie na mesma aba.
      if (voltarComo === 'app') setSessionCookie(res, sessionId);
      if (pickerId) return await concluir('picked', { status: 'picked', fileId });
      res.redirect(destinoDe(voltarComo, 'connected', returnTo));
    } catch {
      console.error('[drive-oauth] falha inesperada no callback');
      if (pending?.pickerId) {
        await finishPickerRequest(pending.sessionId, pending.pickerId, { status: 'error' }).catch(() => {});
      }
      res.redirect(destinoDe(pending?.voltarComo ?? 'pagina', 'error', pending?.returnTo ?? fallback));
    }
  });

  /** Access token curto para o Picker e para o download direto pelo navegador. */
  app.get('/api/drive/picker-token', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) return jsonError(res, 401, 'no_session');

    try {
      const token = await getValidAccessToken(sessionId);
      if (!token.ok) return jsonError(res, ['not_connected', 'revoked'].includes(token.reason) ? 401 : 502, token.reason);
      res.json({ accessToken: token.accessToken });
    } catch {
      jsonError(res, 500, 'token_unavailable');
    }
  });

  /**
   * Concede a reprodução de um arquivo escolhido no Picker.
   *
   * O `fileId` vem do cliente porque foi a pessoa que escolheu, mas é validado
   * contra a concessão dela: sem Drive conectado, ou para um id que não é
   * vídeo, a resposta é um motivo — nunca uma URL. O `path` volta relativo de
   * propósito, para o cliente compor com o `SERVER_URL` que ele já tem, tanto
   * no navegador quanto no app desktop.
   */
  app.post('/api/drive/stream-token', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) return jsonError(res, 401, 'no_session');
    try {
      const fileId = typeof req.body?.fileId === 'string' ? req.body.fileId : '';
      const result = await criarStream(sessionId, fileId);
      if (!result.ok) {
        const { http, error } = motivoDe(result.reason);
        return jsonError(res, http, error);
      }
      res.json(result.target);
    } catch (err) {
      console.error('[drive-stream] falha ao conceder reprodução', err);
      jsonError(res, 500, 'stream_token_failed');
    }
  });

  /**
   * A mídia em si: encaminha o `Range` do `<video>` para o Drive e repassa os
   * bytes, sem nunca juntar o arquivo inteiro em memória.
   *
   * Duas coisas que não são óbvias:
   *
   * 1. **Sem `isTrustedOrigin`.** Uma requisição de elemento de mídia não manda
   *    `Origin`, então a guarda de origem rejeitaria toda reprodução. A
   *    autorização aqui é o token de 128 bits do `src` — posse do link, como a
   *    rota de upload já é. Quem quiser fechar isso mais é verificar a sessão
   *    do cookie, mas ela não prova estar na sala: todo visitante tem uma.
   *
   * 2. **O abort acompanha o cliente.** Um espectador que sai no meio, ou um
   *    `seek` que descarta a requisição anterior, fecha a leitura do Drive.
   *    Sem isso, o processo segura streams de um público que já foi embora.
   */
  app.get('/api/drive/stream/:token', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const grant = await lerStream(String(req.params.token ?? ''));
    if (!grant) return jsonError(res, 404, 'not_found');

    const token = await getValidAccessToken(grant.sessionId);
    if (!token.ok) {
      // A concessão da pessoa pode ter sido revogada depois que o item entrou
      // na fila. Sem token não há stream, e o bucket não tem cópia deste Drive.
      return jsonError(res, token.reason === 'not_connected' ? 404 : 502, token.reason);
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    // `Response` aqui é o do Express, então o tipo da resposta do Drive vem do
    // retorno da função — nomeá-lo importaria o objeto errado.
    let upstream: Awaited<ReturnType<typeof abrirArquivo>>;
    try {
      upstream = await abrirArquivo(grant, rangeDe(req.headers.range), token.accessToken, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[drive-stream] falha ao abrir o arquivo no Drive', err);
      return jsonError(res, 502, 'drive_unreachable');
    }

    // Um 4xx do Drive vira status nosso, sem o corpo: a página de erro do Google
    // não interessa a um `<video>` e só gastaria banda.
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      return jsonError(res, upstream.status === 404 ? 404 : 502, upstream.status === 404 ? 'not_found' : 'drive_unreachable');
    }

    repassarCabecalhos(upstream, res);
    res.status(upstream.status);
    if (!upstream.body) return res.end();

    // `pipe` sem fim: o Node aplica backpressure, então a memória do processo
    // não cresce com o tamanho do vídeo, e o spectator lento segura o stream
    // em vez de acelerar o download do Drive.
    corpoComoStream(upstream).on('error', () => res.destroy()).pipe(res);
  });

  app.get('/api/drive/oauth/concluido', (req, res) => {
    const { status, html } = paginaDriveConcluido(
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
