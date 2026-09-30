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
export { spotifyProvider } from './spotifyLink';
export { primeProvider, usePrimeSource } from './prime';
export { useYoutubeSource } from './useYoutubeSource';
export { useScreenShare } from './useScreenShare';

export type {
  MediaSourceProvider,
  MediaSourceState,
  MediaSourceContext,
  MediaSourceAccount,
  DraftMediaItem,
} from './types';
export { READY, unavailable, checking } from './types';

import { driveProvider } from './drive';
import { globoplayProvider } from './globoplay';
import { screenShareProvider } from './screenShare';
import { spotifyProvider } from './spotifyLink';
import { primeProvider } from './prime';
import type { MediaSourceProvider } from './types';
import { uploadProvider } from './upload';

/**
 * Fontes sem painel próprio: entram direto na grade de cards do modal.
 *
 * A lista tem fontes das duas formas, e a distinção é onde o `start` mora:
 * o YouTube não aparece aqui porque a busca dele precisa de um painel com
 * estado próprio (termo, resultados, carregando, erro), que só um hook monta —
 * `useYoutubeSource`.
 *
 * A tela compartilhada e o Prime Video estão na lista **e** têm hook,
 * porque o que o `MediaSourceModal` precisa é do `id`: o provider do registro
 * garante que a fonte está listada, e o mapa `comHook` troca o `start` pelo
 * do hook. É o mesmo caminho que qualquer fonte futura com painel próprio
 * usaria: provider no registro + hook devolvendo o painel.
 */
export const MEDIA_SOURCES: MediaSourceProvider[] = [
  uploadProvider,
  driveProvider,
  globoplayProvider,
  screenShareProvider,
  /*
   * A posição do Spotify é a que fecha a primeira linha: a grade é de duas
   * colunas, e colocá-lo depois faria a última linha ficar com um card só e um
   * buraco ao lado. Ele vem antes do Prime por isso, e não por ser uma fonte —
   * ver `spotifyLink.tsx`, que explica por que ele só abre um link.
   */
  spotifyProvider,
  /*
   * O Prime Video vem depois do Spotify, e a posição é só da grade de duas
   * colunas. Ele tem painel próprio (escolher o título dentro do app), então
   * quem entra no `MediaSourceModal` é a versão do hook, pelo mapa
   * `comHook` — e a versão do registro é a que existe para o `id` estar
   * listado e para o `gradeFontes.test.ts` ter o que conferir.
   */
  primeProvider,
];
