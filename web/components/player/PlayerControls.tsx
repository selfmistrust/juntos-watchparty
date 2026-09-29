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
  Subtitles,
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
  /**
   * Só o player do YouTube tem legenda. `undefined` esconde o botão — é
   * assim que o `VideoStage` diz "este item não tem legenda para ligar",
   * sem o `PlayerControls` precisar saber de onde vem o vídeo.
   */
  captionsOn?: boolean;
  /**
   * Transmissão ao vivo. Troca o relógio por um selo e desliga a barra de
   * progresso, que num `MediaStream` não tem para onde apontar.
   */
  live?: boolean;
  /**
   * A barra mostra **a sua** posição, e não a da sala.
   *
   * O vídeo e a transmissão têm uma posição só: o servidor a guarda, e todos
   * puxam dela. O Spotify não tem essa posição. O áudio sai do Web Playback SDK
   * na conta de cada pessoa, no dispositivo de cada pessoa, e o servidor não tem
   * como saber onde cada uma está — nem como mandar todas para o mesmo lugar.
   *
   * Por isso a barra fica visível e arrastável=false. Arrastar e ver o contador
   * andar só na sua máquina ensinaria que a sala está sincronizada, e ela não
   * está: a faixa seguinte começa do zero para cada pessoa. A barra desabilitada
   * com um aviso curto diz a verdade sem roubar o espaço de nada.
   */
  pessoal?: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onNext: () => void;
  onVolume: (value: number) => void;
  onToggleMute: () => void;
  onToggleCaptions: () => void;
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
  captionsOn,
  live,
  pessoal,
  onTogglePlay,
  onSeek,
  onNext,
  onVolume,
  onToggleMute,
  onToggleCaptions,
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
        /*
         * O `pt` é o fade do gradiente, e ele é o que mais come o vídeo nas
         * telas pequenas: num palco de 167px de altura, 40px de fade são um
         * quarto da imagem. Por isso ele cai para 20px no celular e volta a 40px
         * a partir de `sm`, onde o palco é grande o bastante para o fade
         * readability-count. O `pb` acompanha a mesma ideia, menor.
         */
        'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2 pt-5 transition-opacity duration-300 ease-out sm:px-5 sm:pb-4 sm:pt-10',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {/*
        * A barra some inteira numa transmissão ao vivo. Deixá-la desabilitada
        * parecia mais seguro, mas um range desabilitado e vazio é pior do que
        * nada: parece quebrado, e não dá pista do que houve. O selo "Ao vivo" e
        * o estado do palco é que explicam.
        */}
      {!live && (
        <>
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
            disabled={!canControl || duration === 0 || pessoal}
            title={
              pessoal
                ? 'A posição é só a da sua conta: o Spotify toca na sua máquina e a sala não governa esse relógio.'
                : undefined
            }
            style={{ ['--progress' as string]: `${progress}%` }}
            /* A trilha fica com 4px, mas o alvo sensível é o dobro. O `py-2`
               adiciona 16px de área clicável sem engrossar o desenho — no toque
               uma trilha de 4px é quase impossível de acertar. */
            className="seek-track w-full cursor-pointer appearance-none rounded-full transition-[height] duration-150 hover:h-1.5 disabled:cursor-not-allowed
              [@media(pointer:coarse)]:h-1.5 [@media(pointer:coarse)]:py-2.5
              [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
              [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white"
          />
        </>
      )}

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
            /*
             * O slider nasce recolhido (`w-0 opacity-0`) e abre no hover, no
             * foco e no toque.
             *
             * ## O que aconteceu
             *
             * O `group-hover` foi removido em `fa20a0c`, numa auditoria de
             * responsividade. A intenção era boa e o problema era real: no celular
             * não existe hover, então o `group-hover` mantinha o slider
             * recolhido e o volume só podia ser mutado. Mas a remoção **levou
             * junto o desktop**, onde o hover funciona — e o slider ficou
             * invisível para todo mundo, sem que nada quebrasse ou aparecesse no
             * console. O botão continuava alternando mudo e desmutido, que é
             * exatamente o comportamento que fica parecendo "só falta a barra".
             *
             * ## A correção
             *
             * O hover volta, e a causa do problema do celular é tratada no lugar
             * certo: `pointer: coarse` não tem hover, e o `group-hover` sozinho
             * não chega lá. Então as duas condições são independentes:
             *
             * - ponteiro fino (desktop): abre no `group-hover` e no foco;
             * - ponteiro grosso (toque): já vem aberto, compacto (`w-8`), sem
             *   depender de hover;
             * - teclado: o `focus-visible` abre, e é o que mantém o controle
             *   alcançável sem mouse.
             *
             * `shrink-0` impede que o play, o painel ou a tela cheia paguem por
             * ele, que é o que a barra de 320px não comporta.
             */
            className="seek-track h-1 w-0 shrink-0 cursor-pointer appearance-none rounded-full opacity-0 transition-all duration-200 ease-out group-hover:w-20 group-hover:opacity-100 focus-visible:w-20 focus-visible:opacity-100 focus-within:w-20 focus-within:opacity-100 [@media(pointer:coarse)]:w-8 [@media(pointer:coarse)]:opacity-100
              [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
              [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white"
          />
        </div>

        {/*
          * Legenda não é controle da sala: cada pessoa escolhe, igual ao volume.
          * Não ganha `disabled={!canControl}` de propósito — quem não controla a
          * reprodução também pode querer ler.
          *
          * Fica escondido quando o item não é do YouTube (`captionsOn` é
          * `undefined` nesse caso, o FilePlayer não manda a prop), porque não
          * há legenda para ligar.
          */}
          {captionsOn !== undefined && (
            <IconButton
              label={captionsOn ? 'Desligar legenda' : 'Ligar legenda'}
              onClick={onToggleCaptions}
              active={captionsOn}
              aria-pressed={captionsOn}
              className="shrink-0"
            >
              <Subtitles size={18} weight={captionsOn ? 'fill' : 'regular'} />
            </IconButton>
          )}

        {/* O tempo cede espaço antes de qualquer botão: `shrink` + `truncate`
            deixa só o total aparecer quando a barra aperta, em vez de empurrar
            o botão de tela cheia para fora da tela.

            Numa transmissão ao vivo não há tempo: a imagem não tem começo nem
            fim, e mostrar "0:00 / 0:00" seria pior que não mostrar nada. No
            lugar, o selo deixa claro que o que está na tela é outra pessoa. */}
        {live ? (
          <span className="ml-1 flex shrink-0 items-center gap-1.5 rounded-md bg-live/90 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            Ao vivo
          </span>
        ) : pessoal ? (
          /*
           * O tempo é real e é o da sua conta — mas não é o da sala, e o texto
           * diz isso em vez de deixar a barra falar por si. Sem o selo, a barra
           * desabilitada parece defeito; com ele, é informação.
           */
          <span
            className="ml-1 flex shrink-0 items-center gap-1.5 whitespace-nowrap"
            title="O Spotify toca na sua conta, no seu dispositivo. A sala não controla este relógio."
          >
            <span className="font-mono text-xs tabular-nums text-white/70">
              <span className="[@media(max-width:400px)]:hidden">{formatTime(current)} </span>
              <span className="text-white/35">/ {formatTime(duration)}</span>
            </span>
            <span className="hidden text-2xs text-white/45 [@media(min-width:520px)]:inline">na sua conta</span>
          </span>
        ) : (
          <span className="ml-1 min-w-0 shrink select-none truncate font-mono text-xs tabular-nums text-white/70">
            <span className="[@media(max-width:400px)]:hidden">{formatTime(current)} </span>
            <span className="text-white/35">/ {formatTime(duration)}</span>
          </span>
        )}

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
