'use client';

import { MusicNotes } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { spotifyAccessToken, playSpotifyTrack } from '@/lib/spotifyAccount';
import {
  conectarPlayerSpotify,
  textoDoEstado,
  type EstadoDoPlayer,
  type PlayerSpotify,
  type RelogioDoPlayer,
} from '@/lib/spotifyPlayback';

/**
 * O que a sala está tocando no Spotify.
 *
 * ## Este componente não é a fonte do estado
 *
 * A versão anterior recebia `conectado` e `reproduz` como booleanos, e o palco
 * recebia **`conectado={false}` fixo** no `VideoStage`. O resultado era uma tela
 * dizendo "Conecte sua conta do Spotify para ouvir" para uma pessoa que tinha
 * acabado de buscar e enfileirar uma música com a conta conectada.
 *
 * A mensagem estava certa para o código e errada para a situação — que é a forma
 * mais cara de um texto fixo: ele mente com a confiança de quem está medindo.
 *
 * Agora o estado vem de `usePlayerSpotify`, que é quem conversa com o SDK. E o
 * texto de cada estado é do estado, não um genérico: só `sem_conta` pede para
 * conectar, e os outros três dizem o que fazer de fato.
 *
 * ## Por que não há um player aqui
 *
 * Todas as outras fontes têm um player que o servidor dirige, e o áudio é o
 * mesmo que sai de todas as máquinas. O Spotify não tem isso e não pode ter: não
 * existe URL de áudio, e o som vem do Web Playback SDK em cada navegador, com a
 * conta de cada pessoa.
 */
interface Props {
  title: string;
  artwork?: string;
  /** O estado que o player do SDK realmente está. */
  estado: EstadoDoPlayer;
  /**
   * A frase do servidor, quando ele tem uma.
   *
   * "Sua autorização do Spotify precisa ser renovada." vem do endpoint de
   * reprodução, que é quem sabe o que houve. O palco não reescreve: quem recusa
   * é quem descreve, e um texto reescrito no cliente é um texto que pode
   * discordar da situação.
   */
  aviso?: string | null;
}

export function SpotifyStage({ title, artwork, estado, aviso: avisoDoServidor }: Props) {
  const aviso = avisoDoServidor ?? textoDoEstado(estado);

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center">
      {artwork ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={artwork} alt="" className="h-40 w-40 rounded-lg object-cover shadow-lift sm:h-52 sm:w-52" />
      ) : (
        <span className="flex h-40 w-40 items-center justify-center rounded-lg bg-raised text-ink-faint sm:h-52 sm:w-52">
          <MusicNotes size={32} />
        </span>
      )}
      <div className="min-w-0 max-w-sm">
        <p className="truncate text-sm font-medium text-ink">{title}</p>
        {aviso && <p className="mt-1 text-2xs leading-relaxed text-ink-faint">{aviso}</p>}
        {/*
         * Só o `tocando` afirma reprodução, e só porque o `player_state_changed`
         * disse. A versão anterior imprimia isto com o estado `tocando` que o
         * `ready` publicava — device conectado, nada carregado, `0:00 / 0:00` na
         * barra e nenhum som. Um device conectado não é uma música tocando.
         */}
        {estado === 'tocando' && (
          <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
            Tocando pelo Spotify, na sua conta. Quem não tem Premium vê a faixa e não ouve o áudio.
          </p>
        )}
        {/*
         * `pronto` é o device conectado sem áudio rolando. Não se anuncia nada
         * porque não há nada a anunciar: a faixa está na tela, o nome está logo
         * acima, e um texto aqui seria uma previsão.
         */}
      </div>
    </div>
  );
}

/**
 * O player do SDK desta pessoa, o estado em que ele de fato está, e o comando de
 * tocar uma faixa.
 *
 * ## A ordem que faz a faixa sair
 *
 *   conta conectada -> faixa vira mídia atual -> obtém token -> SDK conecta ->
 *   `ready(device_id)` -> começa a tocar
 *
 * O último passo é o que faltava, e é o que separa "o palco deixou de mentir"
 * de "a música toca". Chamar `playTrack` antes do `ready` é recusado pelo SDK, e
 * o sintoma é o pior dos dois: a sala mostra tocando, o palco não diz nada, e
 * não sai som.
 *
 * ## Por que o player fica aqui e não no palco
 *
 * O player é um recurso **da sessão**, não da faixa. Montá-lo no palco criaria um
 * `device_id` novo a cada música, e a lista de dispositivos do Spotify Connect no
 * telefone da pessoa encheria de "Juntos" repetido.
 *
 * ## Trocar de faixa não mexe no estado de conta
 *
 * A conexão é montada uma vez e só desmonta quando `conectado` cai de verdade —
 * que vem do `useSpotifyAccount`, alimentado por `/api/spotify/status`. Trocar de
 * mídia, avançar na fila ou remontar o palco **não** passa por esse caminho, e é
 * por isso que a conta não volta a "desconectada" sozinha. A versão anterior
 * justamente não tinha isso: o palco recebia `false` fixo a cada montagem, e a
 * pessoa via "conecte de novo" a cada faixa.
 */
export function usePlayerSpotify(opts: {
  conectado: boolean;
  /** O `spotifyUri` da faixa que a sala está tocando, quando for uma. */
  faixa?: string | null;
  /** O que a sala acredita: play ou pause. */
  tocando: boolean;
}): {
  estado: EstadoDoPlayer;
  aviso: string | null;
  relogio: RelogioDoPlayer;
  tocar: (uri: string) => void;
} {
  const [estado, setEstado] = useState<EstadoDoPlayer>('sem_conta');
  /*
   * A frase do servidor quando ele tem uma. Vive no estado em vez de vir de
   * 	extoDoEstado porque o texto do servidor ja e uma frase escrita para a
   * pessoa, e reescreve-lo aqui seria um segundo lugar para errar.
   */
  const [aviso, setAviso] = useState<string | null>(null);
  /*
   * O relogio que a barra de progresso mostra.
   *
   * Vive no estado, e nao e lido direto do player no render, porque a interface
   * precisa **redesenhar** para mostrar o segundo certo. Quem atualiza e o efeito
   * de 250ms abaixo, no mesmo periodo que o video usa.
   *
   * Comeca zerado de proposito: enquanto nao ha faixa carregada, `0:00 / 0:00` e
   * a leitura correta, e nao um valor inventado.
   */
  const [relogio, setRelogio] = useState<RelogioDoPlayer>({
    posicaoMs: 0,
    duracaoMs: 0,
    tocando: false,
  });
  /*
   * O player vive num ref, e não no estado, porque é o que o `tocar` de baixo
   * alcança sem re-renderizar a árvore. E **precisa** ser um ref: a versão
   * anterior guardava o player no estado, e o closure do primeiro efeito
   * capturava `null` — que é por isso que o `destruir` do cleanup não
   * desconectava nada, e cada troca de conta deixava um device_id órfão
   * registrado no Spotify até a aba fechar.
   */
  const playerRef = useRef<PlayerSpotify | null>(null);

  /** A última faixa que este player começou, para retomar em vez de recomeçar. */
  const ultimaFaixa = useRef<string | null>(null);

  const tocar = useCallback((uri: string) => {
    void playerRef.current?.tocar(uri).catch((err) => {
      /*
       * `tocar` avanca por `PUT /me/player/play`, e o erro que chega aqui e do
       * servidor.
       *
       * Um 403 com "autorizacao" no corpo e a frase que o **servidor** escreveu:
       * "Sua autorizacao do Spotify precisa ser renovada." Ela vai no estado
       * em vez de vir de `textoDoEstado`, porque quem sabe o que aconteceu e
       * quem recusou. Traduzir de volta no cliente seria um segundo lugar onde
       * o texto pode acertar o codigo e errar a situacao.
       *
       * Nada aqui vira `premium`. Quem decide isso e o `account_error` do SDK.
       */
      const e = err as { status?: number; message?: string };
      const mensagem = typeof e?.message === 'string' ? e.message : '';
      if (e?.status === 403 && /autoriza|escopo/i.test(mensagem)) {
        setEstado('sem_escopo');
        setAviso(mensagem);
        return;
      }
      console.warn('[spotify] Spotify recusou carregar a faixa:', err);
    });
  }, []);

  useEffect(() => {
    /*
     * `!conectado` e o **unico** lugar onde o estado volta a "sem conta". Ele vem
     * de `/api/spotify/status`, que e a resposta do servidor sobre o token -- e
     * nao de um erro do SDK. Um `account_error` deixa a conta conectada e muda
     * so o estado de reproducao, que e o que a distincao compra.
     */
    if (!opts.conectado) {
      setEstado('sem_conta');
      setAviso(null);
      setRelogio({ posicaoMs: 0, duracaoMs: 0, tocando: false });
      return;
    }

    let vivo = true;
    setEstado('sem_token');

    void conectarPlayerSpotify({
      /*
       * O nome aparece na lista de dispositivos do Spotify Connect. Sem um nome
       * que a pessoa reconheca, ela nao consegue escolher este dispositivo como
       * saida de audio -- e o player tocaria no alto-falante errado, sem aviso.
       */
      nomeDoPlayer: 'Juntos - esta sala',
      /*
       * `getOAuthToken` roda no navegador, e e por isso que o token chega aqui
       * em vez de ser guardado no cliente. O `credentials: 'include'` desta
       * chamada e o que amarra o token a **mesma** sessao que fez o OAuth -- sem
       * ele o servidor criaria uma sessao nova, o `status` diria "conectado" e
       * este `access-token` responderia 401 para a conta que acabou de conectar.
       */
      pedirToken: spotifyAccessToken,
      /*
       * A carga da faixa passa pelo servidor porque o token vive la. O corpo da
       * requisicao e um uri; quem entrega o som continua sendo este player.
       */
      carregar: playSpotifyTrack,
      onEstado: (novo) => {
        if (!vivo) return;
        setEstado(novo);
      },
    }).then((p) => {
      if (!vivo) {
        /*
         * O componente saiu enquanto o script carregava. Conectar mesmo assim
         * deixaria um device_id orfao no Spotify ate a aba fechar.
         */
        p?.destruir();
        return;
      }
      playerRef.current = p;
    });

    return () => {
      vivo = false;
      playerRef.current?.destruir();
      playerRef.current = null;
      ultimaFaixa.current = null;
    };
  }, [opts.conectado]);

  /*
   * A faixa so comeca depois do `ready`, e so quando a sala esta tocando.
   *
   * A dependencia e `pronto` e nao `tocando`: `tocando` passa a ser a leitura do
   * `player_state_changed`, e depender dele aqui criaria um laco em que cada
   * estado novo recarrega a faixa. O `ready` e a readiness do device; e ele que
   * autoriza a primeira carga.
   *
   * Sao dois comandos porque sao dois momentos. A faixa mudou, e a musica recomeca
   * pelo inicio. A sala voltou a tocar **a mesma** faixa que ela mesma mandou
   * pausar, e o que se quer e retomar -- recarregar aqui jogaria a pessoa para os
   * primeiros segundos toda vez que ela desse play.
   *
   * ## `autoplay` tambem autoriza a carga
   *
   * O device existe nos dois estados, e o audio bloqueado nao muda isso: a faixa
   * esta carregada no device, o que o navegador recusou foi o som. Deixar
   * `autoplay` de fora faria o botao de play da sala ficar morto justo quando a
   * pessoa esta tentando destravar -- ela apertaria e nada aconteceria, sem
   * nenhuma mensagem nova para explicar.
   *
   * A dependencia continua sendo readiness, e nao `tocando`: `tocando` e a leitura
   * do `player_state_changed`, e depender dele aqui criaria um laco em que cada
   * estado novo recarrega a faixa.
   */
  useEffect(() => {
    const devicePronto = estado === 'pronto' || estado === 'autoplay';
    if (!devicePronto || !opts.faixa || !opts.tocando) return;
    if (ultimaFaixa.current === opts.faixa) {
      void playerRef.current?.play().catch(() => {
        /* Retomar o que ja esta tocando nao e erro que a pessoa precise ver. */
      });
      return;
    }
    ultimaFaixa.current = opts.faixa;
    setRelogio({ posicaoMs: 0, duracaoMs: 0, tocando: false });
    tocar(opts.faixa);
  }, [estado, opts.faixa, opts.tocando, tocar]);

  /*
   * O `autoplay_failed` se resolve em dois passos, e a versao anterior so fazia o
   * primeiro.
   *
   * A referencia do SDK diz que `activateElement` precisa ser chamado de dentro de
   * um gesto. Por isso chama-lo no `ready` nao resolvia: o `ready` acontece sem
   * ninguem ter tocado em nada. Na sala isso e o caso comum, nao o raro -- a faixa
   * vira midia atual por decisao de outra pessoa.
   *
   * ## O segundo passo e o que estava faltando
   *
   * `activateElement` **libera** o elemento de midia. Ele nao **inicia** a
   * reproducao que o navegador recusou. A chamada ao `PUT /me/player/play` ja foi
   * feita, a faixa ja esta carregada no device, e o estado do SDK e
   * `tocando=false` -- recusado pelo navegador, nao pelo Spotify.
   *
   * Entao depois do gesto e preciso pedir o play de novo. E o efeito de carga,
   * logo abaixo, e quem faz: por isso este handler volta o estado para `pronto`,
   * e nao chama `play` por conta propria. Um unico caminho para iniciar, e o
   * estado depois conta a verdade sobre o que o SDK respondeu.
   *
   * Qualquer gesto serve, e por isso o listener e na janela inteira: a pessoa
   * pode estar digitando no chat, e isso tambem e um gesto. Ouvir so o botao de
   * play deixaria quem so le a sala sem saida.
   */
  const semPlayer = estado === 'sem_conta' || estado === 'sem_token';
  useEffect(() => {
    if (semPlayer) return;
    const liberar = () => {
      const p = playerRef.current;
      if (!p) {
        /*
         * O player ainda nao existe -- o `ready` nao chegou. O listener fica, e o
         * proximo gesto tenta de novo. Sair na primeira tentativa sem ativar nada
         * deixaria a pessoa sem audio e sem nenhuma forma de destravar.
         */
        return;
      }
      void p
        .ativar()
        .then(() => {
          /*
           * `pronto` e o estado honesto aqui: o device existe e o audio esta
           * liberado, mas ninguem confirmou que a musica comecou. Quem confirma e
           * o `player_state_changed`.
           *
           * Voltar direto para `tocando` seria afirmar reproducao que ainda nao
           * aconteceu -- e foi exatamente esse o defeito que o `ready` ja causou
           * uma vez, com "Tocando pelo Spotify" e `0:00 / 0:00` na tela.
           */
          setEstado('pronto');
        })
        .catch(() => {
          /* Sem audio liberado nao ha como melhorar daqui. */
        });
      window.removeEventListener('pointerdown', liberar);
      window.removeEventListener('keydown', liberar);
    };
    window.addEventListener('pointerdown', liberar, { passive: true });
    window.addEventListener('keydown', liberar);
    return () => {
      window.removeEventListener('pointerdown', liberar);
      window.removeEventListener('keydown', liberar);
    };
  }, [semPlayer]);

  /*
   * O pause da sala precisa chegar no Spotify.
   *
   * Sem isto o botão de play/pause da sala governa o vídeo e o stream, e a
   * faixa do Spotify segue tocando: a sala em pausa com áudio correndo. O
   * Spotify não entra na ponte de `PlayerHandle` porque ele não tem posição nem
   * seek coletivo — ele tem play e pause, e é isso que este efeito faz.
   *
   * `ultimaFaixa` **não** é limpa aqui, e é de propósito: sem isso o play
   * seguinte cairia no ramo errado e não saberia de onde retomar.
   */
  useEffect(() => {
    if (estado !== 'tocando' || opts.tocando) return;
    void playerRef.current?.pause().catch(() => {
      /* Pausar o que já está pausado não é erro que a pessoa precise ver. */
    });
  }, [estado, opts.tocando]);

  /*
   * O relogio anda a cada 250ms, no mesmo periodo que o video usa.
   *
   * So roda quando ha player. Fora disso o estado ficaria em zero e a interface
   * redesenhando sem nenhuma informacao nova, que e trabalho de grafica a toa.
   */
  const temPlayer = playerRef.current !== null;
  useEffect(() => {
    if (!temPlayer) return;
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      setRelogio(p.relogio());
    }, 250);
    return () => clearInterval(id);
  }, [temPlayer, estado]);

  return { estado, aviso, relogio, tocar };
}
