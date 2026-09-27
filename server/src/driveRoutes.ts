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

import { criarFaixa, registrarDonoDoTrack, type DriveTrackFailure } from './driveTrack.js';
import { revogarTudoDaSessao } from './driveShare.js';

/** Motivo de recusa virado em resposta HTTP, para o painel saber o que dizer. */
function motivoDe(reason: DriveTrackFailure): { http: number; error: string } {
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
      if (errorParam || !code) {
        /*
         * O `error` que o Google manda é a única pista quando a falha é na
         * autorização, e antes disto ele não era registrado em lugar nenhum: a
         * pessoa recebia "tente de novo" e o servidor não guardava o motivo.
         * Escopo indevido, redirect divergente e recusa do consentimento
         * chegam todos por aqui, e são coisas completamente diferentes para
         * corrigir.
         */
        console.error(`[drive-oauth] o Google recusou a autorização: ${errorParam || 'sem código'}`);
        return await concluir('error', { status: 'error' });
      }

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

  /**
   * Access token curto, para abrir o Picker e para o player reproduzir.
   *
   * A distinção que importa aqui é entre **reconectar** e **tentar de novo**:
   *
   * - `not_connected`, `revoked` e `expired` são 401, porque a autorização
   *   guardado não vai mais render token. Reconectar resolve, e o cliente já
   *   sabe transformar 401 em "conecte de novo".
   * - `temporary` é 502, porque o Google recusou por algo passageiro e a conta
   *   está boa. Um 401 aqui mandaria a pessoa refazer o consentimento por causa
   *   de um 503 do Google, o que é o pior jeito de se errar.
   */
  app.get('/api/drive/picker-token', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) return jsonError(res, 401, 'no_session');

    try {
      const token = await getValidAccessToken(sessionId);
      if (token.ok) return res.json({ accessToken: token.accessToken });
      // Só `temporary` é passageiro; todo o resto (`not_connected`, `revoked`,
      // `expired`) é autorização que não vai mais render token.
      return jsonError(res, token.reason === 'temporary' ? 502 : 401, token.reason);
    } catch (err) {
      // Sem isto, um 500 chegava ao painel como falha genérica e o motivo
      // ficava só no console de quem desenvolve — ou seja, em lugar nenhum. A
      // renovação do token é o caminho que mais quebra, e é o que a pessoa
      // mais precisa ver registrado.
      console.error('[drive-token] falha inesperada ao obter o token do Picker', err);
      jsonError(res, 500, 'token_unavailable');
    }
  });

  /**
   * Registra o arquivo escolhido como faixa de Drive.
   *
   * O `fileId` vem do cliente porque foi a pessoa que escolheu, mas é validado
   * contra a concessão dela: sem Drive conectado, ou para um id que não é
   * vídeo, a resposta é um motivo. O que volta são o `fileId` e o nome — nada de
   * URL de mídia, porque o vídeo não passa por este servidor.
   */
  app.post('/api/drive/track', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!isTrustedOrigin(req)) return jsonError(res, 403, 'forbidden_origin');
    const sessionId = readSessionId(req);
    if (!sessionId) return jsonError(res, 401, 'no_session');
    try {
      const fileId = typeof req.body?.fileId === 'string' ? req.body.fileId : '';
      const result = await criarFaixa(sessionId, fileId);
      if (!result.ok) {
        const { http, error } = motivoDe(result.reason);
        return jsonError(res, http, error);
      }
      // O registro indexado por `fileId` é o que permite ao servidor saber de
      // quem é a concessão que deu acesso, sem que a sessão de quem escolheu
      // apareça no estado da sala — que é transmitido para todo mundo.
      await registrarDonoDoTrack(result.track.fileId, sessionId, result.track.name);
      res.json(result.track);
    } catch (err) {
      console.error('[drive] falha ao registrar a faixa', err);
      jsonError(res, 500, 'track_failed');
    }
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
      // Desconectar derruba as permissões que a conta criou, em todas as salas
      // onde ela concessionou acesso. Precisa vir antes de apagar o token, porque
      // a revogação usa o token do dono para falar com o Google.
      await revogarTudoDaSessao(sessionId);
      await revokeAndDelete(sessionId);
      res.set('Cache-Control', 'no-store');
      res.json({ connected: false });
    } catch {
      jsonError(res, 500, 'disconnect_failed');
    }
  });
}
