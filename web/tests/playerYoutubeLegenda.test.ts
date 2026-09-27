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
   * `{}` e o ponto: o padrao do YouTube e nao carregar legenda, entao nao ha
   * param nenhum para mandar.
   *
   * Este teste ja afirmava, em comentario, que `cc_load_policy: '0'` explicito
   * "nao faria nada" contra a preferencia de legenda da conta — e dizia que isso
   * tinha sido medido. Nao tinha. A afirmacao veio de um comentario antigo,
   * pareceu plausivel, e ninguem conferiu. Ela fazia duas coisas ruins ao mesmo
   * tempo: autorizava um "nao faz diferenca" sem medicao, e trancava num teste o
   * que nao se sabe.
   *
   * O que este teste faz agora e o que da para afirmar: o caminho desligado nao
   * manda param de legenda. Se alguem mandar `0` explicito, este teste falha — de
   * proposito. A mudanca tem de ser uma decisao medida, com o resultado da
   * medicao escrito, e nao um default que ninguem questiona.
   */
  const corpo = youtube.slice(youtube.indexOf('function legendaParams'));
  const funcao = corpo.slice(0, corpo.indexOf('\n}'));
  assert.match(
    funcao,
    /if \(!captionsOn\) return \{\};/,
    'desligado tem que devolver objeto vazio, sem nenhum param de legenda',
  );
});

test('o codigo nao afirma medicao que ninguem fez', () => {
  /*
   * Este arquivo nasceu de uma frase: "ja foi medido que o 0 nao segura". Nao
   * tinha. Sobreviveu em comentario e em teste porque era crivel, e crivel e o
   * que faz uma afirmacao falsa passar por revisada.
   *
   * O teste trava a forma, nao o merito: legenda e um tema em que o codigo vai
   * acumulando afirmacoes herdadas sobre o que o YouTube aceita, e cada uma
   * pareceu confirmada por causa da anterior.
   */
  const codigo = youtube
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !/já foi medido|ja foi medido/.test(codigo),
    'so se afirma medicao que o codigo faz de verdade — e o codigo nao mede nada',
  );

  /*
   * Onde o comentario da funcao fala de medicao, tem que dizer que nao houve.
   * A razao de ser por arquivo separado: a frase estava dentro do bloco de
   * comentario da propria funcao, que e o lugar onde o proximo vai procurar a
   * explicacao e onde ela passou por verdade.
   */
  const bloco = youtube.slice(youtube.indexOf('function legendaParams'));
  const comentario = bloco.slice(0, bloco.indexOf('\n}'));
  const falaDeMedicao = /medid[oa]/.test(comentario);
  if (falaDeMedicao) {
    assert.match(
      comentario,
      /não foi|Não foi|nao foi/,
      'o comentario pode citar medicao, mas so dizendo que nao houve',
    );
  }
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
    /\.\.\.legendaParams\(legendaAoConstruir\)/,
    'o unico caminho de legenda na construcao e a funcao, e ela recebe o latch — nao a intencao, que cairia no desligar',
  );
});

test('o comando que esconde legenda existe e roda no onReady', () => {
  /*
   * Este teste nasceu do contrario do que ele verifica hoje. Ele existia para
   * garantir que `setOption` **nao** fosse chamado em execucao, com a justificativa
   * de que a API nao tinha o verbo. As duas coisas estavam erradas: o verbo
   * existe, aceita objeto vazio, e esconde a legenda que esta na tela.
   *
   * E o defeito era invisível por construção: um comando que não lança parece um
   * comando que funciona, e envolvido em `try/catch` não deixa rastro nenhum. O
   * código podia ter tentado esconder legenda durante anos e o sintoma seria o
   * mesmo de nunca ter tentado.
   *
   * Por isso o `onReady` é o ponto obrigatório: o param de construção não cobre
   * a preferencia de legenda que o YouTube guarda por conta e por video, e ela
   * vem acima do param. Sem o comando no `onReady`, o video sobe com legenda
   * mesmo sem nenhum `cc_load_policy`.
   */
  const codigo = semComentario(youtube);
  assert.match(
    codigo,
    /setOption\?\.\('captions',\s*'track',\s*\{\}\)/,
    'o comando de esconder legenda precisa existir de verdade',
  );
  /*
   * Procurar `onReady` pela primeira ocorrência pega o da interface `Props` — e
   * o teste passaria vazio, o que é o pior jeito de um teste falhar. A âncora é
   * o bloco `events`, que só existe uma vez, dentro do construtor do player.
   */
  const iEvents = codigo.indexOf('events: {');
  assert.ok(iEvents !== -1, 'o bloco events precisa existir');
  const iReady = codigo.indexOf('onReady:', iEvents);
  assert.ok(iReady !== -1, 'o onReady do player precisa existir');
  const trecho = codigo.slice(iReady, iReady + 600);
  assert.match(
    trecho,
    /if \(!legendaIntentada\.current\) hideCaptions\(\)/,
    'e o onReady precisa esconder quando a intencao e desligado',
  );
});

test('desligar legenda nao recria o player', () => {
  /*
   * O latch `legendaAoConstruir` é o que separa ligar de desligar.
   *
   * Sem ele, a dependência do efeito de criação seria `captionsOn`, e desligar
   * derrubaria e refazia o player: o vídeo recarregava e a posição voltava pelo
   * `handleReady` do `VideoStage`. Numa sala isso aparece como um soluço em todo
   * mundo, por causa de um botão de legenda.
   *
   * O teste trava a forma: o latch sobe e não desce dentro do mesmo vídeo, e
   * recomeça quando o vídeo muda. Descer é o que destruiria o ganho.
   */
  const codigo = semComentario(youtube);
  assert.match(
    codigo,
    /const \[legendaAoConstruir, setLegendaAoConstruir\] = useState\(captionsOn\)/,
    'o latch precisa existir separado da intencao',
  );
  assert.match(
    codigo,
    /if \(captionsOn\) setLegendaAoConstruir\(true\)/,
    'e so subir quando alguem liga legenda',
  );

  const iDeps = codigo.indexOf('}, [videoId, legendaAoConstruir, hideCaptions])');
  assert.ok(iDeps !== -1, 'a criacao depende do latch, nao da intencao');
  assert.ok(
    !/\[videoId, captionsOn/.test(codigo),
    'depender de captionsOn faria o desligar recriar o player',
  );

  // O desligar tem de estar em um efeito que observa `captionsOn` de lado.
  const iVirada = codigo.indexOf('const legendaAnterior');
  assert.ok(iVirada !== -1, 'o desligar precisa de efeito proprio');
  const trecho = codigo.slice(iVirada, iVirada + 400);
  assert.match(
    trecho,
    /if \(antes && !captionsOn\) hideCaptions\(\)/,
    'e ele esconde na virada de ligado para desligado',
  );
  assert.ok(
    !/setLegendaAoConstruir\(false\)/.test(codigo),
    'o latch nunca pode descer: descer recria o player',
  );
});

test('o onReady le a intencao por ref, e nao por props', () => {
  /*
   * O `onReady` é criado uma vez por player e roda depois. Se fechar sobre a
   * prop, ele carrega o valor do instante da construção — e dá para desligar a
   * legenda antes de o player ficar pronto, o que faria o `onReady` achar que
   * está ligado e não esconder. Por ref, ele lê o valor do momento em que roda.
   */
  const codigo = semComentario(youtube);
  assert.match(
    codigo,
    /const legendaIntentada = useRef\(captionsOn\)/,
    'a intencao precisa de ref para o onReady',
  );
  assert.match(
    codigo,
    /legendaIntentada\.current = captionsOn/,
    'e a ref precisa ser atualizada a cada render',
  );
});

test('nenhum getOptions de captions em tempo de execucao', () => {
  /*
   * `getOptions('captions')` devolveu objeto vazio em todos os videos testados,
   * contra o player real. Não serve para decidir se há faixa, então não tem por
   * que estar no código: ele só daria a ilusão de estar consultando algo.
   */
  const codigo = semComentario(youtube);
  assert.ok(
    !/getOptions\s*\(/.test(codigo),
    'getOptions nao informa nada util aqui: devolve vazio',
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
