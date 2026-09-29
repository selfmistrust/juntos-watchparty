'use client';

import { MusicNotes } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { spotifyAccessToken } from '@/lib/spotifyAccount';
import {
  conectarPlayerSpotify,
  textoDoEstado,
  type EstadoDoPlayer,
  type PlayerSpotify,
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
}

export function SpotifyStage({ title, artwork, estado }: Props) {
  const aviso = textoDoEstado(estado);

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
        {estado === 'tocando' && (
          <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
            Tocando pelo Spotify, na sua conta. Quem não tem Premium vê a faixa e não ouve o áudio.
          </p>
        )}
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
}): { estado: EstadoDoPlayer; tocar: (uri: string) => void } {
  const [estado, setEstado] = useState<EstadoDoPlayer>('sem_conta');

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
       * `playTrack` pode rejeitar quando a conta não pode reproduzir, e essa é
       * a pista mais direta que existe. Não é o `account_error` que confirma,
       * mas registrá-la evita o silêncio de uma sala que mostra tocando e não
       * sai som.
       */
      console.warn('[spotify] playTrack recusado:', err);
    });
  }, []);

  useEffect(() => {
    /*
     * `!conectado` é o **único** lugar onde o estado volta a "sem conta". Ele vem
     * de `/api/spotify/status`, que é a resposta do servidor sobre o token — e
     * não de um erro do SDK. Um `account_error` deixa a conta conectada e muda
     * só o estado de reprodução, que é o que a distinção compra.
     */
    if (!opts.conectado) {
      setEstado('sem_conta');
      return;
    }

    let vivo = true;
    setEstado('sem_token');

    void conectarPlayerSpotify({
      /*
       * O nome aparece na lista de dispositivos do Spotify Connect. Sem um nome
       * que a pessoa reconheça, ela não consegue escolher este dispositivo como
       * saída de áudio — e o player tocaria no alto-falante errado, sem aviso.
       */
      nomeDoPlayer: 'Juntos — esta sala',
      /*
       * `getOAuthToken` roda no navegador, e é por isso que o token chega aqui
       * em vez de ser guardado no cliente. O `credentials: 'include'` desta
       * chamada é o que amarra o token à **mesma** sessão que fez o OAuth — sem
       * ele o servidor criaria uma sessão nova, o `status` diria "conectado" e
       * este `access-token` responderia 401 para a conta que acabou de conectar.
       */
      pedirToken: spotifyAccessToken,
      onEstado: (novo) => {
        if (!vivo) return;
        setEstado(novo);
      },
    }).then((p) => {
      if (!vivo) {
        /*
         * O componente saiu enquanto o script carregava. Conectar mesmo assim
         * deixaria um device_id órfão no Spotify até a aba fechar.
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
   * A faixa só começa depois do `ready`, e o efeito reage a três coisas: o
   * `ready`, a faixa, e o play da sala — nunca a um render a mais. Depender
   * apenas de `estado` e `faixa` faria a faixa tocar assim que o player
   * conectasse, mesmo com a sala em pause.
   *
   * São dois comandos porque são dois momentos. A faixa mudou, e a música
   * recomeça pelo início. A sala voltou a tocar **a mesma** faixa que ela mesma
   * mandou pausar, e o que se quer é retomar: `playTrack` aqui jogaria a
   * pessoa para os primeiros segundos toda vez que ela desse play.
   *
   * `play` é o nome daqui e não `resume` porque é o que a interface deste
   * projeto expõe; ele chama o `resume` do SDK por baixo.
   */
  useEffect(() => {
    if (estado !== 'tocando' || !opts.faixa || !opts.tocando) return;
    if (ultimaFaixa.current === opts.faixa) {
      void playerRef.current?.play().catch(() => {
        /* Retomar o que já está tocando não é erro que a pessoa precise ver. */
      });
      return;
    }
    ultimaFaixa.current = opts.faixa;
    tocar(opts.faixa);
  }, [estado, opts.faixa, opts.tocando, tocar]);

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

  return { estado, tocar };
}
