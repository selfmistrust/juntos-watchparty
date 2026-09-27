/* eslint-disable @typescript-eslint/no-explicit-any */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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
 * A IFrame Player API não tem verbo de "esconder legenda". Isso foi conferido
 * com a legenda visível na tela, não só lendo estado: sem param nenhum ela
 * aparece, com `cc_load_policy=0` também, com `cc_lang_pref` inválido também, no
 * domínio `youtube-nocookie.com` também, e `setOption('captions', 'track', …)`
 * só aceita faixa válida. Em `getOptions('captions')` não existe "esconder" — só
 * `reload`, `fontSize`, `track`, `tracklist`, `translationLanguages` e
 * `sampleSubtitle`.
 *
 * A única alavanca é `cc_load_policy`, e ela só é lida na **construção** do
 * player. Por isso o botão de legenda da watchparty recria o player nos dois
 * sentidos: ligado pede `cc_load_policy: 1`, desligado não pede nada e o
 * padrão do YouTube é não carregar.
 *
 * A versão anterior deste texto afirmava que o `0` explícito não seguraria a
 * legenda que vem da preferência da conta, e que isso fora medido. Não fora, e a
 * afirmação foi removida em vez de reescrita: era um "não faz diferença" sem
 * medição, que desiste de uma alavanca possivelmente útil.
 *
 * ## O que mudou quando a barra nativa saiu
 *
 * Antes, o botão de CC do próprio YouTube era a rede de segurança do desligar:
 * `cc_load_policy` falhando ainda deixava quem ligou legenda desligá-la. Com
 * `controls: 0` essa rede não existe mais, e o recriar passou a ser a única via.
 *
 * A consequência honesta: se o YouTube devolver as legendas ligadas por conta
 * própria — ele guarda a preferência de legenda por vídeo na conta, e isso tem
 * precedência sobre o param — o botão da watchparty não tem como vencer, porque
 * não existe comando de API para isso. Essa é a fraqueza conhecida de usar só a
 * API, e é o preço de não ter duas barras competindo na tela.
 *
 * Português porque é o idioma de quase todo mundo na sala. O YouTube respeita a
 * ordem: se não houver faixa em português, ele cai para outra.
 */
function legendaParams(captionsOn: boolean): Record<string, string> {
  /*
   * Este é o padrão do player: sem param algum, o YouTube não carrega faixa. O
   * `1` abaixo só existe depois que alguém clica no botão — não é um default.
   *
   * ## O que não está escrito aqui, e por quê
   *
   * Existe uma versão anterior deste comentário que dizia que o `0` explícito
   * não seguraria a legenda vinda da preferência da conta, e que isso tinha sido
   * medido. Não foi. Ninguém mediu, e a afirmação sobreviveu porque era crível e
   * ninguém foi conferir. Está aqui fora de propósito: um "não faz diferença"
   * sem medição é pior do que o silêncio, porque desiste de uma alavanca que
   * pode funcionar.
   *
   * O que se sabe de fato é mais estreito:
   *
   * - o YouTube guarda preferência de legenda por conta e por vídeo, e ela pode
   *   vir acima do param. Isso é do YouTube, e não tem verbo de API;
   * - `setOption('captions', 'track', {})` **não lança** — foi executado contra o
   *   player real. O que ele faz é outra pergunta, e a resposta ainda não está
   *   medida, porque medir exige uma conta com a preferência ligada;
   * - `cc_load_policy` só é lida na construção, o que é o motivo de o botão
   *   recriar o player.
   *
   * Ou seja: o botão de legenda é a única saída que temos quando a conta força
   * legenda. Com a barra nativa desligada, ele virou a única de todas.
   */
  if (!captionsOn) return {};
  return { cc_load_policy: '1', cc_lang_pref: 'pt' };
}

/**
 * Player do YouTube, com a barra nativa **desligada**.
 *
 * ## Por que `controls: 0`
 *
 * A barra nativa do YouTube ocupava a mesma faixa de ~48px no rodapé que a nossa
 * e, pior, tinha vida própria. Três problemas, todos de sincronização:
 *
 * - o play e a pausa dela mandavam direto no player, sem passar pela sala, e
 *   desincronizavam todo mundo. O efeito que reage a `isPlaying` corrigia em um
 *   ciclo, mas era uma correção e não uma prevenção — e ninguém corrigindo é
 *   melhor que ninguém errando;
 * - o volume e o mudo dela eram estado local do iframe. Quem ajustava no YouTube
 *   não mudava nada na sala, e o `setVolume` do `VideoStage` sobrescrevia no
 *   snapshot seguinte;
 * - `fs: 0` já tirava o botão de tela cheia, mas a barra continuava sendo a
 *   superfície onde esse botão morava.
 *
 * Com `controls: 0` nada disso compete. A única interface é a nossa, e ela
 * fala com o player pelos verbos da API — `playVideo`, `pauseVideo`, `seekTo`,
 * `setVolume`, `mute`, `unMute`, `getCurrentTime`, `getDuration`, todos no
 * `useImperativeHandle` abaixo.
 *
 * `disablekb: 1` era a condição para a barra sumir sem quebrar o alcance por
 * teclado: os atalhos do player (espaço, setas, `k`, `j`, `f`) iam direto no
 * vídeo e ignoravam a sala. Desligados eles, o teclado pertence à nossa barra,
 * que é alcançável por Tab e Enter.
 *
 * ## Nada é escondido por CSS
 *
 * O iframe é cross-origin: não há como alcançar o interior dele, e nem seria
 * certo tentar. A única forma legítima de tirar a barra é não a pedir, que é o
 * que `controls: 0` faz. Também não há overlay sobre o logo do YouTube para
 * disfarçar marca de terceiro: o que o YouTube decide mostrar, continua
 * mostrando, e a legibilidade dos nossos controles vem do gradiente da nossa
 * barra, não de paint por cima do player.
 *
 * ## O que se perde
 *
 * O botão de CC nativo. Era ele que desligava a legenda, porque a API não tem
 * esse comando — o desligar passou a depender do recriar o player, e a fraqueza
 * disso está escrita em `legendaParams`. A troca foi deliberada: uma barra
 * inteira que desincroniza a sala para alcançar um botão é mais cara que um
 * botão, e o `PlayerControls` expõe legenda nos dois sentidos.
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

  /*
   * Não existe mais `hideControls`.
   *
   * Ele existia para rebater a barra nativa depois de cada comando nosso, porque
   * o `YT.Player` reconstrói a UI a cada `play`/`pause`/`seek`/`setVolume` — e a
   * correção de deriva dispara a cada ~1,2s, então a barra voltava a cada ciclo
   * se ninguém a escondesse. Com `controls: 0` a UI não é construída, e a
   * a necessidade de escondê-la desaparece junto. Teria sido deixado como chamada inócua
   * a cada comando, mas isso custa uma ida ao iframe por ciclo de correção para
   * não fazer nada, e é o tipo de no-op que sobrevive anos sem ninguém saber por
   * que existe.
   */

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
          /*
           * A barra nativa não é pedida, e é o que tira de uma vez a barra de
           * progresso, o play/pausa, o volume e o botão de tela cheia do
           * YouTube — os quatro ocupavam a mesma faixa do rodapé que a nossa e
           * competiam com ela.
           *
           * `controls: 0` é a única forma de pedir isso. Não há como esconder por
           * CSS: o iframe é cross-origin, e mascarar o interior dele com um
           * overlay seria fingir que o elemento não existe, além de cobrir o
           * vídeo.
           */
          controls: 0,
          // A IFrame API liga isso sozinha, mas fica explícito porque é o que
          // habilita os verbos usados no `useImperativeHandle` abaixo.
          enablejsapi: 1,
          // Sem o botão de tela cheia do próprio YouTube: quem manda é o
          // controle da watchparty, e os dois se sobrepunham.
          fs: 0,
          /*
           * Atalhos de teclado do player desligados. Espaço, setas, `k`, `j` e
           * `f` iam direto no vídeo e ignoravam a sala, que é exatamente o que
           * esta barra existe para evitar. Com eles fora, o teclado pertence à
           * nossa barra, alcançável por Tab.
           */
          disablekb: 1,
          // Reprodução no lugar, sem saltar para o app de vídeo do sistema.
          playsinline: 1,
          /*
           * Pedido ao YouTube, e não um disfarce: o param oficial para a marca
           * d'água. Na prática o YouTube atual já ignora quase tudo aqui.
           *
           * O que sobrar da marca é decisão do YouTube, e não foi tapado: um
           * retângulo por cima do player cobriria o vídeo para esconder um logo,
           * que é o oposto de integrar. O que garante a legibilidade dos
           * controles é o gradiente da nossa barra, que chega a 85% de preto na
           * base — a marca é desenhada nas pontas do vídeo, dentro dessa faixa
           * escura.
           *
           * Verificado no navegador com o player real: com `controls: 0` e o
           * ponteiro sobre o vídeo, não aparece barra, nem progresso, nem play,
           * nem volume, nem tela cheia. Ao lado, `controls: 1` no mesmo instante
           * mostra a barra nativa inteira. E `seekTo`, `setVolume`, `mute` e
           * `getDuration` continuam respondendo depois de `controls: 0`.
           */
          modestbranding: 1,
          // Sem o cartão de "vídeos relacionados" ao terminar.
          rel: 0,
          // Sem anotações sobre o vídeo, que entravam por cima do palco.
          iv_load_policy: 3,
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

  /*
   * Os verbos da IFrame Player API, e a superfície inteira de comando sobre o
   * player do YouTube. Nada mais escreve nele: a barra nativa está desligada, e
   * o que sobra é esta lista.
   *
   * `PlayerHandle` é compartilhado com o `FilePlayer` e o player de tela, e é por
   * isso que os verbos são uniformes — é o `VideoStage` que fala com os três sem
   * saber de onde veio o vídeo.
   */
  useImperativeHandle(ref, (): PlayerHandle => ({
    play: () => {
      playerRef.current?.playVideo?.();
    },
    pause: () => {
      playerRef.current?.pauseVideo?.();
    },
    seek: (s) => {
      playerRef.current?.seekTo?.(s, true);
    },
    getCurrentTime: () => playerRef.current?.getCurrentTime?.() ?? 0,
    getDuration: () => playerRef.current?.getDuration?.() ?? 0,
    setVolume: (v) => {
      playerRef.current?.setVolume?.(Math.round(v * 100));
    },
    setMuted: (m) => {
      if (m) playerRef.current?.mute?.();
      else playerRef.current?.unMute?.();
    },
    setPlaybackRate: (r) => {
      playerRef.current?.setPlaybackRate?.(r);
    },
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
        * Este era o motivo de o wrapper **não** ser `pointer-events-none`: o
        * mouse precisava chegar na barra nativa, onde estava o botão de CC. Com
        * `controls: 0` não há mais nada clicável dentro do iframe, e o wrapper
        * capturando o clique só criaria um alvo morto no meio do palco — quem
        * trata o play/pausa é o click-catcher do `VideoStage`, em `z-10`.
        */}
      <div ref={wrapRef} className="pointer-events-none h-full w-full" />
    </div>
  );
});
