import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Reprodução dos dois laços de sincronização, fora do React.
 *
 * O `VideoStage` tem dois `useEffect` que dependem de `targetPosition`, e essa
 * função é um `useCallback([state])`: **nova identidade a cada snapshot**. Um
 * snapshot chega a cada comando de play/pause/seek e periodicamente, então os
 * efeitos que a listam como dependência são recriados junto.
 *
 * Aqui o `setInterval` é substituído pelo mesmo par `clearInterval`/
 * `setInterval` que o React faz no cleanup, e o alvo é medir o que muda de fato
 * no player: quantas vezes o relógio interno é reiniciado e quantas vezes o
 * player recebe `play`.
 */

/** O relógio do player: só corre se o timer não for reiniciado. */
class Relogio {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tiques = 0;
  private ultimoInicio = 0;
  readonly intervaloMs = 1200;

  iniciar() {
    this.ultimoInicio = Date.now();
    this.timer = setInterval(() => {
      this.tiques += 1;
    }, this.intervaloMs);
  }
  reiniciar() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tiques = 0;
    this.ultimoInicio = Date.now();
    this.iniciar();
  }
  parar() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  get corridas() {
    return this.tiques;
  }
  get quantoTempoDesdeReinicio() {
    return Date.now() - this.ultimoInicio;
  }
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('um snapshot que muda a identidade de targetPosition reinicia o relógio de deriva', async () => {
  /*
   * Este é o bug: `targetPosition` é `useCallback([state])`, então cada snapshot
   * cria uma função nova. O efeito de deriva a lista como dependência, o React
   * roda o cleanup e recria o `setInterval` — e o contador de 1,2 s volta a zero.
   *
   * O sintoma é uma sala que "quase" fica em sincronia: enquanto os snapshots
   * ficam quietos, funciona; com alguém dando play e pause, a correção de deriva
   * nunca chega a disparar, porque o relógio reinicia antes de completar o
   * primeiro tique.
   */
  const relogio = new Relogio();
  relogio.iniciar();

  // Dois snapshots chegando em 900 ms: menos que o intervalo, então a primeira
  // correção ainda não teria disparado.
  await dormir(900);
  relogio.reiniciar();
  await dormir(900);
  relogio.reiniciar();

  await dormir(1300);
  const disparou = relogio.corridas;
  relogio.parar();

  assert.equal(disparou, 1, 'com o reinício, a correção dispara');
  assert.ok(relogio.quantoTempoDesdeReinicio >= 1300);
  // Documenta o defeito: se o intervalo fosse preservado, o contador seria maior
  // porque nenhum tique teria sido perdido.
  assert.ok(disparou < 3, 'o reinício do timer faz o laço perder tiques');
});

test('a identidade de targetPosition muda a cada snapshot, e isso é o gatilho', () => {
  /*
   * A causa raiz, verificada sem React: `useCallback` com `[state]` devolve uma
   * função nova quando o estado muda. É isso que recria o efeito. Um teste que
   * só olhasse o sintoma (deriva que não corrige) não mostraria onde consertar.
   */
  const useCallbackSimulado = <T,>(fn: () => T, deps: () => unknown[]) => {
    let anterior: unknown[] | null = null;
    return () => {
      const atuais = deps();
      const mudou =
        anterior === null ||
        atuais.length !== anterior.length ||
        atuais.some((d, i) => !Object.is(d, anterior?.[i]));
      if (mudou) anterior = [...atuais];
      return mudou ? { fn, nova: true } : { fn, nova: false };
    };
  };

  const alvo = () => 42;
  let estado: { serverTime: number } = { serverTime: 1 };
  // Os deps são lidos no momento da chamada, como o React faz: é o valor atual
  // que decide, e não uma cópia tirada na criação.
  const callback = useCallbackSimulado(alvo, () => [estado]);

  assert.equal(callback().nova, true, 'o primeiro render cria a função');
  assert.equal(callback().nova, false, 'sem estado novo, a função é a mesma');

  estado = { serverTime: 2 };
  assert.equal(callback().nova, true, 'um snapshot novo recria a função — e o efeito junto');
});
