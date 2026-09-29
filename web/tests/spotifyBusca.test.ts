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
  // A lista de faixas de um álbum usa 50 de propósito, e por isso tem outro nome.
  const faixas = c.slice(c.indexOf('export async function listTracks'));
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

test('o log registra endpoint, status e o corpo do Spotify', () => {
  const c = semComentario(oauth);
  const fn = c.slice(c.indexOf('async function registrarErroSpotify'));
  assert.match(fn, /error\?\.status/, 'o error.status');
  assert.match(fn, /error\?\.message/, 'o error.message');
  assert.match(fn, /error\?\.reason/, 'o error.reason quando existir');
  assert.match(fn, /await r\.text\(\)/, 'e o corpo cru, para quando não é JSON');
  assert.ok(
    !/accessToken|Bearer/.test(fn),
    'e nunca registra o token: o log é lido por quem tem acesso ao deploy, e o token nao precisa estar lá',
  );
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
