import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureResult, CaptureSource, DesktopApi, PrimeBounds, PrimePage } from '../shared/contract';

/**
 * Ponte entre o renderer e o processo principal.
 *
 * `contextIsolation: true` e `sandbox: true` na janela significam que o
 * renderer **não** tem acesso ao Node. Tudo que ele pode fazer da máquina
 * passa por esta lista explícita de canais. Sem ela, qualquer script que
 * conseguisse rodar na página — inclusive conteúdo de terceiro dentro de um
 * `<iframe>` — teria o sistema inteiro.
 *
 * Por isso o `ipcRenderer` não é exposto: só funções com nome e formato
 * fixos. E cada argumento é validado aqui, antes de cruzar o processo, porque
 * o renderer é a parte não confiável da conversa.
 */
function soTexto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/**
 * Retângulo da view do Prime, ou `null` se o renderer mandou algo que não é um.
 *
 * O renderer é a parte não confiável da conversa. Sem esta checagem, um
 * `width` de `-1` ou de `1e12` colocaria a view fora da janela e o retângulo
 * viraria uma brecha para escrever fora do `contentView`. O teto de 16384 é o
 * lado maior que qualquer monitor já teve; o piso de 1 é o menor retângulo que
 * ainda é uma área, e não um ponto.
 */
function soRetangulo(valor: unknown): PrimeBounds | null {
  if (typeof valor !== 'object' || valor === null) return null;
  const { x, y, width, height } = valor as Record<string, unknown>;
  const numeros = [x, y, width, height];
  if (!numeros.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (width as number < 1 || height as number < 1) return null;
  if (width as number > 16384 || height as number > 16384) return null;
  if (Math.abs(x as number) > 16384 || Math.abs(y as number) > 16384) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

const api: DesktopApi = {
  isDesktop: true,
  /*
   * A versão vem do processo principal, que a lê do `package.json` empacotado.
   *
   * Era uma string escrita à mão aqui, e o `package.json` tinha a mesma
   * informação em outro lugar. Os dois discordavam em silêncio: subir a versão
   * gerava um instalador novo que a janela announcingava com o número antigo.
   * Nenhum aviso, nenhum teste — só um app mentindo sobre a própria versão, o
   * que é justamente o número que a pessoa usa para dizer o que está instalado.
   *
   * `sendSync` e não `invoke` porque `DesktopApi.version` é síncrono, e o que
   * seria ganho trocando por Promise é um estado de carregamento para um texto
   * que não muda. A leitura é de um `package.json`, uma vez, antes da janela.
   */
  version: ipcRenderer.sendSync('desktop:versao') as string,

  listCaptureSources: () =>
    ipcRenderer.invoke('desktop:listar-fontes', false) as Promise<CaptureSource[]>,

  selectCaptureSource: async (sourceId: string): Promise<CaptureResult> => {
    const id = soTexto(sourceId);
    if (!id) {
      return {
        ok: false,
        error: { reason: 'failed', message: 'Nenhuma tela foi informada.' },
      };
    }
    await ipcRenderer.invoke('desktop:escolher-fonte', id);
    return { ok: true, source: { id, name: '', kind: 'screen', thumbnail: '' } };
  },

  stopCapture: async () => {
    await ipcRenderer.invoke('desktop:parar-captura');
  },

  isCapturing: () => ipcRenderer.invoke('desktop:esta-capturando') as Promise<boolean>,

  copyText: async (text: string): Promise<boolean> => {
    const valor = soTexto(text);
    if (!valor) return false;
    return (await ipcRenderer.invoke('desktop:copiar-texto', valor)) === true;
  },

  openInSystemBrowser: async (url: string): Promise<boolean> => {
    const valor = soTexto(url);
    if (!valor) return false;
    return (await ipcRenderer.invoke('desktop:abrir-no-navegador', valor)) === true;
  },

  openPermissionSettings: async () => {
    // Não existe equivalente no Electron: no Windows a permissão de captura é
    // pedida pelo sistema na hora, e não há um painel para abrir. A função
    // existe para o contrato não mudar se um dia houver.
  },

  notifyMention: async (title: string, body: string): Promise<boolean> => {
    /*
     * O texto vai inteiro para o processo principal, e a validação fica lá: o
     * `soTexto` do preload garante o tipo, mas quem decide o tamanho aceito é o
     * `main`, porque é o `main` que escreve na tela do sistema.
     */
    const t = soTexto(title);
    const b = soTexto(body);
    if (!t || !b) return false;
    return (await ipcRenderer.invoke('desktop:mencao', t, b)) === true;
  },

  /*
   * A view do Prime.
   *
   * `openPrimeView` devolve `false` quando o retângulo não passou no
   * `soRetangulo`: o palco some, e é melhor um retângulo preto honesto do que
   * uma view flutuando em posição aleatória sobre a janela.
   */
  openPrimeView: async (bounds: PrimeBounds): Promise<boolean> => {
    const retangulo = soRetangulo(bounds);
    if (!retangulo) return false;
    return (await ipcRenderer.invoke('prime:abrir', retangulo)) === true;
  },

  closePrimeView: async (): Promise<void> => {
    await ipcRenderer.invoke('prime:fechar');
  },

  primeNavigate: async (url: string): Promise<boolean> => {
    const valor = soTexto(url);
    if (!valor) return false;
    return (await ipcRenderer.invoke('prime:navegar', valor)) === true;
  },

  primePage: () => ipcRenderer.invoke('prime:pagina') as Promise<PrimePage>,

  /*
   * `onPrimePage` usa `on`/`off` e não um `handle`, porque quem empurra é o
   * `main` a cada navegação dentro da view — não é o renderer pedindo. O
   * `off` no cleanup usa a mesma função, que é o que a documentação do
   * Electron exige para não vazar assinatura.
   */
  onPrimePage: (callback: (page: PrimePage) => void): (() => void) => {
    const ouvinte = (_evento: unknown, page: PrimePage) => {
      try {
        callback(page);
      } catch {
        // Um erro no renderer não pode derrubar o `main`: quem empurra é a
        // navegação da view, e ela continua acontecendo.
      }
    };
    ipcRenderer.on('prime:pagina-mudou', ouvinte);
    return () => {
      ipcRenderer.off('prime:pagina-mudou', ouvinte);
    };
  },

  primeCanPlayProtected: async (): Promise<boolean> =>
    (await ipcRenderer.invoke('prime:tem-drm')) === true,
};

contextBridge.exposeInMainWorld('juntosDesktop', api);
