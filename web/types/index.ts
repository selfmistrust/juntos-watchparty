/**
 * `stream` é uma transmissão ao vivo, não um arquivo.
 *
 * A diferença molda o player inteiro: um arquivo tem `src` e posição
 * seekável, e a sincronização da sala é construída sobre isso. Uma tela
 * compartilhada não tem posição — o mesmo instante chega pelo relógio da
 * mídia. Por isso o item referencia a transmissão e o `src` fica vazio.
 *
 * `drive` também tem `src` vazio, por outro motivo: o arquivo vem do Google, de
 * cada conta para o seu próprio player. Ele tem posição seekável como qualquer
 * arquivo, então a sincronização trata igual.
 */
export type MediaKind = 'youtube' | 'file' | 'stream' | 'drive' | 'spotify';

export interface PlaylistItem {
  id: string;
  kind: MediaKind;
  /**
   * videoId do YouTube, URL direta de um .mp4, ou vazio em `stream`, `drive` e
   * `spotify`.
   */
  src: string;
  /**
   * Arquivo do Google Drive, quando `kind === 'drive'`.
   *
   * O vídeo **não** vem do nosso servidor nem do bucket: cada pessoa pede direto
   * ao Google com o token da própria conta, e a URL que o `<video>` usa é
   * montada no cliente, via service worker. Por isso o `src` fica vazio.
   */
  driveFileId?: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  addedBy: string;
  /** id de quem adicionou, usado para o badge de "DJ" na faixa que está tocando. */
  addedById: string;
  /** Transmissão referenciada, quando `kind === 'stream'`. */
  streamId?: string;
  /**
   * URI da faixa no Spotify, quando `kind === 'spotify'`.
   *
   * O `src` fica vazio e não é um buraco: **o Spotify não tem URL de áudio**.
   * Quem entrega o som é o Web Playback SDK, direto do Spotify para o navegador
   * de cada pessoa. Não passa por este servidor, nem por bucket, nem por socket
   * — e não há como montar um `src` sem que a URL seja uma mentira.
   *
   * Cada pessoa toca com o token da **própria** conta, e só quem tem Spotify
   * Premium ouve alguma coisa. Quem não tem Premium vê a faixa tocando e não
   * ouve: isso é a regra do plano, não um estado quebrado, e a interface tem de
   * dizer isso em vez de fingir que está tudo bem.
   */
  spotifyUri?: string;
  /** Duração em milissegundos, para a barra de progresso antes do áudio chegar. */
  spotifyDurationMs?: number;
}

/**
 * Uma transmissão ao vivo, como o servidor a publica.
 *
 * Sem `ownerSessionId`: é o id do socket de uma instância específica, e o
 * cliente não tem o que fazer com o de outra. A identidade estável do dono é o
 * `ownerUserId`, que sobrevive a reconexão.
 */
export interface LiveStream {
  id: string;
  ownerUserId: string;
  ownerName: string;
  title: string;
  startedAt: number;
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
  /** Instante em que a sala é encerrada de todo modo (teto de vida absoluta). */
  expiresAt?: number;
  /** Últimas mensagens do chat (últimas 100). */
  messages: ChatMessage[];
  /** Transmissões ao vivo ativas na sala. */
  streams: LiveStream[];
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
  /**
   * Quem foi citado por `@nome`, em `sessionId`. O servidor é quem decide esta
   * lista; o cliente só desenha o destaque em volta do que está aqui.
   */
  mentions?: string[];
}

/** Notificação de menção, entregue só para a pessoa citada. */
export interface ChatMentionEvent {
  messageId: string;
  fromName: string;
  fromColor: string;
  fromSessionId: string;
  /** O nome como foi digitado, para o texto do aviso fazer sentido. */
  texto: string;
  /** Recorte da mensagem, para o aviso não ser uma notificação vazia. */
  preview: string;
  at: number;
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
