/* eslint-disable @typescript-eslint/no-explicit-any */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { loadYoutubeApi } from '@/lib/youtubeApi';
import type { PlayerHandle } from '@/types';

interface Props {
  videoId: string;
  /** Intenção da pessoa: legenda ligada ou desligada. Controlled pelo VideoStage. */
  captionsOn: boolean;
  onReady: () => void;
  onEnded: () => void;
}

/**
 * Params de legenda para o playerVar.
 *
 * Só o "ligado" existe de verdade. A IFrame Player API não tem como desligar
 * legenda, e isso foi conferido com a legenda visível na tela, não só lendo
 * estado: sem param nenhum ela aparece, com `cc_load_policy=0` também, com
 * `cc_lang_pref` inválido também, no domínio `youtube-nocookie.com` também, e
 * `setOption('captions', 'track', …)` só aceita faixa válida. Em
 * `getOptions('captions')` não existe verbo de "esconder legenda" — só
 * `reload`, `fontSize`, `track`, `tracklist`, `translationLanguages` e
 * `sampleSubtitle`.
 *
 * A única alavanca que funciona é `cc_load_policy: 1`, lida na construção do
 * player. Por isso o botão da watchparty liga (recriando o player) e o botão de
 * CC do próprio YouTube é quem desliga.
 *
 * Português porque é o idioma de quase todo mundo na sala. O YouTube respeita a
 * ordem: se não houver faixa em português, ele cai para outra.
 */
function legendaParams(captionsOn: boolean): Record<string, string> {
  if (!captionsOn) return {};
  return { cc_load_policy: '1', cc_lang_pref: 'pt' };
}

/**
 * Player do YouTube.
 *
 * ## A barra nativa fica ligada, de propósito
 *
 * Ela ficava desligada (`controls: 0`) para nenhum clique escapar da
 * sincronização do servidor, e o efeito colateral foi o botão de CC sumir junto.
 * Como a API não tem como desligar legenda, quem dependia dela ficava preso sem
 * nenhum jeito de desligá-la. Com a barra nativa de volta, o botão de CC volta
 * junto, e é ele quem resolve.
 *
 * A divisão ficou: o botão da nossa barra **liga**, o do YouTube **desliga**.
 *
 * ## O que continua sendo nosso
 *
 * `disablekb` continua ligado: play, pausa e busca por teclado têm de passar
 * pela sala, senão uma pessoa desincroniza a sala inteira. O botão de CC
 * continua alcançável por Tab e Enter, que não é atalho de teclado do player.
 *
 * Usar o play ou a pausa da barra nativa desincroniza na hora, mas o efeito
 * que reage a `isPlaying` roda a cada snapshot do servidor e re-imprime o
 * estado — então o ruim dura no máximo um ciclo.
 *
 * A sobreposição das duas barras é resolvida no `VideoStage`: o click-catcher
 * de play/pause deixa livre a faixa de baixo, e a nossa barra senta acima da
 * nativa em vez de por cima.
 *
 * ## A recriação do player
 *
 * Trocar a legenda recria o player, porque `cc_load_policy` só vale na
 * construção. Isso só incomoda quem mexe no botão — cada navegador tem o seu
 * `YT.Player`. Posição e estado de play voltam sozinhos: o `handleReady` do
 * `VideoStage` faz `seek` para a posição da sala, e reenvia o `seek` porque o
 * primeiro é descartado enquanto o player carrega.
 */
export const YoutubePlayer = forwardRef<PlayerHandle, Props>(function YoutubePlayer(
  { videoId, captionsOn, onReady, onEnded },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const callbacks = useRef({ onReady, onEnded });
  callbacks.current = { onReady, onEnded };

  /**
   * Esconde a barra nativa do YouTube.
   *
   * As duas barras não podem coexistir — as duas ocupam os mesmos ~48px do
   * rodapé. Então, enquanto a nossa está no ar, a do YouTube fica escondida, e
   * o inverso acontece quando a pessoa pede os controles nativos.
   *
   * Chamado depois de cada comando nosso (`seek`, `play`, volume): cada um
   * acorda a UI nativa, e sem repetir aqui a barra do YouTube apareceria por
   * cima da nossa a cada ciclo de correção de deriva, que roda a cada 1,2s.
   */
  const hideChrome = useCallback(() => {
    try {
      playerRef.current?.hideControls?.();
    } catch {
      // Player ainda não pronto, ou já destruído.
    }
  }, []);

  useEffect(() => {
    // O wrapper é capturado aqui para o cleanup usar o mesmo nó: ele já está
    // montado quando o efeito roda.
    const wrap = wrapRef.current;
    let cancelled = false;

    loadYoutubeApi().then((YT) => {
      if (cancelled || !wrap) return;

      // Recriação: o player anterior morre antes do novo nascer, senão os dois
      // ficam vivos e o antigo rouba o vídeo.
      if (playerRef.current) {
        try {
          playerRef.current.destroy?.();
        } catch {
          // Já destruído.
        }
        playerRef.current = null;
      }
      wrap.innerHTML = '';

      // O host é nosso, não do React: o construtor do `YT.Player` o substitui
      // por um `<iframe>` e não existe mais o div original.
      const host = document.createElement('div');
      host.className = 'h-full w-full';
      wrap.appendChild(host);

      playerRef.current = new YT.Player(host, {
        videoId,
        playerVars: {
          // Barra nativa ligada: é o que traz o botão de CC de volta.
          controls: 1,
          // Atalhos de teclado do player desligados — play/pausa/busca têm de
          // passar pela sala. O botão de CC continua usável por Tab e Enter.
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          // Sem o botão de tela cheia do próprio YouTube: quem manda é o
          // controle da watchparty, e os dois se sobrepunham.
          fs: 0,
          ...legendaParams(captionsOn),
        },
        events: {
          onReady: () => {
            callbacks.current.onReady();
          },
          onStateChange: (e: any) => {
            if (e.data === YT.PlayerState.ENDED) callbacks.current.onEnded();
          },
        },
      });
    });

    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        // Já destruído.
      }
      playerRef.current = null;
      // Limpa o que o YT deixou no wrapper. Precisa ser aqui, e não no JSX,
      // porque o React não pode remover o `<iframe>` que o player criou.
      if (wrap) wrap.innerHTML = '';
    };
  }, [videoId, captionsOn]);

  useImperativeHandle(ref, (): PlayerHandle => ({
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
    hideNativeControls: hideChrome,
  }));

  return (
    <div className="absolute inset-0">
      {/*
        * O `wrapRef` é um div que o React nunca troca. O div que o `YT.Player`
        * recebe é criado dentro dele imperativamente, porque o construtor
        * *substitui* o elemento que recebe por um `<iframe>` — se o React
        * administrasse esse nó, ele tentaria remover um div que já não seria
        * mais filho do wrapper e quebraria com `removeChild`. Como aqui o React
        * só enxerga o wrapper, que é estável, quem limpa é o efeito, via
        * `innerHTML = ''`.
        *
        * Sem `pointer-events-none`: o mouse precisa chegar na barra nativa do
        * YouTube, que é onde está o botão de CC.
        */}
      <div ref={wrapRef} className="h-full w-full" />
    </div>
  );
});
