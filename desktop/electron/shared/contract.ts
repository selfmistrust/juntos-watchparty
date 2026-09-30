/**
 * Contrato entre o processo principal do Electron e o renderer (a app web).
 *
 * Fica num arquivo próprio, e não dentro do `preload`, porque os dois lados
 * precisam conhecer a mesma forma: o main implementa, o preload expõe, e a
 * web consome via `window.juntosDesktop`. Se a forma mudasse em um dos lados
 * sem o outro, o erro apareceria em runtime como `undefined is not a function`
 * dentro do app — que é o pior lugar para descobrir uma incompatibilidade de
 * tipo.
 *
 * A web declara uma versão própria deste arquivo em `web/lib/desktop.ts`, com
 * as mesmas assinaturas. A duplicação é deliberada: o `desktop` é empacotado
 * separado da `web`, e o renderer não pode importar nada de `desktop/`, que só
 * existe depois do build do Electron.
 */

/** Uma tela ou janela que a pessoa pode escolher para transmitir. */
export interface CaptureSource {
  id: string;
  /** Nome legível ("Tela 1", "Chrome — Documento"). */
  name: string;
  kind: 'screen' | 'window';
  /** `thumbs:` do data URL, para o seletor não depender de screenshot assíncrono. */
  thumbnail: string;
}

export type CaptureErrorReason =
  /** A pessoa cancelou o seletor. */
  | 'cancelled'
  /** Não há permissão de captura (raro no desktop, mas o Windows pode negar). */
  | 'denied'
  | 'unsupported'
  | 'failed';

export interface CaptureError {
  reason: CaptureErrorReason;
  message: string;
}

export type CaptureResult =
  | { ok: true; source: CaptureSource }
  | { ok: false; error: CaptureError };

/**
 * Onde a view do Prime fica, em pixels do conteúdo da janela.
 *
 * O palco manda o retângulo que ele ocupa na tela, e o `main` posiciona a view
 * em cima dele. É a mesma medida em que o palco se vê: o `rect` do navegador é
 * relativo à viewport, e a janela do Electron não rola — a sala ocupa
 * exatamente `100dvh` e a rolagem que existe é de um `div` interno, que só se
 * move no celular, e no celular não há view do Prime. Ainda assim a soma do
 * scroll entra na medida, porque custa uma linha e é o que mantém o
 * posicionamento certo se a rolagem do documento voltar a existir.
 */
export interface PrimeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Página do Prime Video que a view embutida está mostrando.
 *
 * `url` é a URL canônica — o mesmo `normalizarUrlDoPrime` do servidor, e o
 * `main` revalida antes de mandar. `isTitulo` diz se essa página é a de um
 * título, que é o que habilita "Assistir com a sala". `titulo` é o
 * `<title>` do documento: o que o Prime já escreve na aba do navegador, sem
 * leitura de DOM.
 */
export interface PrimePage {
  url: string;
  titulo: string;
  isTitulo: boolean;
}


/** O que o renderer sabe da app desktop. */
export interface DesktopApi {
  /** `true` quando está rodando dentro do Electron. */
  readonly isDesktop: true;

  /**
   * Versão do app, para a UI conseguir mostrar "versão 1.0.1".
   *
   * Vem de `app.getVersion()`, que lê o `package.json` empacotado. Não é uma
   * string escrita aqui: as duas pontas precisam concordar, e discordar em
   * silêncio é como o app passa a anunciar um número diferente do instalador.
   */
  readonly version: string;

  /**
   * Lista telas e janelas para o seletor. Não pede permissão nenhuma: só
   * enumera. A permissão vem no `select`.
   */
  listCaptureSources(): Promise<CaptureSource[]>;

  /**
   * Marca a fonte escolhida como a que o próximo `getDisplayMedia` vai
   * receber, e devolve o que o processo principal respondeu.
   *
   * Não devolve o `MediaStream`: isso é do renderer, via
   * `navigator.mediaDevices.getDisplayMedia()`, e o main apenas intercepta o
   * pedido e entrega a fonte que foi marcada aqui. Separar as duas coisas é o
   * que permite a UI mostrar a pré-visualização antes de confirmar.
   */
  selectCaptureSource(sourceId: string): Promise<CaptureResult>;

  /** Encerra a captura e devolve os controles de tela ao sistema. */
  stopCapture(): Promise<void>;

  /** A captura está ativa agora? */
  isCapturing(): Promise<boolean>;

  /**
   * Copia texto para a área de transferência do sistema.
   *
   * Existe porque `navigator.clipboard.writeText` não funciona de forma
   * confiável aqui: a API da web exige que o documento esteja com foco, e uma
   * janela de app que não está em primeiro plano — ou que acabou de recuperar
   * foco depois de o usuário voltar do navegador do sistema, que é exatamente o
   * que acontece logo após o OAuth do YouTube — não tem. O processo principal
   * não tem essa exigência.
   *
   * Devolve `false` quando não copiou, para a UI poder avisar em vez de mostrar
   * "copiado" sobre um link que não foi para lugar nenhum.
   */
  copyText(text: string): Promise<boolean>;

  /**
   * Abre uma URL no navegador do sistema, sem tirar a pessoa da janela do app.
   *
   * Existe para o login do YouTube. O Google recusa autenticar dentro da janela
   * do Electron, então a tela de consentimento precisa ir para o navegador real.
   *
   * E o motivo de a URL chegar por esta ponte, e não por um
   * `location.assign`: o `/start` tem de ser pedido **pelo renderer**, que tem
   * o cookie de sessão, e só a URL do Google é entregue ao navegador. Se o
   * navegador fizesse o `/start` também, ele forjaria uma sessão nova e a conta
   * ficaria ligada a ela — a tela de conclusão diria "conta conectada" e o app
   * continuaria sem conta nenhuma, porque pergunta à sessão dele.
   *
   * Só `http` e `https`, e com o tamanho de uma URL de verdade. O renderer é a
   * parte não confiável da conversa, e `shell.openExternal` entrega o controle
   * para um programa de fora do app.
   */
  openInSystemBrowser(url: string): Promise<boolean>;

  /** Abre as configurações de permissões do app no sistema operacional. */
  openPermissionSettings(): Promise<void>;

  /**
   * Chama atenção para a janela do app, e mostra a notificação do sistema.
   *
   * Só existe no desktop porque é a única camada onde dá para **puxar o foco**.
   * Na web, o navegador não deixa o app roubar a aba de quem está em outra
   * página — e nem deveria. O que a web faz é piscar o título e marcar o chat
   * como não lido, que é o mais que o padrão permite.
   *
   * `win.flashFrame` é o pedido de "olha aqui" da barra de tarefas, e só pisca
   * se a janela **não** estiver em primeiro plano: com a janela à frente, a
   * pessoa já está vendo, e piscar seria só ruído.
   *
   * A notificação do sistema é do Electron e não da `Notification` da web
   * porque dentro do app a `Notification` depende de permissão do Chromium
   * embarqueado, que nem sempre está concedida, e o resultado seria um botão de
   * notificação que liga e não notifica. O `main` não depende de nada disso.
   */
  /**
   * Abre (ou reusa) a `WebContentsView` do Prime, na posição dada.
   *
   * A sessão é `persist:prime`, que sobrevive ao fechar o app: é o que evita
   * pedir login toda vez. Ela é desta instalação, e não da sala — duas pessoas
   * em computadores diferentes têm contas diferentes, e o Juntos nunca troca
   * nada entre elas. Nenhum cookie, token ou cabeçalho sai do `main`: a única
   * coisa que volta é a URL e o título da página, no fim de `primePage`.
   */
  openPrimeView(bounds: PrimeBounds): Promise<boolean>;

  /** Fecha e destrói a view. A sessão `persist:prime` fica em disco. */
  closePrimeView(): Promise<void>;

  /** Manda a view navegar, se e só se a URL for do domínio do Prime. */
  primeNavigate(url: string): Promise<boolean>;

  /**
   * Página do Prime Video que a view embutida está mostrando.
   *
   * Só a URL canônica e o `<title>` do documento — o mesmo par que o `main`
   * já tinha à mão, sem nenhuma leitura do DOM e sem injeção de JavaScript na
   * página do Prime. `isTitulo` diz se essa página é a de um título, que é o
   * que habilita "Assistir com a sala".
   */
  primePage(): Promise<PrimePage>;

  /**
   * Assina as mudanças de página da view do Prime.
   *
   * É um `on` e não um `primePage` que empurra, porque a pessoa navega pelo
   * catálogo do Prime dentro da view — o renderer não sabe quando isso
   * acontece, e não pode descobrir lendo o DOM de um site de terceiro.
   * Devolve a função que cancela a assinatura.
   */
  onPrimePage(callback: (page: PrimePage) => void): () => void;

  /**
   * O build do Electron tem o componente de DRM (Widevine) para decifrar vídeo
   * protegido dentro dele?
   *
   * A pergunta é feita ao motor, não ao site: `requestMediaKeySystemAccess`
   * responde se este Chromium consegue decifrar, e não tem nada a ver com a
   * conta de quem assiste nem com a assinatura do título.
   *
   * `false` é resposta definitiva: o build oficial do Electron não traz o CDM,
   * e nenhum título protegido vai tocar dentro do app. `true` é só o mínimo
   * necessário — a Prime Video ainda pode recusar na hora de tocar, por causa
   * da checagem de caminho verificado (VMP). Por isso a UI nunca promete que
   * vai tocar, e sempre deixa "Abrir no Prime Video" à mão.
   */
  primeCanPlayProtected(): Promise<boolean>;

  notifyMention(title: string, body: string): Promise<boolean>;
}

declare global {
  interface Window {
    juntosDesktop?: DesktopApi;
  }
}
