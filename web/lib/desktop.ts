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
