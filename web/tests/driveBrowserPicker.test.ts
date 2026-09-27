import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { escolherVideoNoNavegador } from '@/lib/driveBrowserPicker';
import { SERVER_URL } from '@/lib/socket';

/*
 * O renderer sem DOM: o módulo só precisa de `window` para os timers e de
 * `window.juntosDesktop` para abrir o navegador. O resto da conversa é HTTP
 * com o servidor, então o `fetch` é o único ponto que precisa ser simulado.
 */
(globalThis as { window?: unknown }).window = globalThis;
// O `returnTo` viaja para o servidor como URL da sala; o Node não tem `location`.
(globalThis as { location?: unknown }).location = { href: 'http://localhost:3210/room/teste' };

type Chamada = { metodo: string; caminho: string };

let chamadas: Chamada[] = [];
let abrirResultado: boolean | 'lancar' = true;
let respostas = new Map<string, () => Response>();
let pendentes = new Map<string, { resolver: (r: Response) => void; rejeitar: (e: unknown) => void }>();

/** Registra a resposta da próxima consulta de status de um pedido. */
function responder(caminho: string, corpo: unknown, status = 200): void {
  respostas.set(caminho, () => Response.json(corpo, { status }));
}

const INICIO = { url: 'https://accounts.google.com/x', requestId: 'req-1', expiresAt: Date.now() + 600_000 };

beforeEach(() => {
  chamadas = [];
  respostas = new Map();
  pendentes = new Map();
  abrirResultado = true;
  (globalThis as { juntosDesktop?: unknown }).juntosDesktop = {
    isDesktop: true,
    openInSystemBrowser: async () => {
      if (abrirResultado === 'lancar') throw new Error('sem navegador');
      return abrirResultado;
    },
  };
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const metodo = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const caminho = url.pathname.replace('/api/drive/picker', '');
    chamadas.push({ metodo, caminho });
    if (metodo === 'POST') return Response.json(INICIO);
    if (metodo === 'DELETE') return new Response(null, { status: 204 });
    const pendente = pendentes.get(caminho);
    if (pendente) {
      // Um fetch de verdade rejeita quando o sinal aborta; sem isso um pedido
      // pendente seguraria a espera para sempre, e o teste travaria.
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Abortado', 'AbortError')), { once: true });
        pendente.resolver = resolve;
        pendente.rejeitar = reject;
      });
    }
    return respostas.get(caminho)?.() ?? Response.json({ error: 'unexpected' }, { status: 500 });
  });
});

afterEach(() => {
  mock.restoreAll();
  delete (globalThis as { juntosDesktop?: unknown }).juntosDesktop;
});

test('abre o Google no navegador externo e entrega o vídeo escolhido à sessão do app', async () => {
  responder('/req-1', { status: 'picked', fileId: 'video-1' });
  const controller = new AbortController();
  const fileId = await escolherVideoNoNavegador(controller.signal, () => {});
  assert.equal(fileId, 'video-1');
  assert.deepEqual(
    chamadas.map((c) => `${c.metodo} ${c.caminho}`),
    ['POST /start', 'GET /req-1', 'DELETE /req-1'],
  );
  assert.equal(controller.signal.aborted, false);
});

test('aguarda a escolha no navegador e só então entrega o resultado', async () => {
  responder('/req-1', { status: 'pending' });
  const controller = new AbortController();
  const pendente = escolherVideoNoNavegador(controller.signal, () => {});
  await new Promise((r) => setTimeout(r, 50));
  // Enquanto a pessoa navega no Drive, o app não recebe resposta de rede.
  assert.deepEqual(chamadas.map((c) => c.metodo), ['POST', 'GET']);
  respostas.set('/req-1', () => Response.json({ status: 'picked', fileId: 'video-2' }));
  assert.equal(await pendente, 'video-2');
  assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /start', 'GET /req-1', 'GET /req-1', 'DELETE /req-1']);
});

test('cancelar no Google não copia nada e encerra a espera', async () => {
  responder('/req-1', { status: 'cancelled' });
  assert.equal(await escolherVideoNoNavegador(new AbortController().signal, () => {}), null);
});

test('cancelar no app invalida o pedido, mesmo com a aba do Google aberta', async () => {
  responder('/req-1', { status: 'pending' });
  const controller = new AbortController();
  const espera = escolherVideoNoNavegador(controller.signal, () => {});
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  assert.equal(await espera, null);
  assert.deepEqual(chamadas.map((c) => c.metodo), ['POST', 'GET', 'DELETE']);
});

test('cancelar o painel durante a espera devolve controle em vez de erro', async () => {
  pendentes.set('/req-1', { resolver: () => {}, rejeitar: () => {} });
  const controller = new AbortController();
  const espera = escolherVideoNoNavegador(controller.signal, () => {});
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  assert.equal(await espera, null);
});

test('falha ao abrir o navegador é diferente de recusa silenciosa', async () => {
  abrirResultado = false;
  await assert.rejects(escolherVideoNoNavegador(new AbortController().signal, () => {}), /browser_open_failed/);
  assert.deepEqual(chamadas.map((c) => c.metodo), ['POST', 'DELETE']);

  abrirResultado = 'lancar';
  await assert.rejects(escolherVideoNoNavegador(new AbortController().signal, () => {}), /browser_open_failed/);
});

test('pedido expirado ou de outra sessão vira erro tratável, sem-travar o app', async () => {
  responder('/req-1', { error: 'picker_expired' }, 410);
  await assert.rejects(escolherVideoNoNavegador(new AbortController().signal, () => {}), /picker_expired/);

  respostas.set('/req-1', () => Response.json({ error: 'no_session' }, { status: 401 }));
  await assert.rejects(escolherVideoNoNavegador(new AbortController().signal, () => {}), /not_connected/);
});

test('o módulo só conduz o pedido: nem token nem metadados saem por aqui', async () => {
  responder('/req-1', { status: 'picked', fileId: 'video-3' });
  const controller = new AbortController();
  assert.equal(await escolherVideoNoNavegador(controller.signal, () => {}), 'video-3');

  // A conversa inteira é com o servidor de salas, e apenas no recurso do pedido.
  // O token de acesso e os metadados ficam com o painel, que copia depois: o
  // renderer do desktop não deve pedir credencial para só esperar a seleção.
  assert.ok(SERVER_URL.startsWith('http'));
  assert.deepEqual(
    chamadas.map((c) => `${c.metodo} ${c.caminho}`),
    ['POST /start', 'GET /req-1', 'DELETE /req-1'],
  );
  assert.ok(chamadas.every((c) => !c.caminho.includes('picker-token')));
});
