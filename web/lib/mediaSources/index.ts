/**
 * Ponto de entrada único das fontes de mídia.
 *
 * Todo o resto do app importa daqui, e não dos arquivos internos: assim o
 * registro pode ser reorganizado (ou trocar de lugar a busca do YouTube, que
 * vive num hook) sem quebrar quem consome.
 */
export { uploadProvider } from './upload';
export { youtubeProvider, searchYoutube, addYoutubeFromUrl } from './youtube';
export { driveProvider } from './drive';
export { globoplayProvider } from './globoplay';
export { screenShareProvider } from './screenShare';
export { useYoutubeSource } from './useYoutubeSource';

export type {
  MediaSourceProvider,
  MediaSourceState,
  MediaSourceContext,
  DraftMediaItem,
} from './types';
export { READY, unavailable, checking } from './types';

import { driveProvider } from './drive';
import { globoplayProvider } from './globoplay';
import { screenShareProvider } from './screenShare';
import type { MediaSourceProvider } from './types';
import { uploadProvider } from './upload';

/**
 * Fontes sem painel próprio: entram direto na grade de cards do modal.
 *
 * O YouTube não está nesta lista de propósito. A busca dele precisa de um
 * painel com estado próprio (termo, resultados, carregando, erro), que só pode
 * ser montado por um hook — `useYoutubeSource`. Ele é combinado no
 * `MediaSourceModal`, e é o mesmo caminho que qualquer fonte futura com painel
 * próprio usaria: provider no registro + hook devolvendo o painel.
 */
export const MEDIA_SOURCES: MediaSourceProvider[] = [
  uploadProvider,
  driveProvider,
  globoplayProvider,
  screenShareProvider,
];
