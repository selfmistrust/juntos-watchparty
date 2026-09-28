import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * O espelho do campo de menção.
 *
 * ## Por que isto é delicate o suficiente para ter teste
 *
 * A técnica é o espelho: um `div` com o mesmo texto por trás de um `textarea`
 * transparente, porque `textarea` não aceita marcação. E ela quebra de um jeito
 * que nenhum teste de unidade pegaria: **desalinha**.
 *
 * Se uma diferença de 1px em padding, uma linha de `line-height` ou a barra de
 * rolagem de um lado e não do outro, o roxo da menção cai sobre a palavra
 * errada. E o defeito parece aleatório, porque depende do tamanho do texto.
 *
 * ## O que foi medido no navegador, e estes números são o motivo do arquivo
 *
 * Com o campo rolando (`max-h-28`), a área de texto do `textarea` era mais
 * estreita que a do espelho, e o texto quebrava em pontos diferentes:
 *
 *     campo:    1236px de conteúdo
 *     espelho:  1246px            ← 10px: a barra de rolagem
 *
 * Com `scrollbar-gutter: stable` nos dois, sobraram 5px — porque o espelho não
 * tinha `scroll-thin` e reservava os 15px da barra padrão, contra os 10px da
 * fina. Com as duas coisas nos dois: **0px de diferença**, medido com texto curto
 * e com texto longo.
 *
 * Nenhum desses números aparece no código, e é por isso que o teste trava a
 * estrutura em vez do valor.
 */
const mirror = readFileSync(
  resolve(process.cwd(), '../web/components/chat/MentionMirror.tsx'),
  'utf8',
);
const painel = readFileSync(
  resolve(process.cwd(), '../web/components/chat/ChatPanel.tsx'),
  'utf8',
);
const auto = readFileSync(
  resolve(process.cwd(), '../web/components/chat/MentionAutocomplete.tsx'),
  'utf8',
);

test('as classes de metrica sao as mesmas nos dois elementos', () => {
  /*
   * Duas listas de classes de métrica divergem na primeira edição que alguém
   * fizer em uma delas. Por isso a lista é **exportada** do espelho e o
   * `textarea` a importa — os dois literalmente não podem divergir.
   */
  assert.match(mirror, /export const CLASSE_METRICA =/, 'a métrica precisa ser exportada');
  assert.match(
    painel,
    /\$\{CLASSE_METRICA\}/,
    'o textarea precisa usar a métrica do espelho, e não a sua própria',
  );
  assert.ok(
    !/CLASSE_METRICA =/.test(painel),
    'o painel não pode ter uma segunda lista de métrica',
  );
});

test('a faixa da barra de rolagem e a mesma nos dois', () => {
  /*
   * `scrollbar-gutter: stable` reserva a faixa nos dois desde sempre, e é isso
   * que faz o texto não re-quebrar quando a 4ª linha aparece.
   *
   * E `scroll-thin` vai junto porque o gutter reserva a largura **daquele**
   * contêiner: sem a classe no espelho, ele reservava 15px e o campo 10px. Era
   * o que faltava para os dois chegarem a 0px de diferença.
   */
  assert.match(
    mirror,
    /export const GUTTER_ESTAVEL = 'scroll-thin \[scrollbar-gutter:stable\]'/,
    'o gutter tem que vir com a barra fina, ou os dois reservam larguras diferentes',
  );
  assert.match(painel, /\$\{GUTTER_ESTAVEL\}/, 'o textarea precisa do mesmo gutter');
  assert.match(
    mirror,
    /\$\{CLASSE_METRICA\} \$\{GUTTER_ESTAVEL\}/,
    'e o espelho usa os dois, na mesma ordem do campo',
  );
});

test('o texto do campo e transparente, com cursor e selecao visiveis', () => {
  /*
   * `text-transparent` esconde o texto — que é de propósito, quem lê é o
   * espelho. Mas o cursor e a seleção **não podem** ir junto:
   *
   * - sem `caret`, a pessoa não sabe onde está digitando;
   * - sem fundo de seleção, apagar uma frase inteira selecionada pareceria não
   *   ter funcionado, porque o texto selecionado ficaria invisível.
   */
  assert.match(painel, /text-transparent/, 'o texto do campo é transparente');
  assert.match(painel, /caret-\[var\(--ink\)\]/, 'e o cursor continua visível');
  assert.match(
    painel,
    /selection:bg-accent\/30/,
    'e a seleção precisa de fundo, senão apagar selecionado parece não funcionar',
  );
});

test('o espelho e aria-hidden e nao interage', () => {
  /*
   * O espelho é uma cópia do valor. Sem `aria-hidden`, um leitor de tela leria o
   * texto duas vezes — uma no campo, outra no espelho — e a pessoa ouviria a
   * mensagem repetida a cada tecla.
   */
  assert.match(mirror, /aria-hidden/, 'o espelho precisa ser aria-hidden');
  assert.match(mirror, /pointer-events-none/, 'e não pode capturar clique');
});

test('a rolagem do espelho acompanha a do campo', () => {
  /*
   * O campo rola a partir de `max-h-28`. Sem copiar o `scrollTop`, o roxo
   * apareceria na linha errada justamente quando há mais texto na tela — que é
   * quando a pessoa está lendo para conferir o que digitou.
   *
   * E é por listener, e não por re-render: o `scrollTop` muda a cada pixel, e
   * levá-lo por estado faria o `ChatPanel` re-renderizar a cada um durante a
   * digitação.
   */
  assert.match(
    mirror,
    /addEventListener\('scroll', aoRolar, \{ passive: true \}\)/,
    'o espelho escuta a rolagem do campo',
  );
  assert.match(mirror, /espelho\.scrollTop = campo\.scrollTop/, 'e copia o scrollTop');
  assert.match(
    mirror,
    /removeEventListener\('scroll', aoRolar\)/,
    'e desliga o listener ao desmontar, senão acumula a cada tecla',
  );
});

test('o espelho so marca quando a consulta casa com alguem', () => {
  /*
   * O `@` de uma frase pode ser texto, não menção. `@Maria Silva, viu?` tem
   * vírgula depois do nome, e portanto não é menção nenhuma — se o espelho
   * marcasse, o roxo apareceria sobre a frase inteira.
   *
   * O filtro é o mesmo do autocomplete: o espelho recebe `inicio`/`fim` já
   * calculados, e quem calcula é o `mencaoAberta`, que é nulo sem casamento.
   */
  assert.match(painel, /inicio=\{mencaoAberta\?\.inicio\}/, 'o espelho só recebe a menção quando ela existe');
  assert.match(
    painel,
    /mencaoAberta\.inicio\s*\+\s*1\s*\+\s*mencaoAberta\.consulta\.length/,
    'e o fim é o fim da consulta (@ + o que foi digitado), não o fim do texto',
  );
});

test('passar o mouse na lista so move o destaque', () => {
  /*
   * A primeira versão chamava `onEscolher` no `onMouseEnter`, e o defeito era o
   * pior possível num autocomplete: passar o mouse sobre a lista escrevia
   * `@Nome Completo` no meio da frase, sem ninguém pedir.
   */
  assert.ok(
    !/onMouseEnter=\{\(\) => onEscolher/.test(auto),
    'o hover não pode escolher: passaria o mouse e o texto mudaria sozinho',
  );
  assert.match(auto, /onMouseEnter=\{\(\) => onPassarOMouse\(indice\)\}/, 'o hover move o índice');
});

test('o perfil e um botão separado, e não dentro do botão do nome', () => {
  /*
   * Botão dentro de botão é HTML inválido, e o botão de perfil ficaria preso
   * dentro da área de clique do nome: clicar nele inseriria a menção em vez de
   * abrir o perfil — o botão pareceria funcionar e faria outra coisa.
   */
  assert.match(
    auto,
    /flex items-center gap-1 rounded-lg pr-1/,
    'a linha precisa de um wrapper, para os dois botões ficarem irmãos',
  );
  assert.match(auto, /onVerPerfil\(user\)/, 'e o botão de perfil precisa chamar onVerPerfil');
  assert.match(
    auto,
    /aria-label=\{`Ver perfil de \$\{user\.name\}`\}/,
    'com rótulo próprio, que é o que o leitor de tela anuncia',
  );
});
