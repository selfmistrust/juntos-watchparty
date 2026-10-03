import { BrowserWindow, WebContentsView, app, ipcMain, session, shell } from 'electron';
import { log } from './log';
import { urlDeTitulo, validarUrlPrime } from '../shared/dominioPrime';
import type { PrimeBounds, PrimePage } from '../shared/contract';

/**
 * A Prime Video dentro do Junto, como `WebContentsView`.
 *
 * ## O que esta integração é, e o que ela não é
 *
 * É um navegador apontado para `primevideo.com`, do mesmo jeito que a aba que a
 * pessoa já teria aberta. Login, catálogo, busca e escolha de título acontecem
 * na página oficial da Amazon, com a conta de quem está usando.
 *
 * Não há leitura de cookie, captura de token, leitura de manifesto de vídeo,
 * armazenamento de chave de DRM nem proxy do stream. O vídeo chega no aparelho
 * de cada pessoa direto do Prime Video, e o nosso servidor não participa.
 *
 * ## As duas URLs, e por que elas não podem ser a mesma
 *
 *   navegação   a URL **integral**, com tudo. É o que o Chromium carrega e o que
 *               continua um login: query e âncora são o estado do fluxo OpenID.
 *   mídia       a URL canônica do **título**, sem query. É o que vai para a fila
 *               e para os outros participantes.
 *
 * A versão anterior tinha uma função só, que decidia se a URL era válida e ao
 * mesmo tempo apagava a query. Duas responsabilidades, e a segunda destruía a
 * primeira: uma URL de signin OpenID perdia `openid.sig` e `openid.return_to`, e
 * o login nunca completava dentro do app.
 *
 * A separação está em `shared/dominioPrime.ts` — `validarUrlPrime` e
 * `urlDeTitulo` — e ela é respeitada aqui em todos os quatro lugares por onde uma
 * URL passa: `will-navigate`, `setWindowOpenHandler`, `prime:navegar` e a
 * descrição da página.
 */

/** Sessão dedicada, separada da `defaultSession` do app. */
const PARTICAO = 'persist:juntos-prime';

/**
 * Tamanho máximo de `pathname` no log.
 *
 * O log é diagnóstico, e um `pathname` de 4 KB numa linha de log não ajuda
 * ninguém: a informação que interessa é a forma, não o comprimento. O teto
 * segura o log sem cortar o que foi pedido.
 */
const PATHNAME_NO_LOG = 200;

let view: WebContentsView | null = null;
/** A janela dona da view. Só muda quando a janela fecha. */
let dona: BrowserWindow | null = null;
/**
 * A janela em que a view foi de fato adicionada como filha.
 *
 * Separado de `dona` porque `removeChildView` precisa ser chamado no mesmo pai
 * onde `addChildView` foi chamado. Remover no pai errado deixa a view órfã
 * dentro de uma janela que já não é a dela.
 */
let paiDaView: BrowserWindow | null = null;
/**
 * Última página, já na forma segura: a URL só existe preenchida quando é um
 * título, e nunca contém query.
 *
 * Note o que **não** mora em variável nenhuma aqui: a URL de navegação integral,
 * com os parâmetros OpenID. Ela vive só no Chromium. Não é preciso guardar — e
 * guardar seria guardar estado de autenticação em memória por um motivo que não
 * existe, já que `webContents.getURL()` devolve o valor atual a qualquer momento.
 */
let paginaAtual: PrimePage = { url: '', titulo: '', isTitulo: false };

/**
 * Registro de diagnóstico do fluxo de login.
 *
 * ## O que entra, e por que é exatamente isso
 *
 *   evento        o que aconteceu
 *   host          o domínio — a regra de domínio é daqui que se decide
 *   path          o caminho, truncado
 *   len           o tamanho da URL
 *   query         se há query
 *   popup         se veio de um `window.open`
 *
 * ## O que nunca entra
 *
 * A query. Ela é o estado do fluxo OpenID: `openid.sig`, `openid.signed`,
 * `openid.assoc_handle` e `location` carregam material de autenticação. Um log
 * com a query completa é um log com credencial de sessão — e o log de um app
 * desktop é o que a pessoa cola num relatório de bug.
 *
 * A função recebe a string crua, extrai só o que pode extrair, e **não** tem como
 * registrar a query: o que ela concatena é o resultado do parse, e a query não
 * está no resultado.
 */
function registrar(evento: string, cru: string, popup = false): void {
  const u = validarUrlPrime(cru);
  const caminho = u ? u.pathname.slice(0, PATHNAME_NO_LOG) : '-';
  log(
    `[prime] ${evento} host=${u ? u.hostname : '-'} path=${caminho} ` +
      `len=${cru.length} query=${u ? u.search !== '' : false} popup=${popup}`,
  );
}

/**
 * Descreve a página que a view está mostrando, na forma segura.
 *
 * `getURL()` é o estado de navegação do próprio Chromium, e `getTitle()` é o que
 * o Prime já escreve na aba do navegador. Nenhum dos dois é leitura de DOM, e é por
 * isso que não dependem de classe nem de seletor do site.
 *
 * O que sai daqui para o renderer é **só** a URL de mídia, e ela só existe se a
 * página for de um título.
 */
function descrever(): PrimePage {
  if (!view || view.webContents.isDestroyed()) return { url: '', titulo: '', isTitulo: false };
  const cru = view.webContents.getURL();
  const u = validarUrlPrime(cru);
  if (!u) return { url: '', titulo: '', isTitulo: false };
  const midia = urlDeTitulo(u);
  return {
    url: midia,
    titulo: view.webContents.getTitle(),
    // `urlDeTitulo` devolve vazio fora de uma página de título, e é esse
    // vazio que torna as duas coisas a mesma informação.
    isTitulo: midia !== '',
  };
}

/** Avisa o renderer da mudança de página e guarda a última para quem perguntar depois. */
function publicar(evento: string): void {
  if (!view || view.webContents.isDestroyed()) return;
  const cru = view.webContents.getURL();
  registrar(evento, cru);
  paginaAtual = descrever();
  for (const wc of BrowserWindow.getAllWindows()) {
    if (!wc.isDestroyed()) wc.webContents.send('prime:pagina-mudou', paginaAtual);
  }
}

/**
 * Remove a view do `contentView` e fecha a página.
 *
 * `dona` **não** é zerada aqui: quem fecha a view é a pessoa, e a janela continua
 * sendo a dona dela. Zerar a janela aqui fazia `prime:abrir` receber `null` na vez
 * seguinte, e o Prime não abria mais pelo resto da sessão.
 *
 * ## Por que remover, e não esconder
 *
 * `setVisible(false)` desliga a renderização, mas a view continua filha do
 * `contentView` e continua entrando no hit-test do Chromium. O sintoma é invisível
 * na tela e aparece como clique perdido: o chat, o cabeçalho e os controles
 * param de responder enquanto o vídeo de outra pessoa toca.
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
  log('[prime] view fechada');
}

/**
 * Abre uma janela para o login da Amazon, na **mesma sessão** da view do Prime.
 *
 * ## O que estava errado
 *
 * O `setWindowOpenHandler` mandava toda URL permitida para `shell.openExternal`.
 * O login da Amazon acontece em parte numa janela separada, com formulário e POST.
 * Mandar essa URL para o navegador do sistema significa que o POST vai para o
 * Chrome — e a sessão que completa o login é a do Chrome. A `persist:juntos-prime`
 * continua deslogada, a view pede login de novo, e a pessoa entra num ciclo.
 *
 * ## A URL não é tocada
 *
 * `overrideBrowserWindowOptions` não recebe URL nenhuma: o Chromium navega o
 * popup para o endereço que ele próprio produziu. Reescrever essa URL aqui seria
 * reescrever o estado do fluxo OpenID.
 */
function opcoesDaJanelaDeLogin(janela: BrowserWindow | null) {
  const base = janela && !janela.isDestroyed() ? janela.getBounds() : null;
  const largura = 460;
  const altura = 620;
  return {
    title: 'Entrar no Prime Video',
    width: largura,
    height: altura,
    ...(base
      ? {
          x: Math.round(base.x + (base.width - largura) / 2),
          y: Math.round(base.y + (base.height - altura) / 3),
        }
      : {}),
    parent: janela ?? undefined,
    modal: false,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      /*
       * A mesma partição da view do Prime. É a linha inteira que faz o login
       * funcionar: o POST do formulário e os cookies que a Amazon grava precisam
       * cair em `persist:juntos-prime`, e não na sessão do navegador do sistema.
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
 * ## Só decide; nunca reescreve
 *
 * O `will-navigate` recebe um evento com uma decisão: deixa passar, ou cancela.
 * Não existe "deixa passar mas com outra URL" — e é por isso que o cancelamento
 * precisa ser a única forma de recusar. Reescrever a URL exigiria chamar
 * `loadURL` no lugar, e aí estariam dois pedidos de navegação em voo, com
 * o OpenID do segundo competindo com o do primeiro.
 *
 * ## Por que o gancho global, e não só a view
 *
 * A janela de login é criada pelo Chromium, e um filtro preso à view não alcança o
 * que nasce dentro dela. Sem este gancho, ela navegaria para o que quisesse —
 * inclusive para uma página que imitasse a Amazon e trouxesse a pessoa a digitar a
 * senha num lugar que não é a Amazon, dentro de um app que tem cara de app
 * confiável.
 */
function instalarFiltroDeNavegacao(): void {
  app.on('web-contents-created', (_evento, wc) => {
    if (wc.getURL().startsWith('data:')) return;
    if (wc.session !== session.fromPartition(PARTICAO)) return;
    wc.on('will-navigate', (evento, url) => {
      // Valida só o domínio. A URL que o Chromium vai usar é a que ele recebeu.
      if (validarUrlPrime(url)) return;
      registrar('navegacao bloqueada', url);
      evento.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    });
  });
}

function abrir(janela: BrowserWindow | null, bounds: PrimeBounds): boolean {
  if (!janela || janela.isDestroyed()) return false;

  if (!view) {
    const sessao = session.fromPartition(PARTICAO);
    /*
     * Sem `setUserAgent`.
     *
     * A versão anterior mandava um UA fixo de `Chrome/130.0.0.0`. Ele não é
     * necessariamente o Chromium que está rodando — o Electron 33 embarca outro
     * — e um UA que não bate com o motor faz a Amazon responder com uma variante
     * de página diferente, que é indistinguível de "o Prime não funciona aqui".
     *
     * Sem override, o Chromium manda o UA dele, que é o único que ele consegue
     * honour. Este é um teste: se o login funcionar assim, a linha volta a ser
     * um problema a investigar, e não antes.
     */
    log(`[prime] sessao criada sem override de UA (${sessao.getUserAgent().slice(0, 120)})`);

    /*
     * Sem preload, sem Node, em sandbox. O conteúdo é de terceiro e não conversa
     * com o app: a única ponte são os canais IPC abaixo, e nenhum deles entrega o
     * que a sessão do Prime guarda.
     */
    view = new WebContentsView({
      webPreferences: {
        partition: PARTICAO,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (!validarUrlPrime(url)) {
        /*
         * Fora dos domínios permitidos, o navegador do sistema. Um popup de
         * anúncio ou de terceiro não pode ficar dentro do app com a cara dele.
         */
        registrar('popup bloqueado', url, true);
        if (/^https?:/.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
      }
      /*
       * Login. A janela é criada aqui, na MESMA sessão da view — o ponto inteiro.
       * E a URL não é passada nem reescrita: `action: 'allow'` entrega ao Chromium
       * o endereço que ele produziu, com a query OpenID intacta.
       */
      registrar('popup permitido', url, true);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: opcoesDaJanelaDeLogin(dona),
      };
    });

    /*
     * A navegação fora dos domínios é filtrada por `instalarFiltroDeNavegacao`,
     * que alcança esta view e a janela de login. Aqui não há um segundo filtro:
     * a mesma regra em dois lugares diverge, e ninguém descobre qual está errada.
     */
    view.webContents.on('did-navigate', () => publicar('navegou'));
    view.webContents.on('did-navigate-in-page', () => publicar('navegou na pagina'));

    janela.contentView.addChildView(view);
    paiDaView = janela;
    log(`[prime] view criada na particao ${PARTICAO}`);

    /*
     * Nenhum `loadURL` aqui.
     *
     * O destino é do renderer, que sabe se há um título escolhido ou se a pessoa
     * só abriu o catálogo. Carregar a home aqui e deixar a faixa carregar o título
     * em seguida são dois `loadURL` em sequência, e o primeiro chega a aparecer.
     */
  }

  try {
    /*
     * O retângulo vai na própria view, e não em `contentView`.
     *
     * `contentView` é a raiz da hierarquia: `setBounds` nela move a raiz, e não o
     * filho. Quem posiciona a view do Prime é `view.setBounds`.
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
   */
  return true;
}

/**
 * Este build do Electron decifra vídeo protegido?
 *
 * A pergunta vai para o motor, e não para o site, numa view descartável em
 * `data:`. Rodar `executeJavaScript` na view do Prime seria injeção no DOM de um
 * site de terceiro, que é o que esta integração não faz.
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

    sondagem.webContents.once('did-fail-load', () => responder(false));
    setTimeout(() => responder(false), 4000);

    void sondagem.webContents.loadURL('data:text/html,<title>sonda</title>');
  });
}

/** Registra os canais IPC do Prime. Uma vez só, junto com o resto. */
export function registrarIpcPrime(): void {
  instalarFiltroDeNavegacao();

  /*
   * A janela vem do `sender`, e não de uma variável global.
   *
   * Com mais de uma janela, o `prime:abrir` da uma acabaria posicionando a view da
   * outra — e o sintoma é a Prime aparecendo na janela errada.
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
    /*
     * A URL **integral**, com query e âncora.
     *
     * `validarUrlPrime` devolve o que o renderer mandou, e nada é removido: se
     * algum dia esta rota for chamada com uma URL de signin, ela precisa chegar
     * inteira até o Chromium. Usar aqui a versão canônica do título — que é o
     * que `urlDeTitulo` produz — é o erro que `dominioPrime.ts` avisa em
     * maiúsculas, e ele custaria o login de novo.
     */
    // A validação já recusa o que não é string; o que precisa de um texto
    // próprio é o log, e `len=undefined` num diagnóstico não ajuda ninguém.
    const cru = typeof url === 'string' ? url : '';
    const u = validarUrlPrime(url);
    if (!u) {
      registrar('navegar recusado', cru);
      return false;
    }
    registrar('navegar', cru);
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

  log(`[prime] view ligada na janela ${janela.id}`);
}

/** A view existe agora? */
export function temViewPrime(): boolean {
  return view !== null && !view.webContents.isDestroyed();
}
