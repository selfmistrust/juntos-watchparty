export type MediaKind = 'youtube' | 'file';

export interface PlaylistItem {
  id: string;
  kind: MediaKind;
  src: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  addedBy: string;
  /** id de quem adicionou, usado para o badge de "DJ" na faixa que está tocando. */
  addedById: string;
}

export interface User {
  /** Identidade persistente do usuário (sobrevive a reconexões). */
  userId: string;
  /** ID da sessão/conexão atual (socket.id). Muda a cada reconexão. */
  sessionId: string;
  name: string;
  color: string;
  /** Semente do DiceBear; usada quando não há foto customizada. */
  avatarSeed: string;
  /** Foto enviada pelo usuário (data URL), se houver. Tem prioridade sobre avatarSeed. */
  avatarUrl?: string;
  /** Timestamp da última atividade/heartbeat. */
  lastSeen: number;
  /** Se a conexão atual está ativa. */
  connected: boolean;
}

export type ChatMessageKind = 'text' | 'gif' | 'image';

/** Mesma lista fechada do servidor, mantém cliente e servidor em sincronia visual. */
export const ALLOWED_REACTIONS = ['❤️', '😂', '😱', '🔥', '👏'] as const;
export type ReactionEmoji = (typeof ALLOWED_REACTIONS)[number];

/** Emojis aceitos para reações em mensagens do chat. */
export const CHAT_REACTION_EMOJIS = [
  '❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '🎉', '🤔', '👏',
  '😍', '🥰', '🤩', '😊', '😭', '😡', '😠', '🤬', '😱', '😨',
  '😰', '😥', '😐', '😶', '🙄', '😏', '😴', '🤷', '🤷‍♂️', '🤷‍♀️',
  '🤦', '👋', '🤝', '✋', '🤚', '🖐', '✌️', '🤞'
] as const;
export type ChatReactionEmoji = (typeof CHAT_REACTION_EMOJIS)[number];

export const ALLOWED_SOUNDS = ['clap', 'laugh', 'wow', 'drum'] as const;
export type SoundId = (typeof ALLOWED_SOUNDS)[number];

/** Reação recebida do servidor, já com a posição sorteada no cliente para a animação. */
export interface FloatingReaction {
  id: string;
  emoji: string;
  name: string;
  /** posição horizontal, 0–100 (%) */
  left: number;
  /** duração da subida, em segundos */
  duration: number;
}

export interface GifResult {
  id: string;
  title: string;
  preview: string;
  url: string;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  hostId: string | null;
  hostUserId: string | null;
  openControl: boolean;
  hasPassword: boolean;
  users: User[];
  playlist: PlaylistItem[];
  currentIndex: number;
  isPlaying: boolean;
  position: number;
  serverTime: number;
  /** Últimas mensagens do chat (últimas 100). */
  messages: ChatMessage[];
}

export type JoinErrorReason = 'wrong_password' | 'password_required';

export interface JoinError {
  reason: JoinErrorReason;
  message: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  name: string;
  color: string;
  kind: ChatMessageKind;
  text: string;
  mediaUrl?: string;
  at: number;
  /** ID da mensagem original, se for uma resposta. */
  parentMessageId?: string;
  /** Resumo da mensagem original para preview na resposta. */
  parentMessagePreview?: {
    id: string;
    name: string;
    text: string;
  };
  /** Reações na mensagem: emoji -> { count, users: string[] }. */
  reactions?: Record<string, { count: number; users: string[] }>;
}

export type SystemEventKind = 'join' | 'leave' | 'play' | 'pause' | 'seek' | 'track' | 'host';

export interface SystemEvent {
  id: string;
  kind: SystemEventKind;
  text: string;
  at: number;
}

export type FeedEntry =
  | ({ type: 'message' } & ChatMessage)
  | ({ type: 'system' } & SystemEvent);

export interface YoutubeResult {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
}

/** API imperativa que todo player (YouTube ou .mp4) precisa expor. */
export interface PlayerHandle {
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  setVolume: (value: number) => void;
  setMuted: (muted: boolean) => void;
  setPlaybackRate: (rate: number) => void;
}
