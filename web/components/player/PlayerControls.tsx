import clsx from 'clsx';
import {
  ArrowsInSimple,
  ArrowsOutSimple,
  Pause,
  Play,
  SkipForward,
  SpeakerHigh,
  SpeakerSimpleX,
  SidebarSimple,
} from '@phosphor-icons/react';
import { useCallback, type ChangeEvent } from 'react';
import { IconButton } from '@/components/ui/Button';
import { formatTime } from '@/lib/media';

interface Props {
  visible: boolean;
  isPlaying: boolean;
  current: number;
  duration: number;
  volume: number;
  muted: boolean;
  canControl: boolean;
  hasNext: boolean;
  isFullscreen: boolean;
  sidebarOpen: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onNext: () => void;
  onVolume: (value: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onToggleSidebar: () => void;
}

export function PlayerControls({
  visible,
  isPlaying,
  current,
  duration,
  volume,
  muted,
  canControl,
  hasNext,
  isFullscreen,
  sidebarOpen,
  onTogglePlay,
  onSeek,
  onNext,
  onVolume,
  onToggleMute,
  onToggleFullscreen,
  onToggleSidebar,
}: Props) {
  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  const handleSeek = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onSeek(Number(e.target.value)),
    [onSeek],
  );

  return (
    <div
      className={clsx(
        'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-3 pt-10 transition-opacity duration-300 ease-out sm:px-5 sm:pb-4',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <label className="sr-only" htmlFor="seek">
        Posição do vídeo
      </label>
      <input
        id="seek"
        type="range"
        min={0}
        max={Math.max(duration, 1)}
        step={0.5}
        value={Math.min(current, duration || 0)}
        onChange={handleSeek}
        disabled={!canControl || duration === 0}
        style={{ ['--progress' as string]: `${progress}%` }}
        className="seek-track h-1 w-full cursor-pointer appearance-none rounded-full transition-[height] duration-150 hover:h-1.5 disabled:cursor-not-allowed
          [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white"
      />

      <div className="mt-2 flex items-center gap-1">
        <IconButton
          label={isPlaying ? 'Pausar' : 'Reproduzir'}
          onClick={onTogglePlay}
          disabled={!canControl}
          className="text-ink hover:bg-white/15"
        >
          {isPlaying ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
        </IconButton>

        <IconButton label="Próximo da fila" onClick={onNext} disabled={!canControl || !hasNext}>
          <SkipForward size={18} weight="fill" />
        </IconButton>

        <div className="group flex items-center gap-1">
          <IconButton label={muted ? 'Ativar som' : 'Silenciar'} onClick={onToggleMute}>
            {muted || volume === 0 ? <SpeakerSimpleX size={18} /> : <SpeakerHigh size={18} />}
          </IconButton>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={(e) => onVolume(Number(e.target.value))}
            style={{ ['--progress' as string]: `${(muted ? 0 : volume) * 100}%` }}
            className="seek-track h-1 w-0 cursor-pointer appearance-none rounded-full opacity-0 transition-all duration-200 ease-out focus:w-20 focus:opacity-100 group-hover:w-20 group-hover:opacity-100
              [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
              [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white"
          />
        </div>

        <span className="ml-1 select-none font-mono text-xs tabular-nums text-white/70">
          {formatTime(current)} <span className="text-white/35">/ {formatTime(duration)}</span>
        </span>

        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label={sidebarOpen ? 'Ocultar painel lateral' : 'Mostrar painel lateral'}
            onClick={onToggleSidebar}
            active={sidebarOpen}
          >
            <SidebarSimple size={18} />
          </IconButton>
          <IconButton
            label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? <ArrowsInSimple size={18} /> : <ArrowsOutSimple size={18} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}
