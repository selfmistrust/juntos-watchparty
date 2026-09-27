import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { PlayerHandle } from '@/types';

interface Props {
  src: string;
  /**
   * Transmissão ao vivo, quando vem de WebRTC.
   *
   * Quando presente, o `src` é ignorado e o vídeo passa a ser alimentado por
   * `srcObject`. Isso não é detalhe: um `MediaStream` não tem posição nem
   * duração, e as operações de `PlayerHandle` que dependem delas não fazem
   * sentido. Por isso cada uma abaixo trata o caso ao vivo explicitamente, em
   * vez de fingir que um arquivo sem duração é um arquivo.
   */
  stream?: MediaStream | null;
  onReady: () => void;
  onEnded: () => void;
  /**
   * Prefixo dos logs de diagnóstico, para distinguir as fontes.
   *
   * A origem importa: um `moov` no fim que não resolve com o Drive pode estar
   * perfeitamente bem no mesmo arquivo servido pelo bucket, e sem o rótulo os
   * dois casos viram um só.
   */
  rotulo?: string;
  /**
   * O elemento não conseguiu carregar a mídia.
   *
   * Sem isto, uma src que responde erro produz o pior resultado possível: um
   * player preto com a barra em 0:00, indistinguível de "carregando" e de
   * "quebrou". Quem assiste não tem como saber se falta permissão, se é um
   * arquivo inválido ou se a rede caiu.
   */
  onError?: (message: string) => void;
}

/**
 * O diagnóstico do player, em um lugar só.
 *
 * ## Por que cada evento
 *
 * Um `<video>` que não reproduz tem quatro causas que produzem exatamente a
 * mesma tela preta, e cada uma é confirmada por um evento diferente:
 *
 * - **Range/streaming quebrado**: `error` com `MEDIA_ERR_SRC_NOT_SUPPORTED`, e
 *   nenhum `loadedmetadata` — o player nunca chega a ter metadados.
 * - **`moov` no fim do MP4**: `loadedmetadata` só chega depois de o player pedir
 *   o fim do arquivo. Sem `Content-Range` na resposta a esse pedido, ele nunca
 *   chega: é o sintoma que parece falta de banda e é falta de cabeçalho.
 * - **Codec de vídeo incompatível**: `loadedmetadata` chega, e o que falha é
 *   `canplay`; `canPlayType` do tipo do vídeo responde string vazia.
 * - **Codec de áudio incompatível**: o mesmo de vídeo, mas `canPlayType` do
 *   vídeo responde o tipo e o do áudio responde vazio.
 *
 * Registrar os seis eventos é o que separa os quatro. Sem isso, qualquer um
 * deles vira "não toca", que não ajuda ninguém.
 */
function diagnosticarVideo(video: HTMLVideoElement, rotulo: string): void {
  const estado = {
    rotulo,
    currentTime: video.currentTime,
    duration: video.duration,
    readyState: video.readyState,
    networkState: video.networkState,
    seeking: video.seeking,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  };
  console.info('[player] evento', estado);
}

function diagnosticarErro(video: HTMLVideoElement, rotulo: string): void {
  /*
   * `video.error.message` é quase sempre vazio no Chromium, então registrar
   * apenas ele não diria nada. O código é o que separa as causas, e o
   * `canPlayType` do tipo que o navegador deduziu é o que diz se o problema é
   * de decodificação ou de transporte.
   */
  const tipo = video.canPlayType('video/mp4');
  const tipoGenerico = video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
  console.error('[player] erro', {
    rotulo,
    codigo: video.error?.code,
    mensagem: video.error?.message,
    readyState: video.readyState,
    networkState: video.networkState,
    duration: video.duration,
    videoWidth: video.videoWidth,
    canPlayMp4: tipo,
    canPlayAvcAAC: tipoGenerico,
  });
}

/** O que o erro diz, na ordem em que costuma ajudar mais.
 *
 * O código do `MediaError` sozinho não distingue "sem permissão" de "formato
 * inválido", e o texto do Google às vezes ajuda. Por isso os dois são repassados
 * à mão em vez de confiar em `error.message`, que o navegador deixa vazio na
 * maioria dos casos.
 */
function descreverErro(video: HTMLVideoElement): string {
  switch (video.error?.code) {
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'O navegador não conseguiu reproduzir este arquivo. O formato pode não ser suportado, ou o servidor recusou o pedido.';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'A leitura do arquivo falhou no meio do caminho. Pode ser a conexão ou o servidor de origem.';
    case MediaError.MEDIA_ERR_DECODE:
      return 'O navegador não conseguiu decodificar este arquivo.';
    case MediaError.MEDIA_ERR_ABORTED:
      return 'A leitura do arquivo foi interrompida.';
    default:
      return 'Não foi possível reproduzir este arquivo.';
  }
}

export const FilePlayer = forwardRef<PlayerHandle, Props>(function FilePlayer(
  { src, stream, onReady, onEnded, onError, rotulo = src },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const aoVivo = Boolean(stream);

  /**
   * `srcObject` tem de ser posto depois que o elemento existe, e não logo após
   * o fluxo chegar: no caso do WebRTC o `<video>` pode já estar montado (ao
   * contrário da captura local, que monta junto com o estado), mas o efeito
   * abaixo roda em qualquer ordem. Aqui a fonte é sempre o estado atual, então
   * as duas ordens dão o mesmo resultado.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      // O `load()` é o que efetivamente anexa o fluxo em alguns navegadores
      // quando o elemento já tinha um `src` antes.
      video.load();
    } else {
      video.srcObject = null;
      video.load();
    }
  }, [stream, src]);

  useImperativeHandle(ref, (): PlayerHandle => ({
    play: () => {
      // Autoplay com som pode ser bloqueado; o mute deixa o vídeo seguir e o
      // usuário reativa o áudio pelo controle de volume.
      videoRef.current?.play().catch(() => {
        if (videoRef.current) {
          videoRef.current.muted = true;
          void videoRef.current.play();
        }
      });
    },
    pause: () => videoRef.current?.pause(),
    seek: (s) => {
      // Não dá para posicionar uma transmissão ao vivo: não existe "instante"
      // para saltar. Tentar escrever em `currentTime` de um MediaStream joga
      // fora o buffer ou não faz nada, e a exceção apareceria aqui.
      if (videoRef.current && !aoVivo) videoRef.current.currentTime = s;
    },
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
    // `Infinity` é o que o navegador devolve para mídia ao vivo. Devolver 0
    // faria a barra de progresso da sala mostrar "0 de 0" e a correção de
    // deriva tentar sincronizar todo mundo para o instante zero.
    getDuration: () => videoRef.current?.duration ?? 0,
    setVolume: (v) => {
      if (videoRef.current) videoRef.current.volume = v;
    },
    setMuted: (m) => {
      if (videoRef.current) videoRef.current.muted = m;
    },
    setPlaybackRate: (r) => {
      // Acelerar uma tela compartilhada não tem sentido: o vídeo é gerado na
      // velocidade em que a tela se mexe.
      if (videoRef.current && !aoVivo) videoRef.current.playbackRate = r;
    },
  }));

  return (
    <video
      ref={videoRef}
      // Só com arquivo. `muted` no ao vivo impede o navegador de baixar o
      // volume do sistema inteiro quando a pessoa ajusta o controle.
      src={stream ? undefined : src}
      playsInline
      onLoadedMetadata={() => {
        diagnosticarVideo(videoRef.current as HTMLVideoElement, `${rotulo} loadedmetadata`);
        onReady();
      }}
      onCanPlay={() => diagnosticarVideo(videoRef.current as HTMLVideoElement, `${rotulo} canplay`)}
      onCanPlayThrough={() =>
        diagnosticarVideo(videoRef.current as HTMLVideoElement, `${rotulo} canplaythrough`)
      }
      onWaiting={() => {
        const v = videoRef.current as HTMLVideoElement;
        // `waiting` em rajada é o sintoma do `moov` no fim: o player esvaziou o
        // buffer esperando um trecho que não chega.
        console.info('[player] waiting', { rotulo, readyState: v.readyState, currentTime: v.currentTime });
      }}
      onStalled={() =>
        console.info('[player] stalled', {
          rotulo,
          readyState: videoRef.current?.readyState,
          networkState: videoRef.current?.networkState,
        })
      }
      onError={() => {
        if (videoRef.current) {
          diagnosticarErro(videoRef.current, rotulo);
          onError?.(descreverErro(videoRef.current));
        }
      }}
      // Uma transmissão não "termina": o `MediaStream` segue até o dono
      // parar, e o fim real chega pelo evento `stream:stopped`. Ouvir `ended`
      // aqui dispararia a próxima faixa num close repentino da conexão.
      onEnded={aoVivo ? undefined : onEnded}
      className="absolute inset-0 h-full w-full bg-black object-contain"
    />
  );
});
