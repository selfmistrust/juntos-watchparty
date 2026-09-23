import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { PlayerHandle } from '@/types';

interface Props {
  src: string;
  onReady: () => void;
  onEnded: () => void;
}

export const FilePlayer = forwardRef<PlayerHandle, Props>(function FilePlayer(
  { src, onReady, onEnded },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    videoRef.current?.load();
  }, [src]);

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
      if (videoRef.current) videoRef.current.currentTime = s;
    },
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
    getDuration: () => videoRef.current?.duration ?? 0,
    setVolume: (v) => {
      if (videoRef.current) videoRef.current.volume = v;
    },
    setMuted: (m) => {
      if (videoRef.current) videoRef.current.muted = m;
    },
    setPlaybackRate: (r) => {
      if (videoRef.current) videoRef.current.playbackRate = r;
    },
  }));

  return (
    <video
      ref={videoRef}
      src={src}
      playsInline
      onLoadedMetadata={onReady}
      onEnded={onEnded}
      className="absolute inset-0 h-full w-full bg-black object-contain"
    />
  );
});
