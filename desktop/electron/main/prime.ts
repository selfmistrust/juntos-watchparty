import { BrowserWindow, WebContentsView, app, ipcMain, session, shell, type Session, type WebContents } from 'electron';
import { createServer } from 'node:http';
import { log } from './log';
import {
  ehDominioPermitido,
  ehMesmoRetangulo,
  ehRotaDeAutenticacao,
  retanguloDeAutenticacao,
  rotaDeAutenticacao,
  urlDeTitulo,
  validarUrlPrime,
} from '../shared/dominioPrime';
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

/* ---------------------------------------------------------------------------
 * Onde a view fica.
 * ------------------------------------------------------------------------ */

/**
 * A área do player, como o renderer mediu.
 *
 * `null` enquanto ninguém mandou. O renderer manda em `prime:abrir`, que dispara
 * na montagem do palco, em cada `resize` da janela e em cada mudança do
 * `ResizeObserver` do palco — que é o que cobre arrastar a divisória, abrir e
 * fechar o painel lateral, e entrar e sair de tela cheia.
 *
 * Guardar o último valor é o que permite ao `main` reposicionar a view sozinho,
 * nos eventos de janela que ele enxerga e o renderer não. Sem isto, o `main`
 * só saberia se mover quando alguém perguntasse.
 */
let areaDoPlayer: PrimeBounds | null = null;

/** A view está mostrando uma tela de login da conta Amazon? */
let modoAutenticacao = false;

/**
 * O último retângulo aplicado, para não repetir trabalho idêntico.
 *
 * `resize` dispara dezenas de vezes por segundo durante um arrasto de janela, e
 * `setBounds` a cada um deles é compositor trabalhando à toa. Serve também para
 * o log: uma linha por mudança real é legível; uma por quadro não é.
 */
let retanguloAplicado: PrimeBounds | null = null;

/** A última linha de layout registrada, para a mesma razão de `retanguloAplicado`. */
let layoutRegistrado: string | null = null;

/**
 * Onde a tela de login vai ficar, dentro da área do player.
 *
 * Uma função só, e é ela quem decide entre os dois modos. A versão anterior
 * aplicava o retângulo que o renderer mandava, sem olhar a página: a área do
 * player é de ~1900 pixels numa janela maximizada, e o formulário da Amazon é
 * desenhado para uma janela de navegador comum. O resultado era o formulário
 * inteiro na borda direita, fora do campo de visão.
 *
 * Três coisas ela considera, e as três vêm de lugares diferentes:
 *
 *   a área            do renderer, que é quem vê o painel, a divisória e a faixa
 *   a rota atual      do Chromium, via `getURL()` — é a rota que diz se a
 *                     página é um formulário estreito
 *   o zoom            do próprio `webContents`, garantido em 1
 *
 * ## Por que nada aqui recarrega a página
 *
 * `setBounds` reposiciona a view. Não navega, não recria nada, não toca em
 * cookie, e não passa nada pelo `loadURL`. É a operação de menor consequência
 * disponível: muda o retângulo, o `layout` do documento recalcula, e o POST do
 * formulário — que é o que completa o login — segue intacto.
 *
 * Este é o ponto que não pode ser negociado. A versão anterior do login falhava
 * porque uma URL OpenID longa era barrada na validação e o POST ia para o
 * navegador do sistema; qualquer "correção" de layout que reabra um caminho de
 * navegação traz o defeito de volta por outro nome.
 */
function updatePrimeBounds(): void {
  if (!view || view.webContents.isDestroyed()) return;
  if (!areaDoPlayer) return;

  const urlAtual = validarUrlPrime(view.webContents.getURL());
  const rota = rotaDeAutenticacao(urlAtual);
  const autenticando = ehRotaDeAutenticacao(urlAtual);

  /*
   * Zoom em 1, sempre.
   *
   * Nada no app mexe em zoom hoje, e o padrão do Chromium já é 1 — esta linha é
   * o que garante que continue sendo. Ela existe por duas razões, e as duas são
   * sobre o futuro:
   *
   *   um dia algum outro lugar decidir aplicar zoom para "ler melhor" o catálogo
   *   e herdar o valor na tela de login, onde o formulário é o oposto de uma
   *   tela para ler;
   *   e a pessoa apertar Ctrl+ e Ctrl- dentro da view, que grava o zoom no
   *   perfil da sessão `persist:juntos-prime`, e esse perfil sobrevive ao fechar o
   *   app. Um dia ela aperta Ctrl- para ver o catálogo melhor, e na volta o login
   *   nasce a 80%.
   *
   * Comparar antes evita uma chamada a cada `resize`.
   */
  const zoom = view.webContents.getZoomFactor();
  if (zoom !== 1) view.webContents.setZoomFactor(1);

  const destino = autenticando ? retanguloDeAutenticacao(areaDoPlayer) : areaDoPlayer;

  const mudouBounds = !ehMesmoRetangulo(retanguloAplicado, destino);
  const mudouModo = modoAutenticacao !== autenticando;

  if (mudouBounds) {
    /*
     * O retângulo vai na própria view, e não em `contentView`.
     *
     * `contentView` é a raiz da hierarquia: `setBounds` nela move a raiz, e não o
     * filho. Quem posiciona a view do Prime é `view.setBounds`.
     */
    try {
      view.setBounds(destino);
      retanguloAplicado = destino;
    } catch {
      // Janela fechada no meio do `setBounds`: não há mais para onde aplicar.
      return;
    }
  }

  modoAutenticacao = autenticando;

  if (!mudouBounds && !mudouModo) return;

  const linha =
    `[prime] layout authMode=${autenticando} rota=${rota || '-'} ` +
    `pathname=${urlAtual ? urlAtual.pathname.slice(0, PATHNAME_NO_LOG) : '-'} ` +
    `bounds={${destino.x},${destino.y},${destino.width},${destino.height}} ` +
    `area={${areaDoPlayer.x},${areaDoPlayer.y},${areaDoPlayer.width},${areaDoPlayer.height}} ` +
    `zoomFactor=${zoom !== 1 ? 1 : zoom} ` +
    `modo=${autenticando ? 'caixa' : 'area toda'}`;
  if (linha !== layoutRegistrado) {
    layoutRegistrado = linha;
    log(linha);
  }
}

/**
 * Esquece a área conhecida.
 *
 * Sem isto, quem abrir o Prime numa sessão nova receberia o retângulo da sessão
 * anterior — que é o de outra janela, em outra posição na tela. O sintoma é a
 * view aparecendo deslocada em um canto, sem nada do nosso embaixo.
 */
function esquecerArea(): void {
  areaDoPlayer = null;
  retanguloAplicado = null;
  layoutRegistrado = null;
  modoAutenticacao = false;
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
  //
  // A rota acabou de mudar, e é ela que decide o tamanho da view: o login da
  // Amazon entra numa caixa de 650 pixels e o catálogo volta a preencher a área.
  updatePrimeBounds();
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
  esquecerArea();
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


/* ---------------------------------------------------------------------------
 * Diagnóstico do player.
 * ------------------------------------------------------------------------ */

/**
 * Palavras que marcam uma linha de log como sobre DRM.
 *
 * A lista é das duas pontas: o nome do key system e do CDM, e o nome dos erros
 * que o Chromium e o player do Prime usam quando o DRM falha. `MEDIA_ERR` entra
 * porque é assim que o `HTMLMediaElement` nomeia erro de decodificação — o
 * `MEDIA_ERR_DECODE` (3) e o `MEDIA_ERR_SRC_NOT_SUPPORTED` (4) são os dois
 * códigos que aparecem quando o stream não abre.
 *
 * Case-insensitive, e comparada com `includes`. A lista é sobre o **conteúdo**
 * da mensagem, não sobre a origem dela: qualquer script do site pode escrever no
 * console, e o filtro é o que impede um log de 300 linhas de `console.debug` do
 * player.
 */
const PALAVRAS_DE_DRM = [
  'widevine',
  'mediakeysystem',
  'media key',
  'eme',
  'cdm',
  'drm',
  'license',
  'notsupportederror',
  'notallowederror',
  'quotaexceedederror',
  'securityerror',
  'unsupported',
  'decrypt',
  'media_err',
  'src_not_supported',
  'encrypted',
];

/**
 * O que pode entrar no log de uma linha vinda do site.
 *
 * ## O corte não é decorativo
 *
 * O `console.error` de um player de vídeo carrega o objeto de erro inteiro, e o
 * objeto de erro do EME carrega, em `message`, coisas que descrevem a tentativa de
 * decifrar. Um log de bug é o que a pessoa cola num relatório, e um relatório
 * com material de DRM num arquivo de texto é um vazamento que dura mais que o
 * app.
 *
 * Por isso: 300 caracteres, e **qualquer sequência longa e sem espaços vira
 * `…`**. Licenças são base64, `message` de erro do Widevine costuma ser hex, e
 * ambos são a mesma forma: uma parede de caracteres sem espaço. Isso corta o
 * conteúdo e preserva a frase que explica o erro.
 */
const CARACTERES_NO_LOG = 300;

/** Redige uma mensagem vinda do site: corta, e achata blocos sem espaços. */
function redigir(texto: unknown): string {
  const bruto = typeof texto === 'string' ? texto : String(texto ?? '');
  const achatado = bruto
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  return achatado.length > CARACTERES_NO_LOG
    ? `${achatado.slice(0, CARACTERES_NO_LOG)}…`
    : achatado;
}

/** O script que escreveu a linha, sem caminho nem query. */
function origemDaLinha(sourceId: unknown): string {
  if (typeof sourceId !== 'string' || sourceId === '') return '-';
  try {
    const u = new URL(sourceId);
    // `blob:` e `data:` não têm host; o prefixo do esquema basta para saber de
    // onde veio, e o resto do endereço não é necessário para o diagnóstico.
    return u.origin === 'null' ? `${u.protocol}//…` : u.origin;
  } catch {
    return '-';
  }
}

/**
 * Ouve o console da view do Prime, e registra só o que for sobre DRM.
 *
 * ## O que isto NÃO é
 *
 * Não é leitura de DOM, não é injeção, e não altera nada na página: o
 * `console-message` é um evento do processo principal sobre algo que o renderer
 * já imprimiu por conta própria. Nenhum `executeJavaScript`, nenhum
 * `insertCSS`, nenhum `debugger` — este último em especial está de fora **por
 * escolha**, e o comentário abaixo diz por quê.
 *
 * ## Por que o `debugger` ficou de fora
 *
 * `webContents.debugger` veria `Network.requestWillBeSentExtraInfo` da
 * requisição de licença, e o corpo dessa requisição **é a mensagem de
 * solicitação de licença**. A instrumentação que resolveria o diagnóstico com
 * precisão máxima é a mesma que colocaria credencial de DRM no disco. O que
 * sobrar do diagnóstico tem de ser suficiente sem ela.
 */
function diagnosticarPlayer(wc: WebContents): void {
  wc.on('console-message', (...args: unknown[]) => {
    /*
     * Electron 33 entrega `(evento, level, mensagem, linha, sourceId)`. As
     * versões mais novas trocam por um objeto `details`, e o app não deve quebrar
     * quando o Electron subir: se o segundo argumento for objeto, é o `details`.
     */
    const segundo = args[1];
    if (segundo !== null && typeof segundo === 'object') {
      const d = segundo as { level?: unknown; message?: unknown; sourceId?: unknown };
      registrarLinhaDoPlayer(d.message, d.level, d.sourceId);
      return;
    }
    registrarLinhaDoPlayer(args[2], args[1], args[4]);
  });
}

function registrarLinhaDoPlayer(mensagem: unknown, level: unknown, sourceId: unknown): void {
  const texto = typeof mensagem === 'string' ? mensagem : String(mensagem ?? '');
  if (texto === '') return;

  const minuscula = texto.toLowerCase();
  if (!PALAVRAS_DE_DRM.some((p) => minuscula.includes(p))) return;

  log(`[prime] player ${redigir(texto)} nivel=${String(level)} origem=${origemDaLinha(sourceId)}`);
}

/* ---------------------------------------------------------------------------
 * Permissões da partição do Prime.
 * ------------------------------------------------------------------------ */

/**
 * O que a view do Prime pode pedir.
 *
 * ## Por que uma lista, e não "o padrão do Electron"
 *
 * A partição **não** tinha handler nenhum: a política era a do Electron para
 * sessão sem handler, e a do `defaultSession` (que libera `display-capture`,
 * `media` e `fullscreen`) **não** valia aqui — `setPermissionRequestHandler` é por
 * sessão, e a do Prime nunca recebeu nada.
 *
 * Registrar um handler para tratar `mediaKeySystem` significa escolher a política
 * das outras permissões junto, porque não existe "delegar ao padrão": o handler
 * registrado é a política. Deixar isso implícito seria trocar uma dependência de
 * comportamento não documentado por outra — desta vez *dentro do nosso código*,
 * que é onde dá para ler.
 *
 * Por isso a lista é explícita, e o que não está nela é **recusado**. O que
 * entrou é o que o site do Prime precisa para funcionar, e nada além:
 *
 *   fullscreen, automatic-fullscreen  o botão de tela cheia do player
 *   media                             áudio e vídeo de entrada, para preview
 *   clipboard-sanitized-write         copiar texto, sem ler a área de transferência
 *   persistent-storage, background-fetch, background-sync
 *                                     o que o site guarda entre visitas
 *
 * E o que **não** entrou e é recusado por omissão: `geolocation`, `notifications`,
 * `hid`, `usb`, `serial`, `bluetooth`, `midi`, `payment-handler`,
 * `window-management`, `local-network`, `storage-access`. Nenhum deles é do
 * Prime Video, e todos entregam controle do aparelho a uma página de terceiro.
 */
const PERMISSOES_DO_PRIME: ReadonlySet<string> = new Set([
  'fullscreen',
  'automatic-fullscreen',
  'media',
  'clipboard-sanitized-write',
  'persistent-storage',
  'background-fetch',
  'background-sync',
]);

/** A permissão que decide se o Prime decifra alguma coisa. */
const PERMISSAO_DRM = 'mediaKeySystem';

/**
 * A origem pode ter DRM?
 *
 * Duas condições, e as duas importam:
 *
 *   o domínio é da Prime ou da Amazon — a regra é a mesma de navegação, e
 *   reaproveitar é o que impede a lista de permissões de virar uma porta que a
 *   regra de domínio não fecha;
 *
 *   **ou** a origem é o servidor local do próprio app, que é de onde a sonda de
 *   DRM roda. Sem essa segunda, a sonda cairia em `SecurityError` por falta de
 *   permissão — e o diagnóstico do build passaria a medir a própria política em
 *   vez de o CDM.
 *
 * A página da sonda não serve conteúdo nenhum e não sabe que existe, então
 * autorizar a origem local aqui não abre nada: `mediaKeySystem` dá acesso ao que
 * **a própria origem** serve, e lá não há nada.
 */
function origemDoPrimeTemDrm(origem: unknown): boolean {
  if (typeof origem !== 'string' || origem === '') return false;
  let host: string;
  try {
    host = new URL(origem).hostname;
  } catch {
    return false;
  }
  if (ehDominioPermitido(host)) return true;
  return host === '127.0.0.1' || host === 'localhost';
}

/**
 * Instala a política de permissões da partição do Prime.
 *
 * ## Por que os dois handlers, e não um
 *
 * A documentação do Electron é explícita: "you must also implement
 * `setPermissionCheckHandler` to get complete permission handling. Most web APIs
 * do a permission check and then make a permission request if the check is
 * denied."
 *
 * Só o `check` resolve: devolvendo `true`, a página nem chega a pedir. O
 * `request` fica como a segunda linha, porque uma API que pede direto — sem
 * checar antes — passaria por ele.
 *
 * ## E o log de cada decisão
 *
 * Toda permissão pedida entra no log, concedida ou não. É o que responde
 * "a permissão `mediaKeySystem` foi bloqueada?" sem precisar de outro
 * experimento — e uma negativa de DRM aparece aqui como uma linha, ao lado da
 * recusa do site, que é o par que separa os três casos.
 */
function instalarPermissoesDoPrime(ses: Session): void {
  ses.setPermissionCheckHandler((_wc, permissao, requestingOrigin) => {
    if (permissao === PERMISSAO_DRM) {
      const ok = origemDoPrimeTemDrm(requestingOrigin);
      log(`[prime] permissao check ${PERMISSAO_DRM} origem=${origemDoPrime(requestingOrigin)} -> ${ok}`);
      return ok;
    }
    return PERMISSOES_DO_PRIME.has(permissao);
  });

  ses.setPermissionRequestHandler((_wc, permissao, callback, details) => {
    if (permissao === PERMISSAO_DRM) {
      /*
       * `details.requestingUrl` primeiro, e o URL do webContents como reserva.
       *
       * O pedido vem do frame que pediu, e num site como o Prime há iframes de
       * anúncio e de player de terceiros: o `requestingUrl` é o do frame que
       * pediu, e o do webContents é o do documento de topo. A ordem é do mais
       * específico para o menos, e é a que impede um iframe de pedir DRM em nome
       * da página de topo.
       */
      const pedido = requestingUrlDoPedido(details, requestingUrlDoWebContents(_wc));
      const ok = origemDoPrimeTemDrm(pedido);
      log(`[prime] permissao request ${PERMISSAO_DRM} origem=${origemDoPrime(pedido)} -> ${ok}`);
      callback(ok);
      return;
    }
    const ok = PERMISSOES_DO_PRIME.has(permissao);
    log(`[prime] permissao request ${permissao} -> ${ok ? 'concedida' : 'recusada'}`);
    callback(ok);
  });
}

/** Só a origem de uma URL, para o log — sem caminho, sem query, sem identificador. */
function origemDoPrime(url: unknown): string {
  if (typeof url !== 'string' || url === '') return '-';
  try {
    return new URL(url).origin;
  } catch {
    return '-';
  }
}

/**
 * O URL que o pedido de permissão acompanha.
 *
 * `requestingUrl` está em `details` e nem toda permissão o traz; quando falta, o
 * chamador passa o do webContents como reserva.
 */
function requestingUrlDoPedido(details: unknown, reserva: unknown): unknown {
  if (details && typeof details === 'object' && 'requestingUrl' in details) {
    const v = (details as { requestingUrl?: unknown }).requestingUrl;
    if (typeof v === 'string' && v !== '') return v;
  }
  return reserva;
}

function requestingUrlDoWebContents(wc: unknown): unknown {
  try {
    const alvo = wc as { isDestroyed?: () => boolean; getURL?: () => string } | null;
    if (!alvo || typeof alvo.getURL !== 'function') return '';
    if (typeof alvo.isDestroyed === 'function' && alvo.isDestroyed()) return '';
    return alvo.getURL();
  } catch {
    return '';
  }
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
     * A política de permissões entra **antes** da view ser criada.
     *
     * `session.fromPartition` devolve sempre o mesmo objeto para a mesma partição,
     * então instalar aqui ou depois é a mesma coisa — e aqui é antes de qualquer
     * `loadURL`, que é o que garante que a primeira navegação já seja avaliada pela
     * política nova e não pela anterior.
     */
    instalarPermissoesDoPrime(sessao);
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
    diagnosticarPlayer(view.webContents);

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

  /*
   * A área medida pelo palco é guardada, e o posicionamento é de `updatePrimeBounds`.
   *
   * Guardar em vez de aplicar aqui é o que deixa o `main` se mexer sozinho quando a
   * janela muda de tamanho: `prime:abrir` continua sendo a única fonte da área, e
   * ninguém mais precisa mandar a mesma informação por um caminho novo.
   */
  areaDoPlayer = bounds;
  updatePrimeBounds();

  /*
   * Sem `setVisible`: a view nasce visível, e o que a esconde é removê-la.
   */
  return true;
}

/**
 * Este build do Electron decifra vídeo protegido?
 *
 * ## A pergunta vai ao motor, e não ao site
 *
 * Numa view descartável, sem preload e sem Node, em sandbox — as mesmas
 * restrições da view do Prime. Rodar `executeJavaScript` na view do Prime seria
 * injeção no DOM de um site de terceiro, que é o que esta integração não faz.
 *
 * ## Por que a sonda precisa de uma página em `127.0.0.1`, e não de `data:`
 *
 * EME só funciona em **contexto seguro**, e `data:text/html,…` tem origem opaca:
 * `window.isSecureContext` é `false` ali. Nesses casos o Chromium responde
 * `SecurityError` — **com ou sem CDM instalado**.
 *
 * A versão anterior desta sonda rodava em `data:` e tratava qualquer falha como
 * "sem DRM". Isso é um falso negativo garantido: ela diria que não há DRM num
 * Chromium que tem, e a conclusão sairia de uma medição que não mede. Por isso a
 * sonda sobe um servidor próprio em `127.0.0.1`, que o Chromium trata como
 * potencialmente confiável, e registra `isSecureContext` no log: **a sonda
 * verifica a própria precondição**, e um resultado negativo só vale se a página
 * rodou segura.
 *
 * ## Por que na partição do Prime, e não na sessão padrão
 *
 * Porque a pergunta tem duas metades — "existe CDM?" e "esta origem tem
 * permissão?" — e só na partição do Prime a segunda é respondida pelo mesmo
 * handler que vai responder pela página do Prime. Sondar na sessão padrão daria
 * uma resposta que não vale para o caso real.
 *
 * ## O que a resposta NÃO decide
 *
 * `tem: true` é o **mínimo**: este build tem CDM. Não significa que o Prime Video
 * vai tocar nele. Depois de `disponivel=true` sobram dois casos, e a diferença entre
 * eles é o que decide entre reproduzir no Juntos, trocar o runtime ou cair no
 * navegador:
 *
 *   CASO B  Widevine ok, permissão negada — corrigir o handler. Feito aqui.
 *   CASO C  Widevine ok, permissão ok, e o Prime recusa de novo.
 *
 * O CASO C é incompatibilidade entre o Prime Video e o ambiente, e **não há o que
 * fazer no cliente**: o Prime pode recusar clientes não oficialmente suportados, e
 * essa decisão é da Amazon, não nossa. Nenhuma linha deste arquivo pode mudá-la, e
 * por isso a UI nunca promete que toca — ela deixa o caminho oficial à mão.
 *
 * O diagnóstico do CASO C é o log do player, com o filtro de DRM. É o que mostra o
 * nome do erro que a página do Prime recebeu, e esse nome é a evidência que separa
 * "falta CDM" de "o site recusou o cliente".
 */
function sondarDrm(): Promise<SondaDrm> {
  return new Promise((resolve) => {
    let sondagem: WebContentsView;
    try {
      sondagem = new WebContentsView({
        webPreferences: {
          partition: PARTICAO,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
    } catch (err) {
      log(`[prime] drm sonda nao criou a view (${nomeDoErro(err)})`);
      resolve({ tem: false, motivo: 'view indisponivel', tentativas: [] });
      return;
    }

    let respondeu = false;
    const encerrar = (valor: SondaDrm) => {
      if (respondeu) return;
      respondeu = true;
      if (!sondagem.webContents.isDestroyed()) sondagem.webContents.close();
      resolve(valor);
    };

    sondagem.webContents.once('did-finish-load', () => {
      sondagem.webContents
        .executeJavaScript(SONDA_DE_EME)
        .then((bruto: unknown) => {
          const r = (bruto ?? {}) as Partial<SonDaBruta>;
          const tentativas = Array.isArray(r.tentativas) ? r.tentativas.map(String) : [];
          const contextoSeguro = r.contextoSeguro === true;
          const apiExiste = r.apiExiste === true;
          const tem = tentativas.some((t) => t.endsWith(': ok'));

          encerrar({
            tem,
            motivo: motivoDaSonda(apiExiste, contextoSeguro, tentativas),
            tentativas,
          });
        })
        .catch((err: unknown) =>
          encerrar({ tem: false, motivo: `falha na sonda: ${nomeDoErro(err)}`, tentativas: [] }),
        );
    });

    sondagem.webContents.once('did-fail-load', () =>
      encerrar({ tem: false, motivo: 'a pagina da sonda nao carregou', tentativas: [] }),
    );

    setTimeout(
      () => encerrar({ tem: false, motivo: 'tempo esgotado', tentativas: [] }),
      SONDA_TIMEOUTO_MS,
    );

    abrirServidorDaSonda()
      .then((sonda) => {
        // `catch` vazio de propósito: se o load falhar, o `did-fail-load`
        // acima já encerra a sonda com um motivo, e um `unhandledRejection`
        // aqui seria um segundo relatório do mesmo evento.
        void sondagem.webContents.loadURL(sonda.origem).catch(() => {});
      })
      .catch((err: unknown) =>
        encerrar({ tem: false, motivo: `o servidor da sonda nao subiu: ${nomeDoErro(err)}`, tentativas: [] }),
      );
  });
}

/** O que a sonda descobre. */
interface SondaDrm {
  /**
   * A EME respondeu com um key system utilizável?
   *
   * `true` é o mínimo: significa que este build tem CDM. **Não** significa que o
   * Prime Video vai tocar nele — Widevine disponível e o Prime aceitando o
   * ambiente são duas perguntas separadas, e a segunda só a Amazon responde.
   */
  tem: boolean;
  /**
   * Por que não, ou `'disponivel'`.
   *
   * Quando existe, é o nome do erro do Chromium, e a diferença entre eles é a
   * diferença entre as três conclusões possíveis:
   *
   *   `NotSupportedError`  o build não tem CDM registrado. Conclusivo.
   *   `SecurityError`       contexto inseguro ou permissão barrada.
   *   `NotAllowedError`     a permissão foi respondida com `false`.
   *
   * Por isso `SondaDrm` guarda o motivo e não só o booleano: um `false` sem
   * motivo é indistinguível de "a sonda rodou no lugar errado".
   */
  motivo: string;
  /** Uma linha por configuração pedida, com o que cada uma respondeu. */
  tentativas: string[];
}

/** O que o script da sonda devolve, antes de virar `SondaDrm`. */
interface SonDaBruta {
  apiExiste: boolean;
  contextoSeguro: boolean;
  tentativas: string[];
}

/**
 * Traduz o que a sonda respondeu no motivo que o log mostra.
 *
 * A ordem importa: `apiExiste` e `contextoSeguro` são **precondições**, e um
 * resultado que falhou nelas não diz nada sobre CDM. Um `SecurityError` com
 * `contextoSeguro: false` é a sonda mal feita — e dizer "não tem DRM" aí seria
 * concluir a partir de uma medição inválida.
 */
function motivoDaSonda(
  apiExiste: boolean,
  contextoSeguro: boolean,
  tentativas: string[],
): string {
  if (!apiExiste) return 'requestMediaKeySystemAccess ausente neste motor';
  if (!contextoSeguro) return 'contexto nao seguro: resposta invalida';
  if (tentativas.some((t) => t.endsWith(': ok'))) return 'disponivel';
  const primeira = tentativas.find((t) => !t.endsWith(': ok'));
  if (!primeira) return 'a EME nao respondeu';
  const i = primeira.indexOf(':');
  return i < 0 ? primeira : primeira.slice(i + 1).trim();
}

/**
 * O script da sonda.
 *
 * ## Duas configurações, e por quê
 *
 * `initDataTypes: ['cenc']` e `[]`. Um CDM pode aceitar a combinação com `cenc` e
 * recusar a vazia, ou o contrário — `requestMediaKeySystemAccess` promete **uma**
 * configuração, e a resposta vale só para aquela. Testar uma delas dá `false` num
 * CDM que funciona com a outra.
 *
 * ## Um objeto, e não um booleano
 *
 * Porque o que interessa é *qual* falhou e como. Um `true`/`false` perde
 * `NotSupportedError` — a assinatura do build sem Widevine — e `SecurityError`,
 * que é a assinatura de sonda feita no contexto errado.
 */
const SONDA_DE_EME = `(async () => {
  const saida = {
    apiExiste: typeof navigator.requestMediaKeySystemAccess === 'function',
    contextoSeguro: window.isSecureContext === true,
    tentativas: [],
  };
  if (!saida.apiExiste) return saida;
  for (const initDataTypes of [['cenc'], []]) {
    const rotulo = initDataTypes.length ? 'cenc' : 'vazia';
    try {
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes }]);
      saida.tentativas.push(rotulo + ': ok');
    } catch (erro) {
      saida.tentativas.push(rotulo + ': ' + (erro && erro.name ? erro.name : 'sem nome'));
    }
  }
  return saida;
})()`;

/** O nome do erro, porque a mensagem de uma promise rejeitada é inútil no log. */
function nomeDoErro(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err).slice(0, 120);
}

/** Quanto esperar a sonda antes de desistir. */
const SONDA_TIMEOUTO_MS = 8000;

/**
 * A página da sonda: uma linha, e nada que possa ser confundido com conteúdo.
 *
 * Ela não pede nada, não carrega nada, e não sabe que existe. O único JavaScript
 * que roda é o da sonda, injetado pelo `main` — que é o app, não um terceiro.
 */
const PAGINA_DA_SONDA =
  '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>sonda drm</title>' +
  '</head><body></body></html>';

/**
 * Um servidor HTTP de uma requisição, em `127.0.0.1`, para a página da sonda.
 *
 * ## Por que um servidor, e não `data:`
 *
 * Porque `data:` não é contexto seguro, e EME exige contexto seguro. Ver o
 * comentário de `sondarDrm`.
 *
 * ## Por que `127.0.0.1` e não `localhost`
 *
 * `localhost` precisa resolver, e no Windows ele costuma resolver para `::1`
 * primeiro — o que faz o servidor abrir num endereço e o `loadURL` procurar no
 * outro. `127.0.0.1` pula essa etapa, e o Chromium trata o bloco `127.0.0.0/8`
 * como potencialmente confiável, então o contexto seguro é o mesmo.
 *
 * ## A escuta é na loopback
 *
 * `listen(0, '127.0.0.1')`: porta efêmera, só na loopback. O servidor existe
 * enquanto a sonda roda, responde uma página sem corpo, e não tem nada a não
 * expor. Deixar em `0.0.0.0` abriria uma porta na rede local sem motivo.
 */
function abrirServidorDaSonda(): Promise<{ origem: string }> {
  return new Promise((resolve, reject) => {
    let servidor: ReturnType<typeof createServer>;
    try {
      servidor = createServer((_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(PAGINA_DA_SONDA);
      });
    } catch (err) {
      reject(err);
      return;
    }

    servidor.once('error', reject);
    servidor.listen(0, '127.0.0.1', () => {
      const endereco = servidor.address();
      if (endereco === null || typeof endereco === 'string') {
        servidor.close();
        reject(new Error('a porta da sonda nao foi informada'));
        return;
      }
      /*
       * O servidor morre sozinho, e o timer nao segura o processo.
       *
       * `unref` porque o app pode estar fechando enquanto a sonda ainda está no
       * ar: um timer referenciado manteria o `main` vivo até ele estourar.
       */
      const fechar = setTimeout(() => servidor.close(), SONDA_TIMEOUTO_MS);
      fechar.unref?.();
      resolve({ origem: `http://127.0.0.1:${endereco.port}/` });
    });
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

  /*
   * A pergunta que a UI faz, e a resposta que o log guarda.
   *
   * A UI precisa de um booleano — ela só sabe dizer "toca" ou "não toca" — e o
   * diagnóstico precisa das tentativas, do contexto seguro e do nome do erro. São
   * duas saídas de uma sondagem só, e a razão inteira fica no log.
   *
   * E o log escreve **antes** de responder: se a pessoa relatar "a faixa não
   * apareceu", o arquivo já tem o motivo, e isso não depende de a UI ter chegado a
   * perguntar.
   */
  ipcMain.handle('prime:tem-drm', async () => {
    const sonda = await sondarDrm();
    log(
      `[prime] drm disponivel=${sonda.tem} motivo=${sonda.motivo} ` +
        `tentativas=[${sonda.tentativas.join(" | ")}] ` +
        `electron=${process.versions.electron} chromium=${process.versions.chrome}`,
    );
    return sonda.tem;
  });
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
   * A view se mexe junto com a janela, mesmo sem o renderer pedir.
   *
   * O palco do Junto já manda a área nova em `resize`, em tela cheia e a cada
   * mudança do painel, pelo `ResizeObserver`. Estes três existem aqui para o caso
   * em que ele não chega: o renderer ocupado, a faixa fora do montagem, uma
   * navegação em curso enquanto a pessoa arrasta a janela.
   *
   * Nenhum deles é o único caminho. `updatePrimeBounds` é idempotente — se o retângulo
   * não mudou, não chama `setBounds` — então os dois lados podem responder ao mesmo
   * evento sem que a view fique pulando entre dois lugares.
   *
   * `resize` já cobre tela cheia no Windows, e `enter-full-screen` cobre o resto: os
   * dois eventos existem porque nem toda plataforma emite os dois, e a caixa do login
   * precisa ficar centralizada nas duas.
   */
  janela.on('resize', () => updatePrimeBounds());
  janela.on('enter-full-screen', () => updatePrimeBounds());
  janela.on('leave-full-screen', () => updatePrimeBounds());

  log(`[prime] view ligada na janela ${janela.id}`);
}

/** A view existe agora? */
export function temViewPrime(): boolean {
  return view !== null && !view.webContents.isDestroyed();
}
