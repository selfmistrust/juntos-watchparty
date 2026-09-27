import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * O slider de volume nunca foi removido: ele foi *escondido*.
 *
 * O `group-hover` saiu em `fa20a0c`, numa auditoria de responsividade. A intenção
 * era resolver um problema real — no celular não existe hover, e o slider ficava
 * recolhido, deixando o volume impossível de ajustar no toque. Mas a remoção
 * levou o desktop junto, onde o hover funciona. O botão continuou alternando
 * mudo e desmutado, que é o comportamento que faz parecer "só falta a barra".
 *
 * Este arquivo trava a condição no texto, e o motivo de ela ser o que importa é
 * que a falha foi silenciosa: nada quebrou, nada apareceu no console, e o
 * componente seguia compilando.
 */
const controls = readFileSync(
  resolve(process.cwd(), '../web/components/player/PlayerControls.tsx'),
  'utf8',
);
const stage = readFileSync(
  resolve(process.cwd(), '../web/components/player/VideoStage.tsx'),
  'utf8',
);

test('o slider de volume abre no hover do desktop', () => {
  /*
   * `group-hover` é a condição que faltava. Sem ela o slider fica em `w-0
   * opacity-0` para sempre no desktop — invisível, mas presente no DOM, que é o
   * que faz o defeito passar despercebido em revisão de código.
   */
  assert.ok(
    /group-hover:w-20/.test(controls),
    'o slider precisa abrir no group-hover — foi o que sumiu no desktop',
  );
  assert.ok(
    /group-hover:opacity-100/.test(controls),
    'e precisa ficar visível no mesmo estado',
  );
});

test('o toque não depende de hover', () => {
  /*
   * A causa do `group-hover` ter sido removido continua válida e precisa
   * continuar atendida: `pointer: coarse` não tem hover, então o slider vem
   * aberto e compacto. Sem isso, o conserto do desktop desfaria o do celular.
   */
  assert.ok(
    /\[@media\(pointer:coarse\)\]:w-8/.test(controls),
    'no toque o slider precisa vir visível e compacto',
  );
  assert.ok(
    /\[@media\(pointer:coarse\)\]:opacity-100/.test(controls),
    'e opaco, sem depender de hover',
  );
});

test('o teclado ainda alcança o volume', () => {
  assert.ok(
    /focus-visible:w-20|focus-within:w-20/.test(controls),
    'foco de teclado precisa abrir o slider',
  );
  assert.ok(
    /aria-label="Volume"/.test(controls),
    'o slider precisa continuar nomeado para leitor de tela',
  );
});

test('o hover do play do centro existe e é contido', () => {
  /*
   * O disco do centro é `pointer-events-none` — quem recebe o clique é o catcher.
   * O hover mesmo assim funciona porque o `:hover` sobe para os ancestrais, e o
   * palco é o mesmo `group` que o wrapper do disco.
   *
   * A escala é de 1.05 e o deslocamento do ícone é de 1px: o disco fica no meio
   * do vídeo, e um efeito grande ali é barulho. Este teste trava o teto, porque
   * "não exagerar" é um valor, não uma intenção.
   */
  assert.ok(/group-hover:scale-105/.test(stage), 'o disco precisa reagir ao hover do palco');
  assert.ok(
    !/group-hover:scale-1[1-9]/.test(stage),
    'a escala não pode passar de 1.05 — é um disco sobre o vídeo',
  );
  assert.ok(
    /group-hover:translate-x-px/.test(stage),
    'o ícone pode deslocar 1px, e é o que dá o ar de botão sem pesar',
  );
});

test('quem não controla a reprodução não recebe feedback de clique', () => {
  /*
   * Sem este condicionamento, quem não é host veria o disco crescer e achar que o
   * clique funciona. A reação tem que acompanhar a permissão, senão o feedback
   * vira mentira — o mesmo defeito do catcher sobre o botão do Drive, em versão
   * silenciosa.
   */
  assert.ok(
    /canControl && 'group-hover:scale-105/.test(stage),
    'a reação precisa depender de canControl',
  );
});

test('o catcher tem foco visível sem o contorno padrão', () => {
  /*
   * `outline-none` sem um anel no lugar deixaria a navegação por teclado sem
   * indicador nenhum. O anel é `inset` porque o elemento é o palco inteiro: o
   * contorno padrão sairia da tela.
   */
  assert.ok(/outline-none/.test(stage), 'o contorno padrão precisa sair, o palco é grande demais');
  assert.ok(
    /focus-visible:ring-inset/.test(stage),
    'e precisa voltar como anel interno, ou o teclado fica cego',
  );
});
