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
        /* A trilha fica com 4px, mas o alvo sensível é o dobro. O `py-2`
           adiciona 16px de área clicável sem engrossar o desenho — no toque
           uma trilha de 4px é quase impossível de acertar. */
        className="seek-track w-full cursor-pointer appearance-none rounded-full transition-[height] duration-150 hover:h-1.5 disabled:cursor-not-allowed
          [@media(pointer:coarse)]:h-1.5 [@media(pointer:coarse)]:py-2.5
          [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white"
      />

      {/* Uma linha só (`flex-nowrap`): quebrar em duas empurraria a barra para
          baixo do player. O que cede espaço aqui é o volume e o tempo corrente,
          com `shrink`/`hidden` — nunca o play, o painel ou a tela cheia, que
          ficam com `shrink-0`. */}
      <div className="mt-2 flex min-w-0 flex-nowrap items-center gap-1">
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

        <div className="group flex min-w-0 shrink items-center gap-1">
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
                    /* O slider nascia recolhido (`w-0 opacity-0`) e só abria no
               `group-hover`. Toque não tem hover, então o volume era impossível
               de ajustar no celular — só dava para mutar.

               O `group-hover` foi retirado de propósito: com ele, o slider ficava
               aberto com o dedo sobre ele no celular e empurrava a barra, tirando
               o botão de tela cheia da tela. Agora ele abre só por foco (teclado)
               e no toque fica visível, mas compacto (`w-8`), cabendo junto dos
               demais controles em 320px. `shrink-0` impede que o play, o painel
               ou a tela cheia paguem por ele. */
            className="seek-track h-1 w-0 shrink-0 cursor-pointer appearance-none rounded-full opacity-0 transition-all duration-200 ease-out focus:w-20 focus:opacity-100 focus-within:w-20 focus-within:opacity-100 [@media(pointer:coarse)]:w-8 [@media(pointer:coarse)]:opacity-100
              [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
              [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white"
          />
        </div>

        {/* O tempo cede espaço antes de qualquer botão: `shrink` + `truncate`
            deixa só o total aparecer quando a barra aperta, em vez de empurrar
            o botão de tela cheia para fora da tela. */}
        <span className="ml-1 min-w-0 shrink select-none truncate font-mono text-xs tabular-nums text-white/70">
          <span className="[@media(max-width:400px)]:hidden">{formatTime(current)} </span>
          <span className="text-white/35">/ {formatTime(duration)}</span>
        </span>

        {/* `ml-auto` joga este par para a direita quando cabe em uma linha. Por
            ter `shrink-0`, ele não é comprimido quando a linha aperta: em vez
            de sumir, os botões da esquerda é que descem na quebra. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
