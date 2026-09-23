/* eslint-disable @typescript-eslint/no-explicit-any */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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
        },
        events: {
          onReady: () => callbacks.current.onReady(),
          onStateChange: (e: any) => {
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
    play: () => playerRef.current?.playVideo?.(),
    pause: () => playerRef.current?.pauseVideo?.(),
    seek: (s) => playerRef.current?.seekTo?.(s, true),
    getCurrentTime: () => playerRef.current?.getCurrentTime?.() ?? 0,
    getDuration: () => playerRef.current?.getDuration?.() ?? 0,
    setVolume: (v) => playerRef.current?.setVolume?.(Math.round(v * 100)),
    setMuted: (m) => (m ? playerRef.current?.mute?.() : playerRef.current?.unMute?.()),
    setPlaybackRate: (r) => playerRef.current?.setPlaybackRate?.(r),
  }));

  return (
    <div className="absolute inset-0">
      <div ref={hostRef} className="h-full w-full" />
      {/* Bloqueia cliques no iframe: todo controle passa pela barra customizada. */}
      <div className="absolute inset-0" />
    </div>
  );
});
