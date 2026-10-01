import { BrowserWindow, WebContentsView, app, ipcMain, session, shell } from 'electron';
import { log } from './log';
import { ehDominioPermitido } from '../shared/dominioPrime';
import type { PrimeBounds, PrimePage } from '../shared/contract';

/**
 * A Prime Video dentro do Junto, como `WebContentsView`.
 *
 * ## O que esta integração é, e o que ela não é
 *
 * É um navegador apontado para `primevideo.com`, do mesmo jeito que a aba que a
 * pessoa já teria aberta. Login, catálogo, busca e escolha de título acontecem
 * na página oficial da Amazon, com a conta de quem está usando. O Juntos recebe
 * duas coisas quando o título é escolhido: a **URL** da página e o **título**
 * do documento — nada mais.
 *
 * Não há leitura de cookie, captura de token, leitura de manifesto de vídeo,
 * armazenamento de chave de DRM nem proxy do stream. O vídeo chega no aparelho
 * de cada pessoa direto do Prime Video, e o nosso servidor não participa.
 *
 * ## Por que `WebContentsView` e não `<webview>`
 *
 * `WebContentsView` é a API atual: uma view nativa, separada do frame da
 * janela, que o Chromium renderiza por cima. O `<webview>` é a tag legada, e
 * manter as duas no mesmo app é manter duas políticas de segurança sem nenhum
 * ganho.
 *
 * ## Por que a sessão é `persist:prime`
 *
 * É o que faz a pessoa não precisar logar de novo toda vez que abre o app. O
 * prefixo `persist:` é o que grava em disco; sem ele a sessão morre com o
 * processo e o login seria pedido a cada abertura.
 *
 * E é uma sessão **desta instalação**. Nenhum byte dela vai para a sala, para o
 * servidor ou para o outro participante: cada pessoa abre o Prime na conta
 * dela, que é o requisito de nunca compartilhar sessão entre usuários.
 */

/**
 * Sessão dedicada, separada da `defaultSession` do app.
 *
 * O nome é explícito de propósito. `persist:prime` é curto e poderia colidir
 * com outra coisa da máquina que guarde uma sessão com esse nome;
 * `juntos-prime` não collide com nada, e o que aparece na pasta de dados do
 * app diz de quem é a sessão quando alguém precisar investigate.
 */
const PARTICAO = 'persist:juntos-prime';

/**
 * A regra de domínios mora em `shared/dominioPrime.ts`.
 *
 * Ela fica lá, e não aqui, por um motivo concreto: a suíte de testes roda a
 * partir de `server`, onde o pacote `electron` não está instalado. Com a regra
 * num módulo sem import nenhum, o `main` e o teste exercitam o mesmo código —
 * antes havia uma cópia aqui e outra em `server/src/prime.ts`, e o teste só
 * olhava uma delas.
 */


/** Caminhos que são a página de um título. O primeiro segmento basta. */
const CAMINHOS_DE_TITULO = ['detail', 'title', 'dp'];

/** Mesmo UA do `index.ts`: o Prime recusa contexto que se identifica como Electron. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let view: WebContentsView | null = null;
/** A janela dona da view. Só muda quando a janela fecha. */
let dona: BrowserWindow | null = null;
/**
 * A janela em que a view foi de fato adicionada como filha.
 *
 * Separado de `dona` porque `removeChildView` precisa ser chamado no mesmo
 * pai onde `addChildView` foi chamado. Com o app de instância única são a
 * mesma janela — e quando não forem, remover no pai errado deixa a view órfã
 * dentro de uma janela que já não é a dela.
 */
let paiDaView: BrowserWindow | null = null;
/** Última página conhecida, para responder a `prime:pagina` sem esperar evento. */
let paginaAtual: PrimePage = { url: '', titulo: '', isTitulo: false };

/** URL canônica de uma página permitida, com query e âncora removidas. */
function normalizar(url: unknown): URL | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!ehDominioPermitido(u.hostname)) return null;
    u.search = '';
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

/**
 * Descreve a página que a view está mostrando.
 *
 * `getURL()` é o estado de navegação do próprio Chromium, e `getTitle()` é o
 * que o Prime já escreve na aba do navegador. Nenhum dos dois é leitura de DOM,
 * e é por isso que eles não dependem de classe nem de seletor do site: a
 * Amazon pode reescrever o CSS inteiro amanhã e a detecção continua valendo.
 */
function descrever(u: URL | null): PrimePage {
  if (!u) return { url: '', titulo: '', isTitulo: false };
  const primeiro = u.pathname.split('/').filter(Boolean)[0] ?? '';
  return {
    url: u.toString(),
    titulo: view && !view.webContents.isDestroyed() ? view.webContents.getTitle() : '',
    isTitulo: CAMINHOS_DE_TITULO.includes(primeiro),
  };
}

/** Avisa o renderer da mudança de página e guarda a última para quem perguntar depois. */
function publicar(): void {
  if (!view || view.webContents.isDestroyed()) return;
  paginaAtual = descrever(normalizar(view.webContents.getURL()));
  for (const wc of BrowserWindow.getAllWindows()) {
    if (!wc.isDestroyed()) wc.webContents.send('prime:pagina-mudou', paginaAtual);
  }
}

/**
 * Remove a view do `contentView` e fecha a página.
 *
 * `dona` **não** é zerada aqui: quem fecha a view é a pessoa, e a janela
 * continua sendo a dona dela. Zerar a janela aqui fazia `prime:abrir` receber
 * `null` na vez seguinte, e o Prime não abria mais pelo resto da sessão — o
 * sintoma seria "funcionou uma vez e nunca mais".
 *
 * E remover, em vez de esconder: ver o comentário de `ligarPrimeJanela`.
 */
function destruir(): void {
  if (!view) return;
  if (paiDaView && !paiDaView.isDestroyed()) {
    try {
      paiDaView.contentView.removeChildView(view);
    } catch {
      // Janela já fechada: a view morreu com ela.
    }
  }
  paiDaView = null;
  if (!view.webContents.isDestroyed()) view.webContents.close();
  view = null;
  paginaAtual = { url: '', titulo: '', isTitulo: false };
}

/**
 * Abre uma janela para o login da Amazon, na **mesma sessão** da view do Prime.
 *
 * ## O que estava errado
 *
 * O `setWindowOpenHandler` mandava toda URL permitida para `shell.openExternal`.
 * A login da Amazon acontece em parte numa janela separada, com formulário e POST.
 * Mandar essa URL para o navegador do sistema significa que o POST vai para o
 * Chrome — e a sessão que completa o login é a do Chrome. A sessão
 * `persist:juntos-prime` continua deslogada, a view volta para o Prime pedindo
 * login de novo, e a pessoa entra num ciclo.
 *
 * Não é um detalhe de implementação: é o passo "login na conta própria" inteiro
 * quebrado, e ele é o que o modelo do Rave promete — *"you can sign in to that
 * account in Rave"*.
 *
 * ## Por que deixar o Electron criar
 *
 * `action: 'allow'` deixa o Chromium abrir a janela, e o Electron herda a
 * `webPreferences` do pai. `partition` está explícita em `overrideBrowserWindowOptions`
 * de propósito: é ela que garante que o POST e os cookies do login caiam na
 * sessão do Prime, e confiar na herança seria confiar num detalhe de versão.
 *
 * `parent` faz a janela ser filha da principal: ela fica agrupada na barra de
 * tarefas e na frente, em vez de sumir atrás do app.
 */
function opcoesDaJanelaDeLogin(janela: BrowserWindow | null) {
  const base = janela && !janela.isDestroyed() ? janela.getBounds() : null;
  const largura = 460;
  const altura = 620;
  return {
    title: 'Entrar no Prime Video',
    width: largura,
    height: altura,
    /*
     * Sem `useContentSize`: o `width`/`height` acima são da **janela**, e o
     * conteúdo fica menor que isso por causa da borda. Centralizar pelo tamanho
     * da janela punha a janela do login um pouco acima e à esquerda do centro da
     * tela, e o deslocamento era visível a cada login.
     */
    ...(base
      ? { x: Math.round(base.x + (base.width - largura) / 2), y: Math.round(base.y + (base.height - altura) / 3) }
      : {}),
    parent: janela ?? undefined,
    modal: false,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      /*
       * A mesma partição da view do Prime. É a linha inteira que faz o login
       * funcionar: o `POST` do formulário e os cookies que a Amazon grava
       * precisam cair em `persist:juntos-prime`, e não na sessão do navegador do
       * sistema.
       */
      partition: PARTICAO,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  } as const;
}

/**
 * Filtro de navegação, para **todo** WebContents da partição do Prime.
 *
 * ## Por que um `app.on('web-contents-created')` e não só na view
 *
 * A view principal tem o seu próprio `will-navigate`. A janela de login, não:
 * ela é criada pelo Chromium, e um filtro preso à view não alcança o que nasce
 * dentro dela. Sem este gancho, a janela de login navegaria para o que
 * quisesse — inclusive para uma página que imitasse a Amazon e trouxesse a
 * pessoa a digitar a senha num lugar que não é a Amazon, dentro de um app que
 * tem cara de app confiável.
 *
 * O gancho dispara para cada `webContents` criado no processo, e o filtro é
 * aplicado só aos que estão na partição do Prime. Uma view de terceiro outro
 * qualquer no mesmo app não é tocada por ele.
 */
function instalarFiltroDeNavegacao(): void {
  app.on('web-contents-created', (_evento, wc) => {
    if (wc.getURL().startsWith('data:')) return;
    const ehDoPrime = wc.session === session.fromPartition(PARTICAO);
    if (!ehDoPrime) return;
    wc.on('will-navigate', (evento, url) => {
      const u = normalizar(url);
      if (u) return;
      evento.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    });
  });
}

function abrir(janela: BrowserWindow | null, bounds: PrimeBounds): boolean {
  if (!janela || janela.isDestroyed()) return false;

  if (!view) {
    session.fromPartition(PARTICAO).setUserAgent(USER_AGENT);

    /*
     * Sem preload, sem Node, em sandbox. O conteúdo é de terceiro e não
     * conversa com o app: a única ponte são os canais IPC abaixo, e nenhum
     * deles entrega o que a sessão do Prime guarda.
     */
    view = new WebContentsView({
      webPreferences: {
        partition: PARTICAO,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    /*
     * Popup do Prime — login em janela separada, avisos de conta — vai para o
     * navegador do sistema. Deixar o `default` criaria uma `BrowserWindow`
     * sem nenhum destes ajustes, e a pessoa perderia o foco do Juntos no meio
     * do login.
     */
    view.webContents.setWindowOpenHandler(({ url }) => {
      const u = normalizar(url);
      if (!u) {
        /*
         * Fora dos domínios permitidos, o navegador do sistema. Um popup de
         * anúncio ou de terceiro não pode ficar dentro do app com a cara dele.
         */
        if (/^https?:/.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
      }
      /*
       * Login. A janela é criada aqui, na MESMA sessão da view -- o que é o
       * ponto inteiro: a sessão que completa o login tem de ser a
       * `persist:juntos-prime`, e não a do navegador do sistema.
       *
       * Ver `opcoesDaJanelaDeLogin`.
       */
      return {
        action: 'allow',
        overrideBrowserWindowOptions: opcoesDaJanelaDeLogin(dona),
      };
    });

    /*
     * Navegação fora dos domínios permitidos também vai para o navegador. Não
     * é bloqueio: é para a pessoa não ficar presa numa tela do Prime sem barra
     * de endereço, sem volta e sem saber que saiu do app.
     */
    //
    // A navegação fora dos domínios é filtrada por
    // `instalarFiltroDeNavegacao`, que alcança esta view e a janela de login.
    // Aqui não há um segundo filtro: a mesma regra em dois lugares diverge,
    // e ninguém descobre qual delas está errada.

    view.webContents.on('did-navigate', publicar);
    view.webContents.on('did-navigate-in-page', publicar);

    janela.contentView.addChildView(view);
    paiDaView = janela;
    /*
     * Nenhum `loadURL` aqui.
     *
     * O destino é do renderer, que sabe se há um título escolhido ou se a
     * pessoa só abriu o catálogo. Carregar a home aqui e deixar a faixa
     * carregar o título em seguida são dois `loadURL` em sequência, e o
     * primeiro chega a aparecer: um flash da home do Prime a cada troca de
     * faixa, exatamente quando a pessoa está esperando o filme.
     */
  }

  try {
    /*
     * O retângulo vai na própria view, e não em `contentView`.
     *
     * `contentView` é a raiz da hierarquia: `setBounds` nela move a raiz, e não
     * o filho. Quem posiciona a view do Prime é `view.setBounds`, que é o mesmo
     * método que o `main` usaria se a view estivesse no lugar.
     */
    view.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  } catch {
    return false;
  }
  /*
   * Sem `setVisible`: a view nasce visível, e o que a esconde é removê-la.
   * Se existisse um `setVisible(false)` em algum lugar, a view ficaria fora
   * da tela e ainda dentro do hit-test — que é o pior defeito possível num
   * app com view nativa sobreposta.
   */
  return true;
}

/**
 * Este build do Electron decifra vídeo protegido?
 *
 * `requestMediaKeySystemAccess` pergunta ao motor, não ao site. A resposta
 * `false` é definitiva: o build oficial do Electron não embarca o CDM do
 * Widevine, e nenhum título protegido toca dentro do app. A `true` é só o
 * mínimo — a Prime Video ainda pode recusar na hora de tocar, por causa da
 * checagem de caminho verificado (VMP), que é do lado do Prime e não aparece
 * nesta pergunta. Por isso a UI nunca promete que vai tocar.
 *
 * ## Por que uma view própria para a pergunta
 *
 * A pergunta vai para um `data:` URL, e não para a página do Prime. Rodar
 * `executeJavaScript` dentro da view seria injeção no DOM de um site de
 * terceiro, que é exatamente o que esta integração não faz. Uma view
 * descartável, sem preload e sem a sessão do Prime, responde a mesma coisa sem
 * tocar no Prime.
 */
function temDrm(): Promise<boolean> {
  return new Promise((resolve) => {
    let sondagem: WebContentsView;
    try {
      sondagem = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
    } catch {
      resolve(false);
      return;
    }

    let respondeu = false;
    const responder = (valor: boolean) => {
      // `loadURL` pode disparar `did-finish-load` e o timeout na mesma volta;
      // sem esta guarda a `close()`rodaria duas vezes e a segunda jogaria.
      if (respondeu) return;
      respondeu = true;
      if (!sondagem.webContents.isDestroyed()) sondagem.webContents.close();
      resolve(valor);
    };

    sondagem.webContents.once('did-finish-load', () => {
      sondagem
        .webContents.executeJavaScript(
          `navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'] }])` +
            `.then(() => true).catch(() => false)`,
        )
        .then((v) => responder(v === true))
        .catch(() => responder(false));
    });

    // Nada carregou: sem resposta, `false` é a resposta honesta.
    sondagem.webContents.once('did-fail-load', () => responder(false));
    setTimeout(() => responder(false), 4000);

    void sondagem.webContents.loadURL('data:text/html,<title>sonda</title>');
  });
}

/**
 * Registra os canais IPC do Prime. Uma vez só, junto do resto.
 *
 * ## Por que não dentro de `ligarPrimeJanela`
 *
 * `criarJanela` roda de novo no `activate` do macOS, e `ipcMain.handle`
 * lança quando o mesmo canal é registrado duas vezes. Se a assinatura morasse
 * aí, a segunda janela derrubaria o app inteiro em vez de apenas abrir.
 */
export function registrarIpcPrime(): void {
  instalarFiltroDeNavegacao();
  /*
   * A janela vem do `sender`, e não da variavel global.
   *
   * Com mais de uma janela, o `prime:abrir` da uma acabaria posicionando a
   * view da outra — e o sintoma é a Prime aparecendo na janela errada, que
   * ninguém sabe explicar. `fromWebContents` é o caminho que não depende de
   * qual janela foi criada por último.
   */
  ipcMain.handle('prime:abrir', (evento, bounds: PrimeBounds) =>
    abrir(BrowserWindow.fromWebContents(evento.sender), bounds),
  );

  ipcMain.handle('prime:fechar', () => {
    destruir();
    return true;
  });

  ipcMain.handle('prime:navegar', (_e, url: unknown) => {
    if (!view || view.webContents.isDestroyed()) return false;
    const u = normalizar(url);
    if (!u) return false;
    void view.webContents.loadURL(u.toString());
    return true;
  });

  ipcMain.handle('prime:pagina', () => paginaAtual);

  ipcMain.handle('prime:tem-drm', () => temDrm());
}

/** Liga a view a uma janela. Pode rodar mais de uma vez, uma por janela. */
export function ligarPrimeJanela(janela: BrowserWindow): void {
  dona = janela;
  janela.on('closed', () => {
    if (dona === janela) {
      destruir();
      dona = null;
    }
  });

  /*
   * A view é REMOVIDA do `contentView` quando o Prime sai, e nunca apenas
   * escondida.
   *
   * `setVisible(false)` desliga a renderização, mas a view continua filha do
   * `contentView` e continua entrando no hit-test do Chromium. O sintoma é o
   * pior possível para quem está usando: a tela mostra o vídeo de outra pessoa
   * e os cliques no chat, no cabeçalho e nos controles vão para o Prime, sem
   * nenhum sintoma visual que explique. Remover é o que fecha isso.
   *
   * O `blur` então não tem mais o que esconder — e é por isso que ele sumiu:
   * esconder no blur era a metade do problema acima.
   */
  log(`prime: view ligada na janela ${janela.id}`);
}

/** A view existe agora? */
export function temViewPrime(): boolean {
  return view !== null && !view.webContents.isDestroyed();
}
