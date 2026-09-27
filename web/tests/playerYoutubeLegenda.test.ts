import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * Vídeo do YouTube não inicia com legenda forçada.
 *
 * ## O que estes testes medem, e por que são distintos dos outros
 *
 * Existe uma confusão fácil aqui, e ela precisa ficar travada em código:
 * `cc_load_policy: '1'` **aparece** no `YoutubePlayer`, mas não é o padrão. Ele
 * só é enviado quando alguém clicou no botão de legenda — o estado nasce em
 * `false` e a função devolve `{}` enquanto isso.
 *
 * Ou seja: o texto do arquivo sugere que a legenda é forçada, e o comportamento
 * é o oposto. Ler o arquivo e concluir errado é fácil; por isso o que está
 * travado aqui é a **cadeia inteira** — o estado inicial, o retorno da função e
 * o spread no `playerVars`. Se alguém passar a forçar legenda na construção sem
 * perceber, o nome da variável continua igual e nada denuncia.
 */
const youtube = readFileSync(
  resolve(process.cwd(), '../web/components/player/YoutubePlayer.tsx'),
  'utf8',
);
const stage = readFileSync(
  resolve(process.cwd(), '../web/components/player/VideoStage.tsx'),
  'utf8',
);

/** Tira comentarios de bloco, que e onde a documentacao destes testes mora. */
function semComentario(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('o estado nasce desligado', () => {
  /*
   * A origem de tudo. `captionsOn` verdadeiro na montagem significaria
   * `cc_load_policy: '1'` em toda primeira carga, e a legenda subiria sozinha
   * em todo vídeo da sala.
   */
  assert.match(
    stage,
    /useState\(false\)[^\n]*\n[^\n]*captionsOn|const \[captionsOn, setCaptionsOn\] = useState\(false\)/,
    'captionsOn precisa nascer em false',
  );
});

test('com legenda desligada nenhum param de legenda e enviado', () => {
  /*
   * `{}` e o ponto: o padrao do YouTube e nao carregar legenda, e o app nao
   * precisa — nem pode, na verdade — mandar `cc_load_policy: '0'`.
   *
   * Mandar o `0` explicito parece mais seguro e nao e. Ja foi medido: quando o
   * YouTube devolve legenda por preferencia da conta, nenhum dos params
   * segura — nem ausencia dele, nem `0`, nem `cc_lang_pref` invalido. Entao o
   * `0` explicito seria um param que nao faz nada, dando a impressao de que a
   * legenda esta sob controle quando nao esta.
   */
  const corpo = youtube.slice(youtube.indexOf('function legendaParams'));
  const funcao = corpo.slice(0, corpo.indexOf('\n}'));
  assert.match(
    funcao,
    /if \(!captionsOn\) return \{\};/,
    'desligado tem que devolver objeto vazio, sem nenhum param de legenda',
  );
});

test('cc_load_policy nao esta no playerVars, so vem da funcao', () => {
  /*
   * Se o `1` aparecesse literal no objeto de `playerVars`, ele entraria em toda
   * carga e o guard da funcao nao impediria nada. E o oposto do que foi pedido:
   * o objetivo e nao forcar legenda na construcao.
   */
  const bloco = youtube.slice(youtube.indexOf('playerVars'), youtube.indexOf('events'));
  assert.ok(
    !/cc_load_policy:\s*['"]1['"]/.test(bloco),
    'o playerVars nao pode trazer cc_load_policy: 1 literal',
  );
  assert.ok(
    !/cc_lang_pref/.test(bloco),
    'cc_lang_pref tambem nao entra sem a escolha da pessoa',
  );
  assert.match(
    bloco,
    /\.\.\.legendaParams\(captionsOn\)/,
    'o unico caminho de legenda e a funcao, que respeita a intencao',
  );
});

test('nenhum setOption ou getOptions de captions em tempo de execucao', () => {
  /*
   * A documentacao do player cita `setOption('captions', ...)` como
   * possibilidade, e essa citacao e o que costuma ser confundido com codigo
   * usando. Aqui a busca e feita **depois** de tirar os comentarios: o que
   * sobrar e chamada de verdade, e nao deve sobrar nada.
   */
  const codigo = semComentario(youtube);
  assert.ok(
    !/setOption\s*\(/.test(codigo),
    'setOption nao pode ser chamado em execucao: so existe em comentario',
  );
  assert.ok(
    !/getOptions\s*\(/.test(codigo),
    'getOptions idem',
  );
  assert.ok(
    !/loadModule\(|addEventListener\(['"]onCaptions/.test(codigo),
    'e nao ha carregamento de legenda por fora dos playerVars',
  );
});

test('so o botao de legenda muda esse estado', () => {
  /*
   * Se outro lugar mexesse em `setCaptionsOn`, a garantia de "nao forcado no
   * inicio" continuaria valendo no primeiro video mas nao depois, e o culpado
   * seria invisivel. Este teste lista quem pode.
   */
  const quem = stage.match(/setCaptionsOn\(/g) ?? [];
  assert.equal(quem.length, 1, 'so o toggle do botao pode mexer em captionsOn');
  assert.match(stage, /setCaptionsOn\(\(prev\) => !prev\)/, 'e ele alterna pelos dois sentidos');
});
