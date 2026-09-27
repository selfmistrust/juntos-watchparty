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
      const pedido = acao.tipo === 'ler' ? loja.get(acao.chave ?? 'token') : null;
      if (pedido) {
        pedido.onsuccess = () => resolve(pedido.result ?? null);
        pedido.onerror = () => reject(pedido.error);
      } else {
        if (acao.tipo === 'guardar') loja.put(acao.valor, acao.chave ?? 'token');
        else loja.delete(acao.chave ?? 'token');
        transacao.oncomplete = () => resolve(null);
        transacao.onerror = () => reject(transacao.error);
      }
    });
  } finally {
    banco.close();
  }
}

/**
 * Guarda por que a última leitura falhou.
 *
 * ## Por que isso é necessário
 *
 * O `<video>` não conta nada. Ele emite um `error` e, no Chromium, tanto um 401
 * do Google quanto um `.mkv` que o navegador não decodifica chegam como
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` — o mesmo código, causas opostas, consertos
 * opostos. A mensagem na tela vira adivinhação, e a pessoa não tem como ajudar a
 * adivinhar.
 *
 * O worker é o único que sabe. Ele grava o status e o `content-type` que o Google
 * devolveu, e a página lê isso quando o player falha. Nenhum dado do arquivo vai
 * para cá: só status, tipo e um recorte da mensagem de erro.
 */
async function registrarFalha(info) {
  await comLoja({ tipo: 'guardar', chave: 'ultima-falha', valor: info }).catch(() => {});
}

async function lerFalha() {
  try {
    return await comLoja({ tipo: 'ler', chave: 'ultima-falha' });
  } catch {
    return null;
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
  const responder = (ok, extra) => {
    if (porta) porta.postMessage({ ok, ...extra });
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
  } else if (dados.type === 'juntos:drive-falha') {
    // A página pergunta por que a leitura falhou. Sem este caminho o player
    // mostraria um código do `MediaError`, que não distingue 401 de formato
    // incompatível.
    evento.waitUntil(lerFalha().then((falha) => responder(!!falha, { falha })));
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
    await registrarFalha({ motivo: 'sem_token', status: 401 });
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
  } catch (erro) {
    await registrarFalha({ motivo: 'rede', status: 0, detalhe: String(erro).slice(0, 200) });
    return new Response('drive indisponivel', { status: 502 });
  }

  if (!resposta.ok || !resposta.body) {
    // 404 aqui é o "você ainda não autorizou este arquivo para o juntos" do
    // `drive.file`. A página traduz isso no botão de autorizar.
    const texto = await resposta.text().catch(() => '');
    /*
     * O corpo do erro do Google é JSON com um `error.message` que diz o que
     * aconteceu de verdade — "File not found", "Rate limit exceeded", "The file
     * has been blocked". Registrar o status sozinho deixaria a pessoa com um
     * número e nenhuma pista, que é o que aconteceu até agora.
     */
    let detalhe = texto.slice(0, 200);
    try {
      const corpo = JSON.parse(texto) as { error?: { message?: string } };
      if (corpo.error?.message) detalhe = corpo.error.message.slice(0, 200);
    } catch {
      // Corpo não-JSON: o recorte do texto serve.
    }
    await registrarFalha({
      motivo: resposta.status === 401 || resposta.status === 403 ? 'sem_acesso' : 'recusado',
      status: resposta.status,
      detalhe,
    });
    return new Response(texto, { status: resposta.status });
  }

  const repassados = new Headers();
  for (const nome of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const valor = resposta.headers.get(nome);
    if (valor) repassados.set(nome, valor);
  }
  repassados.set('Accept-Ranges', 'bytes');
  repassados.set('Cache-Control', 'no-store');

  /*
   * O `content-type` é a prova de que o arquivo chegou inteiro. Sem ele — ou com
   * um `text/html` no lugar — o navegador recebe algo que não decodifica e
   * levanta `MEDIA_ERR_SRC_NOT_SUPPORTED`, que é indistinguível de um 401 na
   * cara da pessoa. Registrar aqui permite dizer qual dos dois foi.
   */
  const tipo = resposta.headers.get('content-type') ?? '';
  if (!tipo.startsWith('video/') && !tipo.startsWith('audio/')) {
    await registrarFalha({ motivo: 'tipo_invalido', status: resposta.status, detalhe: tipo });
  }

  return new Response(resposta.body, {
    status: resposta.status,
    statusText: resposta.statusText,
    headers: repassados,
  });
}
