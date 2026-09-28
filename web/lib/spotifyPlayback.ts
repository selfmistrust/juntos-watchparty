/**
 * Web Playback SDK do Spotify.
 *
 * ## Por que isto é uma camada, e não uma chamada
 *
 * O SDK é um script que se anuncia no `window` e **não** devolve nada na
 * chamada. Quem usa tem que definir `window.onSpotifyWebPlaybackSDKReady` antes
 * de carregar o script, e o objeto `Spotify` só existe depois que ele roda. Um
 * `await import()` não resolve, e um `getScript` esperando o evento tem que
 * lidar com o caso de o script nunca carregar — que é o caso comum quando a
 * rede falha, o script é bloqueado, ou o ambiente não é um navegador.
 *
 * Tudo isso vira uma promessa só, com os erros nomeados, porque quem chama
 * precisa distinguir "ainda carregando" de "não vai carregar" de "carregou e a
 * conta não serve" — e cada um desses vira um texto diferente na tela.
 *
 * ## Os erros que o SDK emite, e o que cada um significa
 *
 *   `ready`                o player está pronto e recebeu um device_id
 *   `not_ready`            o navegador perdeu o player (aba suspensa, tela de
 *                          bloqueio, economia de energia)
 *   `account_error`        a conta não pode reproduzir. É aqui que aparece o
 *                          Premium que o `/me` não conseguiu dizer
 *   `authentication_error` o token foi recusado (revogado ou expirado)
 *   `playback_error`       falha ao tocar uma faixa específica
 *
 * O `account_error` é o que resolve a armadilha do Spotify Lite: o `/me` devolve
 * `product: "premium"` para ele, e só aqui se descobre que é um plano só de
 * celular e não reproduz.
 */

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

interface JanelaDoSdk extends Window {
  /**
   * O SDK **não** devolve nada quando carrega. Ele chama isto, e só depois disso
   * `window.Spotify` existe. Por isso a declaração: sem ela, instalar o callback
   * seria um erro de tipo, e a tentação seria usar `any` — que esconderia
   * exatamente o detalhe de ordenação que faz o SDK funcionar.
   */
  onSpotifyWebPlaybackSDKReady?: () => void;
}

let scriptCarregando: Promise<boolean> | null = null;

/**
 * Carrega o script do SDK uma vez só.
 *
 * O `onSpotifyWebPlaybackSDKReady` é instalado **antes** do append, e não
 * depois: o script pode executar assim que entra no documento, e quem registrasse
 * o callback depois perderia o evento e a promessa nunca resolveria.
 */
export function carregarSdkSpotify(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if ('Spotify' in window) return Promise.resolve(true);
  if (scriptCarregando) return scriptCarregando;

  scriptCarregando = new Promise<boolean>((resolve) => {
    const w = window as JanelaDoSdk;
    w.onSpotifyWebPlaybackSDKReady = () => resolve('Spotify' in window);

    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    // O SDK não dá eventos de erro: sem `onerror`, uma rede bloqueada deixaria a
    // promessa pendurada para sempre, e o card ficaria em "carregando" sem
    // nunca sair. Resolver `false` aqui é o que transforma uma rede ruim em um
    // estado visível.
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });

  return scriptCarregando;
}

export type MotivoDoAudio =
  /** Ainda não sabemos; o card não diz nada. */
  | 'desconhecido'
  /** O SDK carregou e o player conectou. */
  | 'ok'
  /** O SDK não carregou, ou o contexto não é seguro, ou estamos no Electron. */
  | 'indisponivel'
  /** A conta conectou mas não pode reproduzir. É o caso do Premium que falta. */
  | 'premium_necessario'
  /** O token foi recusado pelo Spotify. */
  | 'token_recusado';

export interface PlayerSpotify {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  /** Toca uma faixa pelo uri. Só isso: a fila é de faixas, uma a uma. */
  tocar: (trackUri: string) => Promise<void>;
  destruir: () => void;
  on: (evento: 'player_state_changed' | 'not_ready', fn: () => void) => void;
}

interface PlayerBruto {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: (evento: string, fn: (arg?: unknown) => void) => boolean;
  removeListener: (evento: string, fn?: (arg?: unknown) => void) => boolean;
  getCurrentState: () => Promise<unknown>;
  activateElement: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  togglePlay: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  loadTrack: (id: string) => Promise<unknown>;
  playTrack: (id: string) => Promise<unknown>;
  pauseTrack: () => Promise<void>;
}

interface PlayerWindow extends Window {
  Spotify: {
    Player: new (opts: {
      name: string;
      getOAuthToken: (cb: (token: string) => void) => void;
      volume?: number;
      enableMediaSession?: boolean;
    }) => PlayerBruto;
  };
}

/**
 * Conecta um player do Spotify e resolve quando ele está pronto.
 *
 * O `getOAuthToken` do SDK é chamado de novo sempre que o token expira, e o
 * token vive uma hora — por isso ele **pede** o token a cada chamada em vez de
 * guardar um. Guardar seria uma janela de uma hora em que a reprodução falha sem
 * que ninguém perceba por quê.
 *
 * `nomeDoPlayer` é o que aparece no app "Spotify Connect" do telefone de quem
 * conectou. Não é decoração: é como a pessoa reconhece este dispositivo na lista
 * de saída de áudio, e um player sem nome distinto não dá para escolher.
 */
export async function conectarPlayerSpotify(opts: {
  nomeDoPlayer: string;
  pedirToken: () => Promise<string | null>;
  onMotivo: (motivo: MotivoDoAudio) => void;
}): Promise<PlayerSpotify | null> {
  const carregou = await carregarSdkSpotify();
  if (!carregou) {
    opts.onMotivo('indisponivel');
    return null;
  }

  const w = window as unknown as PlayerWindow;
  if (!w.Spotify) {
    opts.onMotivo('indisponivel');
    return null;
  }

  return new Promise<PlayerSpotify | null>((resolve) => {
    let resolvido = false;
    const finalizar = (valor: PlayerSpotify | null) => {
      if (resolvido) return;
      resolvido = true;
      resolve(valor);
    };

    /*
     * Todo listener registrado, para poder ser removido.
     *
     * O SDK não tem "remove todos": `removeListener` recebe evento e callback.
     * Guardar só o player e chamar `removeListener` sem argumento não compila e,
     * com `any`, silenciosamente não removeria nada — o player continuaria
     * registrado depois de a tela fechar, chamando `onMotivo` em um componente
     * que já saiu.
     */
    const registrados: Array<[string, (arg?: unknown) => void]> = [];
    const escutar = (evento: string, fn: (arg?: unknown) => void) => {
      player.addListener(evento, fn);
      registrados.push([evento, fn]);
    };

    const player = new w.Spotify.Player({
      name: opts.nomeDoPlayer,
      enableMediaSession: false,
      getOAuthToken: (cb) => {
        void opts.pedirToken().then((token) => {
          if (token) cb(token);
          else opts.onMotivo('token_recusado');
        });
      },
    });

    escutar('ready', () => {
      /*
       * `activateElement` é o que impede o navegador de roubar o som para outra
       * aba depois que o player conecta. Sem ele o Spotify toca, mas o áudio sai
       * em outro lugar — e o sintoma (silêncio) não aponta para cá.
       */
      void player.activateElement();
      opts.onMotivo('ok');
      finalizar({
        play: async () => {
          await player.resume();
        },
        pause: async () => {
          await player.pause();
        },
        seek: async (ms) => {
          await player.seek(ms);
        },
        /*
         * Toca uma faixa, e só uma faixa.
         *
         * Álbum e playlist não são transmitidos como contexto: a fila guarda
         * **faixas**, e quem escolhe um disco na busca percorre ele e escolhe as
         * músicas. Tocar pelo contexto exigiria `PUT /me/player/play` com o token
         * da pessoa direto na chamada — um segundo caminho de áudio, fora do
         * SDK, e sem nenhuma necessidade. O caminho do SDK também é o único que
         * o Spotify autoriza: o áudio é entregue pelo player, não por nós.
         */
        tocar: async (trackUri) => {
          const id = trackUri.split(':').pop();
          if (!id) return;
          await player.playTrack(id);
        },
        destruir: () => {
          for (const [evento, fn] of registrados) player.removeListener(evento, fn);
          registrados.length = 0;
          player.disconnect();
        },
        on: (evento, fn) => {
          escutar(evento, fn);
        },
      });
    });

    escutar('not_ready', () => {
      opts.onMotivo('indisponivel');
      /*
       * Não resolve `null` aqui: `not_ready` também dispara quando a aba é
       * suspensa pelo navegador e o player volta sozinho. Resolver `null`
       * transformaria uma pausa de cinco segundos em "o Spotify não funciona
       * neste dispositivo", e o card passaria a mentir.
       */
    });

    escutar('account_error', (arg) => {
      const mensagem = (arg as { message?: string } | undefined)?.message ?? '';
      opts.onMotivo('premium_necessario');
      if (mensagem) console.warn('[spotify] account_error:', mensagem);
      finalizar(null);
    });

    escutar('authentication_error', (arg) => {
      const mensagem = (arg as { message?: string } | undefined)?.message ?? '';
      console.warn('[spotify] authentication_error:', mensagem);
      opts.onMotivo('token_recusado');
      finalizar(null);
    });

    escutar('initialization_error', (arg) => {
      const mensagem = (arg as { message?: string } | undefined)?.message ?? '';
      console.warn('[spotify] initialization_error:', mensagem);
      opts.onMotivo('indisponivel');
      finalizar(null);
    });

    void player.connect().then((ok) => {
      if (!ok) {
        opts.onMotivo('indisponivel');
        finalizar(null);
      }
      // `ok === true` não é "pronto": é só que a conexão foi aceita. O `ready`
      // acima é o que diz que o player existe de fato, e é por isso que aqui
      // não se resolve nada.
    });
  });
}

/** Texto que o card e o painel mostram para cada motivo. */
export function textoDoMotivo(motivo: MotivoDoAudio, conectado: boolean): string | null {
  if (!conectado) return null;
  switch (motivo) {
    case 'premium_necessario':
      return 'A conta está conectada, mas o Spotify Premium é necessário para o áudio tocar aqui.';
    case 'indisponivel':
      return 'O Spotify não reproduz neste dispositivo. A busca e a fila continuam funcionando.';
    case 'token_recusado':
      return 'O Spotify recusou a autorização desta conta. Conecte de novo.';
    default:
      return null;
  }
}
