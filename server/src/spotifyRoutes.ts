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
 * Envia o motivo que a pessoa precisa ler.
 *
 * A rota devolvia `{ error: "spotify_403" }` e o painel mostrava essa string na
 * tela. O número é o mesmo que o servidor já registrou, e não diz nada: um 403
 * do Spotify pode ser app em modo de desenvolvimento, scope insuficiente, ou API
 * não habilitada — e cada um tem uma correção diferente no painel da Spotify.
 *
 * O `reason` que a busca e a listagem devolvem já é uma frase em português, feita
 * com o status em mãos. O corpo da resposta é esse texto, e o cliente mostra
 * direto.
 */
function erroDeSpotify(res: Response, reason: string) {
  res.status(403).json({ error: reason });
}

/**
 * Página de erro do OAuth, e não um JSON cru.
 *
 * A pessoa autorizou no Spotify e voltou para cá. Um `{"error":"..."}` na tela
 * não diz o que houve nem offers a menor saída possível — que é tentar de novo.
 * E "tente de novo" é seguro justamente porque o registro `pending` foi
 * consumido: um segundo clique cria um novo.
 */
function paginaDeFalha(res: Response, mensagem: string): void {
  res.status(400).type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spotify · juntos</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#08080A;color:#ECECEF;font-family:system-ui,-apple-system,sans-serif}
  .c{max-width:24rem;padding:2rem;text-align:center}
  h1{font-size:1rem;font-weight:600;margin:0 0 .5rem}
  p{font-size:.8125rem;line-height:1.6;color:#8C8C99;margin:0 0 1.5rem}
  a{display:inline-block;padding:.625rem 1.25rem;border-radius:.75rem;
    background:#7C5CFF;color:#fff;font-size:.8125rem;font-weight:500;text-decoration:none}
</style></head><body><div class="c">
<h1>${mensagem}</h1>
<p>Isso costuma acontecer quando a autorização passa do tempo ou é aberta duas vezes.
Nada foi conectado, e a fila da sala não mudou.</p>
<a href="/">Voltar para o Juntos</a>
</div></body></html>`);
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
        /*
         * "state inválido" tem três causas que produzem a mesma resposta, e sem
         * este log elas são indistinguíveis depois do deploy:
         *
         *   - o Spotify não devolveu `state` (o fluxo foi montado errado)
         *   - o `state` chegou mas não há registro (expirou, ou foi consumido)
         *   - a pessoa clicou em "conectar" duas vezes e voltou pelo fluxo velho
         *
         * As três respondem `400` e o JSON não diz qual é. O registro só existe
         * por `PENDING_TTL_SEC`, então "esperou demais para autorizar" é a
         * primeira hipótese quando a pessoa demorou.
         *
         * Só o formato, nunca o valor: o `state` é um token de uso único.
         */
        const motivo = state
          ? `state de ${state.length} caracteres nao encontrado (expirou ou ja foi usado)`
          : 'o Spotify nao devolveu o state';
        console.warn(`[spotify] callback sem registro valido: ${motivo}`);
        return paginaDeFalha(res, 'A autorização do Spotify expirou.');
      }

      if (erro) {
        console.warn(`[spotify] a pessoa recusou o consentimento: ${erro}`);
        res.redirect(pending.returnTo || '/');
        return;
      }
      if (!code) {
        console.warn('[spotify] callback sem code');
        return jsonError(res, 400, 'spotify_code_missing');
      }

      const result = await completeOAuth({
        sessionId: pending.sessionId,
        code,
        codeVerifier: pending.codeVerifier,
      });
      if (!result.ok) {
        console.error('[spotify] a troca do code falhou:', result.error);
        return paginaDeFalha(res, 'O Spotify recusou a autorização. Tente de novo.');
      }

      /*
       * O log de sucesso é o que fecha odiagnóstico: ele diz que o `code`
       * chegou, que o `state` casou e que a conta foi gravada. Sem ele, "funciona"
       * e "não funciona" são o mesmo silêncio.
       */
      console.log(`[spotify] conta conectada, sessao ${pending.sessionId.slice(0, 8)}…`);
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
      if (!result.ok) return erroDeSpotify(res, result.reason);
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
      if (!result.ok) return erroDeSpotify(res, result.reason);
      res.json({ items: result.items });
    } catch (err) {
      console.error('[spotify] tracks falhou', err);
      res.status(502).json({ error: 'spotify_tracks_failed' });
    }
  });
}
