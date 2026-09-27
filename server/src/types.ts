/**
 * `stream` é uma transmissão ao vivo, não um arquivo.
 *
 * A diferença não é cosmética: um arquivo tem `src` e posição seekável, e a
 * sincronização da sala (projetar posição, corrigir deriva) é construída em
 * cima disso. Uma tela compartilhada não tem posição nenhuma — o mesmo
 * instante chega pelo relógio da mídia, não por `position`. Por isso o item
 * carrega `streamId` e o `src` fica vazio, e o player não tenta sincronizar.
 */
export type MediaKind = 'youtube' | 'file' | 'stream' | 'drive';

export interface PlaylistItem {
  id: string;
  kind: MediaKind;
  /**
   * videoId do YouTube, URL direta de um .mp4, ou vazio em `stream`.
   *
   * Também pode ser a rota `/api/drive/stream/<token>`, para um arquivo escolhido
   * no Drive de quem adicionou. Nesse caso o `kind` continua sendo `file`: o
   * player trata igual, com `Range` e posição seekável. A diferença é de onde
   * os bytes vêm, não de como se reproduz.
   */
  src: string;
  /**
   * Arquivo do Google Drive, quando `kind === 'drive'`.
   *
   * Só o identificador viaja no snapshot. Quem concedeu o acesso fica guardado
   * no servidor, indexado por este id: o estado da sala é transmitido para
   * todo mundo, e a sessão de quem escolheu não tem motivo nenhum de estar
   * ali. O `src` fica vazio — a URL real é montada no cliente, porque cada
   * pessoa busca no Google com o token da própria conta.
   */
  driveFileId?: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  addedBy: string;
  /** id de quem adicionou, usado para o badge de "DJ" na faixa que está tocando. */
  addedById: string;
  /** Transmissão ao vivo referenciada, quando `kind === 'stream'`. */
  streamId?: string;
}

/**
 * Uma transmissão ao vivo em andamento.
 *
 * Fica na sala (e não em memória do processo) por dois motivos: o estado da
 * sala vive no Redis e o adapter do Socket.IO pode ter várias instâncias
 * atendendo sockets diferentes da mesma sala. Uma transmissão que só existisse
 * na memória de um processo quebraria assim que as pessoas caíssem em
 * instâncias diferentes.
 */
export interface LiveStream {
  id: string;
  /** sessionId de quem transmite. Muda a cada reconexão do dono. */
  ownerSessionId: string;
  /** userId do dono, estável entre reconexões. */
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

/** Emojis aceitos nas reações flutuantes. */
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

export interface ReactionEvent {
  id: string;
  emoji: ReactionEmoji;
  userId: string;
  name: string;
}


/** Estado autoritativo mantido pelo servidor. */
export interface Room {
  id: string;
  name: string;
  /** sessionId do host (para compatibilidade com socket.id). */
  hostId: string | null;
  /** userId do host (persistente across reconexões). */
  hostUserId: string | null;
  /** Quando true, qualquer participante pode controlar o player. */
  openControl: boolean;
  /**
   * Objeto simples em vez de Map: o estado da sala vive no Redis como JSON,
   * e Map não serializa. A chave é o sessionId (socket.id) de cada participante.
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
  /** Histórico de mensagens do chat (últimas 500). */
  messages: ChatMessage[];
  /**
   * Transmissões ao vivo ativas, por id. Ausente em salas antigas — a leitura
   * usa `room.streams ?? {}` para não quebrar dado gravado antes do recurso.
   */
  streams?: Record<string, LiveStream>;
}

/** Recorte serializável enviado aos clientes. */
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
  /** Posição já projetada para o instante `serverTime`. */
  position: number;
  serverTime: number;
  /** Instante em que a sala é encerrada de todo modo (teto de vida absoluta). */
  expiresAt?: number;
  /** Últimas mensagens do chat (últimas 100). */
  messages: ChatMessage[];
  /**
   * Transmissões ativas, sem o `ownerSessionId`.
   *
   * O sessionId fica de fora de propósito: ele é o id do socket de *uma*
   * instância, e o cliente não tem o que fazer com o de outra. Quem precisa
   * saber quem transmite — para assinar ou para recusar — se identifica pelo
   * `ownerUserId`, que é estável entre reconexões.
   */
  streams: Array<Omit<LiveStream, 'ownerSessionId'>>;
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

export type SystemEventKind =
  | 'join'
  | 'leave'
  | 'play'
  | 'pause'
  | 'seek'
  | 'track'
  | 'host'
  /** Anúncio que não corresponde a um comando do player (usado pela tela compartilhada). */
  | 'info';

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
