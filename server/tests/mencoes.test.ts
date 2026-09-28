import assert from 'node:assert/strict';
import { test } from 'node:test';
/*
 * Os caminhos do import são relativos ao **arquivo**, e os do `readFileSync` são
 * relativos ao `cwd`. Como o runner é chamado de dentro de `server/`, os dois
 * não podem usar o mesmo prefixo — e o `.ts` é explícito porque este import é
 * resolvido pelo Node, que não sabe da extensão.
 */
import { extrairMencoes, mencaoPendente, normalizarNome, sugerirMencoes } from '../src/mentions.js';
import {
  mencaoPendente as mencaoPendenteCliente,
  normalizar,
  segmentarTexto,
  sugerir,
} from '../../web/lib/mentionHighlight.ts';

/*
 * Menções: o parser do servidor e o do cliente precisam concordar.
 *
 * ## Por que dois parsers
 *
 * O servidor é quem decide quem é notificado; o cliente é quem desenha o
 * destaque. Cada um roda no seu lado, e a `web` não importa nada de `server/`
 * — o backend e o front são empacotados separados. Então existem duas
 * implementações, e o preço de duas é a possibilidade de divergirem.
 *
 * A divergência tem um sintoma pequeno e chato: a menção toca o som, chega a
 * notificação, e o `@nome` na tela não fica marcado. Ninguém percebe o motivo,
 * e o primeiro palpite é sempre "a menção não chegou".
 *
 * Estes testes existem para que essa divergência seja um teste vermelho e não
 * um relato.
 *
 * ## O que o teste não tenta fazer
 *
 * Não tenta provar que a lógica é boa em todos os casos. Ele prova o que
 * importa para o defeito: **os dois lados dizem a mesma coisa no mesmo texto**.
 */

/*
 * A sala de teste.
 *
 * `Ana` e `ana` são o par de nomes repetidos, em caixa diferente de propósito:
 * é o caso que expõe o `Map<string, string>`, que guardaria um dos dois e
 * deixaria o outro sem nunca ser citado.
 *
 * `Maria Silva` ao lado de `maria` não é par de repetidos, e a diferença
 * importa para o teste: `maria` é o **primeiro nome** de `Maria Silva`, e é
 * por isso que `@Maria` tem que citar alguém. Confundir os dois casos foi
 * exatamente o que fez a primeira versão deste fixture passar vergonha.
 */
const SALA = [
  { sessionId: 's-maria', name: 'Maria Silva' },
  { sessionId: 's-joao', name: 'João' },
  { sessionId: 's-ana1', name: 'Ana' },
  { sessionId: 's-ana2', name: 'ana' },
  { sessionId: 's-bob', name: 'Bob' },
];

/** O que o servidor resolve, como lista de `sessionId`. */
function cited(texto: string): string[] {
  return extrairMencoes(texto, SALA).map((m) => m.sessionId).sort();
}

/** Os segmentos de menção que o cliente desenharia, dado o que o servidor Cited. */
function segmentosDesenhados(texto: string) {
  return segmentarTexto(texto, SALA, cited(texto)).filter((s) => s.tipo === 'mencao');
}

/**
 * A invariante real: o que o cliente desenha é um **subconjunto** do que o
 * servidor resolveu, e nunca é zero quando o servidor resolveu algo.
 *
 * Subconjunto, e não igualdade, porque com nomes repetidos os dois lados estão
 * certos e mesmo assim as contagens não batem: o servidor notifica as duas
 * pessoas chamadas `Ana`, e a tela mostra um `@Ana` só — um `sessionId` por
 * pedaço de texto é o máximo que um texto pode ter.
 *
 * Comparar as listas inteiras falhava nesse caso, e o jeito mais fácil de "consertar"
 * seria fazer o servidor citar uma pessoa só. Era o teste errado, não o código.
 */
function confere(texto: string): void {
  const ids = cited(texto);
  const desenhados = segmentosDesenhados(texto);
  for (const seg of desenhados) {
    assert.ok(
      ids.includes((seg as { sessionId: string }).sessionId),
      `o cliente desenhou ${JSON.stringify(seg)} e o servidor não citou ninguém assim em ${JSON.stringify(texto)}`,
    );
  }
  assert.equal(
    desenhados.length > 0,
    ids.length > 0,
    `servidor e cliente discordaram sobre existir menção em ${JSON.stringify(texto)}`,
  );
}

test('os dois lados concordam em quem é citado', () => {
  const textos = [
    '@Maria Silva você viu essa cena?',
    '@João olha isso',
    'e aí @ana, o que acha?',
    '@Maria @João @ana três de uma vez',
    'sem menção nenhuma aqui',
    '@Bob',
    '@mari silva em minúsculo e sem acento',
    '@Mariaxyz não cita ninguém',
    '@inexistente não casa com nada',
    'email alguem@Bob.com não é menção',
    '@João e depois mais texto @Bob',
    '@Maria Silva! com exclamação',
    '@ana.',
    'texto com @ no fim',
    '@',
  ];

  for (const texto of textos) {
    confere(texto);
  }
});

test('nome com espaço casa inteiro e por primeiro nome', () => {
  /*
   * `@Maria Silva` precisa citar a pessoa do nome inteiro, e `@Maria` também —
   * é o que a pessoa espera ao digitar o primeiro nome.
   *
   * O caso que prova o "maior casamento ganha": na sala está `Maria Silva`, e
   * `@Maria` é o primeiro nome dela. O candidato de uma palavra casa com ela, e
   * o de duas também casa com o nome inteiro. Ganha o de duas.
   *
   * E `@Mariaxyz` não pode citar: casamento por palavra completa, não por
   * prefixo solto, ou `@Mari` citaria metade da sala.
   */
  assert.deepEqual(cited('@Maria Silva olha'), ['s-maria']);
  assert.deepEqual(cited('@Maria olha'), ['s-maria']);
  assert.deepEqual(cited('@Mariaxyz olha'), []);
  assert.deepEqual(cited('@Mari olha'), []);
});

test('nomes repetidos citam as duas pessoas', () => {
  /*
   * Duas pessoas com o mesmo nome na sala é a ambiguidade que não tem solução
   * limpa. Notificar as duas é o pior erro conhecido; notificar uma errada é o
   * pior erro possível, porque quem recebe uma menção que não era para ela para
   * de confiar na próxima.
   *
   * O par é `Ana` e `ana`: a comparação de nome normaliza a caixa, então as
   * duas colidem — e é a colisão que um `Map` de valor único esconderia.
   */
  assert.deepEqual(cited('@Ana olha'), ['s-ana1', 's-ana2']);
  assert.deepEqual(cited('@ana olha'), ['s-ana1', 's-ana2']);
  assert.deepEqual(cited('@ANA olha'), ['s-ana1', 's-ana2']);
});

test('a si mesmo nunca é citado', () => {
  /*
   * O filtro acontece no `socket`, que monta a lista de participantes sem a
   * própria pessoa. Aqui o teste trava a consequência: se a pessoa se
   * mencionasse, ouviria o próprio nome.
   */
  const semEu = SALA.filter((u) => u.sessionId !== 's-joao');
  assert.deepEqual(
    extrairMencoes('@João olha', semEu).map((m) => m.sessionId),
    [],
    'sem a própria pessoa na lista, não há quem casar',
  );
  assert.deepEqual(cited('@João olha'), ['s-joao'], 'e com ela na lista, casa normalmente');
});

test('email não vira menção', () => {
  /*
   * `alguem@Bob.com` tem um `@` seguido de um nome que existe na sala. Sem a
   * regra do caractere anterior, citar alguém por e-mail seria o jeito mais
   * fácil de ser citado sem querer — e de tocar o som de alguém por acidente.
   */
  assert.deepEqual(cited('escreve pra alguem@Bob.com'), []);
  assert.deepEqual(cited('@Bob é assim que se escreve'), ['s-bob']);
});

test('acentos e caixa não importam', () => {
  assert.deepEqual(cited('@joao olha'), ['s-joao']);
  assert.deepEqual(cited('@JOÃO olha'), ['s-joao']);
  /*
   * `maria silva`, e não `mari silva`: o primeiro nome é "Maria", com cinco
   * letras. A primeira versão deste teste escrevia `mari` e `MARI` esperando
   * acerto — que não existe, porque "mari" não é o primeiro nome de ninguém na
   * sala. O parser estava certo as duas vezes e o teste é que estava digitado
   * errado, duas vezes.
   */
  assert.deepEqual(cited('@maria silva olha'), ['s-maria']);
  assert.deepEqual(cited('@MARIA SILVA olha'), ['s-maria']);
  assert.equal(normalizarNome('João'), normalizarNome('joao'));
  assert.equal(normalizar('João'), normalizar('joao'));
});

test('o destaque cobre o @ e só o nome', () => {
  /*
   * O `inicio`/`fim` delimitam o nome, e o desenho monta `@` + nome. Se o
   * intervalo incluísse a frase seguinte, o destaque viraria um bloco
   * destacado em volta de "@Maria você viu essa cena?" — que é o defeito mais
   * visível possível e o mais fácil de não perceber em texto curto.
   */
  const texto = '@Maria Silva você viu essa cena?';
  const [m] = extrairMencoes(texto, SALA);
  assert.equal(m.texto, 'Maria Silva');
  assert.equal(texto.slice(0, m.inicio), '@');
  assert.equal(texto.slice(m.inicio, m.fim), 'Maria Silva');
  assert.equal(texto.slice(m.fim), ' você viu essa cena?');

  /*
   * Dois segmentos, e não três: não existe pedaço de texto vazio antes do `@`,
   * porque a menção começa no índice 0. Emitir um `''` aqui renderizaria um nó a
   * mais por mensagem sem nada dentro, e a lista de segmentos é comparada
   * inteiro nos testes — um `''` espúrio faria toda comparação divergir.
   */
  const segmentos = segmentarTexto(texto, SALA, ['s-maria']);
  assert.equal(segmentos.length, 2);
  assert.equal(segmentos[0].tipo === 'mencao' && segmentos[0].texto, '@Maria Silva');
  assert.deepEqual(segmentos[1], { tipo: 'texto', texto: ' você viu essa cena?' });

  /*
   * E o mesmo texto com a menção no meio: agora o pedaço da esquerda **existe**,
   * e precisa ser preservado. É o caso em que a menção no início esconde um
   * defeito de perder o texto anterior.
   */
  const noMeio = segmentarTexto('olá @Maria Silva, tudo bem?', SALA, ['s-maria']);
  assert.equal(noMeio.length, 3);
  assert.deepEqual(noMeio[0], { tipo: 'texto', texto: 'olá ' });
  assert.equal(noMeio[1].tipo === 'mencao' && noMeio[1].texto, '@Maria Silva');
  assert.deepEqual(noMeio[2], { tipo: 'texto', texto: ', tudo bem?' });
});

test('o cliente não desenha quem o servidor não citou', () => {
  /*
   * A direção importa: um cliente que desenha por conta própria poderia
   * mencionar alguém que o servidor decidiu que não é menção. O servidor é a
   * autoridade, e o desenho obedece.
   */
  const texto = '@Maria olha';
  const segmentos = segmentarTexto(texto, SALA, []);
  assert.equal(segmentos.length, 1);
  assert.equal(segmentos[0].tipo, 'texto');
  assert.equal(segmentos[0].texto, '@Maria olha');
});

test('o autocomplete dos dois lados concorda', () => {
  /*
   * A lista de sugestões é do cliente, mas a regra do que é "um @ que ainda
   * está sendo digitado" precisa ser a mesma do servidor — senão a lista abre
   * num `@` que o servidor não consideraria menção, e a pessoa completa uma
   * sugestão que não vai notificar ninguém.
   */
  for (const texto of ['@', '@Ma', '@Maria', '@Maria Silva', 'olá @Ma', 'email a@Bob', '@Maria!', 'linha\n@Ma']) {
    const a = mencaoPendente(texto);
    const b = mencaoPendenteCliente(texto);
    assert.deepEqual(
      b,
      a,
      `os dois lados discordaram do @ pendente em ${JSON.stringify(texto)}`,
    );
  }
});

test('a lista de sugestões filtra e ordena', () => {
  const todos = SALA.map((u) => ({ ...u, userId: u.sessionId }));
  /*
   * A ordem é a do `localeCompare` em pt-BR, e ela põe `ana` antes de `Ana`
   * porque a comparação ignora a caixa: os dois começam com "ana", e o nome
   * mais curto vem primeiro. Esperar o contrário foi o erro da primeira
   * versão deste teste — a ordenação estava certa e a expectativa não.
   */
  assert.deepEqual(sugerir('Ma', todos).map((u) => u.name), ['Maria Silva']);
  assert.deepEqual(sugerirMencoes('Ma', SALA).map((u) => u.name), ['Maria Silva']);
  assert.deepEqual(
    sugerir('a', todos).map((u) => u.name),
    sugerirMencoes('a', SALA).map((u) => u.name),
    'os dois lados ordenam igual',
  );
  assert.deepEqual(sugerir('zzz', todos), []);
  assert.deepEqual(sugerir('', todos), [], 'consulta vazia não sugere ninguém');
});

test('nomes absurdamente longos não travam', () => {
  /*
   * Sem teto, `@` seguido de 600 caracteres vira 600 comparações de nome por
   * mensagem, e o `sanitizeMessage` corta em 600 — então o pior caso é o
   * tamanho máximo da mensagem mesmo. O teto mantém o trabalho constante e a
   * regra é a mesma dos dois lados.
   */
  const longo = '@' + 'a'.repeat(500) + ' João';
  const achados = extrairMencoes(longo, SALA);
  assert.ok(Array.isArray(achados));
  assert.equal(mencaoPendente('@' + 'a'.repeat(200)), null);
  assert.equal(mencaoPendenteCliente('@' + 'a'.repeat(200)), null);
});
