import { FilmSlateIcon, PlayIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FilePlayer } from './FilePlayer';
import { PlayerControls } from './PlayerControls';
import { ReactionDock } from './ReactionDock';
import { ReactionsOverlay } from './ReactionsOverlay';
import { YoutubePlayer } from './YoutubePlayer';
import { useFullscreenLandscape } from '@/hooks/useFullscreenLandscape';
import type { RoomActions } from '@/hooks/useRoom';
import type { FloatingReaction, PlaylistItem, PlayerHandle, ReactionEmoji, RoomSnapshot, SoundId } from '@/types';

/** Acima disto o salto é audível e vale um seek seco. */
const HARD_SYNC_THRESHOLD = 1.5;
/** Abaixo disto a diferença é imperceptível; entre os dois, ajustamos a velocidade. */
const SOFT_SYNC_THRESHOLD = 0.35;
const CONTROLS_TIMEOUT = 2800;
/**
 * Altura da barra de controles nativa do YouTube, no rodapé do vídeo.
 *
 * As duas barras não podem coexistir — as duas ocupam esta mesma faixa. Então
 * elas se revezam, e este valor é o que faz o click-catcher de play/pause parar
 * acima dela enquanto a barra nativa está no ar, para o botão de CC receber o
 * clique.
 */
const NATIVE_BAR = 48;

interface Props {
  state: RoomSnapshot | null;
  currentItem: PlaylistItem | null;
  canControl: boolean;
  targetPosition: () => number;
  actions: RoomActions;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  reactions: FloatingReaction[];
}

export function VideoStage({
  state,
  currentItem,
  canControl,
  targetPosition,
  actions,
  sidebarOpen,
  onToggleSidebar,
  reactions,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const readyRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  /** Segunda tentativa de `seek` logo após o player ficar pronto. */
  const seekRetryRef = useRef<ReturnType<typeof setTimeout>>();
  /** Última velocidade enviada ao player, para não repetir o mesmo comando. */
  const lastRateRef = useRef(1);

  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [drifting, setDrifting] = useState(false);
  /*
   * Legenda é preferência de cada pessoa, não estado da sala: fica só no
   * player de quem assistiu e não vai pelo socket. É por isso que a intenção
   * sobrevive à troca de faixa — quem ligou quer ler no próximo vídeo também.
   */
  const [captionsOn, setCaptionsOn] = useState(false);
  /*
   * As duas barras de controle se revezam. A nativa do YouTube só existe para
   * dar acesso ao botão de CC — que é o único jeito de *desligar* legenda, já
   * que a API não tem esse comando. Empilhá-las não funciona: as duas ocupam os
   * mesmos 48px do rodapé, e a de cima chegava a cobrir 98% do vídeo num
   * celular de 320px.
   */
  const [nativeControls, setNativeControls] = useState(false);
  const isYoutube = currentItem?.kind === 'youtube';

  const { isFullscreen, rotate, toggle: toggleFullscreen } = useFullscreenLandscape({ targetRef: stageRef });

  const isPlaying = Boolean(state?.isPlaying);
  const hasNext = Boolean(state && state.currentIndex < state.playlist.length - 1);

  /** Troca de faixa: zera o relógio local e espera o novo player avisar que carregou. */
  useEffect(() => {
    readyRef.current = false;
    lastRateRef.current = 1; // o player novo já nasce em 1x
    setCurrent(0);
    setDuration(0);
    // `captionsOn` é de propósito preservado entre faixas: quem ligou a legenda
    // quer lê-la no próximo vídeo também.
  }, [currentItem?.id]);

  /**
   * Player pronto: alinha volume, posição e estado de play.
   *
   * O `seek` vai duas vezes porque o primeiro é descartado com frequência: o
   * player acabou de ser criado e ainda não tem o vídeo carregado, e o `seek`
   * chega antes. Sem a segunda tentativa, o vídeo voltava para o começo — o que
   * aparecia toda vez que a legenda era alternada, já que aí o player é
   * recriado. A segunda passada também não atrapalha quando a primeira pega:
   *.seek para onde já estamos é no-op.
   *
   * A correção de deriva (a cada 1,2s) também acabaria acertando, mas ela só
   * roda com `isPlaying` — pausado, o seek perdido significava recomeço.
   */
  const handleReady = useCallback(() => {
    readyRef.current = true;
    const player = playerRef.current;
    if (!player) return;
    player.setVolume(volume);
    player.setMuted(muted);
    const at = targetPosition();
    player.seek(at);
    if (isPlaying) player.play();
    setDuration(player.getDuration());

    seekRetryRef.current = setTimeout(() => {
      // Só repete se o player não foi substituído no meio do caminho.
      if (playerRef.current !== player) return;
      if (Math.abs(player.getCurrentTime() - at) > 1.5) player.seek(at);
    }, 700);
  }, [isPlaying, muted, targetPosition, volume]);

  useEffect(() => () => clearTimeout(seekRetryRef.current), []);

  /** Reage a play/pause vindos do servidor. */
  useEffect(() => {
    if (!readyRef.current) return;
    const player = playerRef.current;
    if (!player) return;
    if (isPlaying) player.play();
    else {
      player.pause();
      player.seek(targetPosition());
    }
    // targetPosition muda a cada snapshot; só queremos reagir à transição de estado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, state?.serverTime]);

  /** Relógio de UI. */
  useEffect(() => {
    const id = setInterval(() => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return;
      setCurrent(player.getCurrentTime());
      const d = player.getDuration();
      if (d && Math.abs(d - duration) > 0.5) setDuration(d);
    }, 250);
    return () => clearInterval(id);
  }, [duration]);

  /**
   * Correção de deriva. Diferenças grandes viram seek; pequenas viram uma
   * mudança de velocidade de ±8%, que o ouvido não percebe e que reabsorve
   * o atraso em poucos segundos.
   */
  useEffect(() => {
    const id = setInterval(() => {
      const player = playerRef.current;
      if (!player || !readyRef.current || !isPlaying) return;

      const drift = targetPosition() - player.getCurrentTime();
      const abs = Math.abs(drift);

      // Só chama quando o valor muda: este laço roda a cada 1,2s e, no
      // player do YouTube, cada comando faz a UI nativa reaparecer.
      const setRate = (rate: number) => {
        if (lastRateRef.current === rate) return;
        lastRateRef.current = rate;
        player.setPlaybackRate(rate);
      };

      if (abs > HARD_SYNC_THRESHOLD) {
        player.seek(targetPosition());
        setRate(1);
        setDrifting(true);
      } else if (abs > SOFT_SYNC_THRESHOLD) {
        setRate(drift > 0 ? 1.08 : 0.92);
        setDrifting(true);
      } else {
        setRate(1);
        setDrifting(false);
      }
    }, 1200);
    return () => clearInterval(id);
  }, [isPlaying, targetPosition]);

  /** Auto-hide dos controles: some com o mouse parado, volta ao pausar. */
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    if (isPlaying) {
      hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_TIMEOUT);
    }
  }, [isPlaying]);

  useEffect(() => {
    revealControls();
    return () => clearTimeout(hideTimer.current);
  }, [revealControls]);

  const togglePlay = useCallback(() => {
    if (!canControl) return;
    const at = playerRef.current?.getCurrentTime() ?? 0;
    if (isPlaying) actions.pause(at);
    else actions.play(at);
  }, [actions, canControl, isPlaying]);

  const handleSeek = useCallback(
    (seconds: number) => {
      if (!canControl) return;
      setCurrent(seconds);
      playerRef.current?.seek(seconds);
      actions.seek(seconds);
    },
    [actions, canControl],
  );

  const handleVolume = useCallback((value: number) => {
    setVolume(value);
    setMuted(value === 0);
    playerRef.current?.setVolume(value);
    playerRef.current?.setMuted(value === 0);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      playerRef.current?.setMuted(!prev);
      return !prev;
    });
  }, []);

  const toggleCaptions = useCallback(() => {
    // Trocar a legenda recria o player do YouTube (é a única forma de o
    // `cc_load_policy` valer). Enquanto o novo não fica pronto, o player está
    // no meio do caminho, e o laço de deriva mandaria `seek`/velocidade para
    // ele. Marcar como "não pronto" suspende esses comandos até o `onReady`
    // chegar — o mesmo que a troca de faixa já faz.
    readyRef.current = false;
    lastRateRef.current = 1;
    setCaptionsOn((prev) => !prev);
  }, []);

  /** Reações e sons não exigem controle da sala — qualquer participante pode mandar. */
  const handleReaction = useCallback((emoji: ReactionEmoji) => actions.sendReaction(emoji), [actions]);
  const handleSound = useCallback((soundId: SoundId) => actions.sendSound(soundId), [actions]);

  /**
   * Entrega os controles ao YouTube, ou os traz de volta.
   *
   * Ao voltar para a nossa barra, esconde a nativa na hora: o `YT.Player`
   * reconstrói a UI a cada comando nosso, e sem isso a barra do YouTube
   * reapareceria por cima assim que a correção de deriva fizesse o próximo
   * `seek`.
   */
  const toggleNativeControls = useCallback(() => {
    setNativeControls((prev) => {
      if (prev) playerRef.current?.hideNativeControls?.();
      return !prev;
    });
  }, []);

  // A nativa é do player do YouTube: trocar de item tem que devolver a nossa.
  useEffect(() => {
    setNativeControls(false);
  }, [currentItem?.id]);

  /** Atalhos de teclado clássicos de player. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (e.code === 'Space' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') handleSeek(current + 10);
      else if (e.key === 'ArrowLeft') handleSeek(Math.max(0, current - 10));
      else if (e.key.toLowerCase() === 'm') toggleMute();
      else if (e.key.toLowerCase() === 'c') toggleCaptions();
      else if (e.key.toLowerCase() === 'f') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, handleSeek, toggleCaptions, togglePlay, toggleFullscreen, toggleMute]);

  return (
    <div
      ref={stageRef}
      onMouseMove={revealControls}
      onTouchStart={revealControls}
      className={clsx(
        'group relative aspect-video w-full overflow-hidden rounded-2xl bg-black ring-1 ring-hairline lg:aspect-auto lg:h-full lg:rounded-none lg:ring-0',
        isFullscreen && 'stage-fullscreen',
        // No celular, se a tela continuou em pé depois do fullscreen, o palco
        // é girado por CSS para o vídeo ficar na horizontal.
        isFullscreen && rotate && 'stage-fullscreen--landscape',
        !controlsVisible && isPlaying && 'cursor-none',
      )}
    >
      {currentItem ? (
        currentItem.kind === 'youtube' ? (
          <YoutubePlayer
            key={currentItem.id}
            ref={playerRef}
            videoId={currentItem.src}
            captionsOn={captionsOn}
            onReady={handleReady}
            onEnded={actions.ended}
          />
        ) : (
          <FilePlayer
            key={currentItem.id}
            ref={playerRef}
            src={currentItem.src}
            onReady={handleReady}
            onEnded={actions.ended}
          />
        )
      ) : (
        <EmptyStage />
      )}

      {/*
        * Clique na imagem para dar play/pause, como em qualquer player.
        *
        * Com a barra nativa no ar, a faixa de baixo fica de fora: é onde ela
        * fica, e o botão de CC mora nela. Se este click-catcher cobrisse até o
        * rodapé, o botão de CC nunca receberia o clique — que é justamente o
        * motivo de a barra nativa existir.
        */}
      {currentItem && (
        <button
          aria-label={isPlaying ? 'Pausar' : 'Reproduzir'}
          onClick={togglePlay}
          disabled={!canControl}
          className="absolute inset-x-0 top-0 z-10 cursor-default disabled:cursor-not-allowed"
          /* Sempre com `bottom`: sem ele o elemento colapsa para altura zero,
             já que o `top-0` está fixo. Só o valor muda — 0 no normal, a altura
             da barra nativa quando ela está no ar. */
          style={{ bottom: nativeControls ? NATIVE_BAR : 0 }}
        />
      )}

      {currentItem && !isPlaying && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <span className="animate-fade-up flex h-16 w-16 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
            <PlayIcon size={28} weight="fill" className="ml-0.5 text-white" />
          </span>
        </div>
      )}

      {drifting && isPlaying && (
        <span className="animate-fade-up absolute left-4 top-4 z-20 rounded-full bg-black/60 px-3 py-1 text-2xs text-white/70 backdrop-blur-sm">
          Ajustando a sincronia…
        </span>
      )}

      <ReactionsOverlay reactions={reactions} />

      {currentItem && (
        <ReactionDock
          visible={controlsVisible || !isPlaying}
          onReaction={handleReaction}
          onSound={handleSound}
        />
      )}

      {/*
        * Com a barra nativa no ar, a nossa dá lugar. E, no canto, um botão
        * pequeno traz a nossa de volta — sem ele não haveria caminho para
        * partir dos controles do YouTube.
        */}
      {currentItem && nativeControls && (
        <button
          type="button"
          onClick={toggleNativeControls}
          className="animate-fade-up absolute bottom-3 right-3 z-20 rounded-lg bg-black/70 px-2.5 py-1.5 text-2xs text-white/80 backdrop-blur-sm transition-colors duration-150 hover:bg-black/85 hover:text-white"
        >
          Voltar aos controles juntos
        </button>
      )}

      {currentItem && !nativeControls && (
        <PlayerControls
          visible={controlsVisible || !isPlaying}
          isPlaying={isPlaying}
          current={current}
          duration={duration}
          volume={volume}
          muted={muted}
          canControl={canControl}
          hasNext={hasNext}
          isFullscreen={isFullscreen}
          sidebarOpen={sidebarOpen}
          captionsOn={currentItem?.kind === 'youtube' ? captionsOn : undefined}
          onTogglePlay={togglePlay}
          onSeek={handleSeek}
          onNext={() => state && actions.selectTrack(state.currentIndex + 1)}
          onVolume={handleVolume}
          onToggleMute={toggleMute}
          onToggleCaptions={toggleCaptions}
          onHandOverToNative={isYoutube ? toggleNativeControls : undefined}
          onToggleFullscreen={toggleFullscreen}
          onToggleSidebar={onToggleSidebar}
        />
      )}
    </div>
  );
}

function EmptyStage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FilmSlateIcon size={32} className="text-ink-faint" />
      <p className="text-sm text-ink-muted">Nenhum vídeo na fila.</p>
      <p className="max-w-xs text-sm text-ink-faint">
        Use &quot;Adicionar de uma aplicação&quot; na aba Fila para escolher de onde vem o vídeo.
      </p>
    </div>
  );
}
