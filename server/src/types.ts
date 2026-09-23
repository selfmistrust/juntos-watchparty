export type MediaKind = 'youtube' | 'file';

export interface PlaylistItem {
  id: string;
  kind: MediaKind;
  /** videoId do YouTube ou URL direta de um .mp4 */
  src: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  addedBy: string;
  /** id de quem adicionou, usado para o badge de "DJ" na faixa que está tocando. */
  addedById: string;
}

export interface User {
  id: string;
  name: string;
  color: string;
  /** Semente do DiceBear; usada quando não há foto customizada. */
  avatarSeed: string;
  /** Foto enviada pelo usuário (data URL), se houver. Tem prioridade sobre avatarSeed. */
  avatarUrl?: string;
}

export type ChatMessageKind = 'text' | 'gif' | 'image';

/** Emojis aceitos nas reações flutuantes. */
export const ALLOWED_REACTIONS = ['❤️', '😂', '😱', '🔥', '👏'] as const;
export type ReactionEmoji = (typeof ALLOWED_REACTIONS)[number];

/** Efeitos sonoros disponíveis, sintetizados no cliente. */
export const ALLOWED_SOUNDS = ['clap', 'laugh', 'wow', 'drum'] as const;
export type SoundId = (typeof ALLOWED_SOUNDS)[number];

export interface ReactionEvent {
  id: string;
  emoji: ReactionEmoji;
  userId: string;
  name: string;
}

export interface SoundEvent {
  id: string;
  soundId: SoundId;
  userId: string;
  name: string;
}

/** Estado autoritativo mantido pelo servidor. */
export interface Room {
  id: string;
  name: string;
  hostId: string | null;
  /** Quando true, qualquer participante pode controlar o player. */
  openControl: boolean;
  /**
   * Objeto simples em vez de Map: o estado da sala vive no Redis como JSON,
   * e Map não serializa. A chave é o socket.id de cada participante.
   */
  users: Record<string, User>;
  /** Hash bcrypt da senha da sala. Ausente = sala pública, sem senha. */
  passwordHash?: string;
  playlist: PlaylistItem[];
  currentIndex: number;
  isPlaying: boolean;
  /** Posição em segundos no instante `updatedAt`. */
  position: number;
  updatedAt: number;
  createdAt: number;
}

/** Recorte serializável enviado aos clientes. */
export interface RoomSnapshot {
  id: string;
  name: string;
  hostId: string | null;
  openControl: boolean;
  hasPassword: boolean;
  users: User[];
  playlist: PlaylistItem[];
  currentIndex: number;
  isPlaying: boolean;
  /** Posição já projetada para o instante `serverTime`. */
  position: number;
  serverTime: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  name: string;
  color: string;
  /** 'text' é a mensagem normal; 'gif'/'image' carregam mediaUrl e texto é legenda opcional. */
  kind: ChatMessageKind;
  text: string;
  mediaUrl?: string;
  at: number;
}

export type SystemEventKind =
  | 'join'
  | 'leave'
  | 'play'
  | 'pause'
  | 'seek'
  | 'track'
  | 'host';

export interface SystemEvent {
  id: string;
  kind: SystemEventKind;
  text: string;
  at: number;
}

export type JoinErrorReason = 'wrong_password' | 'password_required';

export interface JoinError {
  reason: JoinErrorReason;
  message: string;
}
