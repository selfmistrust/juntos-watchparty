import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  explicarFalha,
  explicarPublicacao,
  publicarToken,
  urlDeMidia,
  type FalhaDrive,
} from '@/lib/driveMedia';

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
  assert.deepEqual(await pending, { ok: true }, 'confirmação do worker é o que fecha a publicação');
});

test('o worker que não confirma derruba a publicação em vez de deixá-la pendurada', async () => {
  // Se o worker engole a mensagem e nunca responde, esperar para sempre seria
  // o pior resultado: o player ficaria em "conferindo" sem explicação e sem
  // chance de tentar de novo.
  responder = () => {};

  const inicio = Date.now();
  assert.deepEqual(await publicarToken('token-de-teste'), { ok: false, motivo: 'sem_confirmacao' });
  const passou = Date.now() - inicio;
  assert.ok(passou >= 4900, `deve esperar o limite antes de desistir, esperou ${passou}ms`);
  assert.ok(passou < 8000, `não deve passar muito do limite, esperou ${passou}ms`);
});

test('sem service worker a publicação falha com o motivo, em vez de passar calada', async () => {
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  /*
   * Retorna um motivo, e não um booleano nem uma exceção. Um booleano obrigava a
   * inventar uma frase que não era verdadeira em nenhum caso, e era a mesma
   * armadilha do `MediaError` do `<video>`.
   */
  assert.deepEqual(await publicarToken('token-de-teste'), { ok: false, motivo: 'sem_suporte' });
});

test('cada motivo da publicação vira uma frase que diz o que fazer', () => {
  // Recarregar resolve `sem_controle` e não resolve `sem_suporte`. Uma frase
  // única para os dois manda a pessoa fazer a coisa errada.
  const semControle = explicarPublicacao('sem_controle');
  assert.match(semControle, /Ctrl\+Shift\+R|recarregue/i);
  assert.ok(!explicarPublicacao('sem_suporte').match(/recarregue/i), 'sem service worker não se resolve recarregando');
  assert.match(explicarPublicacao('sem_suporte'), /service worker/i);
  assert.match(explicarPublicacao('registro_falhou'), /registrar/i);
  assert.match(explicarPublicacao('sem_confirmacao'), /confirmou/i);
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

  assert.deepEqual(await pending, { ok: true });
  assert.equal(fired, 1, 'publica uma vez só, depois do claim');
});

test('uma página que nunca é controlada diz isso, em vez de esperar em silêncio', async () => {
  /*
   * `sem_controle` é o caso mais provável depois de um deploy: o worker antigo
   * continua controlando a página e o novo não assume até haver recarregamento.
   * A pessoa precisa ler "recarregue" na tela, e não uma frase genérica que não
   * diz o que fazer.
   */
  serviceWorkerDoTeste().controller = null;
  const inicio = Date.now();
  assert.deepEqual(await publicarToken('token-de-teste'), { ok: false, motivo: 'sem_controle' });
  const passou = Date.now() - inicio;
  assert.ok(passou >= 4900, `deve esperar o limite antes de desistir, esperou ${passou}ms`);
  assert.ok(passou < 8000, `não deve passar muito do limite, esperou ${passou}ms`);
});

/*
 * A tradução da falha é a parte que apareceu no usuário: o Chromium dá
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` tanto para um 401 do Google quanto para um
 * `.mkv` que ele não decodifica, e a conserto de um é reconectar enquanto a do
 * outro é escolher outro arquivo. Um texto genérico obriga a pessoa a adivinhar.
 */
const FALHA = 'O navegador não conseguiu reproduzir este arquivo.';

test('cada causa do Google vira uma frase que aponta o conserto', () => {
  const semAcesso = explicarFalha({ motivo: 'sem_acesso', status: 403 }, FALHA);
  assert.match(semAcesso, /403/);
  assert.match(semAcesso, /Reconecte o Drive/);
  assert.ok(!semAcesso.includes(FALHA), 'não pode repassar a mensagem genérica');

  const semToken = explicarFalha({ motivo: 'sem_token', status: 401 }, FALHA);
  assert.match(semToken, /Recarregue a página/);
  assert.ok(!semToken.includes('401'), 'sem token não é 401 do Google: é o worker sem credencial');

  // O `error_description` do Google entra na frase: é ele que diz a causa real,
  // e sem ele a pessoa só tem um número.
  const comDetalhe = explicarFalha(
    { motivo: 'recusado', status: 403, detalhe: 'The file has been blocked by the owner.' },
    FALHA,
  );
  assert.match(comDetalhe, /blocked by the owner/);

  // Formato incompatível é a causa mais provável de um vídeo que "carrega" e
  // não toca, e ela não se resolve reconectando.
  const tipo = explicarFalha({ motivo: 'tipo_invalido', status: 200, detalhe: 'text/html' }, FALHA);
  assert.match(tipo, /text\/html/);
  assert.match(tipo, /não é um vídeo|não decodifica/);
  assert.ok(!tipo.includes('Reconecte'), 'formato não se resolve reconectando');

  // Sem registro do worker, o texto genérico é o fallback honesto.
  assert.equal(explicarFalha(null, FALHA), FALHA);
  assert.equal(explicarFalha({ motivo: 'desconhecido', status: 500 } as FalhaDrive, FALHA).includes(FALHA), false);
});

test('a url de mídia é um caminho da própria origem, para o worker interceptar', () => {
  const url = urlDeMidia('abc123def456');
  assert.ok(url.startsWith('/__drive_media/'), url);
  assert.ok(!url.startsWith('https://'), 'o src nunca é uma URL absoluta do Google');
  assert.equal(urlDeMidia('id_com_barra'), '/__drive_media/id_com_barra');
});
