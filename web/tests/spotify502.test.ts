import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * Os dois `502` que o módulo do Spotify produzia sozinho.
 *
 * ## De onde vinham
 *
 * 1. `r.json()` na busca, fora do `try`. O Spotify respondia 200, o corpo
 *    chegava truncado, o parse lançava, e a rota transformava em 502 — que
 *    significa "problema no servidor do Juntos". É verdade, e não ajuda: não diz
 *    que a resposta veio pela metade, e repetir o clique resolve.
 *
 * 2. `r.json()` no `listTracks`, solto e sem `try` nenhum. O mesmo defeito, e
 *    pior: era a única leitura de corpo da função.
 *
 * ## E o que vinha junto
 *
 * O endpoint de álbum e playlist. `spotify:album:ID` virava `/album:ID/tracks`
 * por `replace(/^spotify:/, '')` — apagar o prefixo não é converter o formato.
 * O Spotify nunca viu aquela requisição, e o 404 vinha com a frase "o Spotify não
 * encontrou esse recurso", que é verdadeira e não aponta o caminho montado
 * errado aqui.
 */

const oauth = readFileSync(resolve(process.cwd(), '../server/src/spotifyOAuth.ts'), 'utf8');
const rotas = readFileSync(resolve(process.cwd(), '../server/src/spotifyRoutes.ts'), 'utf8');

function semComentario(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s'"`(])(\/\/[^\n]*)/g, '$1');
}

test('a leitura do corpo e texto, e o parse vem depois, com registro', () => {
  /*
   * `r.json()` faz `text()` e o parse juntos, e quando o parse falha o corpo já
   * foi jogado fora. Um `SyntaxError` sozinha não distingue corpo vazio de corpo
   * pela metade de HTML de proxy — três causas, três consertos.
   *
   * Ler o texto primeiro dá os dados que estreitam a causa: status,
   * `Content-Type`, `Content-Length` declarado e tamanho real. Declarado igual ao
   * real e real menor = corte no caminho. Diferentes = alguém respondeu outra
   * coisa no meio.
   */
  const c = semComentario(oauth);
  assert.match(
    c,
    /async function lerCorpo\(r: Response, operacao: string, caminho: string\)/,
    'a leitura do corpo e uma funcao, e recebe a operacao e o caminho para o log',
  );
  const fn = c.slice(c.indexOf('async function lerCorpo'));
  assert.match(fn, /await r\.text\(\)/, 'o corpo e lido como texto');
  assert.match(fn, /JSON\.parse/, 'e o parse vem depois, em outro lugar');
  // Os cinco campos do diagnóstico, todos presentes na linha de log.
  for (const [rotulo, padrao] of [
    ['status', /status=\$\{r\.status\}/],
    ['Content-Type', /type=\$\{r\.headers\.get\('content-type'\)/],
    ['Content-Length', /declarado=\$\{declarado/],
    ['tamanho real', /real=\$\{texto\.length\}/],
    ['primeiros 200 caracteres', /texto\.slice\(0, 200\)/],
  ] as const) {
    assert.match(fn, padrao, `o log precisa mostrar ${rotulo}`);
  }
});

test('o log da resposta nunca traz token nem Authorization', () => {
  const c = semComentario(oauth);
  /*
   * O corte precisa ser **pelas chaves da função**. A primeira versão usava
   * `slice(de lerCorpo, de rotaDeContainer)`, e `lerCorpo` fica antes de
   * `chamarWebApi` — o intervalo cobria metade do módulo, incluindo
   * `spotifyFetch`, que monta o cabeçalho `Authorization` de propósito. O teste
   * acusou o código correto.
   */
  const inicio = c.indexOf('async function lerCorpo');
  const fim = c.indexOf('\n}', inicio);
  const fn = c.slice(inicio, fim);
  assert.ok(
    !/authorization|accessToken|refreshToken|Bearer/i.test(fn),
    'a funcao que registra a resposta nao pode mencionar credencial nenhuma',
  );
  // O limite de 200 caracteres e o que impede um payload inteiro no log.
  assert.match(fn, /slice\(0, 200\)/, 'e o corpo e truncado: o log nao transborda');
});

test('as duas leituras de corpo passam por lerCorpo', () => {
  const c = semComentario(oauth);
  const chamadas = [...c.matchAll(/await lerCorpo\(/g)];
  assert.equal(chamadas.length, 2, 'busca e listTracks, uma cada');
  assert.match(c, /lerCorpo\(r, 'busca', '\/search'\)/, 'a busca registra a operacao');
  assert.match(c, /lerCorpo\(r, 'listTracks', rota\)/, 'e listTracks tambem');
  /*
   * As duas leituras de **resposta do Spotify** passam por `lerCorpo`. Não é
   * "nenhum `r.json()` no arquivo": `spotifyFetch` e `fetchMe` leem JSON de
   * propósito, são o token e o `/me`, e já estão dentro de `try`.
   */
  const fn = c.slice(c.indexOf('export async function search'));
  assert.ok(
    !/await r\.json\(\)/.test(fn),
    'nem a busca nem listTracks leem o corpo direto: as duas passam por lerCorpo',
  );
});

test('o uri vira o endpoint certo, com parse explicito', () => {
  /*
   * O defeito: `uri.replace(/^spotify:/, '')` produzia `/album:ID/tracks`, que
   * não existe. O `uri` é `spotify:<tipo>:<id>` com tipo **singular**, e o
   * endpoint é **plural** — e playlist nem usa `/tracks`, usa `/items`.
   *
   * A transformação tem que ser escrita uma a uma. Apagar o prefixo não é
   * converter formato.
   */
  const c = semComentario(oauth);
  const fn = c.slice(c.indexOf('function rotaDeContainer'));
  assert.match(
    fn,
    /albums\/\$\{album\[1\]\}\/tracks\?limit=50/,
    'spotify:album:ID vira /albums/ID/tracks',
  );
  assert.match(
    fn,
    /playlists\/\$\{playlist\[1\]\}\/items\?limit=50/,
    'spotify:playlist:ID vira /playlists/ID/items, e nao /tracks',
  );
  assert.ok(
    !/replace\(\/\^spotify:\//.test(fn),
    'e nao pode remover o prefixo: foi exatamente isso que gerou o caminho inexistente',
  );
  assert.match(
    c,
    /const rota = rotaDeContainer\(uri\);\s*if \(!rota\) return \{ ok: false, reason: URI_INVALIDA, status: 400 \};/,
    'e um uri fora do catalogo recusa antes de virar chamada',
  );
});

test('o 400 do Spotify nao vira 502', () => {
  /*
   * `listTracks` devolvia `status: 400` para o `uri` inválido, e a rota usava
   * `result.status ?? 502` — que respeitaria. O risco é o inverso: um `400` do
   * Spotify chegando por outro caminho e virando 502, o que faria a pessoa
   * procurar problema de servidor num erro de parâmetro.
   */
  const c = semComentario(rotas);
  assert.match(
    c,
    /\[400,\s*401,\s*403,\s*429\]\.includes\(statusDoSpotify\)/,
    'os quatro status do Spotify passam adiante, sem virar 502',
  );
  assert.match(
    c,
    /erroDeSpotify\(res, result\.reason, result\.status \?\? 502\)/,
    'e a rota repassa o status em vez de assumir 502',
  );
});

test('o 502 da rota registra rota, operacao e excecao', () => {
  const c = semComentario(rotas);
  for (const [rota, operacao] of [
    ['/api/spotify/search', 'operacao=search'],
    ['/api/spotify/tracks', 'operacao=listTracks'],
  ] as const) {
    const bloco = c.slice(c.indexOf(rota));
    const trecho = bloco.slice(0, bloco.indexOf('res.status(502)'));
    assert.match(trecho, /\[spotify\] 502 \|/, `${rota} registra o 502`);
    assert.match(trecho, new RegExp(`rota=${rota.replace(/[/]/g, '\\/')}`), `${rota} registra a rota`);
    assert.match(trecho, new RegExp(operacao), `${rota} registra a operacao`);
    assert.match(trecho, /excecao=/, `${rota} registra a excecao`);
  }
});

test('a resposta truncada e passageira, e nao e problema de conta', () => {
  /*
   * A distinção que muda a ação: corpo pela metade se resolve repetindo o
   * clique, e dizer "reconecte" faria a pessoa jogar fora uma conta boa.
   */
  const c = semComentario(oauth);
  assert.match(c, /RESPOSTA_TRUNCADA\s*=\s*\n?\s*'A resposta do Spotify chegou incompleta/, 'a frase diz que e passageiro');
  assert.match(c, /motivo === 'renovacao_falhou'[\s\S]{0,200}?TOKEN_RENOVACAO/, 'e continua separado da renovacao');
});
