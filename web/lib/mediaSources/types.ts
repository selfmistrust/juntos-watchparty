import type { ReactNode } from 'react';
import type { PlaylistItem } from '@/types';

/** Item pronto para entrar na fila, sem os campos que o servidor preenche. */
export type DraftMediaItem = Omit<PlaylistItem, 'id' | 'addedBy' | 'addedById'>;

/**
 * O que o modal precisa saber sobre uma fonte, resolvido no momento em que o
 * card é desenhado. Separar isto do provider é o que permite a uma fonte estar
 * "carregando" ou "indisponível" sem o modal conhecer nada da integração.
 */
export interface MediaSourceState {
  /** A fonte pode ser usada agora. */
  available: boolean;
  /** Consultando disponibilidade/configuração (ex.: checando se há conta conectada). */
  loading: boolean;
  /** Texto curto de por que está indisponível; some quando `available` é verdadeiro. */
  unavailableReason?: string;
}

export const READY: MediaSourceState = { available: true, loading: false };
export const unavailable = (reason: string): MediaSourceState => ({
  available: false,
  loading: false,
  unavailableReason: reason,
});
export const checking = (): MediaSourceState => ({ available: true, loading: true });

/**
 * Uma fonte de mídia. Adicionar uma integração nova é adicionar um objeto
 * deste tipo e registrá-lo em `registry.ts` — o modal não muda.
 *
 * O contrato é declarativo de propósito: o modal cuida de abrir/fechar, foco,
 * carregando e erro. O provider cuida apenas de *como* a fonte entrega a mídia,
 * devolvendo um `DraftMediaItem` (ou um item de navegador para o caso especial
 * de transmitir a tela, que não é um arquivo).
 */
export interface MediaSourceProvider {
  id: string;
  /** Nome mostrado no card. */
  name: string;
  /** Uma linha, no máximo — o card tem altura fixa. */
  description: string;
  /** Ícone oficial da marca, ou o ícone do Phosphor quando não houver. */
  icon: ReactNode;
  /** Cor de acento do card (fundo do ícone), quando a marca tiver uma. */
  accent?: string;
  /**
   * O que o provider precisa da sala. `canControl` decide se a fonte pode ser
   * usada: sem ele, a pessoa só assiste.
   */
  requiresControl?: boolean;
  /**
   * Se a fonte já está pronta (não precisa consultar nada), devolve esse
   * estado. Ausente, o modal chama `resolveState`.
   */
  fixedState?: MediaSourceState;
  /**
   * Estado em tempo de execução. Só é chamado se o card for montado e
   * visível, e de novo quando o modal reabre.
   */
  resolveState?: (context: MediaSourceContext) => Promise<MediaSourceState>;
  /**
   * Abre o fluxo da fonte. O modal já fechou e o card já saiu de loading, então
   * o provider é dono do seu próprio formulário/erro.
   *
   * Retornar `keepOpen` mantém o modal aberto (útil para upload, que mostra
   * progresso). O padrão é fechar.
   */
  start?: (context: MediaSourceContext) => Promise<void | 'keepOpen'>;
}

export interface MediaSourceContext {
  canControl: boolean;
  /** Entrega o item à fila. Quem chama decide o que fazer com ele. */
  addToPlaylist: (item: DraftMediaItem) => void;
  /** Token de upload, só para fontes que enviam arquivo. */
  requestUploadToken: (payload: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  }) => Promise<import('@/hooks/useRoom').UploadTokenResult>;
}
