import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * O proxy do Range vive em `public/drive-media-sw.js`, que é JavaScript puro e
 * servido sem compilador. Este arquivo não executa o worker — ele confere o
 * **código** que faz o repasse, porque o defeito que importa aqui é silencioso:
 * um `206` sem `Content-Range` produz uma tela preta idêntica à de um codec
 * incompatível, e nenhum teste de integração aqui diria qual dos dois é.
 *
 * Conferir o texto não é a mesma coisa que testar o comportamento, e vale dizer
 * isso: o que este arquivo garante é que a lista de cabeçalhos e o repasse do
 * corpo em stream não voltam a ser regredidos. O comportamento real do `Range`
 * depende do Google e do navegador, e só um teste manual com um MP4 grande
 * fecha isso.
 */

const fonte = readFileSync(
  resolve(process.cwd(), '../web/public/drive-media-sw.js'),
  'utf8',
);

test('o 206 repassa Content-Range, Content-Length, Content-Type e Accept-Ranges', () => {
  /*
   * `Content-Range` é o que diz ao player onde o trecho recebido está no
   * arquivo. Sem ele, um `206` é uma resposta incompleta que o navegador recusa
   * a posicionar — e o sintoma é "não reproduz", indistinguível de codec
   * incompatível.
   */
  for (const cabecalho of [
    'content-range',
    'content-length',
    'content-type',
    'accept-ranges',
    'etag',
    'last-modified',
  ]) {
    assert.ok(
      fonte.includes(`'${cabecalho}'`),
      `${cabecalho} precisa estar na lista de cabeçalhos repassados`,
    );
  }
});

test('o corpo passa como stream, sem virar memória', () => {
  /*
   * Um filme de 700 MB em memória seria 700 MB de RAM por espectador, que é
   * exatamente o que o proxy client-side veio evitar. `arrayBuffer()` e `blob()`
   * são as duas formas de transformar o stream em memória, e as duas precisam
   * continuar ausentes.
   */
  assert.ok(fonte.includes('resposta.body'), 'o corpo precisa ser repassado como stream');
  assert.ok(!/\.arrayBuffer\(/.test(fonte), 'arrayBuffer() traz o arquivo inteiro para a memória');
  assert.ok(!/\.blob\(\)/.test(fonte), 'blob() traz o arquivo inteiro para a memória');
  assert.ok(
    /new Response\(resposta\.body/.test(fonte),
    'a resposta precisa ser construída a partir do stream do Google',
  );
});

test('um 206 sem Content-Range é registrado como contrato quebrado', () => {
  /*
   * A diferença entre "o Google não mandou" e "a gente não repassou" é o que
   * separa um arquivo ruim de um proxy ruim, e os dois têm o mesmo sintoma. O log
   * é o que torna a diferença visível em uma linha.
   */
  assert.match(
    fonte,
    /status === 206[\s\S]{0,200}content-range/,
    'precisa haver um aviso quando um 206 chega sem Content-Range',
  );
});

test('o Range do navegador é encaminhado ao Google', () => {
  /*
   * Sem encaminhar, o Google responde 200 com o arquivo inteiro e o seek
   * arrasta 700 MB a cada reposicionamento — o que explica "não começa
   * rápido" sem que nada pareça quebrado.
   */
  assert.match(fonte, /cabecalhos\.Range = range/, 'o Range pedido precisa ir no pedido ao Google');
  assert.match(fonte, /pedido\.headers\.get\('Range'\)/, 'o Range tem que ser lido da requisição');
});

test('o worker pede a autenticação com o token e nunca na URL', () => {
  assert.match(fonte, /Authorization: `Bearer \$\{token\}`/, 'o token vai no cabeçalho');
  assert.ok(
    !/searchParams\.set\(['"](access_token|token)['"]/.test(fonte),
    'token na URL é descartado por URL e vaza em log de proxy',
  );
});

test('a resposta registra o que saiu do Google e o que está devolvendo', () => {
  /*
   * Um log só do lado de cá esconde o defeito: se o `Content-Range` falta, é
   * preciso saber se o Google não mandou ou se o proxy não repassou. São consertos
   * opostos — um é o arquivo, o outro é este arquivo.
   */
  assert.match(fonte, /doGoogle/, 'o log precisa do que o Google devolveu');
  assert.match(fonte, /devolvido/, 'o log precisa do que está sendo devolvido');
  assert.match(fonte, /contentLength/, 'o Content-Length precisa estar no log');
});
