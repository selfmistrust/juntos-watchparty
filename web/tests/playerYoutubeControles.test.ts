import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * A barra nativa do YouTube fica desligada.
 *
 * ## Por que este arquivo trava uma configuração, e não um comportamento
 *
 * `controls: 1` já esteve neste player, por um motivo bom na época: o botão de CC
 * nativo era a única forma de *desligar* legenda. E o efeito colateral foi
 * exatamente o que este teste existe para impedir de voltar: a barra nativa
 * ocupa os mesmos ~48px do rodapé que a nossa, e ela **não passa pela sala**.
 *
 * O play e a pausa dela desincronizavam todo mundo. O volume e o mudo eram estado
 * local do iframe, e o `setVolume` do `VideoStage` sobrescrevia no snapshot
 * seguinte. Um efeito corrigia em um ciclo, mas correção não é prevenção, e
 * ninguém corrigindo é melhor que ninguém errando.
 *
 * A falha era silenciosa: o vídeo tocava, a sala sincronizava de novo em seguida,
 * e nada aparecia no console. Por isso trava no texto — é a única forma de o
 * valor voltar sem que uma revisão o note.
 */
const youtube = readFileSync(
  resolve(process.cwd(), '../web/components/player/YoutubePlayer.tsx'),
  'utf8',
);
const stage = readFileSync(
  resolve(process.cwd(), '../web/components/player/VideoStage.tsx'),
  'utf8',
);
const controls = readFileSync(
  resolve(process.cwd(), '../web/components/player/PlayerControls.tsx'),
  'utf8',
);
const types = readFileSync(resolve(process.cwd(), '../web/types/index.ts'), 'utf8');

test('a barra nativa e os playerVars exigidos', () => {
  /*
   * Cada param tem um motivo, e o motivo está escrito no código. `controls: 0` é
   * o que tira de uma vez a barra de progresso, o play/pausa, o volume e a tela
   * cheia do YouTube — os quatro que competiam com a nossa barra.
   */
  const bloco = youtube.slice(youtube.indexOf('playerVars'), youtube.indexOf('events'));
  assert.match(bloco, /controls: 0\b/, 'controls tem que ser 0, senão a barra nativa volta');
  assert.match(bloco, /enablejsapi: 1\b/, 'enablejsapi habilita os verbos da API');
  assert.match(bloco, /playsinline: 1\b/, 'playsinline mantem a reproducao no lugar');
  assert.match(bloco, /fs: 0\b/, 'fs desliga a tela cheia do YouTube');
  assert.match(bloco, /disablekb: 1\b/, 'disablekb tira os atalhos que furavam a sala');
});

test('o hideControls nao volta como chamada inocia', () => {
  /*
   * `hideControls` existia para rebater a barra depois de cada comando nosso,
   * porque o `YT.Player` reconstroi a UI a cada `play`/`pause`/`seek`. Com
   * `controls: 0` a UI nao e construida, entao a chamada virou no-op: uma ida
   * ao iframe por ciclo de correcao de deriva (a cada ~1,2s) para nao fazer
   * nada. Deixar seria deixar um no-op com origem desconhecida.
   */
  assert.ok(
    !/hideControls\s*\??\.\s*\(/.test(youtube),
    'hideControls nao deve ser chamado: com controls 0 ele nao faz nada',
  );
  assert.ok(
    !/hideNativeControls/.test(youtube) && !/hideNativeControls/.test(stage) && !/hideNativeControls/.test(types),
    'hideNativeControls saiu do handle, do palco e do tipo compartilhado',
  );
});

test('os verbos da API continuam comandando o player', () => {
  /*
   * Desligar a barra nativa só vale se a nossa barra for a única via de comando.
   * Estes verbos sao a superficie inteira sobre o player do YouTube.
   */
  for (const verbo of [
    'playVideo',
    'pauseVideo',
    'seekTo',
    'setVolume',
    'mute',
    'unMute',
    'getCurrentTime',
    'getDuration',
  ]) {
    /*
     * Com argumento ou sem — `seekTo?.(s, true)` e `playVideo?.()` são ambos
     * verbos em uso. A primeira versão deste teste exigia `verbo?.()` e falhou
     * em `seekTo`, que era o teste errado e não o código: `seekTo` é o único
     * que recebe posição, e é justamente o que faz a barra de progresso
     * funcionar.
     */
    assert.match(
      youtube,
      new RegExp(`${verbo}\\?\\.\\(`),
      `o verbo ${verbo} precisa continuar no handle`,
    );
  }
  assert.match(stage, /playerRef\.current\?\.seek/, 'o palco precisa continuar mandando seek');
  assert.match(stage, /playerRef\.current\?\.setVolume/, 'e volume');
});

test('o handover para os controles do YouTube sumiu inteiro', () => {
  /*
   * Existia um modo em que a nossa barra dava lugar a nativa, com um botao no
   * canto para voltar. Com `controls: 0` esse caminho nao tem destino: o botao
   * trocaria a nossa barra por uma barra que nao existe, e quem clicasse ficaria
   * sem controle nenhum.
   */
  assert.ok(!/onHandOverToNative/.test(controls), 'a prop do handover nao pode sobrar');
  assert.ok(!/onHandOverToNative/.test(stage), 'nem ser passada pelo palco');
  assert.ok(
    !/Voltar aos controles juntos/.test(stage),
    'nem o botao que trazia a barra de volta',
  );
  assert.ok(!/GearSix/.test(controls), 'e o icone dele nao fica importado sem uso');
});

test('a legenda continua com as duas direcoes na nossa barra', () => {
  /*
   * Este e o preco conhecido de `controls: 0`, e precisa ficar escrito: o botao
   * de CC nativo era a rede de seguranca do *desligar*, porque a API nao tem
   * verbo para isso. Sem a nativa, o recriar o player e a unica via — e ele
   * depende de `cc_load_policy`, que so vale na construcao.
   *
   * O teste trava que o botao continua nos dois sentidos, porque perder o
   * "desligar" junto com a nativa deixaria quem ligou legenda preso sem
   * caminho para sair.
   */
  assert.match(controls, /onToggleCaptions: \(\) => void/, 'o botao de legenda continua exposto');
  assert.match(
    stage,
    /setCaptionsOn\(\(prev\) => !prev\)/,
    'o toggle tem que alternar nos dois sentidos, nao so ligar',
  );
  assert.match(
    youtube,
    /cc_load_policy: '1'/,
    'ligar continua pedindo a faixa, que e o que a construicao do player le',
  );
});

test('o click-catcher cobre o palco inteiro, com a barra acima', () => {
  /*
   * O catcher era `inset-x-0 top-0` mais `style bottom`, que valia 48px para
   * deixar a faixa da barra nativa livre. Sem barra nativa, essa faixa vira zona
   * morta: era exatamente onde o polegar ja estava, e clicar nao fazia nada.
   *
   * E o `z-index` e o que impede a nossa barra de virar clicavel: sao `z-10` e
   * `z-20`, nesta ordem. Invertido, os botoes de play e volume ficam mortos —
   * o sintoma mais caro deste arquivo, porque um botao que parece funcionar e nao
   * faz nada nao gera nenhuma mensagem.
   */
  const iCatcher = stage.indexOf('aria-label={isPlaying ?');
  assert.ok(iCatcher !== -1, 'o catcher precisa existir');
  const trecho = stage.slice(iCatcher, iCatcher + 1200);
  assert.match(
    trecho,
    /className="absolute inset-0 z-10/,
    'o catcher cobre o palco inteiro e fica em z-10',
  );
  assert.ok(
    !/style=\{\{ bottom:/.test(trecho),
    'o bottom antigo saio: a faixa de baixo nao e mais zona morta',
  );
  assert.match(
    controls,
    /absolute inset-x-0 bottom-0 z-20/,
    'a nossa barra tem que ficar acima do catcher, em z-20',
  );
});

test('nada e escondido por CSS nem por overlay sobre o iframe', () => {
  /*
   * O iframe e cross-origin: nao da para alcançar o interior dele, e o jeito de
   * "esconder" por overlay seria cobrir o video e fingir que o elemento nao
   * existe. A unica forma legitima e nao pedir a barra.
   *
   * `modestbranding` continua, e e o param oficial para a marca d'agua — nao e
   * disfarce. A distincao importa: um e pedir ao YouTube, o outro e pintar por
   * cima do YouTube.
   *
   * O que dá para medir e que o `YoutubePlayer` não desenha nada: o wrapper do
   * iframe não tem fundo, e não existe irmão posicionado por cima dele. Se
   * alguém resolver tapar a marca com um retângulo, um fundo opaco no wrapper ou
   * um overlay `absolute` no lugar pegam aqui.
   */
  assert.match(youtube, /modestbranding: 1/, 'o param oficial de marca continua pedido');

  const iWrapper = youtube.indexOf('ref={wrapRef}');
  assert.ok(iWrapper !== -1, 'o wrapper do iframe precisa existir');
  const classe = youtube.slice(iWrapper, youtube.indexOf('/>', iWrapper));
  assert.ok(
    !/bg-|background|gradient/.test(classe),
    'o wrapper nao pode ter fundo: um fundo opaco seria um overlay sobre o player',
  );

  // Dois `absolute`: a raiz e o wrapper. Um terceiro é alguém tapando o vídeo.
  const posicionados = youtube.match(/absolute/g)?.length ?? 0;
  assert.ok(
    posicionados <= 2,
    `o YoutubePlayer nao deve ter mais que a raiz e o wrapper posicionados (achou ${posicionados})`,
  );
});
