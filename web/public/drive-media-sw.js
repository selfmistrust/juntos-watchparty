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

/**
 * A versão do worker, e ela precisa mudar sempre que este arquivo mudar.
 *
 * ## Por que a versão está no nome
 *
 * O sintoma observado: `active: "activated"` com `controller: null`. O worker
 * instala e ativa, mas a página nunca entra sob controle dele — e o `<video>`
 * passa a pedir `/__drive_media/...` à rede comum, levando 404 da hospedagem.
 *
 * A causa é o `clients.claim()`: ele roda no evento `activate`, e o `activate`
 * só acontece **uma vez por versão do worker**. Se uma versão já ativou numa
 * visita anterior e a página foi aberta depois, o `claim` daquele `activate` já
 * aconteceu e não alcança esta página. Recarregar não resolve, porque recarregar
 * não gera um `activate` novo — o worker continua sendo o mesmo, já ativado.
 *
 * A saída é forçar um `install` novo, e a forma honesta de fazer isso é mudar a
 * URL do script. Com `?v=N` diferente, o navegador trata como outro script,
 * instala, ativa, e aí o `claim()` roda de fato.
 *
 * Bump este número **sempre** que editar este arquivo. Um `waitUntil` faltando
 * num `activate` antigo nunca mais vai rodar.
 */
const VERSAO = 3;

/** Caminho interceptado. Precisa ser da própria origem para o worker existir. */
const PREFIXO = '/drive-media/';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const BANCO = 'juntos-drive';
const LOJA = 'credenciais';

/*
 * Assume a página imediatamente, e os dois lados disso precisam de `waitUntil`.
 *
 * O sintoma era `active: "activated"` com `controller: null`: o worker instala e
 * ativa, mas a página nunca entra sob controle dele, e o `<video>` passa a pedir
 * `/__drive_media/...` à rede comum, recebendo 404 da hospedagem. Nenhum
 * `controllerchange` chega, porque ninguém foi asumido.
 *
 * `waitUntil` não é formalidade aqui. Sem ele, o navegador pode encerrar o
 * evento antes de a promessa resolver: o `skipWaiting` no `install` pode ficar
 * pela metade, e o `claim` no `activate` — que é o que realmente assume a
 * página — pode não rodar. O sintoma é exatamente esse: registration criada,
 * worker ativado, página fora do controle, e nenhuma pista de por quê.
 */
/*
 * Registra a versão, para que o `claim` do `activate` tenha o que assumir.
 *
 * `waitUntil` não é formalidade em nenhum dos dois: sem ele, o navegador pode
 * encerrar o evento antes da promessa resolver, e o `skipWaiting` fica pela
 * metade. O sintoma é o mesmo nos dois casos — registration criada, worker
 * ativado, página fora do controle, nenhuma pista de por quê.
 */
self.addEventListener('install', (evento) => {
  evento.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(self.clients.claim());
});

/**
 * Assume a página quando ela pede, e não só no `activate`.
 *
 * O `activate` acontece uma vez por versão, e há um caso em que isso não basta:
 * a página carregada com **hard reload** (`Ctrl+Shift+R`) é servida sem o
 * worker, e o `claim` daquele `activate` já passou. O resultado é `active:
 * "activated"` com `controller: null`, e nenhuma recarga resolve — porque a
 * recarga é justamente o que não usa o worker.
 *
 * A página pede o `claim` explicitamente por aqui, e a página consegue falar com
 * o worker por `registration.active` mesmo sem controller. Isso tira do
 * comportamento da recarga a responsabilidade de assumir a página, e é mais
 * honesto do que pedir à pessoa que use um tipo específico de F5.
 */
self.addEventListener('message', (evento) => {
  const dados = evento.data;
  if (dados && typeof dados === 'object' && dados.type === 'juntos:drive-claim') {
    evento.waitUntil(self.clients.claim());
  }
});

console.log('[drive-sw] activate', VERSAO);

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

  console.info('[drive-sw] requisição interceptada', {
    fileId,
    range: evento.request.headers.get('Range'),
  });
  evento.respondWith(repassar(evento.request, fileId));
});

/**
 * Metadados do arquivo, com o tamanho total.
 *
 * ## Por que uma chamada extra
 *
 * Porque o `Content-Range` do Google **não é legível de fora**, e ele é o
 * cabeçalho de que o `<video>` mais depende. A lista de cabeçalhos que o CORS
 * deixa ler é curta — `Content-Type`, `Content-Length`, `Cache-Control`,
 * `Content-Language`, `Expires`, `Last-Modified`, `Pragma` — e `Content-Range`
 * não está nela. Um `fetch` de fora da origem que o peça recebe `null`, mesmo
 * com o cabeçalho chegando no fio.
 *
 * Isso explica o sintoma inteiro: o `206` volta, o `Content-Length` e o
 * `Content-Type` voltam, o `Content-Range` não, e o player recebe um trecho que
 * ele não consegue posicionar. O `MEDIA_ELEMENT_ERROR code 4` é a consequência
 * de um `206` sem intervalo declarado, não de codec — a mesma tela que um
 * `.mkv` incompatível produziria.
 *
 * O tamanho total vem de `files.get`, e é o que permite reconstruir o cabeçalho
 * que o navegador precisa.
 */
async function metadadosDe(fileId, token) {
  const url = new URL(`${DRIVE}/${fileId}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,capabilities(canDownload)');
  url.searchParams.set('supportsAllDrives', 'true');
  const resposta = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resposta.ok) return null;
  const dados = await resposta.json();
  return {
    nome: dados.name || '',
    mimeType: dados.mimeType || '',
    tamanho: Number(dados.size) || 0,
    // `canDownload` explícito: o dono do arquivo pode bloquear o download, e
    // aí o `206` volta com um erro que só o cabeçalho de erro do Google explica.
    podeBaixar: dados.capabilities ? dados.capabilities.canDownload !== false : true,
  };
}

/**
 * Cache dos metadados, por arquivo.
 *
 * Sem isso, cada pedaço de seek chamaria `files.get` de novo, e um arrasto de
 * barra de meio em meio segundo viraria meia dúzia de chamadas à API. O cache é
 * por sessão do worker: se ele for encerrado, o próximo `fetch` repopula, e
 * uma chamada a mais é melhor do que a taxa da API estourada.
 */
const METADADOS = new Map();

async function metadadosComCache(fileId, token) {
  const guardado = METADADOS.get(fileId);
  if (guardado) return guardado;
  const dados = await metadadosDe(fileId, token);
  if (dados) METADADOS.set(fileId, dados);
  return dados;
}

/**
 * Lê o `Range` do navegador e devolve os números.
 *
 * Devolve `null` quando o cabeçalho é ausente ou tem mais de um intervalo, e
 * é aí que o caso muda: um pedido sem `Range` não tem reconstrução a fazer, o
 * Google devolve o arquivo inteiro e o `Content-Range` é desnecessário.
 *
 * Um `bytes=-500` (os últimos 500 bytes) é tratado como sufixo, que é a forma
 * que o CORS e a spec usam para "deixe-me o fim do arquivo" — e é exatamente o
 * pedido que um MP4 com `moov` no fim faz para descobrir se consegue tocar.
 */
function analisarRange(cabecalho, total) {
  if (!cabecalho) return null;
  const achado = /^bytes=(\d*)-(\d*)$/.exec(cabecalho.trim());
  if (!achado) return null;
  const inicio = achado[1];
  const fim = achado[2];
  if (inicio === '' && fim === '') return null;
  // Sufixo: `bytes=-N` pede os N últimos bytes.
  if (inicio === '') {
    const quantos = Number(fim);
    if (!Number.isFinite(quantos) || quantos <= 0) return null;
    return { inicio: Math.max(0, total - quantos), fim: total - 1, sufixo: true };
  }
  const comeco = Number(inicio);
  if (!Number.isFinite(comeco) || comeco < 0) return null;
  const final = fim === '' ? total - 1 : Number(fim);
  if (!Number.isFinite(final) || final < comeco) return null;
  return { inicio: comeco, fim: Math.min(final, total - 1), sufixo: false };
}

/**
 * Reconstrui o `Content-Range` que o CORS escondeu.
 *
 * O `Content-Length` **é** legível, e é o que fecha a conta: o trecho que o
 * Google devolveu começa no `start` que pedimos e tem o tamanho que ele mandou,
 * então `end = start + length - 1`. Só falta o total, que vem dos metadados.
 *
 * A alternativa seria deixar o `Content-Range` de fora, e aí o navegador trata
 * o `206` como incompleto e aborta com `MEDIA_ELEMENT_ERROR` — que é o bug que
 * estamos corrigindo.
 */
function reconstruirContentRange(inicio, tamanho, total) {
  if (total <= 0 || tamanho <= 0) return null;
  const fim = inicio + tamanho - 1;
  // O total vem do metadado, e o `end` não pode passar dele: um valor além do
  // fim do arquivo é um `Content-Range` inválido, e o player vai recusar.
  if (fim > total - 1) return null;
  return `bytes ${inicio}-${fim}/${total}`;
}

async function repassar(pedido, fileId) {
  const token = await lerToken();
  if (!token) {
    // 401 é a resposta certa: a página escuta o erro do `<video>` e mostra o
    // botão de conectar o Drive, em vez de um player quebrado sem explicação.
    await registrarFalha({ motivo: 'sem_token', status: 401 });
    return new Response('sem credencial do drive', { status: 401 });
  }

  const cabecalhoRange = pedido.headers.get('Range');
  let total = 0;
  let mimeDoArquivo = '';
  if (cabecalhoRange) {
    /*
     * O tamanho total vem antes da mídia, e só quando há `Range` a reconstruir.
     * Um pedido sem `Range` não precisa dele, e a chamada extra seria um custo
     * à toa no primeiro playback.
     */
    const metadados = await metadadosComCache(fileId, token).catch(() => null);
    if (metadados) {
      total = metadados.tamanho;
      mimeDoArquivo = metadados.mimeType;
      if (!metadados.podeBaixar) {
        await registrarFalha({ motivo: 'sem_acesso', status: 403, detalhe: 'download bloqueado' });
        return new Response('download bloqueado', { status: 403 });
      }
    }
  }

  const intervalo = analisarRange(cabecalhoRange, total);

  /*
   * Um `start` além do fim do arquivo é um `416 Range Not Satisfiable`, com o
   * total no `Content-Range` — que é o que o RFC pede e o que o player usa para
   * reposicionar em vez de tentar ler do zero.
   */
  if (intervalo && !intervalo.sufixo && intervalo.inicio >= total && total > 0) {
    console.warn('[drive-sw] intervalo além do fim do arquivo', {
      pedido: cabecalhoRange,
      inicio: intervalo.inicio,
      total,
    });
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
    });
  }

  const alvo = new URL(`${DRIVE}/${fileId}`);
  alvo.searchParams.set('alt', 'media');
  alvo.searchParams.set('supportsAllDrives', 'true');

  const cabecalhos = { Authorization: `Bearer ${token}` };
  /*
   * O `Range` do navegador vai junto, e é ele que faz o seek.
   *
   * Sem esta linha o player baixa o arquivo inteiro a cada reposicionamento, e
   * o `Content-Length` que volta não casa com o que foi pedido: o navegador não
   * consegue montar a resposta parcial. Encaminhar o cabeçalho e devolver o
   * `206` com `Content-Range` reconstruído é o contrato inteiro do seek.
   */
  if (cabecalhoRange) cabecalhos.Range = cabecalhoRange;
  console.info('[drive-sw] token recebido, buscando no Drive', {
    fileId,
    range: cabecalhoRange,
    total,
    mimeType: mimeDoArquivo,
  });

  let resposta;
  try {
    resposta = await fetch(alvo.toString(), { headers: cabecalhos });
  } catch (erro) {
    await registrarFalha({ motivo: 'rede', status: 0, detalhe: String(erro).slice(0, 200) });
    return new Response('drive indisponivel', { status: 502 });
  }

  console.info('[drive-sw] resposta do Google', {
    status: resposta.status,
    contentType: resposta.headers.get('content-type'),
    contentRange: resposta.headers.get('content-range'),
    contentLength: resposta.headers.get('content-length'),
  });

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
      /*
       * Sem `as`: este arquivo é JavaScript puro e é servido como está, sem
       * passar por compilador nenhum. Uma anotação de tipo aqui quebra o worker
       * inteiro com `SyntaxError` na linha 207, e o sintoma é o pior possível —
       * nenhuma requisição é interceptada, o `<video>` pede o arquivo e leva
       * 404 da Vercel, e a página recebe um erro que não tem nada a ver com a
       * causa. A lição é que nada aqui pode ser TypeScript, e nada aqui pode
       * falhar em tempo de parse.
       */
      const corpo = JSON.parse(texto);
      if (corpo && corpo.error && typeof corpo.error.message === 'string') {
        detalhe = corpo.error.message.slice(0, 200);
      }
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

  /*
   * Os cabeçalhos que o player precisa.
   *
   * `Content-Range` é o crítico, e é o único que este proxy precisa
   * **reconstruir**: o CORS não deixa o `fetch` de fora da origem lê-lo, mesmo
   * com o Google mandando. Os demais chegam legíveis e são repassados como
   * vieram. `ETag` e `Last-Modified` são repassados porque o player os usa para
   * validar uma nova requisição de intervalo, e inventar um `ETag` falso faria o
   * navegador recusar um intervalo válido.
   */
  const CABECALHOS_REPASSADOS = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ];
  const repassados = new Headers();
  for (const nome of CABECALHOS_REPASSADOS) {
    const valor = resposta.headers.get(nome);
    if (valor) repassados.set(nome, valor);
  }
  /*
   * O `Content-Range` legível tem precedência sobre o reconstruído. Se um dia o
   * Google passar a expor o cabeçalho, usar o valor dele é mais correto do que
   * recalcular, e a diferença é quem calcula a conta.
   */
  let origemDoRange = 'google';
  if (resposta.status === 206 && !repassados.has('content-range') && intervalo && total > 0) {
    const tamanho = Number(resposta.headers.get('content-length')) || 0;
    const reconstruido = reconstruirContentRange(intervalo.inicio, tamanho, total);
    if (reconstruido) {
      repassados.set('Content-Range', reconstruido);
      origemDoRange = 'reconstruido';
    }
  }
  /*
   * `Accept-Ranges` é afirmado quando há `Content-Range` — e só então. Declarar
   * `bytes` numa resposta sem intervalo declarado é anunciar um contrato que a
   * resposta não cumpre, e é assim que o player descobre que o byte pedido não
   * chegou.
   */
  if (repassados.has('content-range')) repassados.set('Accept-Ranges', 'bytes');
  repassados.set('Cache-Control', 'no-store');

  /*
   * Um `206` sem `Content-Range` é um contrato quebrado, e é a falha que
   * produz `MEDIA_ELEMENT_ERROR code 4`: o player recebe bytes e não sabe onde
   * eles estão. O log transformaria "não reproduz" em "o Google devolveu 206 sem
   * Content-Range e não deu para reconstruir" — mas a causa já é conhecida e
   * corrigida, então o que resta é o sinal de que ela voltou.
   */
  if (resposta.status === 206 && !repassados.has('content-range')) {
    console.error('[drive-sw] 206 sem Content-Range e sem como reconstruir', {
      pedido: cabecalhoRange,
      total,
      contentLength: resposta.headers.get('content-length'),
    });
  }

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

  /*
   * O log de ida é o que separa "o Google não mandou" de "a gente não repassou".
   * São dois defeitos com o mesmo sintoma — o player não consegue posicionar o
   * trecho — e consertos opostos: um é do arquivo no Drive, o outro é deste
   * proxy. Registrar o que saiu do Google e o que está saindo daqui torna a
   * diferença visível em uma linha.
   */
  const devolvidos = {};
  for (const nome of CABECALHOS_REPASSADOS) {
    devolvidos[nome] = repassados.get(nome);
  }
  console.info('[drive-sw] contentRange', { origem: origemDoRange, valor: devolvidos['content-range'] });
  console.info('[drive-sw] devolvendo ao player', {
    pedido: cabecalhoRange ?? '(sem Range)',
    status: resposta.status,
    doGoogle: {
      contentRange: resposta.headers.get('content-range'),
      contentLength: resposta.headers.get('content-length'),
      contentType: resposta.headers.get('content-type'),
    },
    devolvido: devolvidos,
  });

  /*
   * O corpo vai como stream, sem `arrayBuffer()` nem `blob()`.
   *
   * Um filme de 700 MB em memória seria 700 MB de RAM por espectador, e é
   * exatamente o que o proxy client-side veio evitar. `response.body` é um
   * ReadableStream: o `206` chega ao player conforme o Google entrega, e o
   * primeiro bloco toca antes de o arquivo inteiro passar.
   */
  return new Response(resposta.body, {
    status: resposta.status,
    statusText: resposta.statusText,
    headers: repassados,
  });
}
