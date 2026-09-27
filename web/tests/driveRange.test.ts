import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * O parser de `Range` e a reconstrução do `Content-Range` moram em
 * `public/drive-media-sw.js`, que é JavaScript puro servido sem compilador.
 *
 * Este arquivo não executa o worker: ele **extrai** as duas funções do texto e as
 * roda. É a diferença entre conferir que a string existe e conferir que a conta
 * fecha — e a conta é o que importa, porque um `Content-Range` com `end` errado
 * produz exatamente o mesmo `MEDIA_ELEMENT_ERROR code 4` que um cabeçalho
 * ausente.
 *
 * A extração por regex é frágil por natureza, e vale dizer: se a função mudar de
 * forma, este arquivo quebra junto, que é o comportamento desejado. Um teste que
 * copiasse a lógica passaria com a lógica quebrada.
 */

const fonte = readFileSync(
  resolve(process.cwd(), '../web/public/drive-media-sw.js'),
  'utf8',
);

/** Extrai o corpo de uma função `nome` até a chave que a fecha. */
function extrair(nome: string): string {
  const inicio = fonte.indexOf(`function ${nome}(`);
  assert.ok(inicio > -1, `a função ${nome} precisa existir no worker`);
  let abre = 0;
  for (let i = fonte.indexOf('{', inicio); i < fonte.length; i += 1) {
    if (fonte[i] === '{') abre += 1;
    else if (fonte[i] === '}') {
      abre -= 1;
      if (abre === 0) return fonte.slice(inicio, i + 1);
    }
  }
  throw new Error(`não consegui achar o fim de ${nome}`);
}

const analisarRange = new Function(`${extrair('analisarRange')}; return analisarRange;`)() as (
  cabecalho: string | null,
  total: number,
) => { inicio: number; fim: number; sufixo: boolean } | null;

const reconstruirContentRange = new Function(
  `${extrair('reconstruirContentRange')}; return reconstruirContentRange;`,
)() as (inicio: number, tamanho: number, total: number) => string | null;

const TOTAL = 708_493_479;

test('um Range aberto vira do byte pedido até o fim do arquivo', () => {
  /*
   * `bytes=0-` é o primeiro pedido de qualquer vídeo, e o mais importante: é o
   * que entrega os metadados. Se o `end` ficar errado aqui, nenhum vídeo
   * reproduz.
   */
  assert.deepEqual(analisarRange('bytes=0-', TOTAL), { inicio: 0, fim: TOTAL - 1, sufixo: false });
});

test('um Range no meio começa exatamente onde foi pedido', () => {
  // É o que um seek faz: pular para o meio do filme.
  assert.deepEqual(analisarRange('bytes=1000000-', TOTAL), {
    inicio: 1_000_000,
    fim: TOTAL - 1,
    sufixo: false,
  });
});

test('um Range com fim fechado respeita o fim pedido', () => {
  // É o que o navegador pede quando ele sabe o tamanho que quer.
  assert.deepEqual(analisarRange('bytes=1000000-2000000', TOTAL), {
    inicio: 1_000_000,
    fim: 2_000_000,
    sufixo: false,
  });
});

test('um Range com fim além do arquivo é limitado ao tamanho real', () => {
  /*
   * Um `end` além do total produziria um `Content-Range` inválido — "bytes
   * 100-999999999/708493479" — e o player recusa um intervalo que ele mesmo
   * pediu. Limitar é o que mantém o cabeçalho coerente com o arquivo.
   */
  const r = analisarRange('bytes=708493400-999999999', TOTAL);
  assert.equal(r?.inicio, 708_493_400);
  assert.equal(r?.fim, TOTAL - 1);
});

test('um Range de sufixo traz o fim do arquivo', () => {
  /*
   * `bytes=-500` é o pedido que um MP4 com `moov` no fim faz para descobrir se
   * consegue tocar. É a forma que mais importa para os arquivos grandes, e é
   * onde um parser mal feito devolve `NaN` e quebra o player.
   */
  const r = analisarRange('bytes=-500', TOTAL);
  assert.equal(r?.inicio, TOTAL - 500);
  assert.equal(r?.fim, TOTAL - 1);
  assert.equal(r?.sufixo, true);
});

test('um sufixo maior que o arquivo começa em zero', () => {
  const r = analisarRange('bytes=-9999999999', TOTAL);
  assert.equal(r?.inicio, 0);
  assert.equal(r?.fim, TOTAL - 1);
});

test('Range ausente, malformado ou múltiplo não vira reconstrução', () => {
  /*
   * Cada um destes tem um desfecho diferente, e um parser que os tratasse como
   * um intervalo normal inventaria um `Content-Range` errado:
   *
   * - ausente: não há o que reconstruir, e o Google devolve o arquivo inteiro;
   * - múltiplo (`bytes=0-3,6-9`): o navegador não usa isso para mídia, e
   *   reconstruir só o primeiro intervalo daria uma resposta que não bate;
   * - invertido (`bytes=200-100`): não existe;
   * - não numérico: não existe.
   */
  assert.equal(analisarRange(null, TOTAL), null);
  assert.equal(analisarRange('', TOTAL), null);
  assert.equal(analisarRange('bytes=0-3,6-9', TOTAL), null);
  assert.equal(analisarRange('bytes=200-100', TOTAL), null);
  assert.equal(analisarRange('bytes=abc-def', TOTAL), null);
  assert.equal(analisarRange('itens=0-3', TOTAL), null);
  assert.equal(analisarRange('bytes=-', TOTAL), null);
});

test('o Content-Range é reconstruído a partir do start e do Content-Length', () => {
  /*
   * A conta: `end = start + length - 1`, com o total vindo dos metadados. É a
   * única forma de ter o cabeçalho que o player exige, já que o CORS esconde o
   * que o Google devolveu.
   */
  assert.equal(reconstruirContentRange(0, TOTAL, TOTAL), `bytes 0-${TOTAL - 1}/${TOTAL}`);
  assert.equal(reconstruirContentRange(1_000_000, 500, TOTAL), `bytes 1000000-1000499/${TOTAL}`);
  assert.equal(reconstruirContentRange(0, 16_777_216, TOTAL), `bytes 0-16777215/${TOTAL}`);
});

test('o Content-Range não é inventado quando não há base para ele', () => {
  /*
   * Devolver `null` é melhor do que devolver um cabeçalho errado: o `206` sem
   * `Content-Range` falha de forma visível e diagnosticável, e um `Content-Range`
   * mentiroso faz o player procurar os bytes no lugar errado e falhar de um jeito
   * que não aponta para nada.
   */
  assert.equal(reconstruirContentRange(0, 0, TOTAL), null, 'sem Content-Length não há conta');
  assert.equal(reconstruirContentRange(0, 100, 0), null, 'sem tamanho total não há cabeçalho');
  // O `end` não pode passar do total: isso tornaria o cabeçalho inconsistente.
  assert.equal(reconstruirContentRange(TOTAL - 10, 100, TOTAL), null, 'o trecho passa do fim do arquivo');
});

test('o Content-Range devolvido é coerente com o que o Google entregou', () => {
  /*
   * A propriedade que o `Content-Range` precisa ter para o player aceitar:
   *
   * - o `start` é exatamente o byte pedido;
   * - o `end` é `start + Content-Length - 1`, o que o Google entregou;
   * - o `total` é o tamanho do arquivo, vindo dos metadados;
   * - o `end` nunca passa do total.
   *
   * O `Content-Length` do segundo caso é o que o Google devolve de fato num
   * intervalo aberto: um bloco, não o resto do arquivo. Por isso o `end` é
   * calculado pelo tamanho devolvido e não pelo fim do intervalo pedido — são
   * coisas diferentes, e confundir as duas é o que produz um cabeçalho que o
   * player recusa.
   */
  for (const [cabecalho, devolvido] of [
    ['bytes=0-', 4_194_304],
    ['bytes=1000000-', 2_097_152],
    ['bytes=1000000-2000000', 1_000_001],
    ['bytes=-4096', 4096],
  ] as const) {
    const intervalo = analisarRange(cabecalho, TOTAL);
    assert.ok(intervalo, `não parseou ${cabecalho}`);
    const range = reconstruirContentRange(intervalo.inicio, devolvido, TOTAL);
    assert.ok(range, `${cabecalho}: deveria reconstruir`);
    // Grupos na ordem do cabeçalho: start, end, total.
    const [, inicio, fim, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range as string) as RegExpExecArray;
    assert.equal(Number(inicio), intervalo.inicio, `${cabecalho}: o start precisa ser o pedido`);
    assert.equal(Number(fim), intervalo.inicio + devolvido - 1, `${cabecalho}: end é start + devolvido - 1`);
    assert.equal(Number(total), TOTAL, `${cabecalho}: o total vem dos metadados`);
    assert.ok(Number(fim) < Number(total), `${cabecalho}: o end não pode passar do total`);
  }
});
