import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from '@/lib/socket';
import { playSound } from '@/lib/sfx';
import type {
  ChatMessage,
  FeedEntry,
  FloatingReaction,
  GifResult,
  JoinError,
  PlaylistItem,
  ReactionEmoji,
  RoomSnapshot,
  SoundId,
  SystemEvent,
  User,
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
  sendMessage: (text: string) => void;
  sendGif: (gif: GifResult) => void;
  sendImage: (dataUrl: string) => void;
  setTyping: (isTyping: boolean) => void;
  sendReaction: (emoji: ReactionEmoji) => void;
  sendSound: (soundId: SoundId) => void;
  setColor: (color: string) => void;
  setAvatar: (avatar: { seed?: string; url?: string }) => void;
  /**
   * Pede autorização (via socket, canal confiável) para enviar um vídeo por
   * HTTP. Resolve com um token de uso único ou um motivo de recusa — ver
   * `upload:requestToken` em server/src/socket.ts.
   */
  requestUploadToken: (payload: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  }) => Promise<UploadTokenResult>;
}

export type UploadTokenResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

export function useRoom({ roomId, name, enabled, avatarSeed, avatarUrl }: UseRoomOptions) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<User | null>(null);
  const [state, setState] = useState<RoomSnapshot | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<JoinError | null>(null);
  /** Reações flutuantes ativas — cada uma se remove sozinha depois da animação. */
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  /** Última senha tentada; usada tanto no join inicial quanto em reconexões. */
  const passwordRef = useRef('');
  /** serverTime - clientTime, já descontada metade do round-trip. */
  const clockOffset = useRef(0);

  useEffect(() => {
    if (!enabled || !roomId) return;
    const socket = getSocket();
    socketRef.current = socket;

    const pushFeed = (entry: FeedEntry) =>
      setFeed((prev) => [...prev, entry].slice(-MAX_FEED));

    const join = () => {
      setConnected(true);
      socket.emit('room:join', {
        roomId,
        name,
        password: passwordRef.current || undefined,
        avatarSeed,
        avatarUrl,
      });
      syncClock(socket, clockOffset);
    };

    const onWelcome = ({ you, state: snap }: { you: User; state: RoomSnapshot }) => {
      setJoinError(null);
      setMe(you);
      setState(snap);
    };

    const onJoinError = (error: JoinError) => setJoinError(error);
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

    const onDenied = (message: string) => setNotice(message);
    const onDisconnect = () => setConnected(false);

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

    const onSoundPlay = ({ soundId }: { soundId: SoundId }) => playSound(soundId);

    if (socket.connected) join();
    socket.on('connect', join);
    socket.on('disconnect', onDisconnect);
    socket.on('room:welcome', onWelcome);
    socket.on('room:join:error', onJoinError);
    socket.on('room:state', onState);
    socket.on('room:event', onEvent);
    socket.on('room:denied', onDenied);
    socket.on('chat:message', onMessage);
    socket.on('chat:typing', onTyping);
    socket.on('reaction:new', onReaction);
    socket.on('sound:play', onSoundPlay);

    const clockTimer = setInterval(() => syncClock(socket, clockOffset), 15_000);

    return () => {
      clearInterval(clockTimer);
      socket.off('connect', join);
      socket.off('disconnect', onDisconnect);
      socket.off('room:welcome', onWelcome);
      socket.off('room:join:error', onJoinError);
      socket.off('room:state', onState);
      socket.off('room:event', onEvent);
      socket.off('room:denied', onDenied);
      socket.off('chat:message', onMessage);
      socket.off('chat:typing', onTyping);
      socket.off('reaction:new', onReaction);
      socket.off('sound:play', onSoundPlay);
    };
    // avatarSeed/avatarUrl só importam no join inicial; trocas depois passam por actions.setAvatar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, roomId, name]);

  /** Mantém `me` em dia quando o próprio usuário muda cor/avatar (o broadcast chega em `state`). */
  useEffect(() => {
    if (!me || !state) return;
    const updated = state.users.find((u) => u.id === me.id);
    if (
      updated &&
      (updated.color !== me.color || updated.avatarSeed !== me.avatarSeed || updated.avatarUrl !== me.avatarUrl)
    ) {
      setMe(updated);
    }
  }, [state, me]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  /** Tenta entrar de novo com uma senha, reaproveitando a conexão já aberta. */
  const retryPassword = useCallback(
    (password: string) => {
      passwordRef.current = password;
      socketRef.current?.emit('room:join', { roomId, name, password: password || undefined });
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
      sendMessage: (text) => emit('chat:message', { kind: 'text', text }),
      sendGif: (gif) => emit('chat:message', { kind: 'gif', mediaUrl: gif.url, text: gif.title }),
      sendImage: (dataUrl) => emit('chat:message', { kind: 'image', mediaUrl: dataUrl }),
      setTyping: (isTyping) => emit('chat:typing', isTyping),
      sendReaction: (emoji) => emit('reaction:send', emoji),
      sendSound: (soundId) => {
        playSound(soundId); // toca na hora pra quem clicou; o eco pros outros vem do servidor
        emit('sound:trigger', soundId);
      },
      setColor: (color) => emit('user:setColor', color),
      setAvatar: (avatar) => emit('user:setAvatar', avatar),
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

  const isHost = Boolean(me && state && state.hostId === me.id);
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
    retryPassword,
    isHost,
    canControl,
    currentItem,
    targetPosition,
    reactions,
    actions,
  };
}

function syncClock(socket: Socket, offsetRef: { current: number }) {
  const sentAt = Date.now();
  socket.emit('time:ping', sentAt, (res: { serverTime: number }) => {
    const rtt = Date.now() - sentAt;
    offsetRef.current = res.serverTime + rtt / 2 - Date.now();
  });
}
