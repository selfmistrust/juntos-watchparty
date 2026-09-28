import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * O campo de mensagem é um campo de verdade.
 *
 * ## O que aconteceu
 *
 * Houve aqui um espelho do texto: um `div` com o mesmo texto por baixo de um
 * `textarea` cujo texto era transparente, para pintar de roxo a menção enquanto
 * se digitava. O espelho foi medido e estava alinhado — 0px de diferença de área
 * de conteúdo, com texto curto e longo.
 *
 * E o campo ficou quebrado: caret que não aparecia, digitação estranha, seleção e
 * colar instáveis. O alinhamento perfeito não importava, porque o que a pessoa
 * digita é o `textarea`, e o `textarea` estava com o texto transparente.
 *
 * ## Por que estes testes são quase todos negativos
 *
 * O valor aqui é **impedir** a técnica de voltar, e não confirmar que algo
 * funciona. Isso é o oposto do resto do arquivo, e é proposital: o defeito foi
 * silencioso, não quebrou o build, passou typecheck e lint, e só apareceu quando
 * alguém digitou.
 *
 * A regra é do tipo "isto não pode aparecer", e a lista é a que foi pedida
 * explicitamente depois do defeito:
 *
 *   - `innerHTML` / `dangerouslySetInnerHTML`
 *   - `replace()` inserindo `<span>` dentro do editor
 *   - `contentEditable` improvisado
 *   - camada sobreposta que bloqueia o input
 *   - `color: transparent` e `caret-color: transparent`
 *   - `pointer-events` incorreto
 */
const painel = readFileSync(
  resolve(process.cwd(), '../web/components/chat/ChatPanel.tsx'),
  'utf8',
);
const espelho = resolve(process.cwd(), '../web/components/chat/MentionMirror.tsx');
const autocomplete = readFileSync(
  resolve(process.cwd(), '../web/components/chat/MentionAutocomplete.tsx'),
  'utf8',
);
const texto = readFileSync(
  resolve(process.cwd(), '../web/components/chat/MentionText.tsx'),
  'utf8',
);
const parser = readFileSync(
  resolve(process.cwd(), '../web/lib/mentionHighlight.ts'),
  'utf8',
);

/** O bloco JSX do `textarea`, que é o que precisa ser conferido. */
function blocoDoCampo() {
  const i = painel.indexOf('<textarea');
  assert.ok(i !== -1, 'o campo precisa existir');
  return painel.slice(i, painel.indexOf('/>', i));
}

test('o espelho do texto nao volta', () => {
  /*
   * O arquivo inteiro. Existiu, foi medido, e produziu um campo quebrado. Ele
   * pode ser reescrito do zero, mas não tem que voltar.
   */
  assert.ok(
    !existsSync(espelho),
    'MentionMirror.tsx não deve existir: ele quebrava o campo e foi removido',
  );
  assert.ok(
    !/MentionMirror/.test(painel),
    'e o ChatPanel não deve mais importar o espelho',
  );
});

test('o campo tem texto visivel e caret visivel', () => {
  /*
   * `text-transparent` é a raiz do defeito: o texto do campo sumia, e com ele a
   * sensação de digitação. O caret era compensado com `caret-color`, mas um
   * cursor desenhado por CSS sobre um campo cujo texto não existe é exatamente
   * o que ficou inconsistente na tela.
   */
  const campo = blocoDoCampo();
  assert.ok(
    !/text-transparent/.test(campo),
    'o campo não pode ter texto transparente: o caret e o texto precisam ser o do navegador',
  );
  assert.ok(
    !/caret-transparent/.test(campo),
    'nem caret transparente',
  );
  assert.match(campo, /text-ink/, 'e o texto tem que ser o da cor normal');
});

test('o campo nao tem camada por cima nem por baixo', () => {
  /*
   * Nada de `absolute`/`z-` no campo, e nada de wrapper `relative` segurando um
   * espelho. Um `relative` sozinho seria inofensivo, mas o wrapper do espelho é
   * o que volta junto com ele — então o wrapper também não deve estar lá.
   */
  const campo = blocoDoCampo();
  assert.ok(!/absolute/.test(campo), 'o campo não pode ser posicionado: não há nada para ele ficar por cima');
  assert.ok(!/z-\d/.test(campo), 'e não pode ter z-index');
  assert.ok(
    !/relative min-w-0 flex-1/.test(painel),
    'o wrapper do espelho não deve existir mais; o textarea volta a ser filho direto da linha',
  );
});

test('nenhuma das tecnicas proibidas aparece no chat', () => {
  /*
   * Varredura ampla de propósito: os arquivos proibidos já foram
   * `MentionMirror.tsx`, e um deles aplicado no `ChatPanel` ou no
   * `MentionAutocomplete` passaria despercebido numa revisão.
   */
  const arquivos = { 'ChatPanel': painel, 'MentionAutocomplete': autocomplete };
  for (const [nome, fonte] of Object.entries(arquivos)) {
    const semComentario = fonte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(!/dangerouslySetInnerHTML/.test(semComentario), `${nome}: sem dangerouslySetInnerHTML`);
    assert.ok(!/innerHTML\s*=/.test(semComentario), `${nome}: sem innerHTML`);
    assert.ok(!/contentEditable/.test(semComentario), `${nome}: sem contentEditable`);
    assert.ok(
      !/replace\([^)]*<span/.test(semComentario),
      `${nome}: sem replace() inserindo span no editor`,
    );
  }
});

test('o campo e controlado so por value e onChange', () => {
  /*
   * O valor do campo é o estado do React, e nada mais escreve nele. Um
   * `setSelectionRange` no `onChange` seria a forma sutil do mesmo defeito: funciona na primeira tecla e briga com o cursor na terceira.
   */
  const campo = blocoDoCampo();
  assert.match(campo, /value=\{draft\}/, 'o valor vem do estado');
  assert.match(campo, /onChange=\{\(e\) => signalTyping\(e\.target\.value\)\}/, 'e o onChange só lê o valor');
  assert.ok(!/setSelectionRange/.test(campo), 'o onChange não mexe no cursor');
  assert.ok(!/ref\.current\.value\s*=/.test(painel), 'e nada escreve no .value do campo por fora');
});

test('o roxo da mencao em curso fica na lista, nao no campo', () => {
  /*
   * A lista de sugestões é onde o destaque ajuda sem custo: é um elemento
   * normal, e pintar o trecho que casou é o que mostra "a lista entendeu o que
   * eu digitei".
   */
  assert.match(
    autocomplete,
    /function dividir\(nome: string, consulta: string\)/,
    'a lista precisa pintar o trecho que casou',
  );
  assert.match(
    autocomplete,
    /<span className="text-accent">@\{casou\}<\/span>/,
    'e o roxo fica no trecho digitado, com o @ fora do destaque',
  );
  assert.match(
    autocomplete,
    /Math\.min\(normalizar\(nome\)\.indexOf\(alvo\)/,
    'o corte é limitado ao tamanho do nome, para o nome não sumir da lista',
  );
});

test('a mensagem enviada continua com a mencao em destaque', () => {
  /*
   * Este é o lugar onde o destaque não tem custo nenhum: é texto já enviado,
   * dentro de um `<p>`, com o valor do campo longe dali.
   */
  /*
   * O tipo do segmento mora no parser, e não no componente: `MentionText` só
   * consome o que `segmentarTexto` devolveu. A primeira versão do teste procurava
   * `tipo: 'mencao'` no componente, e o teste estava errado sobre onde a coisa
   * está — não o componente errado por não ter a string.
   */
  assert.match(parser, /tipo: 'mencao'/, 'o parser de destaque do lado do cliente continua');
  assert.match(texto, /seg\.tipo === 'texto'/, 'e o componente consome os dois tipos de segmento');
  assert.match(
    painel,
    /<MentionText[\s\S]{0,400}?mencionados=\{entry\.mentions\}/,
    'e a mensagem renderizada usa ele',
  );
});
