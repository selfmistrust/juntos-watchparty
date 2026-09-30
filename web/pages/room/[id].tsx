import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { JoinGate } from '@/components/JoinGate';
import { PasswordGate } from '@/components/PasswordGate';
import { RoomHeader } from '@/components/RoomHeader';
import { RoomExpired } from '@/components/RoomExpired';
import { Sidebar } from '@/components/Sidebar';
import { SidebarResizer } from '@/components/player/SidebarResizer';
import { VideoStage } from '@/components/player/VideoStage';
import {
  LARGURA_MAX_PAINEL,
  LARGURA_MIN_PAINEL,
  LARGURA_PADRAO_PAINEL,
  gravaLarguraDoPainel,
  lerLarguraDoPainel,
} from '@/lib/larguraPainel';
import { useRoom } from '@/hooks/useRoom';
import { useMencoes } from '@/hooks/useMencoes';
import { MentionBanner } from '@/components/chat/MentionBanner';
import { useStreamBridge } from '@/hooks/useStreamBridge';
import type { ChatMentionEvent } from '@/types';

const NAME_KEY = 'juntos:name';
const AVATAR_SEED_KEY = 'juntos:avatarSeed';
const AVATAR_URL_KEY = 'juntos:avatarUrl';
const COLOR_KEY = 'juntos:color';

/**
 * A página depende do id da URL, mas não tinha nenhum método de dados — o
 * Next a tratava como auto-exportada e servia um shell estático com
 * `__NEXT_DATA__.query` vazio. Nesse caso o router do cliente nunca resolvia
 * o parâmetro: `query` ficava `{}` e `asPath` travava em `/room/[id]`, com
 * `isReady` em `false` para sempre. Como a página devolvia `null` sem um
 * `roomId`, quem abria o link direto (inclusive pelo convite) ficava com uma
 * página em branco que não recuperava nem com F5.
 *
 * Declarar `getServerSideProps` resolve na raiz: o Next passa a renderizar
 * esta rota no servidor, o `params.id` chega preenchido e o `query` do
 * `__NEXT_DATA__` sai correto, então o router resolve na hora. Nada de dado é
 * buscado aqui — a sala em si chega pelo socket —, o método existe só para
 * a rota deixar de ser pré-renderizada.
 */
export function getServerSideProps() {
  return { props: {} };
}

/**
 * Rede de segurança para o id: se o `query` do router vier vazio, lê da
 * própria URL. Com o `getServerSideProps` acima o caso normal não acontece,
 * mas deixar a página cega aqui significaria voltar ao mesmo bug de tela
 * branca por qualquer outra razão que faça o param atrasar.
 */
function roomIdFromPath(): string {
  if (typeof window === 'undefined') return '';
  const match = window.location.pathname.match(/^\/room\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : '';
}

export default function RoomPage() {
  const router = useRouter();
  const roomId =
    typeof router.query.id === 'string' && router.query.id ? router.query.id : roomIdFromPath();

  const [name, setName] = useState('');
  const [avatarSeed, setAvatarSeed] = useState<string | undefined>();
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>();
  const [color, setColor] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /**
   * A largura do painel, e a divisória que a ajusta.
   *
   * Os limites e a leitura do `localStorage` estão em `lib/larguraPainel`, e não
   * aqui, porque os mesmos números precisam valer na página, na divisória e no
   * `Sidebar` — um `min` em cada lugar é como o painel fica mais estreito que o
   * mínimo num recarregamento.
   */
  const [larguraPainel, setLarguraPainel] = useState(LARGURA_PADRAO_PAINEL);

  /**
   * A largura guardada entra depois da montagem, e não no inicializador do
   * `useState`.
   *
   * O inicializador roda no servidor, onde `localStorage` não existe, e a
   * alternativa — `typeof window` dentro dele — produz dois valores diferentes
   * entre o HTML do servidor e o primeiro render do cliente. O React descarta o
   * HTML nesse caso e o usuário vê a sala piscar para a largura padrão e depois
   * pular para a sua.
   *
   * E a gravação acontece só quando o valor lido difere do padrão, para não
   * encher o `localStorage` de quem nunca tocou na divisória.
   */
  useEffect(() => {
    const guardada = lerLarguraDoPainel();
    if (guardada !== null) setLarguraPainel(guardada);
  }, []);

  const ajustarLargura = useCallback((nova: number) => {
    setLarguraPainel((atual) => {
      if (nova === atual) return atual;
      gravaLarguraDoPainel(nova);
      return nova;
    });
  }, []);

  /** Nome, avatar e cor ficam salvos para quem volta à mesma aba não escolher de novo. */
  useEffect(() => {
    const storedName = window.localStorage.getItem(NAME_KEY);
    if (storedName) setName(storedName);
    const storedSeed = window.localStorage.getItem(AVATAR_SEED_KEY);
    if (storedSeed) setAvatarSeed(storedSeed);
    const storedUrl = window.localStorage.getItem(AVATAR_URL_KEY);
    if (storedUrl) setAvatarUrl(storedUrl);
    const storedColor = window.localStorage.getItem(COLOR_KEY);
    if (storedColor) setColor(storedColor);
  }, []);

  const join = (value: string, avatar: { seed: string; url?: string }) => {
    window.localStorage.setItem(NAME_KEY, value);
    window.localStorage.setItem(AVATAR_SEED_KEY, avatar.seed);
    if (avatar.url) window.localStorage.setItem(AVATAR_URL_KEY, avatar.url);
    else window.localStorage.removeItem(AVATAR_URL_KEY);
    setName(value);
    setAvatarSeed(avatar.seed);
    setAvatarUrl(avatar.url);
  };

  /*
   * Ponte de menção, declarada **antes** do `useRoom`.
   *
   * O `useRoom` é quem assina o socket, e o `useMencoes` — que decide som,
   * notificação e destaque — precisa do `me` que o `useRoom` devolve. A ordem
   * dos hooks não pode ser invertida, então a ponte é uma ref: o `useRoom`
   * recebe um callback estável que só olha a ref, e a ref é apontada para o
   * `useMencoes` assim que ele existir, na linha seguinte.
   *
   * A alternativa — passar o handler direto e depender do `me` — remontaria a
   * conexão do socket cada vez que o `me` mudasse, e menção é justamente o que
   * não pode se perder.
   */
  const mencaoRef = useRef<((evento: ChatMentionEvent) => void) | null>(null);
  const atender = useCallback((evento: ChatMentionEvent) => mencaoRef.current?.(evento), []);

  const {
    connected,
    me,
    state,
    feed,
    typingUsers,
    notice,
    joinError,
    expired,
    retryPassword,
    isHost,
    canControl,
    currentItem,
    targetPosition,
    reactions,
    actions,
  replyingTo,
  } = useRoom({ roomId, name, enabled: Boolean(roomId && name), avatarSeed, avatarUrl, color, onMention: atender });

  /**
   * Ponte de WebRTC da sala. Fica na página, e não dentro do `useRoom`, porque
   * quem transmite precisa do `MediaStream` que o painel de captura produz — e
   * esse fluxo é mídia local de uma máquina só, não estado da sala.
   */
  const streamBridge = useStreamBridge();

  /** Ponte para a limpeza do contador, montada depois do `useMencoes`. */
  const limparNaoLidasRef = useRef<() => void>(() => undefined);

  /**
   * Abre o chat quando alguém te menciona.
   *
   * É aqui que o "destacar a aba/chat" vira alguma coisa visível. O aviso em
   * si mora no `MentionBanner`; este callback é o que ele chama ao ser clicado,
   * e o que a notificação do sistema chama quando a pessoa clica nela.
   *
   * Abrir o painel é o gesture certo e não é invasivo: quem estava vendo vídeo
   * numa tela cheia vê o painel, e quem já tinha o chat aberto não sente nada.
   * Roubar o foco da janela seria outra coisa, e na web não seria possível.
   */
  const abrirChat = useCallback(() => {
    setSidebarOpen(true);
    /*
     * Abrir o chat **é** ver as menções. Sem zerar aqui, o `(3)` ficava na aba
     * depois de a pessoa ter lido tudo, e ela não teria como saber se aquilo
     * era novidade ou resíduo — e título de aba que mente sobre o estado é pior
     * do que não ter.
     *
     * A limpeza vem por ref porque `abrirChat` é criado **antes** do
     * `useMencoes`, que precisa de `abrirChat`. A mesma ponte do `useRoom`, com
     * a mesma razão: a ordem dos hooks não deixa a dependência ser direta.
     */
    limparNaoLidasRef.current();
  }, []);


  const mencoes = useMencoes({
    meuSessionId: me?.sessionId,
    /*
     * `userId`, e não `sessionId`: o `sessionId` é o socket e muda a cada
     * reconexão, enquanto o endereço de push fica no servidor por `userId`. Se a
     * inscrição fosse pela sessão, cada recarga de página deixaria para trás um
     * endereço de push que nunca mais receberia nada — e a lista cresceria a cada
     * F5 até o envio de uma menção custar uma dezena de chamadas que falham.
     */
    meuUserId: me?.userId,
    aoAbrirChat: abrirChat,
  });
  mencaoRef.current = mencoes.tratar;
  limparNaoLidasRef.current = mencoes.limparNaoLidas;

  /*
   * O título da aba marca quantas menções chegaram.
   *
   * Na web não existe API para focar outra aba — e não deveria, um site que
   * roubasse o foco seria hostil. O que dá para fazer é marcar o título, que é
   * o que a pessoa vê na barra de tarefas e no Alt+Tab.
   *
   * ## A versão anterior acumulava `(0) (0) (0) (0) junto`
   *
   * Ela lia `document.title` como base **depois** de já ter escrito nele, e
   * escrevia mesmo com o contador em zero. Cada menção acrescentava um `(0)`,
   * porque a "base" da vez seguinte já era o título adulterado. E a guarda
   * `!original.includes('•')` nunca segurou nada: nada escrevia `•`.
   *
   * A base agora é capturada uma vez, na montagem, antes de qualquer escrita, e
   * guardada numa ref. Daí em diante o título é sempre `base` ou
   * `(n) base` — nunca as duas coisas ao mesmo tempo. E nada é escrito quando o
   * contador é zero, porque `(0) junto` é pior do que `junto`.
   *
   * Por que mexer no título de todo modo: ele é o único indicador que sobrevive
   * a aba em segundo plano sem depender de notificação do sistema, que o
   * navegador pode escolher não mostrar.
   */
  const tituloBase = useRef<string | null>(null);
  if (tituloBase.current === null && typeof document !== 'undefined') {
    tituloBase.current = document.title;
  }

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const base = tituloBase.current ?? document.title;
    const naoLidas = mencoes.mencoesNaoLidas;
    document.title = naoLidas > 0 ? `(${naoLidas}) ${base}` : base;
  }, [mencoes.mencoesNaoLidas]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    return () => {
      // A base é restaurada ao sair: sem isto, sair da sala deixava o `(2)` na
      // aba, e a próxima sala começaria com um contador de fantasma.
      if (tituloBase.current) document.title = tituloBase.current;
    };
  }, []);

  /**
   * A mídia que o palco toca depende de dois papéis. Quem transmite já tem a
   * captura local: tocar o que veio de volta da própria conexão WebRTC
   * atrasaria a própria tela em um round-trip. Quem assiste usa o que chegou.
   */
  const souDono = Boolean(
    streamBridge.transmitting && streamBridge.transmitting.id === currentItem?.streamId,
  );
  const liveStream = souDono ? streamBridge.meuStream : streamBridge.remoto;
  const liveConectando =
    !souDono && Boolean(currentItem?.streamId) && !streamBridge.remoto;

  /**
   * Troca de nome, avatar ou cor feita depois de já estar na sala (painel de
   * pessoas) só passa pelo socket — sem isso aqui, ela nunca volta para o
   * localStorage nem para o estado desta página. Reabrir a aba (comum no
   * celular, que descarta abas em segundo plano) voltaria a mandar o nome, o
   * avatar ou a cor antigos salvos na entrada, entrando em conflito com o que
   * já estava valendo.
   */
  useEffect(() => {
    if (!me) return;
    if (me.name !== name) {
      setName(me.name);
      window.localStorage.setItem(NAME_KEY, me.name);
    }
    if (me.avatarSeed !== avatarSeed) {
      setAvatarSeed(me.avatarSeed);
      window.localStorage.setItem(AVATAR_SEED_KEY, me.avatarSeed);
    }
    if (me.avatarUrl !== avatarUrl) {
      setAvatarUrl(me.avatarUrl);
      if (me.avatarUrl) window.localStorage.setItem(AVATAR_URL_KEY, me.avatarUrl);
      else window.localStorage.removeItem(AVATAR_URL_KEY);
    }
    // Espelha a cor para os dois lados: grava no localStorage (para o próximo
    // F5) e devolve para o estado, que é o que o `useRoom` reenvia no join.
    if (me.color && me.color !== color) {
      setColor(me.color);
      window.localStorage.setItem(COLOR_KEY, me.color);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  /**
   * Assina (ou cancela) a transmissão conforme a faixa atual.
   *
   * Fica na página porque depende de `currentItem`, que o palco já consome.
   * Quem transmite não assina a própria — o bridge recusa, e o efeito abaixo
   * sai cedo para não emitir pedido à toa.
   */
  useEffect(() => {
    const streamId = currentItem?.kind === 'stream' ? currentItem.streamId : undefined;
    if (!streamId || souDono) return;
    streamBridge.assinar(streamId);
    return () => streamBridge.cancelar(streamId);
    // `streamBridge` é recriado a cada render; o que importa é o id da faixa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItem?.streamId, souDono]);

  // Sem id não há nem o que mostrar — nem onde procurar a sala. Um estado de
  // carregamento é melhor que `null`: tela branca não dá nenhuma pista do que
  // aconteceu, e era o sintoma do bug que esta rota tinha.
  if (!roomId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-sm text-ink-faint">Abrindo a sala…</p>
      </div>
    );
  }
  if (!name) return <JoinGate roomId={roomId} onJoin={join} />;

  // Antes do `joinError`: uma sala vencida não tem senha para checar, e o
  // `state` já está em memória, então sem esta ordem o gate de senha
  // ganharia.
  if (expired) return <RoomExpired roomId={roomId} />;

  if (joinError && !state) {
    return <PasswordGate roomId={roomId} error={joinError} onSubmit={retryPassword} />;
  }

  if (!state) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-sm text-ink-faint">Entrando na sala…</p>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <RoomHeader
        state={state}
        connected={connected}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        /*
         * As preferências de menção moram no cabeçalho, e não no painel de chat.
         *
         * Elas valem para a sala inteira — inclusive com o painel fechado, que é
         * quando "não me perturbe" mais importa — e o sino no topo aparece na
         * hora em que a pessoa decide se quer ser interrompida, em vez de
         * aparecer só depois de abrir o painel.
         */
        mentionPrefs={mencoes.prefs}
        onMentionPrefs={mencoes.atualizarPrefs}
        aoPedirPermissaoNotificacao={() => void mencoes.pedirPermissao()}
        jaPediuPermissaoNotificacao={mencoes.jaPediuPermissao}
        pushDeMencaoAtivo={mencoes.pushAtivo}
      />

      {/* Mobile: vídeo no topo, chat empilhado logo abaixo, página rola se precisar.
          Desktop: vídeo ocupa o espaço restante à esquerda, painel fixo à direita. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <main className="flex shrink-0 flex-col p-3 lg:min-h-0 lg:flex-1 lg:p-0">
          <VideoStage
            state={state}
            currentItem={currentItem}
            canControl={canControl}
            targetPosition={targetPosition}
            actions={actions}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            reactions={reactions}
            liveStream={liveStream}
            liveConnecting={liveConectando}
            liveError={streamBridge.erro}
            /*
             * Prontidão: só a faixa `prime` usa, e o palco decide o que
             * fazer com ela. O `readiness` do snapshot é `null` para as outras,
             * e é por isso que ele pode passar direto.
             */
            readiness={state.readiness ?? null}
            users={state.users}
            meId={me?.userId}
            isPrime={currentItem?.kind === 'prime'}
          />
          {currentItem && (
            <div className="shrink-0 px-1 pt-3 lg:px-5 lg:pb-4">
              <h1 className="line-clamp-1 text-sm text-ink">{currentItem.title}</h1>
              <p className="mt-0.5 text-2xs text-ink-faint">
                adicionado por {currentItem.addedBy}
                {!canControl && ' · só o host controla a reprodução'}
              </p>
            </div>
          )}
        </main>

        {/*
          * A divisória fica entre o `main` e o `Sidebar`, e só no desktop.
          *
          * Abaixo de `lg` o layout é empilhado — vídeo em cima, painel embaixo — e
          * não existe uma borda vertical para arrastar. Mostrar a alça ali seria
          * um controle que não faz nada, e a única resposta que ela elicitaria é
          * puxar e nada mexer.
          *
          * Ela também não aparece com o painel fechado: sem painel para
          * redimensionar, a alça ficaria colada na borda da tela, e arrastá-la
          * mudaria a largura de algo invisível.
          */}
        {sidebarOpen && (
          <SidebarResizer
            width={larguraPainel}
            onChange={ajustarLargura}
            min={LARGURA_MIN_PAINEL}
            max={LARGURA_MAX_PAINEL}
            padrao={LARGURA_PADRAO_PAINEL}
          />
        )}

        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          largura={larguraPainel}
          state={state}
          me={me}
          feed={feed}
          typingUsers={typingUsers}
          actions={actions}
          canControl={canControl}
          isHost={isHost}
          replyingTo={replyingTo}
          streamBridge={streamBridge}
        />
      </div>

      {/*
        * O aviso de menção, dentro do app.
        *
        * Fica logo acima da barra de bate-papo, e não no centro da tela: a
        * menção é sobre o chat, e um aviso no meio taparia o vídeo — que é a
        * única coisa que a pessoa está querendo ver enquanto assiste.
        *
        * Só aparece quando o painel está fechado. Com ele aberto, a mensagem
        * citada já está na tela e o aviso seria uma segunda cópia do que a
        * pessoa está lendo.
        */}
      {mencoes.ultimaMencao && !sidebarOpen && (
        <MentionBanner
          fromName={mencoes.ultimaMencao.fromName}
          texto={mencoes.ultimaMencao.texto}
          preview={mencoes.ultimaMencao.preview}
          total={mencoes.mencoesNaoLidas}
          onAbrir={() => {
            abrirChat();
            mencoes.limparNaoLidas();
          }}
          onFechar={mencoes.limparNaoLidas}
        />
      )}

      {notice && (
        <div className="animate-fade-up pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-hairline bg-raised px-4 py-2.5 text-sm text-ink shadow-lift">
          {notice}
        </div>
      )}
    </div>
  );
}
