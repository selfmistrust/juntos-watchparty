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

/** O que o renderer sabe da app desktop. */
export interface DesktopApi {
  /** `true` quando está rodando dentro do Electron. */
  readonly isDesktop: true;

  /** Versão do app, para a UI conseguir mostrar "versão 1.0.0". */
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

  /** Abre as configurações de permissões do app no sistema operacional. */
  openPermissionSettings(): Promise<void>;
}

declare global {
  interface Window {
    juntosDesktop?: DesktopApi;
  }
}
