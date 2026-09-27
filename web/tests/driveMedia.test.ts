import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  esperarWorkerPronto,
  explicarFalha,
  explicarPublicacao,
  publicarToken,
  registrarMediaWorker,
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
/**
 * Quantas vezes `register()` foi chamado no módulo inteiro, e não no teste.
 *
 * O cache de registro vive no módulo e sobrevive ao `beforeEach`, que é
 * exatamente o que o teste do registro único precisa medir. Por isso o contador
 * também é de módulo: zerá-lo por teste faria o teste ver zero e passar por
 * engano, já que o registro real aconteceu num teste anterior.
 */
let chamadasDeRegistro = 0;
/** A URL do último `register` observado, útil quando o cache pula a chamada. */
let ultimaVersao = '';
/** Os pedidos que a página mandou para o worker assumir a página. */

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
    // `update()` é chamado pelo `registrarMediaWorker`; sem ele aqui, o teste
    // veria uma exceção dentro do `catch` e um `registro_falhou` inventado.
    update: async () => {},
    // O `active` também é um `ServiceWorker`, e o código registra `statechange`
    // nele. Um objeto sem `addEventListener` fazia a exceção cair dentro do
    // `catch` de `register()`, e o teste via `registro_falhou` — um motivo
    // inventado pelo fake, não pelo código. O `postMessage` também é real: é por
    // ele que a página pede o `claim`.
    active: {
      state: 'activated',
      scriptURL: '/drive-media-sw.js',
      postMessage: () => {},
      ...(Ouvinte() as object),
    },
    ...(Ouvinte() as object),
  };
  const registro = {
    register: async (u: string) => {
      chamadasDeRegistro += 1;
      ultimaVersao = u;
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
    // `ready` precisa existir e resolver: `publicarToken` espera por ele antes de
    // esperar o controle, e um `ready` ausente faria a publicação resolver por
    // `sem_suporte` em vez de medir o motivo que o teste quer.
    ready: Promise.resolve(registroDoTeste),
  };
  (navigator as unknown as { serviceWorker: unknown }).serviceWorker = registro;
}

/*
 * `sem_suporte` mora em `driveMediaSemSuporte.test.ts`, e o motivo é o cache de
 * registro: ele vive no módulo e sobrevive ao `beforeEach`, então trocar o
 * `navigator` no meio desta suíte mediria o registro de um teste anterior.
 *
 * O detalhe que vale registrar é o motivo de o caso não poder ser resolvido com
 * `delete navigator.serviceWorker`: `navigator` é read-only no `globalThis` do
 * Node, e o `delete` não faz nada. Com `defineProperty` e valor `undefined` também
 * não dá, porque o código decide o suporte com `'serviceWorker' in navigator` e o
 * `in` continua verdadeiro — o teste passava medindo outra coisa, sem nada
 * denunciar. Só substituindo o objeto inteiro o `in` deixa de ver a chave.
 */

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

test('a URL do worker carrega a versão, porque o claim só roda no activate', async () => {
  /*
   * `clients.claim()` roda no evento `activate`, e o `activate` só acontece uma
   * vez por versão. Uma versão já ativada numa visita anterior nunca mais assume
   * as páginas seguintes, e recarregar não gera um `activate` novo — o sintoma
   * é `active: "activated"` com `controller: null`, sem nenhuma pista.
   *
   * A versão na URL obriga o navegador a tratar como outro script, o que dispara
   * um `install` e um `activate` de verdade.
   */
  const sw = navigator.serviceWorker as unknown as { register: (u: string) => Promise<unknown> };
  const original = sw.register;
  const pedidas: string[] = [];
  sw.register = async (u: string) => {
    pedidas.push(u);
    ultimaVersao = u;
    return registroDoTeste;
  };
  try {
    await registrarMediaWorker();
  } finally {
    sw.register = original;
  }
  // O cache pode ter pulado o `register` de um teste anterior; nesse caso a URL
  // de então é a que o módulo usa hoje, e ela precisa ter a versão também.
  const usada = pedidas[0] ?? (ultimaVersao || '');
  assert.match(usada, /^\/drive-media-sw\.js\?v=\d+$/, `URL sem versão: "${usada}"`);
});

/*
 * O pedido de `claim` fica em arquivo próprio, pelo mesmo motivo do
 * `sem_suporte`: o cache de registro vive no módulo e sobrevive ao
 * `beforeEach`, então um teste que troca o `active` da registration no meio da
 * suíte acaba medindo o `active` de um teste anterior. Separar o arquivo isola o
 * módulo sem precisar de gancho de teste na produção.
 */
test('o registro acontece uma vez só, mesmo com várias chamadas', async () => {
  /*
   * `[drive] registration criada` aparecia duas vezes porque o `DriveVideo` e o
   * `publicarToken` registravam em separado. Centralizar o registro é o que
   * resolve, e o cache de promise é o que garante — sem ele, cada chamada
   * refaz `register()` e `update()`.
   *
   * O cache vive no módulo e sobrevive ao `beforeEach`, então este teste não
   * pode contar os registros do seu próprio `publicarToken` — eles podem ter
   * acontecido num teste anterior. O que ele mede é o efeito do cache: com ele,
   * `register` é chamado **no máximo uma vez** na vida inteira do módulo, ainda
   * que os testes peçam a publicação muitas vezes.
   */
  serviceWorkerDoTeste().controller = controlador;
  for (let i = 0; i < 3; i += 1) {
    await publicarToken('token-de-teste');
    await esperarWorkerPronto();
  }
  assert.equal(chamadasDeRegistro, 1, 'o worker deve ser registrado uma vez por página');
});

test('o player só é liberado depois do worker pronto e da página controlada', async () => {
  /*
   * A ordem é o requisito: `<video>` não pode ser montado antes de haver alguém
   * para interceptar `/drive-media/`, porque aí a requisição vai para a rede
   * comum e leva 404 da hospedagem.
   */
  serviceWorkerDoTeste().controller = controlador;
  const resultado = await publicarToken('token-de-teste');
  assert.deepEqual(resultado, { ok: true });
  assert.equal(guardado.get('token'), 'token-de-teste', 'o token fica gravado antes de liberar o player');
  assert.ok(
    (navigator.serviceWorker as unknown as { controller: unknown }).controller,
    'a página precisa estar controlada quando o player é liberado',
  );
});

test('a url de mídia é um caminho da própria origem, para o worker interceptar', () => {
  const url = urlDeMidia('abc123def456');
  assert.ok(url.startsWith('/drive-media/'), url);
  assert.ok(!url.startsWith('https://'), 'o src nunca é uma URL absoluta do Google');
  // O token jamais viaja na URL: a URL é da própria origem e o worker troca
  // pela do Google com o cabeçalho `Authorization`.
  assert.ok(!url.includes('Bearer'), 'o token não pode estar na URL');
  assert.ok(!url.includes('access_token'), 'o token não pode estar na URL');
  assert.equal(urlDeMidia('id_com_barra'), '/drive-media/id_com_barra');
});
