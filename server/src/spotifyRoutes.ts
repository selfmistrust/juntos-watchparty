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
  peekTokens,
  scopesDoToken,
  search,
  SCOPES_NECESSARIOS,
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
/**
 * Envia o erro do Spotify com **o status do Spotify**, e não um 403 fixo.
 *
 * ## O defeito que isto corrige
 *
 * A rota respondia `403` para qualquer falha. Um `400` do Spotify chegava ao
 * console do navegador como `403 Forbidden` — que é a assinatura de "sem
 * permissão", e mandava o diagnóstico para o lado errado. O erro de parâmetro
 * inválido e o erro de conta não autorizada viravam a mesma coisa na tela, e o
 * `403` do navegador era **meu**, não do Spotify.
 *
 * Passar o status adiante é o que torna o console utilizável: `429` no console
 * é limite de requisições, `401` é token, `400` é parâmetro. Um `403` real no
 * console passa a significar exatamente uma coisa.
 */
function erroDeSpotify(res: Response, reason: string, statusDoSpotify: number) {
  // O status do Spotify vai adiante, com uma regra: o que é culpa do Spotify
  // (`401`, `403`, `429`) passa; o resto fica `502`, porque aí a falha foi nossa ou
  // a resposta não era do Spotify. Um `400` virando `502` seria errado do outro
  // jeito, então `400` também passa.
  const status = [400, 401, 403, 429].includes(statusDoSpotify) ? statusDoSpotify : 502;
  res.status(status).json({ error: reason, statusDoSpotify });
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
        state,
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

  /*
   * Diagnóstico do token, para quando a busca falha sem motivo aparente.
   *
   * ## Por que existe
   *
   * A busca deu `403` e o painel dizia só "conectado", que é o estado real do
   * token no Redis — e mesmo assim a busca não funcionava. O `403` do Spotify
   * chega ao console do navegador **só como status**: o corpo vive na resposta e
   * o Chrome não o mostra no painel de Network como texto, o que deixa sem
   * nenhum lugar de olhar o motivo.
   *
   * ## O que devolve
   *
   * Só a **forma** do token, nunca o token:
   *
   *   temToken      se existe token guardado para esta sessão
   *   expiradoEm    quantos segundos até o token precisar de renovação
   *   scopes        os escopos efetivamente concedidos, comparados com os pedidos
   *
   * Os escopos são a informação que decide o bug, porque é o `/me` que engana: o
   * `product` vem do token antigo e a busca usa o token novo. Descobrir isso pelo
   * JWTleva um segundo, e pelo log do servidor eram três deploys.
   *
   * O JWT é decodificado **aqui**, e só o campo `scope` sai. A assinatura não é
   * verificada de propósito: isto não valida nada, é leitura de diagnóstico.
   */
  app.get('/api/spotify/token-info', async (req, res) => {
    try {
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      if (!sessionId) return jsonError(res, 400, 'session_required');
      const record = await peekTokens(sessionId);
      if (!record) return res.json({ temToken: false });

      const expiradoEm = Math.max(0, Math.round((record.accessExpiresAt - Date.now()) / 1000));
      const concedidos = scopesDoToken(record.accessToken);

      res.json({
        temToken: true,
        expiradoEm,
        temRefreshToken: Boolean(record.refreshToken),
        scopes: concedidos,
        // O que pedimos e o que veio. A diferença é a causa de um 403 que
        // ninguém consegue explicar olhando o painel.
        escoposFaltando: SCOPES_NECESSARIOS.filter((s) => !concedidos.includes(s)),
        produto: record.product,
      });
    } catch (err) {
      console.error('[spotify] token-info falhou', err);
      res.status(500).json({ error: 'spotify_token_info_failed' });
    }
  });

  app.get('/api/spotify/search', async (req, res) => {
    try {
      const term = String(req.query.q ?? '').trim();
      if (term.length < 2) return res.json({ items: [] });
      const sessionId = sessionConfigured() ? ensureSessionId(req, res) : readSessionId(req);
      if (!sessionId) return jsonError(res, 400, 'session_required');
      const result = await search(sessionId, term);
      if (!result.ok) return erroDeSpotify(res, result.reason, result.status ?? 502);
      res.json({ items: result.items });
    } catch (err) {
      /*
       * Este `catch` é o que produzia `spotify_search_failed` na tela, e ele era
       * o oposto do que o texto pedia: um código genérico que não diz nada,
       * justamente na rota que deveria dizer o motivo real.
       *
       * A falha chega aqui de três jeitos, e cada um tem uma leitura diferente
       * para quem está olhando:
       *
       *   `spotify_sem_token:*`  o `search()` não devolveu, e por isso o motivo
       *                          já é conhecido e está na frase
       *   `Invalid URL`         uma URL montada com lixo. É bug nosso, e 502 é o
       *                          status certo
       *   rede / timeout        o Spotify não respondeu. Também 502, e de novo
       *                          culpa nossa — não do Spotify
       *
       * O `console.error` traz a exceção inteira; a resposta traz uma frase que
       * diz que a falha foi do lado de cá, e **não** repete o erro técnico como
       * se fosse a resposta da API. Um `search_failed` na tela faz a pessoa
       * procurar no Spotify, que é o lugar errado.
       */
      const bruto = err instanceof Error ? err.message : String(err);
      console.error(`[spotify] busca: exceção inesperada — ${bruto}`, err);
      res.status(502).json({
        error:
          'A busca não chegou ao Spotify. Isso é um problema do servidor do Juntos, ' +
          'e não da sua conta. Tente de novo em alguns instantes.',
      });
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
      if (!result.ok) return erroDeSpotify(res, result.reason, result.status ?? 502);
      res.json({ items: result.items });
    } catch (err) {
      const bruto = err instanceof Error ? err.message : String(err);
      console.error(`[spotify] faixas: exceção inesperada — ${bruto}`, err);
      res.status(502).json({
        error:
          'A lista de faixas não chegou ao Spotify. Isso é um problema do servidor ' +
          'do Juntos, e não da sua conta. Tente de novo em alguns instantes.',
      });
    }
  });
}
