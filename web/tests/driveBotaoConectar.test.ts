import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * O botão "Conectar o Google Drive" aparecia e não recebia o clique.
 *
 * A causa não era o `disabled` dele: o botão estava são, e o `connect` funciona
 * nos dois caminhos (navegador e desktop). Era o **click-catcher** de play/pause
 * do `VideoStage` — um `<button>` `absolute inset-x-0 top-0` com `bottom: 0` e
 * `z-10`, cobrindo o palco inteiro por cima do painel do Drive.
 *
 * Este arquivo confere a estrutura no texto. É uma trava de regressão, não um
 * teste de comportamento: o que prova é que o catcher continua condicionado a
 * haver mídia, e que o painel continua sendo irmão dele em vez de filho.
 */
const stage = readFileSync(
  resolve(process.cwd(), '../web/components/player/VideoStage.tsx'),
  'utf8',
);
const drive = readFileSync(
  resolve(process.cwd(), '../web/components/player/DriveVideo.tsx'),
  'utf8',
);

test('o click-catcher só existe quando há mídia pronta', () => {
  /*
   * A condição é `mediaPronta`, e não `currentItem`. Com `currentItem` o catcher
   * aparecia durante a preparação do Drive — que é exatamente quando o painel
   * precisa do clique. `mediaPronta` só vira `true` depois que existe um
   * `<video>` na árvore.
   */
  assert.ok(
    /\{currentItem && catcherVisivel && \(/.test(stage),
    'o catcher precisa depender de catcherVisivel, e nao so de currentItem',
  );
  assert.ok(
    /const catcherVisivel = mediaPronta && !isPrime;/.test(stage),
    'catcherVisivel precisa ser mediaPronta && !isPrime: o prime nao tem midia sob o dedo, e o catcher cobriria a faixa de baixo do PrimeStage',
  );
});

test('o painel do Drive é irmão do catcher, não está dentro dele', () => {
  /*
   * Se o painel estivesse dentro do `<button>`, o HTML seria inválido — um botão
   * dentro de outro — e o navegador reorganizaria a árvore de um jeito que
   * ninguém entenderia depois. A estrutura de irmãos é o que mantém o catcher
   * como sobreposição de verdade, e é o que deixa o `z-10` ser dispensável em
   * vez de exigir um `pointer-events` condicional.
   */
  const painel = stage.indexOf('<DriveVideo');
  const catcher = stage.indexOf('aria-label={isPlaying ?');
  assert.ok(painel > -1 && catcher > -1, 'os dois precisam existir');
  assert.ok(painel < catcher, 'o painel é montado antes do catcher no JSX');
  assert.ok(
    !/className="absolute inset-x-0 top-0[\s\S]{0,400}<DriveVideo/.test(stage),
    'o catcher não pode conter o painel do Drive',
  );
});

test('o DriveVideo avisa quando há player montado, e avisa uma vez por estado', () => {
  assert.ok(
    /onMediaPronta\?\.\(temPlayer\)/.test(drive),
    'o relatório precisa sair do efeito, não do setEstado',
  );
  /*
   * O efeito depende do **booleano**, não do `estado`. Dependendo do `estado`,
   * ele rodaria em cada etapa — inclusive quando o booleano não muda — e o pai
   * receberia a mesma informação várias vezes.
   */
  assert.ok(
    /\[temPlayer, onMediaPronta\]/.test(drive),
    'o efeito precisa depender do booleano derivado',
  );
});

test('o botão de conectar continua sem disabled indevido', () => {
  /*
   * Uma trava para o caso de alguém "resolver" o problema com `disabled` ou
   * trocando o botão por um `div`: o clique tem que continuar num `<button>` com
   * `onClick`, e o único `disabled` legítimo é o de `contaBusy`.
   */
  assert.ok(
    /<Button size="sm" onClick=\{connect\} disabled=\{contaBusy\}>/.test(drive),
    'o botão de conectar precisa continuar sendo um button com onClick',
  );
  assert.ok(!/onClick=\{connect\}[^>]*disabled=\{(?!contaBusy)/.test(drive), 'nenhum outro disabled');
});
