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
 * **Desligado não é o mesmo que ligar com `0`.** A documentação diz que
 * `cc_lang_pref` é "the default language that the player will use to *display*
 * captions" — ou seja, passar a preferência de idioma pede legenda no idioma
 * escolhido, e é isso que fazia a legenda continuar na tela depois de desligar.
 *
 * Então, desligado, nenhum dos dois params é enviado: o player nasce no
 * default do YouTube, que é sem legenda. Só quando a pessoa pede é que os dois
 * vão, juntos — `cc_load_policy` para exibir e `cc_lang_pref` para escolher a
 * faixa.
 *
 * Português porque é o idioma de quase todo mundo na sala. O YouTube respeita a
 * ordem: se não houver faixa em português, ele cai para outra.
 */
function legendaParams(captionsOn: boolean) {
  if (!captionsOn) return {};
  return { cc_load_policy: 1, cc_lang_pref: 'pt' };
}

/**
 * Os controles nativos ficam desligados: quem comanda é a barra customizada,
 * para que nenhum clique escape da sincronização do servidor.
 *
 * Legenda é o caso interesante de `controls: 0`: sem a barra nativa, o botão de
 * CC do YouTube some junto, e quem depende de legenda não tem por onde ligar.
 * Por isso o controle é nosso.
 *
 * ## Como a legenda é controlada aqui
 *
 * A IFrame Player API não tem como desligar legenda em um player que já existe.
 * A opção `captions.track` só aceita uma faixa válida: passar `{}`, `null`,
 * `{languageCode: ''}`, `{kind: 'none'}` ou `false` não faz nada, e
 * `unloadModule('captions')` também não — o player segue com a faixa
 * selecionada. Foi verificado no navegador, um caso por caso.
 *
 * A única alavanca documentada é o playerVar `cc_load_policy`, lido na
 * construção do player. Então ligar e desligar legenda significa **recriar o
 * player** — e o que vai na construção está em `legendaParams`, que trata
 * "desligado" como "não pedir legenda", não como "pedir desligada".
 *
 * Isso custa um recarregamento, e é o motivo de o botão ser preferência de
 * quem assiste e não estado da sala: cada navegador tem o seu `YT.Player`, então
 * só quem mexe no botão vê o recarregar. Posição e estado de play voltam
 * sozinhos, porque `onReady` chama o `handleReady` do VideoStage, que já faz
 * `seek` para a posição da sala.
 *
 * ## Por que o botão não some em vídeo sem legenda
 *
 * Dá para saber se o vídeo tem faixa (`getOption('captions', 'tracklist')`), mas
 * só pedindo as legendas — o `tracklist` só vem preenchido com
 * `cc_load_policy: 1` ou com um `setOption('captions', 'reload', true)`. Sondar
 * significa carregar as legendas de um vídeo que a pessoa não pediu, e não dá
 * para garantir o efeito colateral disso.
 *
 * Então o botão segue a mesma convenção do próprio YouTube: aparece nos vídeos
 * do YouTube e, se não houver faixa, não há nada a exibir. Um botão que some
 * conforme o vídeo é pior para quem depende de legenda do que um botão que
 * às vezes não faz nada visível.
 */
export const YoutubePlayer = forwardRef<PlayerHandle, Props>(function YoutubePlayer(
  { videoId, captionsOn, onReady, onEnded },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
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

  /**
   * Cria o player.
   *
   * Recria quando o vídeo ou a preferência de legenda mudam, porque
   * `cc_load_policy` só é lido na construção. O player anterior é destruído
   * antes do novo nascer, senão os dois ficam vivos e o antigo rouba o vídeo.
   */
  useEffect(() => {
    // Capturado aqui, e não lido no cleanup: o wrapper já está montado quando o
    // efeito roda, e o cleanup precisa do mesmo nó que o efeito usou.
    const wrap = wrapRef.current;
    let cancelled = false;

    loadYoutubeApi().then((YT) => {
      if (cancelled || !wrap) return;

      // O host é nosso, não do React: o construtor do YT.Player o substitui
      // por um `<iframe>` e não existe mais o div original.
      if (playerRef.current) {
        try {
          playerRef.current.destroy?.();
        } catch {
          // Já destruído.
        }
        playerRef.current = null;
      }
      wrap.innerHTML = '';

      const host = document.createElement('div');
      host.className = 'pointer-events-none h-full w-full';
      wrap.appendChild(host);

      playerRef.current = new YT.Player(host, {
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
          ...legendaParams(captionsOn),
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
  }, [videoId, captionsOn, hideChrome]);

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
      {/*
        * O `wrapRef` é um div que o React nunca troca. O div que o
        * `YT.Player` recebe é criado dentro dele imperativamente, porque o
        * construtor *substitui* o elemento que recebe por um `<iframe>` — se o
        * React administrasse esse nó, ele tentaria remover um div que já não
        * seria mais filho do wrapper e quebraria com `removeChild`. Como aqui o
        * React só enxerga o wrapper, que é estável, quem limpa é o efeito, via
        * `innerHTML = ''`.
        *
        * O `pointer-events-none` no host garante que nenhum clique, toque ou
        * arrasto chegue no embed, mesmo antes do div de bloqueio abaixo existir.
        */}
      <div ref={wrapRef} className="h-full w-full" />
      {/* Bloqueia cliques no iframe: todo controle passa pela barra customizada. */}
      <div className="absolute inset-0" />
    </div>
  );
});
