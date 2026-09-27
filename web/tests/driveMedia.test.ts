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
 * O worker do Drive é JavaScript puro em `public/`, e este módulo é a ponte entre
 * ele e a página. O que importa aqui não é o fetch ao Google — isso roda dentro
 * do worker, fora do alcance de um teste de renderer — e sim o **acordo** entre
 * os dois: o token tem que estar gravado antes de o `<video>` pedir o primeiro
 * intervalo, e a página tem que estar controlada para alguém interceptar a
 * requisição.
 *
 * Sem esse acordo, o sintoma é um player preto com a barra em 0:00 e nenhuma
 * mensagem. Foi exatamente o que aconteceu, e é o tipo de falha em que a pessoa
 * não tem nada contra o que reclamar.
 */

/** O que o IndexedDB falso guarda, para o teste conferir o que foi gravado. */
let guardado = new Map<string, unknown>();
/** Segura o `oncomplete` da transação, para simular gravação lenta de verdade. */
let reterTransacao = false;
let transacaoPendente: { oncomplete: (() => void) | null } | null = null;
let bancoFalha = false;

function concluirTransacao(): void {
  const t = transacaoPendente;
  transacaoPendente = null;
  t?.oncomplete?.();
}

function falharBanco(): void {
  bancoFalha = true;
}

/**
 * Um IndexedDB mínimo, com o suficiente para o caminho real.
 *
 * O `oncomplete` manual é o que permite testar a corrida que existia: se a
 * publicação resolvesse antes da transação fechar, o `<video>` pediria o
 * primeiro intervalo com o token ainda não gravado.
 */
function instalarIndexedDb(): void {
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      const pedido: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          transaction: () => {
            const transacao: Record<string, unknown> = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
              objectStore: () => ({
                put: (valor: unknown, chave: string) => guardado.set(chave, valor),
                delete: (chave: string) => guardado.delete(chave),
              }),
            };
            transacaoPendente = transacao as unknown as { oncomplete: (() => void) | null };
            // Sem reter, a transação fecha no próximo tique, como no navegador.
            if (!reterTransacao) setTimeout(() => concluirTransacao(), 0);
            return transacao;
          },
          close: () => {},
        },
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
        error: null,
      };
      setTimeout(() => {
        if (bancoFalha) (pedido.onerror as (() => void) | null)?.();
        else (pedido.onsuccess as (() => void) | null)?.();
      }, 0);
      return pedido;
    },
  };
}

let controlador: { scriptURL: string } | null = null;
/** `false` simula o primeiro carregamento, em que o `claim()` ainda não rodou. */
let controllerAntes: boolean = true;
/** Quantas vezes `register()` foi chamado: prova de que o caminho é real. */
let chamadasDeRegistro = 0;

/**
 * O `navigator` precisa ser manipulado com cuidado, e isso não é detalhe.
 *
 * `delete navigator.serviceWorker` não funciona aqui: `navigator` é uma
 * propriedade read-only do `globalThis` no Node, e o `delete` não faz nada. E
 * um `defineProperty` com valor `undefined` também não serve, porque o código
 * decide o suporte com `'serviceWorker' in navigator` e o `in` continua
 * verdadeiro. Só substituindo o objeto inteiro o `in` deixa de ver a chave — e é
 * por isso que `semServiceWorker` existe e devolve o `navigator` original.
 *
 * Um teste que passa sem exercitar o caminho é pior do que um teste que não
 * roda: o `sem_suporte` "passava" medindo outra coisa, e nada denunciava.
 */

/** A registration devolvida por `register()` neste teste. */
let registroDoTeste: Record<string, unknown>;

function instalarServiceWorker(): void {
  /*
   * Os ouvintes precisam ser de verdade, e não `() => {}`: o teste dispara um
   * `controllerchange` de verdade, e é o que destrava a publicação no caso do
   * primeiro carregamento. Um `addEventListener` que descarta o ouvinte
   * deixaria o teste passar sem exercitar o caminho.
   */
  const alvos = new Map<string, Set<(e: Event) => void>>();
  const Ouvinte = () => ({
    addEventListener: (nome: string, fn: (e: Event) => void) => {
      const set = alvos.get(nome) ?? new Set();
      set.add(fn);
      alvos.set(nome, set);
    },
    removeEventListener: (nome: string, fn: (e: Event) => void) => {
      alvos.get(nome)?.delete(fn);
    },
  });
  registroDoTeste = {
    installing: undefined,
    waiting: undefined,
    // O `active` também é um `ServiceWorker`, e o código registra `statechange`
    // nele. Um objeto sem `addEventListener` fazia a exceção cair dentro do
    // `catch` de `register()`, e o teste via `registro_falhou` — um motivo
    // inventado pelo fake, não pelo código.
    active: { state: 'activated', scriptURL: '/drive-media-sw.js', ...(Ouvinte() as object) },
    ...(Ouvinte() as object),
  };
  const registro = {
    register: async () => {
      chamadasDeRegistro += 1;
      return registroDoTeste;
    },
    controller: null as unknown,
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
    ready: Promise.resolve(registroDoTeste),
  };
  (navigator as unknown as { serviceWorker: unknown }).serviceWorker = registro;
}

/**
 * Tira o `serviceWorker` do `navigator`, de verdade.
 *
 * O `delete navigator.serviceWorker` não funciona aqui: `navigator` é uma
 * propriedade read-only do `globalThis` no Node, e o `delete` silenciosamente
 * não faz nada. Pior, o código de produção decide o suporte com
 * `'serviceWorker' in navigator`, e um `defineProperty` com valor `undefined`
 * deixa o `in` verdadeiro — o teste passava, `sem_suporte` nunca era exercitado,
 * e o motivo errado era o que se via.
 *
 * Só substituindo o objeto inteiro o `in` deixa de ver a chave. E o `navigator`
 * original é restaurado no fim, senão os testes seguintes rodariam contra um
 * navegador sem service worker e mediriam a coisa errada.
 */
const NAVIGADOR_REAL = globalThis.navigator;

function semServiceWorker<T>(acao: () => T): T {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  try {
    return acao();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: NAVIGADOR_REAL, configurable: true, writable: true });
  }
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
  chamadasDeRegistro = 0;
  guardado = new Map();
  reterTransacao = false;
  transacaoPendente = null;
  bancoFalha = false;
  controlador = { scriptURL: '/drive-media-sw.js' };
  controllerAntes = true;
  instalarIndexedDb();
  instalarServiceWorker();
  serviceWorkerDoTeste().controller = controllerAntes ? controlador : null;
});

test('o token é gravado no IndexedDB pela página, sem depender do worker', async () => {
  /*
   * Este é o ponto do conserto. A gravação é local: a página e o worker
   * compartilham a origem, logo compartilham o IndexedDB. Antes o token ia por
   * `postMessage` e dependia do worker estar **ativo** — e "não assumiu a
   * página" derrubava a publicação junto, mesmo quando gravar não tinha nada de
   * difícil.
   */
  serviceWorkerDoTeste().controller = controlador;
  assert.deepEqual(await publicarToken('token-de-teste'), { ok: true });
  assert.equal(guardado.get('token'), 'token-de-teste', 'o token precisa estar no banco');
  // A gravação acontece com a página já controlada, ou seja, sem depender do
  // worker para nada. Se passasse pelo `postMessage`, precisaria estar ativo.
  assert.equal(chamadasDeRegistro, 1, 'registra uma vez, sem passar o token pelo worker');
});

test('o token só é considerado publicado depois que a gravação termina', async () => {
  /*
   * Se a publicação resolvesse antes da transação fechar, o `<video>` pediria o
   * primeiro intervalo antes de o token existir — o player preto em 0:00. O
   * `indexedDB` falso segura o `oncomplete` até o teste mandar.
   */
  serviceWorkerDoTeste().controller = controlador;
  reterTransacao = true;
  let resolvido = false;
  const pending = publicarToken('token-de-teste').then((r) => {
    resolvido = true;
    return r;
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolvido, false, 'não pode resolver antes de a transação fechar');

  reterTransacao = false;
  concluirTransacao();
  assert.deepEqual(await pending, { ok: true });
});

test('um IndexedDB que recusa a gravação diz isso, em vez de virar 401 depois', async () => {
  // Modo privado restrito recusa o IndexedDB. Sem este motivo, o player montava
  // com um token que nunca existiu e o worker respondia 401 a cada pedaço.
  serviceWorkerDoTeste().controller = controlador;
  falharBanco();
  assert.deepEqual(await publicarToken('token-de-teste'), { ok: false, motivo: 'grava_falhou' });
});

test('cada motivo da publicação vira uma frase que diz o que fazer', () => {
  // Modo privado resolve `grava_falhou` e não resolve `sem_controle`. Uma frase
  // única para os dois manda a pessoa tentar a coisa errada.
  assert.match(explicarPublicacao('grava_falhou'), /privada/i);
  assert.match(explicarPublicacao('sem_controle'), /console/i);
  assert.match(explicarPublicacao('sem_suporte'), /service worker/i);
  assert.match(explicarPublicacao('registro_falhou'), /registrar/i);
});

test('a publicação espera o controle, e o token fica gravado enquanto espera', async () => {
  /*
   * `register()` resolve antes do `activate` e do `clients.claim()`, então
   * `controller` é `null` no primeiro carregamento. Sem controle não há quem
   * intercepte `/__drive_media/`, então a publicação precisa esperar — mas o
   * token já está gravado, e é isso que faz o controle que chega depois
   * funcionar sem refazer nada.
   */
  serviceWorkerDoTeste().controller = null;
  const sw = serviceWorkerDoTeste();

  const pending = publicarToken('token-de-teste');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(guardado.get('token'), 'token-de-teste', 'o token é gravado antes de esperar o controle');

  /*
   * O `controllerchange` num tique seguinte, e não na mesma linha: o
   * `publicarToken` é assíncrono e ainda está dentro do `await
   * guardarToken()` quando um `dispatchEvent` síncrono aconteceria. O navegador
   * não tem essa corrida — o `claim()` leva alguns milissegundos de verdade.
   */
  await new Promise((r) => setTimeout(r, 10));
  sw.controller = controlador;
  sw.dispatchEvent(new Event('controllerchange'));

  assert.deepEqual(await pending, { ok: true });
  assert.equal(guardado.get('token'), 'token-de-teste', 'o token não pode ser apagado pela espera');
});

test('uma página que nunca é controlada diz isso, em vez de esperar em silêncio', async () => {
  /*
   * `sem_controle` é o caso que apareceu: o worker registra, mas a página não
   * fica sob controle dele. A pessoa precisa de uma frase que aponte o console,
   * onde o estado da registration é registrado — e não de um "recarregue" que
   * já foi tentado e não resolveu.
   */
  serviceWorkerDoTeste().controller = null;
  const inicio = Date.now();
  assert.deepEqual(await publicarToken('token-de-teste'), { ok: false, motivo: 'sem_controle' });
  const passou = Date.now() - inicio;
  assert.ok(passou >= 4900, `deve esperar o limite antes de desistir, esperou ${passou}ms`);
  assert.ok(passou < 8000, `não deve passar muito do limite, esperou ${passou}ms`);
});

/*
 * Este é o último de propósito.
 *
 * Tirar o `serviceWorker` do `navigator` deixa o cache de `register()` do módulo
 * intacto — e isso é o que se quer: a ordem não precisa mais importar, porque o
 * `navigator` é restaurado ao final. O teste continua no fim por clareza: ele é o
 * único que muda o ambiente global.
 */
test('sem service worker a publicação falha com o motivo, em vez de passar calada', async () => {
  /*
   * Retorna um motivo, e não um booleano nem uma exceção. Um booleano obrigava a
   * inventar uma frase que não era verdadeira em nenhum caso, e era a mesma
   * armadilha do `MediaError` do `<video>`.
   */
  const resultado = await semServiceWorker(() => publicarToken('token-de-teste'));
  assert.deepEqual(resultado, { ok: false, motivo: 'sem_suporte' });
  // A prova de que o caminho é real: sem `serviceWorker` no `navigator`, o
  // `register` nem é chamado. Sem esta afirmação, um atalho que devolvesse
  // `sem_suporte` por outro caminho passaria igual.
  assert.equal(chamadasDeRegistro, 0, 'não pode tentar registrar sem suporte');
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
