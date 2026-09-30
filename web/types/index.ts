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
/**
 * `prime` segue a mesma lógica por um motivo diferente: o conteúdo protegido do
 * Prime Video não expõe posição para o Juntos ler. O `src` fica vazio, a
 * identidade do título viaja em `primeUrl`, e o que sincroniza as pessoas é o
 * "Estou pronto" com contagem regressiva — ver `Readiness`.
 */
export type MediaKind = 'youtube' | 'file' | 'stream' | 'drive' | 'prime';

export interface PlaylistItem {
  id: string;
  kind: MediaKind;
  /**
   * videoId do YouTube, URL direta de um .mp4, ou vazio em `stream` e `drive`.
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
  /**
   * URL oficial do título no Prime Video, quando `kind === 'prime'`.
   *
   * É a **única** informação do conteúdo que viaja entre as pessoas.
   *
   * Não vai aqui: cookie, token, manifesto de vídeo, URL de HLS/MPD, chave de DRM.
   * O Prime Video entrega o conteúdo de cada pessoa direto para o aparelho dela, e
   * o Juntos não participa dessa entrega.
   */
  primeUrl?: string;
  streamId?: string;
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

/**
 * Quem já está pronto para a faixa atual, e a contagem regressiva.
 *
 * ## Por que o servidor decide o instante
 *
 * O relógio de cada máquina pode estar errado, e o início precisa sobreviver a
 * uma reconexão sem recomeçar. O servidor manda o `countdownAt` e todo mundo
 * calcula o número a partir do mesmo instante.
 *
 * ## `userIds` e não `sessionId`
 *
 * A tela mostra "Ana está pronta" para todo mundo. O `sessionId` é o socket de
 * uma instância específica, que muda a cada reconexão: quem caiu e voltou
 * apareceria como outra pessoa no contador.
 */
export interface Readiness {
  /** Faixa a que isto se refere. Trocar de faixa zera o contador inteiro. */
  itemId: string;
  /** `userId` de quem já confirmou estar pronto. */
  userIds: string[];
  /** Instante em que a contagem regressiva começou (epoch ms), ou `null`. */
  countdownAt: number | null;
}

/**
 * Quanto tempo a contagem regressiva dura.
 *
 * Cópia do valor de `server/src/types.ts`. As duas cópias existem porque o
 * renderer não importa nada de `server/` — a duplicação é deliberada, e
 * `web/tests/primeIntegracao.test.ts` trava que as duas continuam iguais. Se
 * divergirem, a contagem de um cliente termina antes da de outro e a sala
 * inteira dá play em instantes diferentes, que é o oposto do que a contagem
 * existe para evitar.
 */
export const CONTAGEM_REGRESSIVA_MS = 5000;
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
  /** Contagem de prontos da faixa atual. Ver `Readiness`. */
  readiness: Readiness | null;
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
