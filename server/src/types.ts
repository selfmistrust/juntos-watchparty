/**
 * `stream` é uma transmissão ao vivo, não um arquivo.
 *
 * A diferença não é cosmética: um arquivo tem `src` e posição seekável, e a
 * sincronização da sala (projetar posição, corrigir deriva) é construída em
 * cima disso. Uma tela compartilhada não tem posição nenhuma — o mesmo
 * instante chega pelo relógio da mídia, não por `position`. Por isso o item
 * carrega `streamId` e o `src` fica vazio, e o player não tenta sincronizar.
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
  /**
   * URL oficial do título no Prime Video, quando `kind === 'prime'`.
   *
   * É a **única** informação do conteúdo que viaja entre as pessoas. O servidor
   * revalida e reescreve este campo antes de gravar — ver `prime.ts`.
   *
   * Não vai aqui: cookie, token, manifesto de vídeo, URL de HLS/MPD, chave de DRM.
   * O Prime Video entrega o conteúdo de cada pessoa direto para o aparelho dela, e
   * o Juntos não participa dessa entrega.
   */
  primeUrl?: string;
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


/**
 * Quem já está pronto para a faixa atual, e a contagem regressiva.
 *
 * ## Por que existe
 *
 * O Prime Video entrega o conteúdo de cada pessoa direto para o aparelho dela,
 * com DRM que o Juntos não lê e não controla. Não há posição de reprodução
 * compartilhável, então o "sincronizar" aqui não é o laço de deriva do player:
 * é a coordenação de uma sala de cinema. Cada um abre o título na conta
 * própria, aperta "Estou pronto", e a contagem começa quando todo mundo
 * confirmou — ou quando quem conduz a sala decide começar.
 *
 * `userIds` e não `sessionId`: o snapshot mostra "Ana está pronta" para todo
 * mundo, e o `sessionId` é o socket de uma instância específica, que não
 * sobrevive a uma reconexão. Quem caiu e voltou apareceria como outra pessoa no
 * contador.
 */
export interface Readiness {
  /** Faixa a que isto se refere. Trocar de faixa zera o contador inteiro. */
  itemId: string;
  /** `userId` de quem já confirmou estar pronto. */
  userIds: string[];
  /** Instante em que a contagem regressiva começou (epoch ms), ou `null`. */
  countdownAt: number | null;
}

/** Quanto tempo a contagem regressiva dura. Curto o bastante para não irritar. */
export const CONTAGEM_REGRESSIVA_MS = 5000;

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
  /**
   * Contagem de prontos e contagem regressiva da faixa atual.
   *
   * Ausente em salas gravadas antes do recurso, como `streams` — a leitura usa
   * `room.readiness ?? null`, e não quebrar dado antigo é mais importante do
   * que a forma limpa do objeto.
   */
  readiness?: Readiness | null;
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
  /** Contagem de prontos da faixa atual. Ver `Room.readiness`. */
  readiness: Readiness | null;
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
  /**
   * Quem foi citado por `@nome` nesta mensagem, em `sessionId`.
   *
   * Vai na mensagem porque o destaque é público: todo mundo vê o `@nome`
   * marcado. A **notificação** é separada e sai só para os ids desta lista
   * (ver `chat:mention`), porque som e notificação para a sala inteira
   * transformam o chat em lugar insuportável.
   *
   * A lista nunca inclui quem escreveu: citar a si mesmo é ruído, e a pessoa já
   * está lendo a própria mensagem.
   */
  mentions?: string[];
}

/** Notificação de menção, entregue só para a pessoa citada. */
export interface ChatMentionEvent {
  messageId: string;
  fromName: string;
  fromColor: string;
  /** `sessionId` de quem mencionou, para o cliente saber se é a si mesmo. */
  fromSessionId: string;
  /** O nome como foi digitado, para o texto do aviso fazer sentido. */
  texto: string;
  /** Recorte da mensagem, para o aviso não ser uma notificação vazia. */
  preview: string;
  at: number;
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
