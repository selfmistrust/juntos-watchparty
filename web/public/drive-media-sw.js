/*
 * Service worker do Google Drive para o player da sala.
 *
 * ## Por que existe
 *
 * Um `<video>` não manda cabeçalho nenhum: só sabe pedir uma URL. A Drive API
 * exige `Authorization: Bearer`, então um `video.src` apontando direto para
 * `www.googleapis.com` volta 401 sem chance de retry. A alternativa seria um
 * proxy no nosso servidor, e é exatamente o que a gente não quer: o vídeo
 * passaria pelo Render, uma vez por espectador.
 *
 * Este worker resolve o impasse sem sair do navegador. Ele intercepta um
 * caminho **da própria origem** (`/__drive_media/<fileId>`), troca pela URL do
 * Google, acrescenta o token da conta que está assistindo e devolve a resposta
 * com `Range` e `Content-Range` intactos. O navegador continua fazendo as
 * requisições de intervalo, o seek funciona, e nenhum byte passa pelo servidor.
 *
 * ## Onde o token vive
 *
 * No IndexedDB, e não só em memória. Um service worker pode ser encerrado pelo
 * navegador a qualquer momento entre duas requisições; com o token apenas em
 * memória, o vídeo que já estava tocando passaria a falhar sozinho, sem
 * nenhum erro visível. No IndexedDB, quem reativa é a própria página, que
 * republica o token quando a faixa muda.
 *
 * O token **nunca** vai para a URL, nem para query string, nem para log: ele
 * fica no IndexedDB desta origem e some quando a pessoa desconecta a conta.
 */

/** Caminho interceptado. Precisa ser da própria origem para o worker existir. */
const PREFIXO = '/__drive_media/';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const BANCO = 'juntos-drive';
const LOJA = 'credenciais';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evento) => evento.waitUntil(self.clients.claim()));

function abrirBanco() {
  return new Promise((resolve, reject) => {
    const pedido = indexedDB.open(BANCO, 1);
    pedido.onupgradeneeded = () => {
      if (!pedido.result.objectStoreNames.contains(LOJA)) pedido.result.createObjectStore(LOJA);
    };
    pedido.onsuccess = () => resolve(pedido.result);
    pedido.onerror = () => reject(pedido.error);
  });
}

/** Uma operação por vez no IndexedDB: abrir, agir, fechar. */
async function comLoja(acao) {
  const banco = await abrirBanco();
  try {
    return await new Promise((resolve, reject) => {
      const transacao = banco.transaction(LOJA, acao.tipo === 'ler' ? 'readonly' : 'readwrite');
      const loja = transacao.objectStore(LOJA);
      const pedido = acao.tipo === 'ler' ? loja.get('token') : null;
      if (pedido) {
        pedido.onsuccess = () => resolve(pedido.result ?? null);
        pedido.onerror = () => reject(pedido.error);
      } else {
        if (acao.tipo === 'guardar') loja.put(acao.valor, 'token');
        else loja.delete('token');
        transacao.oncomplete = () => resolve(null);
        transacao.onerror = () => reject(transacao.error);
      }
    });
  } finally {
    banco.close();
  }
}

async function guardarToken(token) {
  await comLoja({ tipo: 'guardar', valor: token });
}

async function lerToken() {
  try {
    return await comLoja({ tipo: 'ler' });
  } catch {
    return null;
  }
}

async function limparToken() {
  // Sem token guardado é o estado normal de quem nunca conectou, então a falha
  // aqui não é erro — é só mais um motivo para o player cair no botão de
  // conectar.
  await comLoja({ tipo: 'limpar' }).catch(() => {});
}

/**
 * Grava ou apaga o token e responde pela porta.
 *
 * A resposta importa porque a página precisa saber que o token está no
 * IndexedDB antes de montar o `<video>`. Sem ela, o vídeo pede o primeiro
 * intervalo antes da gravação e recebe 401 — o player preto em 0:00, sem
 * mensagem. A porta é o que transforma "enviei" em "está gravado".
 */
self.addEventListener('message', (evento) => {
  const dados = evento.data;
  if (!dados || typeof dados !== 'object') return;
  const porta = evento.ports && evento.ports[0];
  const responder = (ok) => {
    if (porta) porta.postMessage({ ok });
  };

  if (dados.type === 'juntos:drive-token' && typeof dados.token === 'string') {
    evento.waitUntil(
      guardarToken(dados.token)
        .then(() => responder(true))
        .catch((erro) => {
          console.error('[drive-sw] não foi possível gravar o token', erro);
          responder(false);
        }),
    );
  } else if (dados.type === 'juntos:drive-clear') {
    evento.waitUntil(limparToken().then(() => responder(true)));
  }
});

self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIXO)) return;

  const fileId = url.pathname.slice(PREFIXO.length).split('/')[0];
  if (!/^[A-Za-z0-9_-]{10,256}$/.test(fileId)) {
    evento.respondWith(new Response('arquivo invalido', { status: 400 }));
    return;
  }

  evento.respondWith(repassar(evento.request, fileId));
});

async function repassar(pedido, fileId) {
  const token = await lerToken();
  if (!token) {
    // 401 é a resposta certa: a página escuta o erro do `<video>` e mostra o
    // botão de conectar o Drive, em vez de um player quebrado sem explicação.
    return new Response('sem credencial do drive', { status: 401 });
  }

  const alvo = new URL(`${DRIVE}/${fileId}`);
  alvo.searchParams.set('alt', 'media');
  alvo.searchParams.set('supportsAllDrives', 'true');

  const cabecalhos = { Authorization: `Bearer ${token}` };
  // O `Range` do navegador vai junto, e é ele que faz o seek: sem esta linha o
  // Playwright e os navegadores soaked de teste aqui passariam, e a busca
  // arrastaria o arquivo inteiro a cada reposicionamento.
  const range = pedido.headers.get('Range');
  if (range) cabecalhos.Range = range;

  let resposta;
  try {
    resposta = await fetch(alvo.toString(), { headers: cabecalhos });
  } catch {
    return new Response('drive indisponivel', { status: 502 });
  }

  if (!resposta.ok || !resposta.body) {
    // 404 aqui é o "você ainda não autorizou este arquivo para o juntos" do
    // `drive.file`. A página traduz isso no botão de autorizar.
    return new Response(await resposta.text(), { status: resposta.status });
  }

  const repassados = new Headers();
  for (const nome of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const valor = resposta.headers.get(nome);
    if (valor) repassados.set(nome, valor);
  }
  repassados.set('Accept-Ranges', 'bytes');
  repassados.set('Cache-Control', 'no-store');

  return new Response(resposta.body, {
    status: resposta.status,
    statusText: resposta.statusText,
    headers: repassados,
  });
}
