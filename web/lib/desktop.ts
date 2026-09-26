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
  openPermissionSettings(): Promise<void>;
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
