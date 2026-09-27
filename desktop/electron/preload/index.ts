import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureResult, CaptureSource, DesktopApi } from '../shared/contract';

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

const api: DesktopApi = {
  isDesktop: true,
  version: '1.0.0',

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
};

contextBridge.exposeInMainWorld('juntosDesktop', api);
