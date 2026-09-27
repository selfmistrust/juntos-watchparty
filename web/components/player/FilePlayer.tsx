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
 * O que o erro diz, na ordem em que costuma ajudar mais.
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
  { src, stream, onReady, onEnded, onError },
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
      onLoadedMetadata={onReady}
      onError={() => {
        if (videoRef.current) onError?.(descreverErro(videoRef.current));
      }}
      // Uma transmissão não "termina": o `MediaStream` segue até o dono
      // parar, e o fim real chega pelo evento `stream:stopped`. Ouvir `ended`
      // aqui dispararia a próxima faixa num close repentino da conexão.
      onEnded={aoVivo ? undefined : onEnded}
      className="absolute inset-0 h-full w-full bg-black object-contain"
    />
  );
});
