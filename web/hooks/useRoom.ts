import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from '@/lib/socket';
import { getUserId } from '@/lib/identity';
import type {
  ChatMessage,
  FeedEntry,
  FloatingReaction,
  GifResult,
  JoinError,
  PlaylistItem,
  ReactionEmoji,
  RoomSnapshot,
  SystemEvent,
  User,
  ChatMentionEvent,
} from '@/types';

const MAX_FEED = 250;

interface UseRoomOptions {
  roomId: string;
  name: string;
  /** Só conecta depois que o usuário informou o nome. */
  enabled: boolean;
  /** Avatar escolhido na tela de entrada; pode ser trocado depois com actions.setAvatar. */
  avatarSeed?: string;
  avatarUrl?: string;
  /** Cor salva no navegador; reenviada a cada entrada para não voltar à cor padrão. */
  color?: string;
  /**
   * Alguém te mencionou.
   *
   * É um callback e não estado, por dois motivos: `useRoom` não sabe nada de
   * som nem de notificação — quem sabe é o `useMencoes` da página —, e o
   * efeito de conexão não pode depender de um objeto que muda a cada render da
   * página. Com callback guardado em ref, o listener se registra uma vez e
   * sempre chama a versão atual.
   */
  onMention?: (evento: ChatMentionEvent) => void;
}

export interface RoomActions {
  play: (at?: number) => void;
  pause: (at?: number) => void;
  seek: (to: number) => void;
  ended: () => void;
  addToPlaylist: (item: Omit<PlaylistItem, 'id' | 'addedBy' | 'addedById'>) => void;
  removeFromPlaylist: (itemId: string) => void;
  reorderPlaylist: (from: number, to: number) => void;
  selectTrack: (index: number) => void;
  setOpenControl: (open: boolean) => void;
  sendMessage: (payload: { kind?: 'text' | 'gif' | 'image'; text?: string; mediaUrl?: string; parentMessageId?: string }) => void;
  sendGif: (gif: GifResult) => void;
  sendImage: (dataUrl: string) => void;
  setTyping: (isTyping: boolean) => void;
  sendReaction: (emoji: ReactionEmoji) => void;
  setColor: (color: string) => void;
  setAvatar: (avatar: { seed?: string; url?: string }) => void;
  setName: (name: string) => void;
  /** Reage a uma mensagem do chat, ou desfaz a reação se o usuário já reagiu. */
  toggleReaction: (messageId: string, emoji: string) => void;
  /** Responder a uma mensagem do chat. */
  reply: (message: ChatMessage) => void;
  /** Cancelar resposta em andamento. */
  cancelReply: () => void;
  requestUploadToken: (payload: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  }) => Promise<UploadTokenResult>;
}

export type UploadTokenResult =
  | { ok: true; uploadUrl: string; publicUrl: string; contentType: string }
  | { ok: false; error: string };

export function useRoom({ roomId, name, enabled, avatarSeed, avatarUrl, color, onMention }: UseRoomOptions) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<User | null>(null);
  const [state, setState] = useState<RoomSnapshot | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<JoinError | null>(null);
  /**
   * A sala atingiu o tempo máximo de vida e o servidor a encerrou. Diferente
   * de `notice` (que some sozinho), isto é terminal: a tela precisa sair do
   * player, porque a chave da sala não existe mais e nada recarregado volta a
   * funcionar. Também não dá para reconectar — o `room:join` cairia no
   * `ensureRoom`, que recria a sala vazia, e a pessoa cairia num chat morto
   * sem nenhum aviso de que o histórico se foi.
   */
  const [expired, setExpired] = useState(false);
  /** Reações flutuantes ativas — cada uma se remove sozinha depois da animação. */
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  /** Mensagem sendo respondida no momento (para preview no input). */
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  /** Última senha tentada; usada tanto no join inicial quanto em reconexões. */
  const passwordRef = useRef('');
  /**
   * Callback de menção da página, guardado em ref.
   *
   * Fica no escopo do hook e não dentro do efeito: `useRef` chamado de dentro de
   * um callback é hook em lugar errado, e o lint avisa com razão. Com a ref aqui,
   * o listener do socket lê a versão atual do callback sem nunca se registrar de
   * novo.
   */
  const mencaoRef = useRef(onMention);
  mencaoRef.current = onMention;
  /**
   * Avatar a mandar em cada `room:join` — inclui reconexões automáticas do
   * Socket.io (queda de wi-fi, celular bloqueou, aba ficou muito tempo em
   * segundo plano). Começa com o que veio da tela de entrada, mas depois de
   * cada `room:welcome`/`room:state` é atualizada pra refletir o que o
   * servidor confirmou por último — inclusive uma troca de foto feita no
   * meio da sessão pelo painel de pessoas. Sem isso, uma reconexão silenciosa
   * reenviaria o avatar antigo (a semente do DiceBear escolhida lá no
   * início) e apagaria a foto enviada, mesmo com ela já valendo há um tempo.
   */
  const avatarRef = useRef({ avatarSeed, avatarUrl });
  /**
   * Mesma ideia do `avatarRef`, para a cor. O servidor só sorteia uma cor nova
   * quando o join chega sem `color`; como o `color` era reenviado só no
   * primeiro render, um F5 mandava o payload sem ele e a pessoa voltava para a
   * cor que o servidor sortearia naquele momento.
   */
  const colorRef = useRef(color);
  /** serverTime - clientTime, já descontada metade do round-trip. */
  const clockOffset = useRef(0);
  /**
   * Espelhos de `feed` e `me.userId` usados por `toggleReaction`, que
   * precisa decidir entre `chat:reaction:add` e `chat:reaction:remove` no
   * instante do clique. O `actions` abaixo é memoizado com `[emit]`, então
   * não pode depender do `feed` diretamente sem recriar todas as ações a cada
   * mensagem nova. A leitura é sempre a do último render, o que basta — o
   * clique acontece depois que a tela atualizou.
   */
  const feedRef = useRef<FeedEntry[]>([]);
  const userIdRef = useRef('');
  /**
   * O histórico chega no `room:welcome`/`room:state` (últimas 100 mensagens),
   * mas o `feed` só crescia com eventos ao vivo. Sem semear uma única vez, cada
   * recarregamento da página abria o chat vazio — e junto sumiam as reações já
   * dadas nas mensagens antigas, que só existem guardadas no snapshot.
   */
  const seededFromSnapshot = useRef(false);

  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

  useEffect(() => {
    userIdRef.current = me?.userId ?? '';
  }, [me]);

  /**
   * Sem isto, o `useRef` acima só congela o avatar que existia no primeiro
   * render deste hook — e esse primeiro render acontece antes do efeito em
   * `pages/room/[id].tsx` terminar de ler a foto salva no localStorage (o
   * `useRoom` já é chamado mesmo com a `JoinGate` ainda na tela, só que
   * "desligado" via `enabled`). Resultado: ao atualizar a página, o
   * `room:join` saía sempre com `avatarUrl: undefined` e a foto sumia,
   * voltando pro avatar do DiceBear. Mantendo a ref em dia com as props a
   * cada mudança — não só quando `me` muda — o valor certo já está pronto
   * antes do primeiro `join()`.
   */
  useEffect(() => {
    avatarRef.current = { avatarSeed, avatarUrl };
  }, [avatarSeed, avatarUrl]);

  /**
   * Mantém a cor salva em dia com a prop. Pelo mesmo motivo do `avatarRef`
   * acima: o primeiro render acontece antes do efeito da página ler o
   * localStorage, então sem isto a cor salva nunca chegaria ao `join`.
   * Também reflete uma troca feita no painel de pessoas, para que a próxima
   * reconexão não reponha a cor antiga.
   */
  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  useEffect(() => {
    if (!enabled || !roomId) return;
    const socket = getSocket();
    socketRef.current = socket;
    // Trocar de sala precisa relemer o histórico: o guard abaixo é por sessão.
    seededFromSnapshot.current = false;

    const pushFeed = (entry: FeedEntry) =>
      setFeed((prev) => [...prev, entry].slice(-MAX_FEED));

    const join = () => {
      setConnected(true);
      socket.emit('room:join', {
        roomId,
        name,
        password: passwordRef.current || undefined,
        userId: getUserId(),
        avatarSeed: avatarRef.current.avatarSeed,
        avatarUrl: avatarRef.current.avatarUrl,
        color: colorRef.current,
      });
      syncClock(socket, clockOffset);
    };

    const onWelcome = ({ you, state: snap }: { you: User; state: RoomSnapshot }) => {
      setJoinError(null);
      setMe(you);
      setState(snap);
    };

    const onJoinError = (error: JoinError) => setJoinError(error);
    // Idempotente de propósito: com mais de uma instância do servidor, todas
    // rodam a varredura e o mesmo aviso chega mais de uma vez.
    const onExpired = () => setExpired(true);
    const onState = (snap: RoomSnapshot) => setState(snap);
    const onMessage = (msg: ChatMessage) => pushFeed({ type: 'message', ...msg });
    const onEvent = (evt: SystemEvent) => pushFeed({ type: 'system', ...evt });

    const onTyping = ({ id, name: who, isTyping }: { id: string; name: string; isTyping: boolean }) =>
      setTypingUsers((prev) => {
        const next = { ...prev };
        if (isTyping) next[id] = who;
        else delete next[id];
        return next;
      });

    // Handlers para reações e respostas no chat
    const onReactionAdd = ({ messageId, emoji, userId }: { messageId: string; emoji: string; userId: string }): void => {
      setFeed((prev: FeedEntry[]) =>
        prev.map((entry: FeedEntry): FeedEntry => {
          if (entry.type !== 'message' || entry.id !== messageId) return entry;
          const current = entry.reactions?.[emoji];
          // O servidor já ignora o segundo like da mesma pessoa, mas o mesmo
          // evento pode chegar duas vezes (reconexão, snapshot + broadcast).
          // Contar de novo deixaria o número e a lista de usuários divergentes.
          if (current?.users.includes(userId)) return entry;
          const users = current ? [...current.users, userId] : [userId];
          return {
            ...entry,
            reactions: { ...entry.reactions, [emoji]: { count: users.length, users } },
          };
        })
      );
    };

    const onReactionRemove = ({ messageId, emoji, userId }: { messageId: string; emoji: string; userId: string }): void => {
      setFeed((prev: FeedEntry[]) =>
        prev.map((entry: FeedEntry): FeedEntry => {
          if (entry.type !== 'message' || entry.id !== messageId) return entry;
          const current = entry.reactions?.[emoji];
          if (!current) return entry;
          const users = current.users.filter((u) => u !== userId);
          const reactions = { ...entry.reactions };
          if (users.length === 0) delete reactions[emoji];
          else reactions[emoji] = { count: users.length, users };
          return { ...entry, reactions };
        })
      );
    };

    const onDenied = (message: string) => setNotice(message);
    const onDisconnect = () => setConnected(false);

    /*
     * Menção recebida.
     *
     * Lê a ref, que fica no escopo do hook: declarar `useRef` aqui dentro seria
     * chamar um hook de dentro de um callback, que o React não permite — e o
     * aviso do lint está certo mesmo. Com a ref no escopo, o listener do socket
     * registra uma vez e sempre chama a versão atual do callback da página, sem
     * depender dele: se fosse dependência do efeito, cada render da página — e o
     * `draft` do chat muda a cada tecla — remontaria a conexão inteira.
     */
    const onMentionEvent = (evento: ChatMentionEvent) => mencaoRef.current?.(evento);

    /** Reação recebida: sorteia posição/duração aqui mesmo e agenda a própria remoção. */
    const onReaction = ({ id, emoji, name: who }: { id: string; emoji: string; userId: string; name: string }) => {
      const entry: FloatingReaction = {
        id,
        emoji,
        name: who,
        left: 8 + Math.random() * 84,
        duration: 2.6 + Math.random() * 1.4,
      };
      setReactions((prev) => [...prev, entry]);
      setTimeout(
        () => setReactions((prev) => prev.filter((r) => r.id !== id)),
        (entry.duration + 0.3) * 1000,
      );
    };

    if (socket.connected) join();
    socket.on('connect', join);
    socket.on('disconnect', onDisconnect);
    socket.on('room:welcome', onWelcome);
    socket.on('room:join:error', onJoinError);
    socket.on('room:state', onState);
    socket.on('room:event', onEvent);
    socket.on('room:expired', onExpired);
    socket.on('room:denied', onDenied);
    socket.on('chat:message', onMessage);
    socket.on('chat:reaction:add', onReactionAdd);
    socket.on('chat:reaction:remove', onReactionRemove);
    socket.on('chat:typing', onTyping);
    /*
     * Só a pessoa citada recebe isto. O servidor emite direto para o socket
     * dela, e não pela sala — é a diferença entre o `@` ser um sinal e ser um
     * alarme com som para todo mundo.
     */
    socket.on('chat:mention', onMentionEvent);
    socket.on('reaction:new', onReaction);

    const clockTimer = setInterval(() => syncClock(socket, clockOffset), 15_000);

    return () => {
      clearInterval(clockTimer);
      socket.off('connect', join);
      socket.off('disconnect', onDisconnect);
      socket.off('room:welcome', onWelcome);
      socket.off('room:join:error', onJoinError);
      socket.off('room:state', onState);
      socket.off('room:event', onEvent);
      socket.off('room:expired', onExpired);
      socket.off('room:denied', onDenied);
      socket.off('chat:message', onMessage);
      socket.off('chat:reaction:add', onReactionAdd);
      socket.off('chat:reaction:remove', onReactionRemove);
      socket.off('chat:typing', onTyping);
      // Sem este `off`, o handler antigo continuaria registrado: o socket é
      // reaproveitado entre salas, e a menção da sala anterior tocaria o som na
      // pessoa que acabou de entrar em outra.
      socket.off('chat:mention', onMentionEvent);
      socket.off('reaction:new', onReaction);
    };
    // avatarSeed/avatarUrl não entram nas deps de propósito: usá-las direto
    // faria esse efeito inteiro reconectar o socket a cada troca de avatar.
    // O valor atual pra reconexões automáticas vem de `avatarRef` (acima),
    // que já é mantida em dia por fora deste efeito.
  }, [enabled, roomId, name]);

  /**
   * Semelha o histórico do snapshot no feed — uma única vez por sessão, para
   * não duplicar as mensagens a cada `room:state` emitido durante a sessão.
   */
  useEffect(() => {
    if (!state || seededFromSnapshot.current) return;
    seededFromSnapshot.current = true;
    const history = state.messages ?? [];
    if (history.length === 0) return;
    setFeed(history.map((m) => ({ type: 'message', ...m })));
  }, [state]);

  /** Mantém `me` em dia quando o próprio usuário muda nome/cor/avatar (o broadcast chega em `state`). */
  useEffect(() => {
    if (!me || !state) return;
    const updated = state.users.find((u) => u.userId === me.userId);
    if (
      updated &&
      (updated.name !== me.name ||
        updated.color !== me.color ||
        updated.avatarSeed !== me.avatarSeed ||
        updated.avatarUrl !== me.avatarUrl)
    ) {
      setMe(updated);
    }
  }, [state, me]);

  /** Espelha o avatar mais recente confirmado pelo servidor — ver comentário em `avatarRef`. */
  useEffect(() => {
    if (me) avatarRef.current = { avatarSeed: me.avatarSeed, avatarUrl: me.avatarUrl };
  }, [me]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  /**
   * Rede de segurança do encerramento: se o `room:expired` não chegar — socket
   * caiu antes do aviso, aba ficou em segundo plano e o timer do navegador foi
   * congelado, o servidor caiu no meio — a sala encerra sozinha na hora certa.
   *
   * O atraso é corrigido pelo `clockOffset`, que o hook já mantém: sem isso o
   * relógio do cliente — que pode estar errado por minutos — decidiria quando
   * a sala morre. A dependência é só `expiresAt`, que é constante na vida da
   * sala; usar `serverTime` reiniciaria o timer a cada `room:state`.
   */
  useEffect(() => {
    if (!state?.expiresAt) return;
    const restante = state.expiresAt - (Date.now() + clockOffset.current);
    if (restante <= 0) {
      setExpired(true);
      return;
    }
    // O `+1s` é folga de relógio entre instâncias: encerra um instante depois
    // do servidor, nunca antes.
    const t = setTimeout(() => setExpired(true), restante + 1_000);
    return () => clearTimeout(t);
  }, [state?.expiresAt]);

  /**
   * Depois de expirada, a sala é um beco sem saída: o servidor já apagou a
   * chave. Qualquer reconexão — automática do Socket.io ou disparada pelo
   * `connect` lá dentro — faria `room:join` cair no `ensureRoom`, que recria a
   * sala vazia. A pessoa veria um chat sem histórico e sem ninguém, sem
   * nenhuma explicação. Travar o rejoin deixa o encerramento ser o que a tela
   * mostra.
   */
  useEffect(() => {
    if (!expired) return;
    socketRef.current?.removeAllListeners();
    socketRef.current?.disconnect();
  }, [expired]);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  /** Tenta entrar de novo com uma senha, reaproveitando a conexão já aberta. */
  const retryPassword = useCallback(
    (password: string) => {
      passwordRef.current = password;
      socketRef.current?.emit('room:join', {
        roomId,
        name,
        userId: getUserId(),
        color: colorRef.current,
        password: password || undefined,
      });
    },
    [roomId, name],
  );

  const actions = useMemo<RoomActions>(
    () => ({
      play: (at) => emit('player:play', at),
      pause: (at) => emit('player:pause', at),
      seek: (to) => emit('player:seek', to),
      ended: () => emit('player:ended'),
      addToPlaylist: (item) => emit('playlist:add', item),
      removeFromPlaylist: (itemId) => emit('playlist:remove', itemId),
      reorderPlaylist: (from, to) => emit('playlist:reorder', { from, to }),
      selectTrack: (index) => emit('playlist:select', index),
      setOpenControl: (open) => emit('room:setOpenControl', open),
      sendMessage: (payload: { kind?: 'text' | 'gif' | 'image'; text?: string; mediaUrl?: string; parentMessageId?: string }) => {
        emit('chat:message', payload);
        if (payload.parentMessageId) setReplyingTo(null);
      },
      sendGif: (gif) => emit('chat:message', { kind: 'gif', mediaUrl: gif.url, text: gif.title }),
      sendImage: (dataUrl) => emit('chat:message', { kind: 'image', mediaUrl: dataUrl }),
      setTyping: (isTyping) => emit('chat:typing', isTyping),
      sendReaction: (emoji) => emit('reaction:send', emoji),
      setColor: (color) => emit('user:setColor', color),
      setAvatar: (avatar) => emit('user:setAvatar', avatar),
      setName: (newName) => emit('user:setName', newName),
      toggleReaction: (messageId, emoji) => {
        const entry = feedRef.current.find(
          (e): e is FeedEntry & { type: 'message' } => e.type === 'message' && e.id === messageId
        );
        const mine = entry?.reactions?.[emoji]?.users.includes(userIdRef.current) ?? false;
        emit(mine ? 'chat:reaction:remove' : 'chat:reaction:add', { messageId, emoji });
      },

      reply: (message) => setReplyingTo(message),
      cancelReply: () => setReplyingTo(null),
      requestUploadToken: (payload) =>
        new Promise<UploadTokenResult>((resolve) => {
          const socket = socketRef.current;
          if (!socket) {
            resolve({ ok: false, error: 'offline' });
            return;
          }
          socket.emit('upload:requestToken', payload, (res?: UploadTokenResult) => {
            resolve(res ?? { ok: false, error: 'no_response' });
          });
        }),
    }),
    [emit],
  );

  const isHost = Boolean(me && state && state.hostId === me.sessionId);
  const canControl = Boolean(state?.openControl) || isHost;
  const currentItem = state && state.currentIndex >= 0 ? state.playlist[state.currentIndex] ?? null : null;

  /** Posição autoritativa projetada para agora, já corrigida pelo offset de relógio. */
  const targetPosition = useCallback(() => {
    if (!state) return 0;
    if (!state.isPlaying) return state.position;
    const nowOnServer = Date.now() + clockOffset.current;
    return state.position + (nowOnServer - state.serverTime) / 1000;
  }, [state]);

  return {
    connected,
    me,
    state,
    feed,
    typingUsers: Object.values(typingUsers),
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
  };
}

function syncClock(socket: Socket, offsetRef: { current: number }) {
  const sentAt = Date.now();
  socket.emit('time:ping', sentAt, (res: { serverTime: number }) => {
    const rtt = Date.now() - sentAt;
    offsetRef.current = res.serverTime + rtt / 2 - Date.now();
  });
}
