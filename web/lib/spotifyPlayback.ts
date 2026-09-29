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
 *   sem_escopo  a conta esta conectada, mas o token foi autorizado **antes** de
 *               user-modify-playback-state existir. Token granted nao cresce, e
 *               a unica saida e autorizar de novo. Nao e Premium, e nao e a conta.
 *   premium     a conta conectou e o Spotify recusou a reproducao. So o SDK sabe
 *               disto, e o `/me` nao.
 *   ambiente    o SDK nao rodou aqui: contexto sem TLS, script bloqueado, ou
 *               Electron — que o Spotify Connect nao reconhece.
 *   autoplay    o navegador bloqueou o audio por regra de autoplay. O device esta
 *               pronto; so falta um clique da pessoa. E um evento real do SDK.
 *   pronto      o device conectou, recebeu `device_id`, e NAO esta tocando.
 *   tocando     o SDK confirmou que esta reproduzindo.
 *
 * ## Por que `pronto` e `tocando` sao separados
 *
 * A primeira versao tratava o `ready` como "tocando", e o palco dizia "Tocando
 * pelo Spotify, na sua conta" com o player conectado, nada carregado e
 * `0:00 / 0:00` na barra. `ready` quer dizer que o **device** existe, e nada
 * mais: ele nao afirma que ha audio, nem que ha faixa, nem que ela comecou.
 *
 * Quem tem que dizer que esta tocando e o `player_state_changed`, que e quem
 * sabe. Sem essa separacao, qualquer texto de reproducao e uma previsao em vez
 * de uma leitura — que e exatamente o tipo de texto que a pessoa viu.
 */
export type EstadoDoPlayer =
  | 'sem_conta'
  | 'sem_token'
  | 'sem_escopo'
  | 'premium'
  | 'ambiente'
  | 'autoplay'
  | 'pronto'
  | 'tocando';

export interface PlayerSpotify {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  /** O `device_id` que o `ready` entregou. É o destino do `PUT /me/player/play`. */
  deviceId: string;
  /**
   * Carrega uma faixa pelo uri.
   *
   * A fila guarda **faixas**, uma a uma: quem escolhe um disco na busca percorre
   * ele e escolhe as músicas, então não há contexto para transmitir.
   */
  tocar: (trackUri: string) => Promise<void>;
  /**
   * Libera a saída de áudio neste navegador.
   *
   * A referência do SDK é explícita: isto precisa ser chamado de dentro de um
   * gesto da pessoa, e é o que resolve o `autoplay_failed`. Como a faixa vira a
   * mídia atual na sala sem ninguém clicar em nada, o gesto chega depois — e o
   * site inteiro é um gesto válido, porque a pessoa pode estar digitando no
   * chat, não apertando play.
   */
  ativar: () => Promise<void>;
  destruir: () => void;
  on: (evento: 'player_state_changed' | 'not_ready', fn: () => void) => void;
}

/**
 * A superfície real do `Spotify.Player`.
 *
 * Copiada da referência oficial, método por método: `connect`, `disconnect`,
 * `addListener`, `removeListener`, `getCurrentState`, `setName`, `getVolume`,
 * `setVolume`, `pause`, `resume`, `togglePlay`, `seek`, `previousTrack`,
 * `nextTrack` e `activateElement`.
 *
 * A primeira versão **declarava** `loadTrack`, `playTrack` e `pauseTrack` neste
 * tipo. Três métodos que não existem. O TypeScript aceitou, o navegador não: o
 * erro real em produção foi
 *
 *   [spotify] playTrack recusado: TypeError: s.playTrack is not a function
 *   [spotify] playback_error: Cannot perform operation, no list was loaded.
 *
 * A lição é sobre a origem do tipo, não sobre o método: um tipo escrito à mão
 * declara o que o programador supõe, e o `tsc` não tem como discordar. Só a
 * documentação discorda. Por isso a lista aqui é a da referência, e a busca pela
 * faixa vai para `PUT /me/player/play`, que é a via documentada para o device do
 * SDK — o áudio continua vindo do player no navegador.
 */
interface PlayerBruto {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: (evento: string, fn: (arg?: unknown) => void) => boolean;
  removeListener: (evento: string, fn?: (arg?: unknown) => void) => boolean;
  getCurrentState: () => Promise<WebPlaybackState | null>;
  setName: (nome: string) => Promise<void>;
  getVolume: () => Promise<number>;
  setVolume: (v: number) => Promise<void>;
  pause: () => Promise<void>;
  play: () => Promise<void>;
  resume: () => Promise<void>;
  togglePlay: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  previousTrack: () => Promise<void>;
  nextTrack: () => Promise<void>;
  activateElement: () => Promise<void>;
}

/** O que o `ready` entrega. */
interface WebPlaybackPlayer {
  device_id: string;
}

/**
 * O estado que o SDK devolve, do jeito que a referência documenta.
 *
 * `is_playing` vem do objeto que o `player_state_changed` entrega. A referência
 * documenta `paused` no `WebPlaybackState` e o `player_state_changed` traz
 * `position`, `duration` e `track_window`; `is_playing` aparece nos exemplos do
 * SDK. Por isso os dois são lidos, e `paused` é o critério quando só um vem.
 */
interface WebPlaybackState {
  is_playing?: boolean;
  paused?: boolean;
  position?: number;
  duration?: number;
  track_window?: {
    current_track?: { uri?: string; name?: string } | null;
  };
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
  /**
   * Carrega a faixa no device do SDK.
   *
   * Fica de fora porque a chamada é HTTP e o token é do servidor: este módulo
   * cuida do SDK e nada mais. É a continuação do player, não um caminho de áudio
   * paralelo — o corpo da requisição é um uri, e quem entrega o som continua
   * sendo o player deste navegador.
   */
  carregar: (deviceId: string, trackUri: string) => Promise<void>;
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

    escutar('ready', (arg) => {
      const deviceId = (arg as WebPlaybackPlayer | undefined)?.device_id ?? '';
      if (!/^[A-Fa-f0-9]{32}$/.test(deviceId)) {
        /*
         * Sem `device_id` nao ha `PUT /me/player/play` possivel, e sem ele o
         * Spotify miraria no dispositivo ativo da conta no celular da pessoa --
         * o oposto do que a sala quer. E o palco nao pode dizer "pronto" sem
         * isso, porque "pronto" sem destino nao e nada.
         */
        console.warn(`[spotify] ready sem device_id utilizavel (${deviceId.length} chars)`);
        opts.onEstado('ambiente');
        finalizar(null);
        return;
      }

      /*
       * `activateElement` libera o audio no dispositivo de saida, e a referencia
       * do SDK e explicita: ele precisa ser chamado **emavincia**, de dentro de um
       * gesto da pessoa. Chamado aqui, fora de um clique, ele nao resolve o caso
       * que importa -- e o evento que reporta a falha e o `autoplay_failed`, que
       * ficou sem tratamento ate agora. O palco chama `destivar` no fim e quem
       * libera e o clique em "Tocar".
       */
      void player.activateElement();

      /*
       * `ready` diz que o **device** existe. Nao diz que ha faixa, nem que ela
       * comecou, nem que ha audio. A primeira versao publicava `tocando` aqui, e
       * o palco escrevia "Tocando pelo Spotify" com `0:00 / 0:00` na barra e
       * nenhum som. Quem publica `tocando` e o `player_state_changed`, abaixo.
       */
      opts.onEstado('pronto');

      finalizar({
        play: async () => {
          await player.play();
        },
        pause: async () => {
          await player.pause();
        },
        seek: async (ms) => {
          await player.seek(ms);
        },
        deviceId,
        ativar: async () => {
          await player.activateElement();
        },
        /*
         * Carrega a faixa no device, e so a faixa.
         *
         * Avia `PUT /me/player/play?device_id=...` com `{"uris":[...]}`, porque a
         * referencia do `Spotify.Player` nao tem metodo nenhum para escolher uma
         * faixa -- ver `PlayerBruto`. A versao anterior chamava `playTrack` e
         * recebia `TypeError: s.playTrack is not a function`, o que deixava o
         * player com `Cannot perform operation, no list was loaded`.
         *
         * O corpo e um uri. O audio continua vindo do player do SDK, neste
         * navegador, com a conta desta pessoa.
         *
         * A decisao sobre Premium nao e tomada aqui: o Spotify responde 403 e o
         * `account_error` e quem traduz isso.
         */
        tocar: async (trackUri) => {
          if (!/^spotify:track:[A-Za-z0-9]{1,64}$/.test(trackUri)) {
            throw new Error(`spotify_uri_invalida:${trackUri.slice(0, 40)}`);
          }
          await opts.carregar(deviceId, trackUri);
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
     * `player_state_changed` e quem sabe se ha audio, e por isso e quem publica
     * `tocando`. Sem este listener o estado so poderia ficar parado em `pronto` para
     * sempre, e o texto do palco nunca poderia afirmar reproducao -- nem
     * mentir sobre ela.
     */
    escutar('player_state_changed', (arg) => {
      const s = (arg as WebPlaybackState | undefined) ?? {};
      const tocando = s.is_playing ?? (s.paused === undefined ? undefined : !s.paused);
      if (tocando === undefined) return;
      const faixaAtual = s.track_window?.current_track?.uri ?? null;
      console.log(
        `[spotify] player_state_changed tocando=${tocando} faixa=${faixaAtual ?? 'nenhuma'}`,
      );
      opts.onEstado(tocando ? 'tocando' : 'pronto');
    });

    /*
     * `autoplay_failed` e um evento real da referencia, e ele nao estava sendo
     * tratado. O navegador recusou iniciar audio sem gesto da pessoa -- o que
     * acontece na sala com frequencia, porque a faixa vira a midia atual sem
     * ninguem ter clicado em nada.
     *
     * Sem tratamento, a sala ficava mostrando a faixa e ninguem ouvia, e nenhum
     * texto explicava: o palco dizia que estava tocando. Este e o estado que
     * fecha essa conta, e ele diz o que a pessoa pode fazer.
     */
    escutar('autoplay_failed', () => {
      console.warn('[spotify] autoplay_failed: o navegador exigiu um gesto antes do audio');
      opts.onEstado('autoplay');
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
    case 'sem_escopo':
      /*
       * A pessoa está conectada e vai ver "reconecte" logo depois de ter feito
       * isso. A explicação importa: a conta não mudou, o consentimento é que
       * precisa ser refeito, porque o Spotify não acrescenta escopos a uma
       * autorização já dada.
       *
       * Sem este texto o caminho seria silencioso — o device conecta, o palco
       * não diz nada, e a pessoa conclui que o Spotify não funciona aqui.
       */
      return 'O Spotify precisa de uma nova autorização para tocar nesta sala. Reconecte a conta.';
    case 'premium':
      return 'Spotify Premium é necessário para reproduzir nesta aplicação.';
    case 'ambiente':
      return 'Este ambiente não é compatível com o Spotify Connect. A faixa está na fila.';
    case 'autoplay':
      /*
       * O único estado que pede um clique, e o clique resolve mesmo. O navegador
       * recusou o áudio porque ninguém tinha interagido com a aba ainda — a faixa
       * vira mídia current na sala sem ninguém clicar em nada, então isto é o
       * caso comum, não o raro.
       */
      return 'O navegador segurou o áudio até você interagir com a página. Aperte Tocar para liberar.';
    default:
      /*
       * `pronto` e `tocando` **não** têm texto aqui, e a ausência é o ponto.
       *
       * A primeira versão transformava o `ready` em "tocando" e o palco
       * escrevia "Tocando pelo Spotify, na sua conta" com nada carregado e
       * `0:00 / 0:00` na barra. Um device conectado não é áudio tocando, e
       * dizer que é uma previsão, não uma leitura.
       */
      return null;
  }
}
