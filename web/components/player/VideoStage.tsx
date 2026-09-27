import { FilmSlateIcon, PlayIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FilePlayer } from './FilePlayer';
import { PlayerControls } from './PlayerControls';
import { ReactionDock } from './ReactionDock';
import { ReactionsOverlay } from './ReactionsOverlay';
import { YoutubePlayer } from './YoutubePlayer';
import { DriveVideo } from './DriveVideo';
import { useFullscreenLandscape } from '@/hooks/useFullscreenLandscape';
import type { RoomActions } from '@/hooks/useRoom';
import type { FloatingReaction, PlaylistItem, PlayerHandle, ReactionEmoji, RoomSnapshot } from '@/types';

/** Acima disto o salto é audível e vale um seek seco. */
const HARD_SYNC_THRESHOLD = 1.5;
/** Abaixo disto a diferença é imperceptível; entre os dois, ajustamos a velocidade. */
const SOFT_SYNC_THRESHOLD = 0.35;
const CONTROLS_TIMEOUT = 2800;

interface Props {
  state: RoomSnapshot | null;
  currentItem: PlaylistItem | null;
  canControl: boolean;
  targetPosition: () => number;
  actions: RoomActions;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  reactions: FloatingReaction[];
  /**
   * Mídia de uma faixa `stream`: o próprio `MediaStream` de quem transmite,
   * ou o que chegou por WebRTC de outra pessoa. `null` enquanto a conexão não
   * fecha, e é por isso que o palco precisa de um estado de espera próprio.
   */
  liveStream?: MediaStream | null;
  /** A conexão com quem transmite está em andamento. */
  liveConnecting?: boolean;
  liveError?: string | null;
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
  liveStream,
  liveConnecting,
  liveError,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const readyRef = useRef(false);
  /*
   * `targetPosition` num ref, e o motivo é a lista de dependências.
   *
   * Ela é um `useCallback([state])`, então ganha **identidade nova a cada
   * snapshot** — e snapshot chega a cada play, pause e seek de qualquer pessoa da
   * sala. Listá-la como dependência dos laços recriava o `setInterval` inteiro a
   * cada comando, reiniciando o contador de 1,2 s da correção de deriva antes
   * que ela completasse um tique. Com gente dando play e pause, a deriva nunca
   * chegava a ser corrigida, e a sala slowly saía de sincronia sem que nada
   * aparecesse na tela.
   *
   * Pelo ref, o laço lê sempre a função atual sem depender da identidade dela.
   * O `useEffect` passa a reagir só ao que realmente importa: se está tocando,
   * e se a faixa é ao vivo.
   */
  const targetRef = useRef(targetPosition);
  targetRef.current = targetPosition;
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
   * Só o YouTube tem legenda, e o `PlayerControls` esconde o botão sem legenda
   * quando recebe `undefined` — a distinção é a do item da fila, não a do player
   * montado: o Drive e o arquivo local não têm faixa para carregar.
   */
  /**
   * Faixa ao vivo: a sincronização por posição não se aplica.
   *
   * Ela foi construída sobre `position`, que só existe em mídia com começo e
   * fim. Numa tela compartilhada não há posição a sincronizar — o mesmo
   * instante chega pelo relógio da mídia — e rodar o cálculo ali tentaria
   * manter todo mundo no "segundo zero" de uma imagem que não tem começo. Por
   * isso cada laço abaixo sai cedo neste caso, em vez de confiar no
   * `PlayerHandle` para no-op: um `seek` em `MediaStream` não é no-op, e um
   * `getDuration` devolve `Infinity`.
   */
  const isStream = currentItem?.kind === 'stream';
  /*
   * Se há mídia sob o dedo — o que o click-catcher precisa para ter sentido.
   *
   * Quem responde é o `DriveVideo`, e não este componente: só ele sabe em que
   * etapa da preparação o vídeo do Drive está, e a etapa é o que decide se o
   * painel está pedindo um clique dele. Para o resto das fontes há sempre mídia,
   * então o padrão é `true` e o catcher se comporta como sempre.
   */
  const [driveMediaPronta, setDriveMediaPronta] = useState(false);
  const mediaPronta = currentItem?.kind === 'drive' ? driveMediaPronta : true;

  const { isFullscreen, rotate, toggle: toggleFullscreen } = useFullscreenLandscape({ targetRef: stageRef });

  const isPlaying = Boolean(state?.isPlaying);
  const hasNext = Boolean(state && state.currentIndex < state.playlist.length - 1);

  /** Troca de faixa: zera o relógio local e espera o novo player avisar que carregou. */
  useEffect(() => {
    readyRef.current = false;
    lastRateRef.current = 1; // o player novo já nasce em 1x
    setCurrent(0);
    setDuration(0);
    // A faixa anterior não decide se a nova tem mídia pronta: um vídeo de Drive
    // pode estar em `carregando` e o seguinte ser um upload, e o estado que
    // sobraria de um para o outro cobriria o painel do Drive sem ele estar em uso.
    setDriveMediaPronta(false);
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
    if (isPlaying) player.play();

    // Ao vivo não há para onde pular, e a barra de progresso fica em 0 de 0.
    if (isStream) {
      setDuration(0);
      return;
    }

    const at = targetRef.current();
    player.seek(at);
    setDuration(player.getDuration());

    seekRetryRef.current = setTimeout(() => {
      // Só repete se o player não foi substituído no meio do caminho.
      if (playerRef.current !== player) return;
      if (Math.abs(player.getCurrentTime() - at) > 1.5) player.seek(at);
    }, 700);
  }, [isPlaying, isStream, muted, volume]);

  useEffect(() => () => clearTimeout(seekRetryRef.current), []);

  /** Reage a play/pause vindos do servidor. */
  useEffect(() => {
    if (!readyRef.current) return;
    const player = playerRef.current;
    if (!player) return;
    if (isPlaying) player.play();
    else if (!isStream) {
      player.pause();
      player.seek(targetRef.current());
    }
    /*
     * Reage ao *estado*, não a cada snapshot. Um `play` repetido a cada snapshot
     * seria um laço: o comando reativa o player, o player emite um evento, o
     * evento pode gerar outro snapshot, e a sala gasta banda com um `play` que
     * não muda nada. A dependência é `isPlaying`, e é a transição que importa.
     */
  }, [isPlaying, isStream]);

  /** Relógio de UI. */
  useEffect(() => {
    // Ao vivo o relógio mostraria uma posição que não corresponde a nada, já que
    // a barra de progresso some.
    if (isStream) return;
    const id = setInterval(() => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return;
      setCurrent(player.getCurrentTime());
      const d = player.getDuration();
      if (d && Math.abs(d - duration) > 0.5) setDuration(d);
    }, 250);
    return () => clearInterval(id);
  }, [duration, isStream]);

  /**
   * Correção de deriva. Diferenças grandes viram seek; pequenas viram uma
   * mudança de velocidade de ±8%, que o ouvido não percebe e que reabsorve
   * o atraso em poucos segundos.
   */
  useEffect(() => {
    // Sem isto, a correção de deriva.seekaria uma tela compartilhada para a
    // posição projetada da sala, que é 0 para sempre num item `stream`.
    if (isStream) return;
    const id = setInterval(() => {
      const player = playerRef.current;
      if (!player || !readyRef.current || !isPlaying) return;

      const alvo = targetRef.current();
      const drift = alvo - player.getCurrentTime();
      const abs = Math.abs(drift);

      // Só chama quando o valor muda: este laço roda a cada 1,2s e, no
      // player do YouTube, cada comando faz a UI nativa reaparecer.
      const setRate = (rate: number) => {
        if (lastRateRef.current === rate) return;
        lastRateRef.current = rate;
        player.setPlaybackRate(rate);
      };

      if (abs > HARD_SYNC_THRESHOLD) {
        player.seek(alvo);
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
  }, [isPlaying, isStream]);

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

  /** Reações não exigem controle da sala — qualquer participante pode mandar. */
  const handleReaction = useCallback((emoji: ReactionEmoji) => actions.sendReaction(emoji), [actions]);

  /** Atalhos de teclado clásicos de player. */
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
        ) : currentItem.kind === 'drive' && currentItem.driveFileId ? (
          /*
           * A faixa `drive` tem player próprio porque depende de uma condição
           * que nenhum outro tem: se a conta de quem assiste já está autorizada
           * sobre o arquivo. Ela tem posição seekável como qualquer arquivo, e
           * por isso a sincronização da sala continua funcionando igual — muda o
           * de onde vêm os bytes, não o que se faz com o tempo.
           */
          <DriveVideo
            key={currentItem.id}
            ref={playerRef}
            fileId={currentItem.driveFileId}
            onReady={handleReady}
            onEnded={actions.ended}
            onMediaPronta={setDriveMediaPronta}
          />
        ) : (
          <>
            {/*
              * A faixa `stream` usa o mesmo player de arquivo, alimentado por
              * `srcObject`. Enquanto o fluxo não chega, o palco mostra o estado
              * real em vez de um retângulo preto — que é indistinguível de
              * "quebrou" e é a pior coisa que um player de vídeo pode fazer.
              */}
            {isStream && !liveStream && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black px-6 text-center">
                <p className="text-sm text-ink-muted">
                  {liveError ?? (liveConnecting ? 'Conectando à transmissão…' : 'Preparando a transmissão…')}
                </p>
                {liveError && <p className="text-2xs text-ink-faint">Acontece quando as redes não se alcançam.</p>}
              </div>
            )}
            <FilePlayer
              key={currentItem.id}
              ref={playerRef}
              src={currentItem.src}
              stream={isStream ? liveStream : null}
              onReady={handleReady}
              onEnded={actions.ended}
            />
          </>
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
        *
        * ## Por que ele não cobre o painel do Drive
        *
        * Este botão é `absolute inset-x-0 top-0` com `bottom: 0`: cobre o palco
        * inteiro, em `z-10`, e é um `<button>` — então **captura o clique de tudo
        * que estiver por baixo**. O painel do Drive fica dentro do mesmo palco, e
        * o botão "Conectar o Google Drive" ficava embaixo dele: visível, parecendo
        * ativo, e sem receber o clique.
        *
        * O sintoma é o pior possível para quem tenta usar: um botão que parece
        * funcionar e não faz nada, sem mensagem nenhuma. A causa não era
        * `disabled`, era o `z-index`.
        *
        * A condição abaixo é `mediaPronta`: sem mídia tocando não há play/pause
        * para alternar, e o painel precisa dos cliques. Vale para o Drive em
        * qualquer etapa de preparação e para o YouTube carregando — o catcher só
        * faz sentido com vídeo sob o dedo.
        */}
      {currentItem && mediaPronta && (
        <button
          aria-label={isPlaying ? 'Pausar' : 'Reproduzir'}
          onClick={togglePlay}
          disabled={!canControl}
          /*
           * `outline-none` com um anel desenhado à mão: o padrão do navegador
           * contorna o elemento inteiro, e este elemento é o palco todo — o
           * anel sairia da tela. Aqui o anel acompanha o disco do centro, que é
           * onde o olho está.
           *
           * O anel é desenhado no próprio catcher (uma borda interna) e não no
           * disco, porque o disco só existe quando está pausado: quem está
           * tocando e navega por teclado precisa ver o foco em algum lugar, e o
           * catcher é o único elemento focável do palco.
           */
          className="absolute inset-0 z-10 cursor-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 disabled:cursor-not-allowed"
          /*
           * Cobre o palco inteiro, rodapé incluído.
           *
           * Antes o `bottom` era 48px para deixar a faixa da barra nativa livre,
           * e o `PlayerControls` sentava acima dela. Com `controls: 0` não há
           * mais nada embaixo: a nossa barra é a única, e ela é `z-20` contra o
           * `z-10` deste catcher — então ela continua clicável por cima e o resto
           * do palco continua pertencendo ao play/pausa.
           *
           * A faixa de baixo deixou de ser zona morta por acidente: clicar nela
           * dá play, como em qualquer player. Antes, clicar embaixo não fazia
           * nada, e o lugar onde a barra estava era justamente onde o polegar
           * já estava.
           *
           * `inset-0` substitui `inset-x-0 top-0` mais o `style`: com `top-0`
           * fixo e sem `bottom`, o elemento colapsa para altura zero.
           */
        />
      )}

      {currentItem && !isPlaying && (
        /*
         * O botão do centro é decorativo: quem recebe o clique é o catcher
         * acima. Por isso o wrapper é `pointer-events-none` — se ele pegasse o
         * clique, roubaria o play/pause de quem clica no vídeo.
         *
         * O hover vem do `group-hover` do palco, e é por isso que funciona
         * apesar do `pointer-events-none`: o `:hover` sobe para os ancestrais, e o
         * catcher — que é o elemento de verdade sob o cursor — é filho do mesmo
         * `group`. O elemento com `pointer-events: none` não é alvo do ponteiro,
         * mas o grupo ao redor continua recebendo o hover normalmente.
         *
         * São três estados, e o terceiro é o de quem não pode dar play:
         *
         * - parado: o disco de hoje, sem mudança;
         * - hover ou foco: o disco clareia e cresce um pouco, e o ícone anda
         *   1px. Deliberadamente pouco — o disco fica no centro do vídeo, e um
         *   efeito grande ali é mais barulho do que confirmação;
         * - sem permissão: nenhuma reação, para não sugerir que o clique
         *   funciona. Quem não controla vê o ícone estático.
         */
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <span
            className={clsx(
              'animate-fade-up flex h-16 w-16 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm',
              'transition-[background-color,transform] duration-150 ease-out',
              canControl && 'group-hover:scale-105 group-hover:bg-black/70',
              canControl && 'group-focus-within:scale-105 group-focus-within:bg-black/70',
            )}
          >
            <PlayIcon
              size={28}
              weight="fill"
              className={clsx(
                'ml-0.5 text-white transition-transform duration-150 ease-out',
                canControl && 'group-hover:translate-x-px group-focus-within:translate-x-px',
              )}
            />
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
        <ReactionDock visible={controlsVisible || !isPlaying} onReaction={handleReaction} />
      )}

      {/*
        * A nossa barra é a única, e o `z-20` a põe acima do click-catcher, que é
        * `z-10`. Antes havia um modo em que a nossa dava lugar à nativa do
        * YouTube, com um botão no canto para voltar; com `controls: 0` esse
        * caminho não existe mais e o botão junto com ele.
        */}
      {currentItem && (
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
          live={isStream}
          onTogglePlay={togglePlay}
          onSeek={handleSeek}
          onNext={() => state && actions.selectTrack(state.currentIndex + 1)}
          onVolume={handleVolume}
          onToggleMute={toggleMute}
          onToggleCaptions={toggleCaptions}
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
