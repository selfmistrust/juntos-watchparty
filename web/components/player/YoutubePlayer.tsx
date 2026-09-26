/* eslint-disable @typescript-eslint/no-explicit-any */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { loadYoutubeApi } from '@/lib/youtubeApi';
import type { PlayerHandle } from '@/types';

interface Props {
  videoId: string;
  onReady: () => void;
  onEnded: () => void;
}

/**
 * Os controles nativos ficam desligados: quem comanda é a barra customizada,
 * para que nenhum clique escape da sincronização do servidor.
 */
export const YoutubePlayer = forwardRef<PlayerHandle, Props>(function YoutubePlayer(
  { videoId, onReady, onEnded },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const callbacks = useRef({ onReady, onEnded });
  callbacks.current = { onReady, onEnded };

  /** Esconde a UI nativa do player do YouTube, se ele tiver sido criado. */
  const hideChrome = useCallback(() => {
    try {
      playerRef.current?.hideControls?.();
    } catch {
      // Player ainda não pronto, ou já destruído.
    }
  }, []);

  /**
   * Rede de segurança para o chrome nativo.
   *
   * Chamar `hideControls()` só nos eventos resolve o caso comum, mas o
   * YouTube volta a exibir a barra sozinho depois de alguns segundos — e entre
   * uma chamada e outra ela fica visível, por cima dos controles da watchparty.
   * Como o embed é cross-origin, não dá para zerar isso por CSS. Um intervalo
   * curto garante que a UI esteja escondida no momento em que for olhada, em
   * vez de torcer para a próxima chamada chegar antes do usuário olhar.
   *
   * O custo é um postMessage por segundo, o que é irrelevante em comparação
   * com a correção de deriva, que já manda vários por ciclo.
   */
  useEffect(() => {
    const id = setInterval(hideChrome, 700);
    return () => clearInterval(id);
  }, [hideChrome, videoId]);

  useEffect(() => {
    let cancelled = false;

    loadYoutubeApi().then((YT) => {
      if (cancelled || !hostRef.current) return;

      if (playerRef.current) {
        playerRef.current.loadVideoById(videoId);
        return;
      }

      playerRef.current = new YT.Player(hostRef.current, {
        videoId,
        playerVars: {
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          // Sem o botão de tela cheia do próprio YouTube: quem manda é o
          // controle da watchparty, e os dois se sobrepunham.
          fs: 0,
        },
        events: {
          onReady: () => {
            hideChrome();
            callbacks.current.onReady();
          },
          onStateChange: (e: any) => {
            // `controls: 0` não é garantia: o player do YouTube ainda exibe a
            // barra inferior em algumas interações (pausa, toque, foco), e ela
            // cai exatamente em cima dos controles da watchparty. Como o
            // embed é cross-origin, não dá para esconder por CSS — a API
            // expõe `hideControls()` para isso.
            hideChrome();
            if (e.data === YT.PlayerState.ENDED) callbacks.current.onEnded();
          },
        },
      });
    });

    return () => {
      cancelled = true;
    };
  }, [videoId]);

  useEffect(
    () => () => {
      playerRef.current?.destroy?.();
      playerRef.current = null;
    },
    [],
  );

  useImperativeHandle(ref, (): PlayerHandle => ({
    // Cada comando enviado ao player do YouTube acaba fazendo a UI nativa
    // reaparecer — e a correção de deriva do VideoStage chama `seek` e
    // `setPlaybackRate` a cada ~1,2s. Sem repetir o `hideControls` aqui, a
    // barra do YouTube voltaria o tempo todo por cima dos controles da
    // watchparty, que é exatamente o sintoma reportado.
    play: () => {
      playerRef.current?.playVideo?.();
      hideChrome();
    },
    pause: () => {
      playerRef.current?.pauseVideo?.();
      hideChrome();
    },
    seek: (s) => {
      playerRef.current?.seekTo?.(s, true);
      hideChrome();
    },
    getCurrentTime: () => playerRef.current?.getCurrentTime?.() ?? 0,
    getDuration: () => playerRef.current?.getDuration?.() ?? 0,
    setVolume: (v) => {
      playerRef.current?.setVolume?.(Math.round(v * 100));
      hideChrome();
    },
    setMuted: (m) => {
      if (m) playerRef.current?.mute?.();
      else playerRef.current?.unMute?.();
      hideChrome();
    },
    setPlaybackRate: (r) => {
      playerRef.current?.setPlaybackRate?.(r);
      hideChrome();
    },
  }));

  return (
    <div className="absolute inset-0">
      {/* O wrapper do player recebe os estilos do YT; o `pointer-events-none`
          garante que nenhum clique, toque ou arrasto chegue no embed, mesmo
          antes do div de bloqueio abaixo existir. */}
      <div ref={hostRef} className="pointer-events-none h-full w-full" />
      {/* Bloqueia cliques no iframe: todo controle passa pela barra customizada. */}
      <div className="absolute inset-0" />
    </div>
  );
});
