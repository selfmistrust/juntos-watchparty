/**
 * Ponte para o app desktop.
 *
 * Declara a mesma forma do `desktop/electron/shared/contract.ts`. A duplicação
 * é de propósito: o `desktop` é empacotado separado e o renderer não pode
 * importar de lá. O que este arquivo compra é a checagem de tipos do lado do
 * navegador, que é onde quase todo o código roda.
 *
 * Fora do Electron, `desktop` é `null` e todo o resto do app continua
 * funcionando igual. Nada aqui pode lançar: uma tela de compartilhamento que
 * quebra no navegador derrubaria o `resolveState` do card inteiro.
 */

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
}

export type CaptureErrorReason = 'cancelled' | 'denied' | 'unsupported' | 'failed';

export interface CaptureError {
  reason: CaptureErrorReason;
  message: string;
}

export type CaptureResult = { ok: true; source: CaptureSource } | { ok: false; error: CaptureError };

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


export interface DesktopApi {
  readonly isDesktop: true;
  readonly version: string;
  listCaptureSources(): Promise<CaptureSource[]>;
  selectCaptureSource(sourceId: string): Promise<CaptureResult>;
  stopCapture(): Promise<void>;
  isCapturing(): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  openInSystemBrowser(url: string): Promise<boolean>;
  openPermissionSettings(): Promise<void>;
  /**
   * Chama atenção para a janela e notifica o sistema. Só o desktop implementa:
   * na web o padrão não deixa o app puxar o foco de outra aba, e o que dá para
   * fazer — piscar o título e marcar o chat como não lido — é feito aqui.
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

/** A API do desktop, ou `null` no navegador. */
export function desktop(): DesktopApi | null {
  if (typeof window === 'undefined') return null;
  return window.juntosDesktop ?? null;
}

export const isDesktop = (): boolean => desktop() !== null;

/**
 * Copia texto para a área de transferência, e diz se conseguiu.
 *
 * No desktop vai pela ponte, para o processo principal escrever. No navegador
 * usa a API da web, que funciona — mas pode recusar, e o `catch` transforma a
 * recusa em `false` em vez de uma rejeição que o botão não trata.
 *
 * Devolver o booleano é o ponto: um "Link copiado" sobre um link que não foi
 * copiado é pior do que nenhuma mensagem.
 */
export async function copiarTexto(texto: string): Promise<boolean> {
  const api = desktop();
  if (api) return api.copyText(texto);
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    return false;
  }
}
