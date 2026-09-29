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

/**
 * Os quatro estados que nao podem virar um so.
 *
 * A versao anterior tinha um motivo unico, e a interface traduzia tudo para
 * "Conecte sua conta do Spotify" — inclusive os casos em que a conta **estava**
 * conectada. Um texto que acerta um quarto dos casos e nega os outros tres e
 * pior que nenhum: a pessoa desconecta uma conta boa e regrava, achando que o
 * problema era dela.
 *
 *   sem_conta   nao ha autorizacao. A pessoa nao conectou.
 *   sem_token   ha conta, e o token nao pode ser emitido. Reconectar resolve.
 *   premium     a conta conectou e o Spotify recusou a reproducao. So o SDK sabe
 *               disto, e o `/me` nao.
 *   ambiente    o SDK nao rodou aqui: contexto sem TLS, script bloqueado, ou
 *               Electron — que o Spotify Connect nao reconhece.
 *   tocando     o player esta pronto e ha `device_id`.
 */
export type EstadoDoPlayer =
  | 'sem_conta'
  | 'sem_token'
  | 'premium'
  | 'ambiente'
  | 'tocando';

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
  onEstado: (estado: EstadoDoPlayer) => void;
}): Promise<PlayerSpotify | null> {
  const carregou = await carregarSdkSpotify();
  if (!carregou) {
    opts.onEstado('ambiente');
    return null;
  }

  const w = window as unknown as PlayerWindow;
  if (!w.Spotify) {
    opts.onEstado('ambiente');
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
          else opts.onEstado('sem_token');
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
      opts.onEstado('tocando');
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

    /*
     * `not_ready` **não** vira estado.
     *
     * Ele dispara quando o navegador suspende a aba, e o player volta sozinho em
     * alguns segundos. Traduzir isso para "não funciona neste dispositivo" faz
     * a interface mentir durante uma pausa de cinco segundos, e a pessoa takeaway
     * a conclusão errada. Só o `ready` de volta muda o estado.
     */
    escutar('not_ready', () => {
      console.warn('[spotify] not_ready: o navegador suspendeu o player; aguardando ready');
    });

    /*
     * `account_error` é o **único** lugar onde "falta Premium" pode ser dito.
     *
     * O `/me` devolve `product: "premium"` para Spotify Lite e Premium Mini, que
     * são planos só de celular e não reproduzem. Nenhuma chamada à Web API
     * distingue os dois. Então a interface não pode afirmar "Premium" a partir do
     * `/me`, e o `account_error` é a evidência.
     */
    escutar('account_error', (arg) => {
      const mensagem = (arg as { message?: string } | undefined)?.message ?? '';
      console.warn(`[spotify] account_error: ${mensagem}`);
      opts.onEstado('premium');
      finalizar(null);
    });

    /* Token recusado: reconectar resolve, e é o que o texto diz. */
    escutar('authentication_error', (arg) => {
      const mensagem = (arg as { message?: string } | undefined)?.message ?? '';
      console.warn(`[spotify] authentication_error: ${mensagem}`);
      opts.onEstado('sem_token');
      finalizar(null);
    });

    /*
     * Ambiente ou DRM. O SDK não diz qual dos dois, e essa é a informação que
     * falta: dentro do Electron o player se anuncia como dispositivo que o
     * Spotify não reconhece, e o erro é o mesmo de uma incompatibilidade de DRM.
     */
    escutar('initialization_error', (arg) => {
      const mensagem = (arg as { message?: string } | undefined)?.message ?? '';
      console.warn(`[spotify] initialization_error: ${mensagem}`);
      opts.onEstado('ambiente');
      finalizar(null);
    });

    /*
     * Falha ao tocar uma faixa específica. Não derruba a sessão: a conta segue
     * conectada e as outras faixas tocam. Por isso não chama `finalizar`.
     */
    escutar('playback_error', (arg) => {
      const mensagem = (arg as { message?: string } | undefined)?.message ?? '';
      console.warn(`[spotify] playback_error: ${mensagem}`);
    });

    void player.connect().then((ok) => {
      if (!ok) {
        console.warn('[spotify] connect() devolveu false');
        opts.onEstado('sem_token');
        finalizar(null);
      }
      // `ok === true` não é "pronto": é só que a conexão foi aceita. O `ready`
      // é o que diz que o player existe de fato, e é por isso que aqui não se
      // muda o estado nem se resolve nada.
    });
  });
}

/**
 * O texto que cada estado merece.
 *
 * ## Por que a mensagem de "sem conta" é rara
 *
 * Este é o defeito que a pessoa encontrou: a faixa tocava e o palco dizia
 * "Conecte sua conta do Spotify para ouvir", com a conta conectada. A causa era o
 * palco receber `conectado={false}` fixo — a mensagem estava certa para o código,
 * e errada para a situação.
 *
 * Por isso `sem_conta` só aparece quando o servidor realmente não tem
 * autorização. Toda outra situação tem texto próprio, e nenhum deles pede para
 * conectar uma conta que já está conectada.
 */
export function textoDoEstado(estado: EstadoDoPlayer): string | null {
  switch (estado) {
    case 'sem_conta':
      return 'Conecte sua conta do Spotify para ouvir. Cada pessoa ouve com a conta dela.';
    case 'sem_token':
      return 'Sua sessão do Spotify expirou. Reconecte para continuar ouvindo.';
    case 'premium':
      return 'Spotify Premium é necessário para reproduzir nesta aplicação.';
    case 'ambiente':
      return 'Este ambiente não é compatível com o Spotify Connect. A faixa está na fila.';
    default:
      return null;
  }
}
