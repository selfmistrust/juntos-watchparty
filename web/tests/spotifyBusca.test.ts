import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * A busca do Spotify, e o que a resposta de erro precisa contar.
 *
 * ## O defeito que motivou este arquivo
 *
 * A busca falhava com "O Spotify respondeu 400. Tente de novo.", e o console do
 * navegador mostrava `403 Forbidden`. **O 403 era do nosso servidor, não do
 * Spotify**: a rota respondia `res.status(403)` para qualquer falha, então um
 * `400` do Spotify chegava ao console com a assinatura de "sem permissão".
 *
 * Isso mandou o diagnóstico para o lado errado por três deploys: alguém lê
 * `403` e procura problema de permissão, quando o problema era parâmetro. Um
 * status inventado pela camada errada é pior do que nenhum status, porque
 * aponta a investigação para o lugar errado com a confiança de quem está certo.
 *
 * ## O que estes testes travam
 *
 *  - o status do Spotify passa adiante, e o console volta a significar alguma coisa
 *  - cada status tem ação própria, e nenhuma é "tente de novo" para 401 ou 429
 *  - a renovação acontece **uma vez**, e nunca depois de um 403
 *  - a busca pede `limit=10` e nunca envia parâmetro vazio
 */

const oauth = readFileSync(resolve(process.cwd(), '../server/src/spotifyOAuth.ts'), 'utf8');
const rotas = readFileSync(resolve(process.cwd(), '../server/src/spotifyRoutes.ts'), 'utf8');
const cliente = readFileSync(resolve(process.cwd(), '../web/lib/spotifyAccount.ts'), 'utf8');
const painel = readFileSync(resolve(process.cwd(), '../web/components/media/SpotifyPanel.tsx'), 'utf8');

/**
 * Tira comentários, mas **não** come `https://`.
 *
 * A segunda expressão é o mesmo problema que o arquivo `mencaoCampo.test.ts`
 * já registrou uma vez, em outra forma: um removedor de `//` que apaga o resto da
 * linha traga a URL que o teste estava procurando. A URL é a correção, e o teste
 * falhou achando que ela não estava lá.
 *
 * A solução é exigir que o `//` venha depois de espaço ou aspa, que é como um
 * comentário real aparece no código, e não no meio de uma URL.
 */
function semComentario(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s'"`(])(\/\/[^\n]*)/g, '$1');
}

test('o status do Spotify passa adiante, em vez de virar 403 fixo', () => {
  /*
   * O defeito: `res.status(403)` para qualquer falha. Um `429` (limite de
   * requisições) virava `403` (sem permissão), e a pessoa repetia a busca achando
   * que era um problema de conta.
   */
  const c = semComentario(rotas);
  const fn = c.slice(c.indexOf('function erroDeSpotify'));
  assert.match(
    fn,
    /\[400,\s*401,\s*403,\s*429\]\.includes\(statusDoSpotify\)/,
    'o status do Spotify decide o status da resposta',
  );
  assert.match(
    fn,
    /statusDoSpotify/,
    'e ele precisa ser recebido pela rota, nao assumido',
  );
  assert.ok(
    !/res\.status\(403\)\.json\(\{ error: reason \}\)/.test(fn),
    'sem 403 fixo: era ele que transformava 400 e 429 em "sem permissão"',
  );
});

test('o callback repetido da mesma sessao nao vira pagina de erro', () => {
  /*
   * O log do Render mostrou as duas coisas no mesmo segundo:
   *
   *   [spotify] conta conectada, sessao 45ce7b2v...
   *   [spotify] callback sem registro valido: state de 22 caracteres...
   *
   * O login **funcionou** e a pessoa viu "a autorização expirou" logo em seguida,
   * porque o navegador repete o callback e o registro já tinha sido consumido. Um
   * aviso que contradiz o estado real é o pior resultado possível: a pessoa
   * conclui que precisa refazer o login que acabou de dar certo.
   *
   * Repetir o callback é comum e não é erro de ninguém: `prefetch`, botão
   * voltar, aba restaurada, proxy repetindo o pedido.
   */
  const c = semComentario(oauth);
  assert.match(
    c,
    /export async function jaUsadoPorEstaSessao/,
    'o registro de "ja usado" existe, e e consultado no callback sem registro',
  );
  const rotasC = semComentario(rotas);
  assert.match(
    rotasC,
    /jaUsadoPorEstaSessao\(state, sessaoAtual/,
    'e a consulta e feita com a sessao desta requisicao',
  );
  assert.match(
    rotasC,
    /const destino = await jaUsadoPorEstaSessao[\s\S]{0,300}?res\.redirect\(destino/,
    'a repeticao responde com o mesmo destino, em vez da pagina de erro',
  );
  assert.match(
    rotasC,
    /marcarPendingUsado\(state, pending\.sessionId, pending\.returnTo\)/,
    'e o state e marcado no sucesso, com a sessao que iniciou o fluxo',
  );
});

test('o reaproveitamento so vale para a sessao que iniciou o fluxo', () => {
  /*
   * Isto é o que separa "corrigir o sintoma" de "abrir um buraco".
   *
   * O que a marca guarda é a **sessão**, e a comparação é feita contra a sessão
   * do cookie atual. Um `state` de outra janela não aproveita nada: é recusado
   * como sempre. É o mesmo princípio do `state` de CSRF — ele existe para ligar
   * o callback a quem começou, e afrouxar isso seria permitir que uma janela
   * herde o login de outra.
   *
   * E o que volta é apenas o destino, nada utilizável: nem `code`, nem token, nem
   * a possibilidade de trocar código. A autorização já aconteceu, e quem a fez foi
   * a pessoa desta sessão.
   */
  const c = semComentario(oauth);
  const fn = c.slice(c.indexOf('export async function jaUsadoPorEstaSessao'));
  assert.match(fn, /dono !== sessionId\) return null/, 'sessao diferente nao aproveita');
  assert.match(
    fn,
    /redis\.set\(PENDENTE_USADO\(state\), sessionId, 'EX', PENDING_TTL_SEC\)/,
    'a marca guarda a sessao que usou, com o mesmo prazo do registro',
  );
  /*
   * O que não pode atravessar é o **corpo** da função, não o nome dela: o
   * `codeVerifier` aparece no tipo e é justamente a prova de que o registro
   * original foi apagado. Se algo utilizável voltasse aqui, uma segunda
   * requisição poderia trocar um código.
   */
  const corpo = fn.slice(fn.indexOf('{'));
  assert.ok(
    !/redis\.get\(PENDING_KEY/.test(corpo),
    'a funcao nao relê o registro original, que é o que guardava o codeVerifier',
  );
  assert.match(
    corpo,
    /redis\.get\(`\$\{chave\}:destino`\)/,
    'e o que ela lê é só o destino guardado pela marca',
  );
  // O destino é servido uma vez e a marca some, para não virar um destino
  // guardado por dez minutos.
  assert.match(corpo, /await redis\.del\(chave\)/, 'o destino e servido uma vez so');
});

test('a marcacao do state nao substitui o consumo do registro', () => {
  /*
   * `consumirPending` continua existindo e continua sendo chamado: o registro com
   * o `codeVerifier` é apagado no sucesso, porque é ele que permitiria trocar um
   * código. O que fica é só a marca de sessão, que não tem nenhum poder.
   */
  const c = semComentario(oauth);
  assert.match(c, /async function consumirPending/, 'o consumo do registro continua existindo');
  assert.match(
    c,
    /await consumirPending\(params\.state\)/,
    'e continua sendo chamado no sucesso da troca, pelo `state` do parametro',
  );
  // A ordem importa: apagar o registro antes de gravar a marca é o que garante
  // que uma repetição não encontre nem um nem outro.
  const bloco = c.slice(c.indexOf('const me = await fetchMe'));
  assert.ok(
    bloco.indexOf('consumirPending') < bloco.indexOf('saveTokens'),
    'o registro com o verifier e apagado antes de a conta ser gravada',
  );
});

test('o parse da resposta do Spotify fica dentro de um try', () => {
  /*
   * A origem do 502 que a pessoa viu.
   *
   * `chamarWebApi` devolvia a `Response` crua, e o `await r.json()` ficava
   * **fora** do `try` que protegia a chamada — com o `<T>` genérico na
   * assinatura prometendo que o corpo já estava convertido. O Spotify
   * respondia 200, o corpo chegava truncado, o `r.json()` lançava, e a rota
   * respondia "problema do servidor do Juntos".
   *
   * Isso é verdade, e não ajuda: não diz que a resposta chegou pela metade, e
   * repetir o clique resolve. A ação muda, e é por isso que a distinção importa.
   */
  const c = semComentario(oauth);
  const fn = c.slice(c.indexOf('export async function search'));
  /*
   * O `r.json()` foi depois movido para `lerCorpo` + `JSON.parse` protegido, e
   * este teste acompanhou: a exigência agora é que a leitura do corpo da busca
   * passe por `lerCorpo` e que o parse esteja em `try`. Ver `spotify502.test.ts`
   * para a leitura por extenso, incluindo o que o log precisa mostrar.
   */
  assert.match(
    fn,
    /const corpo = await lerCorpo\(r, 'busca', '\/search'\);/,
    'a leitura do corpo passa por lerCorpo, que registra a forma da resposta',
  );
  assert.match(
    fn,
    /try \{\s*data = JSON\.parse\(corpo\)/,
    'e o parse fica dentro de um try',
  );
  assert.match(
    c,
    /if \(!data \|\| typeof data !== 'object'\)/,
    'um corpo que nao e objeto tambem e resposta truncada, nao excecao',
  );
  assert.match(c, /RESPOSTA_TRUNCADA\s*=/, 'a frase diz que e passageiro');
  assert.ok(
    !/chamarWebApi</.test(c),
    'e chamarWebApi nao tem mais generico: ele prometia um parse que nao fazia',
  );
});

test('um item sem id nao derruba a busca inteira', () => {
  /*
   * O Spotify manda `null` no lugar de faixas indisponíveis em alguns markets.
   * Um `null` só derrubava a busca com `Cannot read properties of null`, e o
   * resultado era um 502 que falava do servidor do Juntos por causa de um item
   * que a API não podia entregar.
   */
  const c = semComentario(oauth);
  for (const tipo of ['t', 'a', 'p']) {
    assert.match(
      c,
      new RegExp(`for \\(const ${tipo} of data\\.[a-z]+\\?\\.items \\?\\? \\[\\]\\) \\{\\s*if \\(!${tipo}\\?\\.id\\) continue;`),
      `o item "${tipo}" sem id e pulado, e a busca continua`,
    );
  }
});

test('a rota repassa o status que veio do Spotify', () => {
  const c = semComentario(rotas);
  assert.match(
    c,
    /erroDeSpotify\(res, result\.reason, result\.status \?\? 502\)/,
    'a busca repassa o status, com 502 quando nao ha status do Spotify',
  );
});

test('cada status do Spotify tem acao propria', () => {
  const c = semComentario(oauth);
  const fn = c.slice(c.indexOf('function motivoDeErro'));

  // 401 precisa mandar reconectar: "tente de novo" com um token recusado não muda
  // nada, e a pessoa fica clicking sem chance de o resultado mudar.
  assert.match(fn, /401[\s\S]{0,400}?Trocar de conta/, 'o 401 diz para reconectar');
  assert.match(fn, /429[\s\S]{0,200}?limite|limitando/i, 'o 429 diz que é limite');
  assert.match(
    fn,
    /Development Mode[\s\S]{0,300}?Users Management/,
    'o 403 cita Development Mode e o caminho exato no painel',
  );
  assert.match(
    fn,
    /INVALID_REDIRECT_URI[\s\S]{0,400}?onrender\.com\/api\/spotify\/oauth\/callback/,
    'o INVALID_REDIRECT_URI mostra a URL esperada, que e a correcao',
  );
});

test('o 403 de Development Mode tem a frase pedida', () => {
  /*
   * A frase importa tanto quanto o status: "sem permissão" manda a pessoa
   * procurar no lugar errado, e a correção está num lugar específico do painel
   * de desenvolvedor.
   */
  const c = semComentario(oauth);
  assert.ok(
    c.includes('ainda não está autorizada a usar esta integração'),
    'a mensagem do 403 diz que a conta não está autorizada',
  );
  assert.ok(c.includes('Settings'), 'e aponta Settings → Users Management');
});

test('a renovacao acontece uma vez, e so depois de um 401', () => {
  /*
   * O laço de refresh é o modo de falha clássico: renova, chama, o Spotify
   * recusa, renova. Cada volta consome uma chamada ao `/api/token`, e um
   * `invalid_grant` no meio do caminho **apaga o token guardado** — aí a pessoa
   * deixa de estar conectada por causa de um bug.
   */
  const c = semComentario(oauth);
  const fn = c.slice(c.indexOf('async function chamarWebApi'));
  const bloco = fn.slice(0, fn.indexOf('return { r, tokenUsado'));

  assert.match(bloco, /if \(r\.status === 401\)/, 'a renovação só entra num 401');
  const renovadas = (bloco.match(/fazer\(/g) ?? []).length;
  assert.equal(renovadas, 2, 'exatamente duas chamadas: a original e a única repetição');
  assert.ok(
    !/while\s*\(/.test(bloco),
    'sem laço: um while aqui é o caminho para o loop de refresh',
  );
  assert.ok(
    !/403[\s\S]{0,120}?renovar|renovar[\s\S]{0,120}?403/.test(bloco),
    'e nunca renova por 403: em Development Mode é a resposta normal, e renovar não muda nada',
  );
  assert.match(
    bloco,
    /await redis\.del\(TOKEN_KEY\(sessionId\)\)/,
    'o token recusado é apagado antes de renovar, senão o retry devolve o mesmo token',
  );
});

test('a busca pede limit=10 e nao envia parametro vazio', () => {
  const c = semComentario(oauth);
  assert.match(c, /const LIMITE_BUSCA = 10;/, 'o limite é 10');
  assert.match(
    c,
    /searchParams\.set\('limit',\s*String\(LIMITE_BUSCA\)\)/,
    'e é o que vai na busca, não um número solto',
  );
  /*
   * A lista de faixas de álbum e playlist usa 50, porque ali a lista **é** o
   * conteúdo e a tela rola. O `50` mora em `rotaDeContainer`, que é onde a URL é
   * montada — ver `spotify502.test.ts`, que confere o endpoint inteiro.
   */
  const faixas = c.slice(c.indexOf('function rotaDeContainer'));
  assert.match(faixas, /limit=50/, 'a lista de álbum continua 50, que é outro caso');

  const clienteC = semComentario(cliente);
  assert.match(
    clienteC,
    /if \(v\) url\.searchParams\.set\(k, v\)/,
    'parametro vazio nao vai: o Spotify responde 400 para q= sem termo',
  );
});

test('o termo e validado antes de gastar uma chamada de rede', () => {
  const c = semComentario(oauth);
  assert.match(
    c,
    /const limpo = term\.trim\(\);\s*if \(limpo\.length < 2\) return \{ ok: true, items: \[\] \};/,
    'um termo de menos de 2 caracteres devolve lista vazia, sem chamar a API',
  );
});

test('uma falha de rede na renovacao nao desconecta a conta', () => {
  /*
   * O defeito mais caro que este arquivo fecha, e ele não apareceu em nenhuma
   * tela: `getValidAccessToken` caía em `not_connected` para **qualquer** falha
   * que não fosse 400/401 — inclusive timeout e "sem internet". E `not_connected`
   * era o motivo que apaga o token.
   *
   * Ou seja: um instante de rede ruim desconectava a conta, e a única correção
   * passava a ser refazer o login inteiro. A pessoa reconnectava, o token era
   * emitido de novo, a busca funcionava, e a pergunta natural — "por que isso
   * acontece comigo?" — não tinha resposta em lugar nenhum, porque o defeito
   * tinha apagado a evidência.
   */
  const c = semComentario(oauth);
  const fn = c.slice(c.indexOf('export async function getValidAccessToken'));
  const bloco = fn.slice(0, fn.indexOf('\n}'));

  assert.match(
    bloco,
    /reason: 'renovacao_falhou'/,
    'falha que nao e 400/401 vira renovacao_falhou, e nao not_connected',
  );
  assert.ok(
    !/return \{ ok: false, reason: 'not_connected' \};?\s*\}\s*catch|catch[\s\S]{0,600}reason: 'not_connected'/.test(bloco),
    'e nunca no catch: not_connected apaga o token, entao nao pode ser o fallback',
  );
  assert.match(
    c,
    /motivo === 'renovacao_falhou'[\s\S]{0,120}?TOKEN_RENOVACAO/,
    'e o texto diz que a conta continua conectada, porque e verdade',
  );
  assert.match(
    c,
    /motivo === 'revoked'[\s\S]{0,120}?TOKEN_REVOGADO/,
    'enquanto revogado manda reconectar',
  );
});

test('o catch da rota fala que a falha e do servidor, e nao da conta', () => {
  /*
   * `spotify_search_failed` na tela mandava a pessoa procurar no Spotify, que é o
   * lugar errado: a exceção era nossa. Um código genérico nesse ponto é o oposto
   * do que o texto pedia, que era dizer o motivo.
   */
  const c = semComentario(rotas);
  assert.ok(
    !/spotify_search_failed/.test(c) && !/spotify_tracks_failed/.test(c),
    'nenhum codigo generico no corpo da resposta de erro',
  );
  const bloco = c.slice(c.indexOf('api/spotify/search'));
  const blocoCatch = bloco.slice(bloco.indexOf('catch'), bloco.indexOf('api/spotify/tracks'));
  assert.match(
    blocoCatch,
    /problema do servidor\s*\n?\s*do Juntos/,
    'a resposta diz que a falha e do servidor do Juntos',
  );
  assert.match(blocoCatch, /console\.error\(/, 'e a excecao inteira vai para o log');
});

test('o log registra endpoint, status e o corpo do Spotify', () => {
  const c = semComentario(oauth);
  const inicio = c.indexOf('async function registrarErroSpotify');
  /*
   * A fatia precisa acabar com a função. Sem o limite, ela vai até o fim do
   * arquivo e passa a varrer `iniciarReproducao`, que lê `peek.accessToken` para
   * checar escopo — e acusa um log que não existe. Já aconteceu: a verificação
   * era mais larga que o que media.
   */
  const fim = c.indexOf('\n}', inicio);
  const fn = c.slice(inicio, fim);
  assert.match(fn, /error\?\.status/, 'o error.status');
  assert.match(fn, /error\?\.message/, 'o error.message');
  assert.match(fn, /error\?\.reason/, 'o error.reason quando existir');
  assert.match(fn, /await r\.text\(\)/, 'e o corpo cru, para quando não é JSON');
  assert.ok(
    !/accessToken|Bearer/.test(fn),
    'e nunca registra o token: o log é lido por quem tem acesso ao deploy, e o token nao precisa estar lá',
  );
});

test('nenhum log do Spotify escreve o token, em nenhuma funcao', () => {
  /*
   * A verificação por função acima não cobre o arquivo inteiro. Esta cobre os dois,
   * porque o vazamento que importa é o que ninguém procurou: o
   * `pending.sessionId.slice(0, 8)` que estava no log do callback apareceu por
   * leitura, não por teste.
   *
   * E mede a coisa certa. A versão anterior proibia a **palavra** `accessToken` em
   * qualquer `console.*`, e reprovou um log legítimo que usa o token só para
   * descobrir o formato dele (`accessToken.split('.').length`). Um teste que
   * reprova o certo costuma ser afrouxado depois — e afrouxado sem querer é como
   * teste de segurança deixa de proteger.
   *
   * O que vaza é o **valor**: interpolado num template, ou passado como argumento
   * inteiro. Derivar um booleano ou uma contagem a partir dele não vaza nada.
   */
  const c = semComentario(oauth);

  for (const m of c.matchAll(/console\.(?:log|warn|error)\(([\s\S]{0,500}?)\);/g)) {
    const corpo = m[1];
    // Interpolação do token dentro de um template.
    assert.ok(
      !/\$\{[^}]*\baccessToken\b[^}]*\}/.test(corpo),
      `um log interpola o access token: ${corpo.slice(0, 100)}`,
    );
    // O token (ou algo que o contém) passado como argumento.
    assert.ok(
      !/[(,]\s*(?:[A-Za-z_$][\w$]*\.)?accessToken\s*[,)]/.test(corpo),
      `um log passa o access token como argumento: ${corpo.slice(0, 100)}`,
    );
    assert.ok(
      !/[(,]\s*(?:[A-Za-z_$][\w$]*\.)?refreshToken\s*[,)]/.test(corpo),
      `um log passa o refresh token como argumento: ${corpo.slice(0, 100)}`,
    );
    assert.ok(!/Bearer\s+/.test(corpo), `um log escreve um header de autorizacao: ${corpo.slice(0, 100)}`);
  }

  // A sessão entra só por hash, em qualquer canto do arquivo.
  for (const m of c.matchAll(/console\.(?:log|warn|error)\(([\s\S]{0,500}?)\);/g)) {
    const corpo = m[1];
    for (const interp of corpo.matchAll(/\$\{([^}]*)\}/g)) {
      const valor = interp[1].trim();
      /*
       * `${hashDeSessao(sessionId)}` é o que se quer. `${sessionId}` e
       * `${x.sessionId}` são o que não pode acontecer.
       *
       * A checagem não é a palavra "sessionId": o hash **recebe** a sessão como
       * argumento, e um teste que proibisse a palavra reprovaria exatamente a
       * linha que resolve o problema. O que se mede é o que a interpolação
       * **produz**.
       */
      const crua = /^(?:[A-Za-z_$][\w$]*\.)?sessionId$/.test(valor);
      assert.ok(
        !crua,
        `um log interpola a sessao crua: \${${valor}}`,
      );
    }
  }
});

test('a falta de token nao vira 500, e tem acao propria', () => {
  /*
   * `chamarWebApi` lança quando não há token. Sem este `try`, um clique sem conta
   * conectada viraria exceção não tratada na rota e o painel mostraria um erro
   * genérico de rede — que é a falha mais confusa possível, porque a pessoa está
   *logged in e acha que é o app.
   */
  const c = semComentario(oauth);
  const buscas = [...c.matchAll(/spotify_sem_token/g)];
  assert.ok(buscas.length >= 1, 'a rota reconhece o erro de token');
  assert.match(c, /TOKEN_AUSENTE\s*=/, 'e "sem conta" tem frase própria');
  assert.match(c, /TOKEN_REVOGADO\s*=/, 'e "revogado" tem frase própria, porque a ação é diferente');
});

test('o painel oferece a acao que o status pede', () => {
  const c = semComentario(painel);
  assert.match(
    c,
    /statusDoSpotify === 401[\s\S]{0,200}?Trocar de conta/,
    'um 401 oferece reconectar em vez de "tente de novo"',
  );
  assert.match(
    c,
    /statusDoSpotify === 429[\s\S]{0,200}?Espere/,
    'e um 429 oferece esperar, porque repetir agora gasta a cota',
  );
  assert.match(c, /instanceof SpotifyErro/, 'o painel distingue o erro do Spotify dos outros');
});
