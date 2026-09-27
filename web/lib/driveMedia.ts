/**
 * Reprodução de um arquivo do Google Drive dentro da sala.
 *
 * ## O caminho do vídeo
 *
 * Nenhum byte passa pelo nosso servidor nem pelo bucket. A URL que o `<video>`
 * recebe é um caminho da **própria origem** (`/drive-media/<fileId>`), que o
 * service worker em `public/drive-media-sw.js` troca pela URL do Google e
 * acompanha com o token da conta de quem está assistindo. O navegador continua
 * pedindo intervalos, então seek funciona como em qualquer arquivo.
 *
 * ## O que cada pessoa precisa fazer
 *
 * O escopo `drive.file` só dá acesso a arquivo que a pessoa escolheu no
 * Picker. O Juntos concede a permissão `reader` no arquivo para quem está na
 * sala, mas isso não basta: falta o vínculo do app com aquele arquivo, que só
 * nasce quando a pessoa o escolhe. Por isso o Picker aqui é aberto já filtrado
 * para o arquivo da sala (`setFileIds`), e a pessoa confirma uma única vez. É o
 * preço de manter um escopo não sensível, que dispensa a avaliação de segurança
 * anual que um escopo restrito exigiria.
 */

/**
 * A URL do worker, com a versão no query string.
 *
 * A versão precisa mudar a cada alteração no arquivo, e o motivo é o mesmo do
 * lado do worker: `clients.claim()` roda no `activate`, e o `activate` só
 * acontece uma vez por versão. Com a URL diferente, o navegador trata como outro
 * script, instala, ativa, e o `claim` roda de fato.
 *
 * Sem isso, uma versão com um `activate` quebrado continua controlando a origem
 * para sempre, e recarregar a página não conserta — porque recarregar não gera um
 * `activate` novo. Foi o que aconteceu: `active: "activated"` com
 * `controller: null`, sem nenhuma pista de por quê.
 *
 * **Bump ao editar `public/drive-media-sw.js`.**
 */
const VERSAO_WORKER = 3;
const SW_URL = `/drive-media-sw.js?v=${VERSAO_WORKER}`;
/**
 * O caminho que o `<video>` pede.
 *
 * Precisa ser da própria origem — é o que dá ao worker o direito de
 * interceptar — e não pode colidir com uma rota do Next, porque se colidir a
 * página chega a responder antes do worker. O prefixo duplo underscore era uma
 * defesa contra essa colisão; `/drive-media/` é mais legível e continua livre.
 */
const MEDIA_PREFIX = '/drive-media/';

/**
 * O mesmo banco e a mesma loja que o worker usa.
 *
 * A página e o worker compartilham a origem, então compartilham o IndexedDB.
 * É essa identidade que permite gravar o token sem passar pelo worker, e o
 * motivo de a página escrever diretamente: ser **ativa** é mais fácil que estar
 * **controlando** a página, e depender só da segunda ponta transformava uma
 * espera em um beco sem saída.
 */
const BANCO = 'juntos-drive';
const LOJA = 'credenciais';
const CHAVE_TOKEN = 'token';

/** Só pode ser resumido por aqui: esperar sem limite é pior do que falhar. */
const TIMEOUT_TOKEN_MS = 5000;

/**
 * A promise de registro, e ela é o que garante um worker só.
 *
 * Sem este cache, cada chamada refazia `register()` e `update()` e imprimia o
 * próprio log — e `[drive] registration criada` aparecia duas vezes porque
 * `publicarToken` e o `conferir` registravam em separado. Um log repetido vira
 * ruído que esconde a única informação que importava: quantas versões do worker
 * existiram.
 */
let registro: Promise<ServiceWorkerRegistration | null> | null = null;

function temSuporte(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Grava o token no IndexedDB, direto da página.
 *
 * Antes o token ia por `postMessage` e voltava por `MessagePort`, esperando
 * confirmação. Isso exigia que o worker estivesse **ativo** para a publicação
 * existir, e "não chegou a controlar a página" derrubava tudo junto — mesmo
 * quando o token podia ter sido gravado sem dificuldade nenhuma.
 *
 * A gravação é local e não depende de nada estar ativo. O worker continua lendo
 * do mesmo lugar, então o caminho de leitura fica idêntico.
 */
export async function guardarToken(accessToken: string | null): Promise<boolean> {
  try {
    await comLoja((loja) =>
      accessToken === null ? loja.delete(CHAVE_TOKEN) : loja.put(accessToken, CHAVE_TOKEN),
    );
    return true;
  } catch (erro) {
    console.warn('[drive] não foi possível gravar o token no IndexedDB', erro);
    return false;
  }
}

/** Uma transação por vez: abrir, agir, fechar. */
function comLoja(acao: (loja: IDBObjectStore) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pedido = indexedDB.open(BANCO, 1);
    pedido.onupgradeneeded = () => {
      if (!pedido.result.objectStoreNames.contains(LOJA)) pedido.result.createObjectStore(LOJA);
    };
    pedido.onsuccess = () => {
      const banco = pedido.result;
      const transacao = banco.transaction(LOJA, 'readwrite');
      try {
        acao(transacao.objectStore(LOJA));
      } catch (erro) {
        banco.close();
        reject(erro);
        return;
      }
      transacao.oncomplete = () => {
        banco.close();
        resolve();
      };
      transacao.onerror = () => {
        banco.close();
        reject(transacao.error);
      };
      transacao.onabort = () => {
        banco.close();
        reject(transacao.error);
      };
    };
    pedido.onerror = () => reject(pedido.error);
    pedido.onblocked = () => reject(new Error('banco bloqueado por outra aba'));
  });
}

/**
 * Registra o worker do Drive.
 *
 * O `localhost:3210` do app desktop conta como contexto seguro, então o worker
 * funciona igual na web. Devolve `null` onde service worker não existe, e o
 * player cai no aviso de "não disponível neste navegador".
 *
 * O estado da registration vai para o console de propósito. "Não assumiu esta
 * página" tem muitas causas — worker em `installing`, install falhado, escopo
 * recusado, o navegador decidindo não ativar — e sem ver o estado nenhuma delas
 * se distingue das outras. Foi o que aconteceu: `register()` resolvia, o script
 * era válido, e nenhuma dessas diferenças aparecia em lugar nenhum.
 */
export function registrarMediaWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!temSuporte()) return Promise.resolve(null);
  /*
   * Um registro só, e a promise em cache é o que garante isso.
   *
   * Sem o cache, cada chamada refazia o `register()` e o `update()`, e cada uma
   * imprimia o seu log — foi o que produziu `[drive] registration criada (v2)`
   * duas vezes, com o `publicarToken` e o `conferir` chamando o registro em
   * separado. Um log que aparece duas vezes é ruído que esconde o que importa:
   * quantas versões do worker existiram de verdade.
   *
   * A falha passageira também deixa de grudar: o cache guarda a promise enquanto
   * ela está em voo e some quando ela rejeita, então o próximo `publicarToken`
   * tenta de novo sem recarregar a página.
   */
  if (!registro) registro = registrarUmaVez();
  return registro;
}

function registrarUmaVez(): Promise<ServiceWorkerRegistration | null> {
  console.info('[drive] registrando o service worker', SW_URL);
  return navigator.serviceWorker
    .register(SW_URL, { scope: '/' })
    .then(async (r) => {
      /*
       * `update()` não é redundante com o `?v=`. O navegador só compara a URL
       * nova com a registrada quando algo o manda verificar, e esse algo é o
       * `register()` — mas só quando o script muda de verdade. Sem o
       * `update()`, trocar a constante de versão pode não installar nada, e o
       * sintoma volta a ser `active` com `controller: null`, agora sem nenhuma
       * pista nova.
       *
       * A falha do `update()` não derruba o registro: uma rede ruim só significa
       * que ficamos com a versão antiga, que ainda funciona.
       */
      await r.update().catch((e) => console.info('[drive] update() não concluiu', e));
      const estado = () => ({
        installing: r.installing?.state ?? null,
        waiting: r.waiting?.state ?? null,
        active: r.active?.state ?? null,
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      });
      console.info(`[drive] service worker registrado (v${VERSAO_WORKER})`, estado());
      r.addEventListener('updatefound', () => console.info('[drive] updatefound', estado()));
      for (const w of [r.installing, r.waiting, r.active]) {
        w?.addEventListener('statechange', () => console.info(`[drive] worker ${w.state}`, estado()));
      }
      return r;
    })
    .catch((e) => {
      // O cache é descartado junto: uma falha passageiro de rede não pode
      // grudar até o próximo recarregamento da página.
      registro = null;
      console.warn('[drive] service worker não registrado', e);
      return null;
    });
}

/**
 * Espera `navigator.serviceWorker.ready`.
 *
 * É a promessa que resolve quando existe um worker **ativo** controlando o
 * escopo, o que é diferente de `register()` resolver: esta última só diz que a
 * registration existe. Esperar as duas coisas é o que garante que o
 * `postMessage` do token não vá para o vazio.
 */
export async function esperarWorkerPronto(timeoutMs = TIMEOUT_TOKEN_MS): Promise<boolean> {
  if (!temSuporte()) return false;
  const reg = await registrarMediaWorker();
  if (!reg) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const pronto = await Promise.race([navigator.serviceWorker.ready.then(() => true), limite]);
    console.info(
      '[drive] service worker pronto',
      pronto ? 'ativo' : 'tempo esgotado',
      estadoDaRegistration(reg),
    );
    return pronto;
  } finally {
    clearTimeout(timer);
  }
}

/** O estado que o `controller: null` sozinho não explica. */
function estadoDaRegistration(r: ServiceWorkerRegistration): Record<string, string | null> {
  return {
    installing: r.installing?.state ?? null,
    waiting: r.waiting?.state ?? null,
    active: r.active?.state ?? null,
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
  };
}

/**
 * Espera a página estar **de fato** controlada pelo worker.
 *
 * Registrar não é controlar. No primeiro carregamento o worker nasce
 * `installing`, e a página só passa a ser controlada depois do `activate` e do
 * `clients.claim()` — o `controller` é `null` até lá. Sem esperar isso, o
 * `postMessage` do token vai para o vazio e o `<video>` recebe 401 do worker,
 * que é exatamente o player preto em 0:00 sem nenhuma mensagem.
 *
 * O `controllerchange` é o sinal de sucesso. Mas a espera também **pede o
 * `claim` de novo**, porque o `activate` só acontece uma vez por versão e há um
 * caso em que isso não basta: a página carregada com hard reload
 * (`Ctrl+Shift+R`) é servida sem o worker, e o `claim` daquele `activate` já
 * passou. O sintoma é `active: "activated"` com `controller: null`, e recarregar
 * não resolve — porque recarregar é justamente o que não usa o worker.
 *
 * A página fala com o worker por `registration.active`, que existe mesmo sem
 * controller. É isso que tira o comportamento da recarga da equação, em vez de
 * depender de a pessoa acertar qual tecla apertar.
 */
function esperarControle(reg: ServiceWorkerRegistration | null): Promise<boolean> {
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      clearInterval(pedido);
      navigator.serviceWorker.removeEventListener('controllerchange', aoMudar);
      if (ok) console.info('[drive] controller assumido', reg ? estadoDaRegistration(reg) : null);
      else console.warn('[drive] controller não assumido', reg ? estadoDaRegistration(reg) : null);
      resolve(ok);
    };
    const aoMudar = () => {
      if (navigator.serviceWorker.controller) done(true);
    };
    // O `claim()` pode não acontecer — se o `register` foi rejeitado, ou se o
    // navegador decidiu não ativar. Sem este limite a página ficaria esperando
    // para sempre, que é pior que falhar visível.
    /*
     * A checagem vem logo antes de cada pedido, e não só no `controllerchange`.
     *
     * Depender só do evento é frágil: um `claim` respondendo a uma mensagem
     * assume a página sem necessariamente disparar o evento, e a espera
     * continuaria até o limite devolvendo `sem_controle` com a página já
     * controlada. Ler `controller` direto é mais barato que esperar um evento.
     */
    const pedirClaim = () => {
      if (navigator.serviceWorker.controller) return done(true);
      /*
       * `postMessage` em um `try`: pedir o `claim` é uma gentileza para acelerar
       * a espera, e uma exceção aqui derrubaria a promessa inteira, com um
       * `TypeError` em vez do motivo certo. Se o worker não aceitar mensagem, a
       * espera segue pelo `controllerchange` e pelo limite, que já resolvem.
       */
      try {
        reg?.active?.postMessage({ type: 'juntos:drive-claim' });
      } catch {
        // Worker sem postMessage: segue esperando pelo evento.
      }
    };
    const pedido = setInterval(pedirClaim, 400);
    const timer = setTimeout(() => done(false), TIMEOUT_TOKEN_MS);
    navigator.serviceWorker.addEventListener('controllerchange', aoMudar);
    pedirClaim();
  });
}

/**
 * Entrega o access token ao worker e **espera confirmação**.
 *
 * O token fica no IndexedDB da origem, e é por isso que sobrevive ao worker ser
 * encerrado pelo navegador no meio da sessão. `null` limpa — é o que a
 * desconexão da conta chama.
 *
 * A confirmação importa: `postMessage` é assíncrono e sem retorno, então
 * publicar o token e montar o `<video>` no mesmo tique dá ao vídeo a chance de
 * pedir o primeiro intervalo antes de o token existir. Com a porta, o
 * `<video>` só aparece depois que o token está gravado.
 *
 * Devolve `false` em vez de falhar calado: sem token nenhum o player vai
 * carregar e falhar, e um player preto sem explicação é a pior coisa que um
 * player de vídeo pode fazer.
 */
/**
 * Por que a publicação não aconteceu.
 *
 * São três causas sem nada em comum, e cada uma precisa de uma resposta
 * diferente da pessoa. Devolver um booleano — como era antes — obrigava a
 * inventar uma frase que não era verdadeira em nenhum dos casos, que é a mesma
 * armadilha do `MediaError` do `<video>`.
 */
export type MotivoPublicacao =
  | 'sem_suporte'
  | 'registro_falhou'
  | 'grava_falhou'
  | 'sem_controle';

/**
 * Publica o token e garante que a página está controlada.
 *
 * A ordem importa e é o ponto do conserto. O token é gravado **pela página**,
 * direto no IndexedDB, e só depois é que se espera o controle. Antes as duas
 * coisas dependiam do worker estar ativo, e a espera pelo controle derrubava a
 * publicação junto — mesmo quando gravar o token não tinha nada de difícil.
 *
 * Controlar a página continua sendo obrigatório: sem `controller` não há
 * ninguém para interceptar `/drive-media/`, e o `<video>` levaria 404 da
 * hospedagem. Mas agora o token está gravado de qualquer forma, então um
 * controle que chega depois funciona sem refazer nada.
 */
export async function publicarToken(
  accessToken: string | null,
): Promise<{ ok: true } | { ok: false; motivo: MotivoPublicacao }> {
  if (!temSuporte()) return { ok: false, motivo: 'sem_suporte' };
  if (!(await guardarToken(accessToken))) return { ok: false, motivo: 'grava_falhou' };
  const reg = await registrarMediaWorker();
  if (!reg) return { ok: false, motivo: 'registro_falhou' };
  // `ready` antes do controle: `ready` garante um worker ativo, e só depois
  // faz sentido esperar que ele controle a página. Pular essa espera foi o que
  // deixou o `postMessage` do token ir para o vazio no primeiro carregamento.
  if (!(await esperarWorkerPronto())) return { ok: false, motivo: 'sem_controle' };
  if (!(await esperarControle(reg))) return { ok: false, motivo: 'sem_controle' };
  console.info('[drive-media] token gravado; player liberado');
  return { ok: true };
}

/**
 * A frase que a pessoa lê, por motivo.
 *
 * `sem_suporte` e `registro_falhou` são de configuração — o navegador não tem
 * service worker, ou o arquivo não pôde ser registrado. `grava_falhou` é o
 * navegador recusando o IndexedDB, o que costuma ser modo privado restrito.
 * `sem_controle` é o worker existindo e registrado sem assumir a página, e o
 * estado dele está no console.
 */
export function explicarPublicacao(motivo: MotivoPublicacao): string {
  switch (motivo) {
    case 'sem_suporte':
      return 'Este navegador não tem service worker, que é o que lê o vídeo do Google sem passar pelo nosso servidor.';
    case 'registro_falhou':
      return 'O navegador recusou registrar o leitor de vídeo do Google. Verifique se o site não está em modo privado restrito e recarregue a página.';
    case 'grava_falhou':
      return 'O navegador não deixou guardar a credencial do Google neste dispositivo, o que costuma acontecer em navegação privada restrita. Tente fora da janela privada.';
    case 'sem_controle':
      return 'O leitor de vídeo está registrado, mas o navegador não deixou ele assumir esta página. Saia e volte à sala, ou feche e abra o app de novo. O estado do leitor está no console do navegador ( procure por "[drive]" ).';
  }
}

/** A URL que o `<video>` recebe: mesma origem, para o worker poder interceptar. */
export function urlDeMidia(fileId: string): string {
  return `${MEDIA_PREFIX}${encodeURIComponent(fileId)}`;
}

/**
 * O que o worker descobriu sobre a última leitura.
 *
 * O `MediaError` do `<video>` não serve: no Chromium um 401 do Google e um
 * `.mkv` que o navegador não decodifica dão o mesmo
 * `MEDIA_ERR_SRC_NOT_SUPPORTED`. Os dois precisam de respostas diferentes —
 * um é reconectar, o outro é escolher outro arquivo — e a pessoa não tem como
 * adivinhar qual dos dois aconteceu.
 */
export type FalhaDrive = {
  motivo: 'sem_token' | 'sem_acesso' | 'recusado' | 'tipo_invalido' | 'rede' | string;
  status: number;
  detalhe?: string;
};

export async function lerFalhaDoWorker(): Promise<FalhaDrive | null> {
  if (!temSuporte()) return null;
  const reg = await registrarMediaWorker();
  if (!(await esperarControle(reg))) return null;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return null;
  return new Promise<FalhaDrive | null>((resolve) => {
    const porta = new MessageChannel();
    const fechar = (falha: FalhaDrive | null) => {
      clearTimeout(timer);
      porta.port1.close();
      porta.port2.close();
      resolve(falha);
    };
    const timer = setTimeout(() => fechar(null), TIMEOUT_TOKEN_MS);
    porta.port1.onmessage = (evento) => {
      const dados = evento.data as { falha?: FalhaDrive } | null;
      fechar(dados?.falha ?? null);
    };
    worker.postMessage({ type: 'juntos:drive-falha' }, [porta.port2]);
  });
}

/**
 * A frase que a pessoa lê, a partir do que o worker viu.
 *
 * O `error_description` do Google entra quando existe porque ele diz a causa
 * real — "File not found", "Rate limit exceeded", "This file has been blocked by
 * the owner" — e a pessoa consegue agir sobre isso sem falar com ninguém.
 */
export function explicarFalha(falha: FalhaDrive | null, fallback: string): string {
  if (!falha) return fallback;
  const doGoogle = falha.detalhe ? ` O Google respondeu: "${falha.detalhe}".` : '';
  switch (falha.motivo) {
    case 'sem_token':
      return 'A credencial do Google não chegou ao leitor deste vídeo. Recarregue a página e tente de novo.';
    case 'sem_acesso':
      return `A sua conta não tem permissão de leitura neste arquivo (${falha.status}).${doGoogle} Reconecte o Drive e autorize este vídeo de novo.`;
    case 'tipo_invalido':
      return `O Google devolveu o arquivo como "${falha.detalhe || 'tipo desconhecido'}", e não como vídeo. O arquivo provavelmente não é um vídeo, ou foi convertido para um formato que o navegador não decodifica.`;
    case 'rede':
      return `A leitura falhou antes de chegar ao Google.${doGoogle}`;
    default:
      return `O Google recusou a leitura deste arquivo (${falha.status}).${doGoogle}`;
  }
}

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/**
 * Esta conta já tem acesso ao app sobre este arquivo?
 *
 * A resposta é a do próprio Google, e é a única confiável: o escopo
 * `drive.file` responde 404 justamente quando o vínculo não existe. Sem esta
 * checagem o `<video>` falharia e a pessoa não saberia se era falta de
 * permissão ou alguma coisa quebrada.
 */
export async function temAcessoAoArquivo(
  fileId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const url = new URL(`${DRIVE_FILES}/${fileId}`);
  url.searchParams.set('fields', 'id');
  url.searchParams.set('supportsAllDrives', 'true');
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
    return res.ok;
  } catch {
    return false;
  }
}
