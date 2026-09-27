import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { publicarToken, urlDeMidia } from '@/lib/driveMedia';

/*
 * O worker do Drive é JavaScript puro em `public/`, e este módulo é a única
 * ponte entre ele e a página. O que importa aqui não é o fetch ao Google — isso
 * roda dentro do worker, fora do alcance de um teste de renderer — e sim o
 * **acordo** entre os dois: o token tem que estar gravado antes de o `<video>`
 * pedir o primeiro intervalo.
 *
 * Sem esse acordo, o sintoma é um player preto com a barra em 0:00 e nenhuma
 * mensagem. Foi exatamente o que aconteceu, e é o tipo de falha em que a pessoa
 * não tem nada contra o que reclamar.
 */

type Porta = { postMessage: (dados: unknown) => void; close: () => void };
type Controle = { postMessage: (msg: unknown, ports?: Porta[]) => void };

let controlador: Controle | null = null;
/** `null` simula o primeiro carregamento, em que o `claim()` ainda não rodou. */
let controllerAntes: boolean = true;
let responder: (porta: Porta) => void = () => {};
let fired = 0;

const registroFalso = { scope: '/' } as unknown as ServiceWorkerRegistration;

function instalarServiceWorker(): void {
  /*
   * Os ouvintes precisam ser de verdade, e não `() => {}`: o teste dispara um
   * `controllerchange` de verdade, e é o que destrava a publicação no caso do
   * primeiro carregamento. Um `addEventListener` que descarta o ouvinte
   * deixaria o teste passar sem exercitar o caminho.
   */
  const alvos = new Map<string, Set<(e: Event) => void>>();
  const registro = {
    register: async () => registroFalso,
    controller: null as unknown as Controle | null,
    addEventListener: (nome: string, fn: (e: Event) => void) => {
      const set = alvos.get(nome) ?? new Set();
      set.add(fn);
      alvos.set(nome, set);
    },
    removeEventListener: (nome: string, fn: (e: Event) => void) => {
      alvos.get(nome)?.delete(fn);
    },
    dispatchEvent: (e: Event) => {
      for (const fn of alvos.get(e.type) ?? []) fn(e);
      return true;
    },
    ready: Promise.resolve(registroFalso),
  };
  (navigator as unknown as { serviceWorker: unknown }).serviceWorker = registro;
}

function serviceWorkerDoTeste(): {
  controller: unknown;
  dispatchEvent: (e: Event) => boolean;
} {
  return navigator.serviceWorker as unknown as {
    controller: unknown;
    dispatchEvent: (e: Event) => boolean;
  };
}

beforeEach(() => {
  fired = 0;
  responder = () => {};
  controlador = {
    postMessage: (msg: unknown, ports?: Porta[]) => {
      fired += 1;
      const dados = msg as { type: string; token?: string };
      assert.equal(dados.type, 'juntos:drive-token', 'o worker só entende o token');
      assert.ok(dados.token, 'o token precisa ir na mensagem');
      // O worker responde pela porta só depois de gravar no IndexedDB.
      if (ports?.[0]) responder(ports[0]);
    },
  };
  controllerAntes = true;
  instalarServiceWorker();
  serviceWorkerDoTeste().controller = controllerAntes ? controlador : null;
});

test('o token só é considerado publicado depois que o worker confirma a gravação', async () => {
  /*
   * O worker grava devagar, como acontece de verdade: só responde quando o
   * IndexedDB terminou. Se `publicarToken` resolvesse no `postMessage`, o
   * `<video>` pediria o primeiro intervalo antes de o token existir.
   *
   * A porta fica num objeto porque o TypeScript entende `liberou` como `null`
   * para sempre quando a atribuição está dentro de um callback — e um `?.()` em
   * cima disso vira `never`, que é o tipo errado para a falha que o teste quer
   * medir.
   */
  const espera: { liberou: (() => void) | null } = { liberou: null };
  responder = (porta) => {
    espera.liberou = () => porta.postMessage({ ok: true });
  };

  let resolvido = false;
  const pending = publicarToken('token-de-teste').then((ok) => {
    resolvido = true;
    return ok;
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolvido, false, 'não pode resolver antes da confirmação do worker');

  assert.ok(espera.liberou, 'o worker deve ter recebido a porta para responder');
  espera.liberou();
  assert.equal(await pending, true, 'confirmação do worker é o que fecha a publicação');
});

test('o worker que não confirma derruba a publicação em vez de deixá-la pendurada', async () => {
  // Se o worker engole a mensagem e nunca responde, esperar para sempre seria
  // o pior resultado: o player ficaria em "conferindo" sem explicação e sem
  // chance de tentar de novo.
  responder = () => {};

  const inicio = Date.now();
  assert.equal(await publicarToken('token-de-teste'), false);
  const passou = Date.now() - inicio;
  assert.ok(passou >= 4900, `deve esperar o limite antes de desistir, esperou ${passou}ms`);
  assert.ok(passou < 8000, `não deve passar muito do limite, esperou ${passou}ms`);
});

test('sem service worker a publicação falha em vez de passar calada', async () => {
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  // Retorna `false`, e não uma exceção: quem chama decide o que mostrar, e um
  // player que nem tenta é melhor que um player que não sabe o que houve.
  assert.equal(await publicarToken('token-de-teste'), false);
});

test('a página só publica depois de estar controlada pelo worker', async () => {
  /*
   * Este é o caso do primeiro carregamento, e o que produzia o player preto.
   * `register()` resolve antes do `activate` e do `clients.claim()`, então
   * `controller` é `null` e um `postMessage` imediato vai para o vazio: o
   * token nunca é gravado e o vídeo recebe 401 do worker.
   */
  controllerAntes = false;
  serviceWorkerDoTeste().controller = null;

  let pedido: Porta | undefined;
  controlador = {
    postMessage: (_msg: unknown, ports?: Porta[]) => {
      fired += 1;
      pedido = ports?.[0];
    },
  };

  const pending = publicarToken('token-de-teste');

  // O `claim()` acontece logo depois: é o `controllerchange` que destrava.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired, 0, 'não pode publicar antes de haver controller');
  assert.equal(pedido, undefined);

  // O worker só responde depois de gravar. Aqui ele grava na hora, e a porta
  // precisa estar em `responder` **antes** do `postMessage` — foi por deixar
  // para depois que a confirmação nunca chegou e o teste mediu o timeout, em vez
  // do caminho que pretendia exercitar.
  responder = (porta) => porta.postMessage({ ok: true });
  const sw = serviceWorkerDoTeste();
  controlador = {
    postMessage: (_msg: unknown, ports?: Porta[]) => {
      fired += 1;
      pedido = ports?.[0];
      if (ports?.[0]) responder(ports[0]);
    },
  };
  sw.controller = controlador;
  /*
   * O evento é disparado num tique seguinte, e não na mesma linha: o
   * `publicarToken` é assíncrono e ainda está dentro do `await
   * registrarMediaWorker()` quando o `dispatchEvent` síncrono aconteceria. O
   * navegador não tem essa corrida — o `claim()` leva alguns milissegundos de
   * verdade — então o tique é o que reproduz a condição real.
   */
  await new Promise((r) => setTimeout(r, 10));
  sw.dispatchEvent(new Event('controllerchange'));

  assert.equal(await pending, true);
  assert.equal(fired, 1, 'publica uma vez só, depois do claim');
});

test('a url de mídia é um caminho da própria origem, para o worker interceptar', () => {
  const url = urlDeMidia('abc123def456');
  assert.ok(url.startsWith('/__drive_media/'), url);
  assert.ok(!url.startsWith('https://'), 'o src nunca é uma URL absoluta do Google');
  assert.equal(urlDeMidia('id_com_barra'), '/__drive_media/id_com_barra');
});
