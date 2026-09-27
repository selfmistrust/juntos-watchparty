import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicarToken } from '@/lib/driveMedia';

/*
 * Este caso vive em arquivo próprio, e a razão é estrutural.
 *
 * O módulo cacheia a promise de `register()` — é o que garante um worker só por
 * página, e o que impede o log `[drive] registration criada` de aparecer duas
 * vezes. O cache atravessa o `beforeEach`, então um teste que troca o `active`
 * da registration no meio da suíte acaba medindo o `active` que um teste
 * anterior deixou.
 *
 * Separar o arquivo isola o módulo sem precisar de um gancho de teste na
 * produção, que seria código que existe só para isto.
 */

const pedidosDeClaim: string[] = [];

/**
 * O IndexedDB mínimo, com a mesma forma do harness do arquivo irmão.
 *
 * A diferença que importa: a transação fecha sozinha no próximo tique, e
 * `onsuccess` dispara junto. Um stub que espera por um disparo manual trava o
 * teste, porque a publicação fica esperando a gravação.
 */
function instalarIndexedDb(): void {
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      const pedido: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          close: () => {},
          transaction: () => {
            const transacao: Record<string, unknown> = {
              objectStore: () => ({ put: () => {}, delete: () => {} }),
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
            };
            // A transação fecha sozinha; se dependesse de um disparo manual, a
            // publicação esperaria a gravação para sempre.
            setTimeout(() => (transacao.oncomplete as (() => void) | null)?.(), 0);
            return transacao;
          },
        },
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
        error: null,
      };
      setTimeout(() => (pedido.onsuccess as (() => void) | null)?.(), 0);
      return pedido;
    },
  };
}

const registration = {
  installing: undefined,
  waiting: undefined,
  active: {
    state: 'activated',
    scriptURL: '/drive-media-sw.js',
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: (msg: unknown) => {
      pedidosDeClaim.push((msg as { type: string }).type);
      // O worker atende ao pedido assumindo a página, como `clients.claim()`
      // faria. É o `controller` aparecendo, que é o sinal de sucesso.
      (navigator.serviceWorker as unknown as { controller: unknown }).controller = {
        scriptURL: '/drive-media-sw.js',
      };
    },
  },
  update: async () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

function instalarServiceWorker(): void {
  (navigator as unknown as { serviceWorker: unknown }).serviceWorker = {
    register: async () => registration,
    controller: null,
    ready: Promise.resolve(registration),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

test('a página pede o claim de novo, e não só espera o activate', async () => {
  /*
   * `clients.claim()` roda no `activate`, e o `activate` só acontece uma vez por
   * versão. A página carregada com hard reload (`Ctrl+Shift+R`) é servida sem o
   * worker, e o `claim` daquele `activate` já passou — recarregar não resolve,
   * porque recarregar é justamente o que não usa o worker.
   *
   * A saída é pedir o `claim` pelo `registration.active`, que existe mesmo sem
   * controller. Sem isso, o conserto depende de a pessoa acertar qual tecla
   * apertar, e a instrução errada vira parte do bug.
   */
  instalarIndexedDb();
  instalarServiceWorker();

  const resultado = await publicarToken('token-de-teste');
  assert.deepEqual(resultado, { ok: true });
  assert.ok(pedidosDeClaim.length > 0, 'tem de pedir o claim pelo registration.active');
  assert.ok(
    pedidosDeClaim.every((t) => t === 'juntos:drive-claim'),
    `esperado apenas o pedido de claim, veio: ${pedidosDeClaim.join(',')}`,
  );
});
