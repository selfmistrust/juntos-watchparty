import bcrypt from 'bcryptjs';
import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';
import type { LiveStream, Room, RoomSnapshot, User } from './types.js';

/** IDs de sala curtos e fáceis de ditar por voz. */
export const newRoomId = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 12);
export const newId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
export const newUserId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);

const NAME_COLORS = [
  '#A78BFA',
  '#7DD3FC',
  '#5EEAD4',
  '#FCA5A5',
  '#FCD34D',
  '#F9A8D4',
  '#86EFAC',
  '#C4B5FD',
];

const key = (id: string) => `room:${id}`;

/**
 * Expiração das salas — três janelas independentes, porque "velha" e
 * "abandonada" são coisas diferentes.
 *
 * O TTL do Redis é renovado a cada `saveRoom`, e o heartbeat de presença chama
 * `saveRoom`. Uma sala com uma aba aberta portanto **nunca** expirava pelo TTL:
 * cada heartbeat renovava as 6h. Só a janela curta de 10 min abaixo limpava
 * salas vazias, e uma sala com gente entrando e saindo ao longo de dias ficava
 * para sempre.
 *
 * - `ACTIVE_TTL` / `EMPTY_TTL`: inatividade. Sala com gente renova a cada ação;
 *   sala vazia morre em 10 min. Cobre o abandono, que é o caso comum.
 * - `MAX_LIFETIME`: teto absoluto, contado do `createdAt`, que nenhuma ação
 *   renova. Cobre a sala que vive para sempre por causa de um heartbeat.
 *
 * O teto não é só checagem periódica: `saveRoom` recorta o TTL no que falta
 * para o fim, então o próprio Redis garante o limite mesmo se o processo de
 * limpeza não rodar. A varredura existe para o encerramento ser educado —
 * avisar quem está dentro e fechar o socket, em vez de a chave sumir no
 * meio de uma sessão.
 */
const ACTIVE_TTL_SECONDS = numFromEnv('ROOM_ACTIVE_TTL_SECONDS', 6 * 60 * 60);
const EMPTY_TTL_SECONDS = numFromEnv('ROOM_EMPTY_TTL_SECONDS', 10 * 60);
const MAX_LIFETIME_MS = numFromEnv('ROOM_MAX_LIFETIME_MS', 24 * 60 * 60 * 1000);

/**
 * Histórico guardado por sala. O `snapshot` já corta em 100 no que vai para o
 * cliente, mas o array no Redis crescia sem teto: o corte era só na projeção,
 * não no armazenamento. Numa sala que vive semanas, eram milhares de mensagens
 * — cada uma com `reactions` e `mediaUrl` — mantidas no Redis.
 */
const MAX_STORED_MESSAGES = numFromEnv('ROOM_MAX_MESSAGES', 300);

/**
 * Folga entre a sala deixar de ser válida e a chave do Redis expirar.
 *
 * Sem ela o TTL encerra a chave exatamente no vencimento, e a varredura — que
 * roda a cada `CLEANUP_INTERVAL_MS` — só encontra a sala depois que a chave já
 * foi embora. O resultado era a pior das combinações: a chave sumia (o limite
 * funcionava) e ninguém era avisado (ninguém recebia `room:expired` nem
 * desconectava), que é a queda de socket sem explicação que a tela
 * `RoomExpired` existe para evitar.
 *
 * A folga precisa ser bem maior que o intervalo da varredura, para que sempre
 * haja janelas em que a chave existe e a sala já venceu. Cinco minutos contra
 * varredura de dez segundos dá folga de sobra, e o excesso de vida da chave é
 * de minutos, não de horas.
 */
const EXPIRY_GRACE_SECONDS = numFromEnv('ROOM_EXPIRY_GRACE_SECONDS', 5 * 60);

/** Intervalo da limpeza de sessões abandonadas. */
export const CLEANUP_INTERVAL_MS = 10_000;

/** Tempo (ms) sem heartbeat para considerar sessão offline. */
export const PRESENCE_TIMEOUT_MS = 30_000;

function numFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Instante em que a sala some, independente de atividade. Cai para
 * `updatedAt` se `createdAt` não vier preenchido (dado antigo/corrompido): sem
 * isso a sala ficaria sem teto nenhum, já que o cálculo depende do relógio.
 */
export function expiresAt(room: Room): number {
  const base = Number.isFinite(room.createdAt)
    ? room.createdAt
    : Number.isFinite(room.updatedAt)
      ? room.updatedAt
      : Date.now();
  return base + MAX_LIFETIME_MS;
}

/** Quanto falta para a sala ser encerrada. Zero ou menos = já passou do teto. */
export function remainingLifetimeMs(room: Room, now = Date.now()): number {
  return Math.max(0, expiresAt(room) - now);
}

export function isPastMaxLifetime(room: Room, now = Date.now()): boolean {
  return remainingLifetimeMs(room, now) <= 0;
}

/** Limites em vigor, para o endpoint de saúde deixar a configuração visível. */
export const roomLimits = {
  activeTtlSeconds: ACTIVE_TTL_SECONDS,
  emptyTtlSeconds: EMPTY_TTL_SECONDS,
  maxLifetimeMs: MAX_LIFETIME_MS,
  expiryGraceSeconds: EXPIRY_GRACE_SECONDS,
  maxStoredMessages: MAX_STORED_MESSAGES,
} as const;

function emptyRoom(id: string, name?: string): Room {
  return {
    id,
    name: name?.trim() || 'Sessão sem título',
    hostId: null,
    hostUserId: null,
    openControl: false,
    users: {},
    playlist: [],
    currentIndex: -1,
    isPlaying: false,
    position: 0,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    messages: [],
  };
}

/**
 * Corta o histórico no teto. Roda dentro de `saveRoom` — e não só no caminho do
 * chat — para que qualquer escrita traga a sala de volta dentro do limite,
 * inclusive uma sala que já veio grande de uma versão anterior.
 */
function trimMessages(room: Room): void {
  if (Array.isArray(room.messages) && room.messages.length > MAX_STORED_MESSAGES) {
    room.messages = room.messages.slice(-MAX_STORED_MESSAGES);
  }
}

async function saveRoom(room: Room): Promise<void> {
  trimMessages(room);

  const inativa = Object.keys(room.users).length > 0 ? ACTIVE_TTL_SECONDS : EMPTY_TTL_SECONDS;
  // O TTL é o menor entre a inatividade e o que falta para o teto absoluto,
  // mais a folga da varredura. É aqui que a sala deixa de depender do processo
  // de limpeza para sumir: mesmo que ele nunca rode, o Redis expira a chave no
  // prazo. A folga é o que dá à varredura a chance de rodar dentro da janela
  // em que a sala já venceu mas a chave ainda existe — ver `EXPIRY_GRACE_SECONDS`.
  const restante = Math.ceil(remainingLifetimeMs(room) / 1000) + EXPIRY_GRACE_SECONDS;
  const ttl = Math.max(1, Math.min(inativa, restante));

  await redis.set(key(room.id), JSON.stringify(room), 'EX', ttl);
}

/** Apaga a sala. Idempotente: pode ser chamado por mais de uma instância. */
export async function deleteRoom(id: string): Promise<void> {
  await redis.del(key(id));
}

export async function createRoom(name?: string, password?: string): Promise<Room> {
  const id = newRoomId();
  const room = emptyRoom(id, name);
  if (password?.trim()) {
    room.passwordHash = await bcrypt.hash(password.trim(), 10);
  }
  await saveRoom(room);
  return room;
}

export async function getRoom(id: string): Promise<Room | undefined> {
  const raw = await redis.get(key(id));
  return raw ? (JSON.parse(raw) as Room) : undefined;
}

/** Cria a sala sob demanda para que um link compartilhado nunca quebre. */
export async function ensureRoom(id: string, name?: string): Promise<Room> {
  const existing = await getRoom(id);
  if (existing) return existing;
  const room = emptyRoom(id, name);
  await saveRoom(room);
  return room;
}

export async function checkPassword(room: Room, password?: string): Promise<boolean> {
  if (!room.passwordHash) return true;
  if (!password) return false;
  return bcrypt.compare(password, room.passwordHash);
}

/**
 * Persiste a sala depois de qualquer mutação. Toda rota do socket.ts segue o
 * padrão: carregar -> mutar com as funções puras abaixo -> chamar isto.
 */
export const persistRoom = saveRoom;

// --- Funções puras: recebem a sala já carregada e só mexem no objeto em
// memória. Não falam com o Redis, por isso continuam fáceis de testar. ---

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function pickColor(room: Room, providedColor?: string): string {
  if (providedColor && HEX_COLOR.test(providedColor)) return providedColor;
  return NAME_COLORS[Object.keys(room.users).length % NAME_COLORS.length];
}

/**
 * Cor de quem está reconectando. O `|| existingUser.color` de antes nunca
 * valia nada, porque `pickColor` sempre devolve alguma coisa: bastava um F5
 * sem `color` no payload para a pessoa receber uma cor sorteada por turno de
 * fala, em vez da que já era dela. Sem cor válida, a que ela já tinha vale.
 */
function reconnectColor(room: Room, existingColor: string, providedColor?: string): string {
  if (providedColor && HEX_COLOR.test(providedColor)) return providedColor;
  return existingColor || pickColor(room);
}

/**
 * Adiciona ou reconecta um usuário na sala.
 * Se o userId já existe na sala, reutiliza aquele usuário (reconexão).
 * Caso contrário, cria novo usuário.
 */
export function addUser(
  room: Room,
  sessionId: string,
  userId: string,
  name: string,
  avatar?: { seed?: string; url?: string },
  color?: string,
): User {
  const now = Date.now();

  // Procura usuário existente com mesmo userId (reconexão)
  const existingEntry = Object.entries(room.users).find(([, u]) => u.userId === userId);
  if (existingEntry) {
    const [existingSessionId, existingUser] = existingEntry;
    // Se era uma sessão diferente, remove a entrada antiga
    if (existingSessionId !== sessionId) {
      delete room.users[existingSessionId];
    }
    // Atualiza sessão existente
    const updated: User = {
      ...existingUser,
      sessionId,
      name: name.slice(0, 24) || existingUser.name,
      color: reconnectColor(room, existingUser.color, color),
      avatarSeed: avatar?.seed?.slice(0, 40) || existingUser.avatarSeed,
      avatarUrl: avatar?.url ?? existingUser.avatarUrl,
      lastSeen: now,
      connected: true,
    };
    room.users[sessionId] = updated;
    // Atualiza host se necessário
    if (!room.hostUserId) room.hostUserId = userId;
    // Se este usuário é o host (userId bate com hostUserId), atualiza hostId para o novo sessionId
    if (room.hostUserId === userId) {
      room.hostId = sessionId;
    } else if (!room.hostId) {
      room.hostId = sessionId;
    }
    return updated;
  }

  // Novo usuário
  const user: User = {
    userId,
    sessionId,
    name: name.slice(0, 24) || 'Convidado',
    color: pickColor(room, color),
    avatarSeed: avatar?.seed?.slice(0, 40) || userId,
    avatarUrl: avatar?.url,
    lastSeen: now,
    connected: true,
  };
  room.users[sessionId] = user;
  if (!room.hostUserId) room.hostUserId = userId;
  if (!room.hostId) room.hostId = sessionId;
  return user;
}

/** Atualiza último heartbeat do usuário. */
export function updateUserHeartbeat(room: Room, sessionId: string): boolean {
  const user = room.users[sessionId];
  if (!user) return false;
  user.lastSeen = Date.now();
  user.connected = true;
  return true;
}

/** Marca usuário como desconectado (mas mantém na sala para possível reconexão). */
export function markUserDisconnected(room: Room, sessionId: string): User | undefined {
  const user = room.users[sessionId];
  if (!user) return undefined;
  user.connected = false;
  return user;
}

/** Remove usuário completamente da sala. */
export function removeUser(room: Room, sessionId: string): User | undefined {
  const user = room.users[sessionId];
  delete room.users[sessionId];
  if (room.hostId === sessionId) {
    // O host sai: procura outro usuário conectado do mesmo hostUserId ou o mais antigo
    const remaining = Object.entries(room.users).filter(([, u]) => u.connected);
    if (remaining.length > 0) {
      room.hostId = remaining[0][0];
      room.hostUserId = remaining[0][1].userId;
    } else {
      room.hostId = null;
      room.hostUserId = null;
    }
  }
  return user;
}

/** Remove usuários desconectados há mais de PRESENCE_TIMEOUT_MS. */
export function cleanupStaleUsers(room: Room): User[] {
  const now = Date.now();
  const removed: User[] = [];
  for (const [sessionId, user] of Object.entries(room.users)) {
    if (!user.connected && now - user.lastSeen > PRESENCE_TIMEOUT_MS) {
      delete room.users[sessionId];
      removed.push(user);
      if (room.hostId === sessionId) {
        const remaining = Object.entries(room.users).filter(([, u]) => u.connected);
        if (remaining.length > 0) {
          room.hostId = remaining[0][0];
          room.hostUserId = remaining[0][1].userId;
        } else {
          room.hostId = null;
          room.hostUserId = null;
        }
      }
    }
  }
  return removed;
}

/** Cor de nome escolhida pelo próprio usuário, substituindo a atribuída automaticamente. */
export function setUserColor(room: Room, sessionId: string, color: string): boolean {
  const user = room.users[sessionId];
  if (!user || !HEX_COLOR.test(color)) return false;
  user.color = color;
  return true;
}

/**
 * Troca a semente do DiceBear e/ou a foto customizada. `url: ''` limpa a
 * foto e volta a usar o avatar gerado a partir da semente.
 */
export function setUserAvatar(room: Room, sessionId: string, avatar: { seed?: string; url?: string }): boolean {
  const user = room.users[sessionId];
  if (!user) return false;
  if (avatar.url !== undefined) {
    user.avatarUrl = avatar.url.length > 0 ? avatar.url : undefined;
  }
  if (avatar.seed) user.avatarSeed = avatar.seed.slice(0, 40);
  return true;
}

/** Nome trocado depois de já estar na sala (painel de pessoas). Mesmas regras do nome de entrada. */
export function setUserName(room: Room, sessionId: string, name: string): boolean {
  const user = room.users[sessionId];
  const trimmed = name.trim().slice(0, 24);
  if (!user || !trimmed) return false;
  user.name = trimmed;
  return true;
}

/**
 * Quem controla a **reprodução**: play, pause, seek, remover e reordenar.
 *
 * Isto é deliberadamente mais restrito do que adicionar mídia. Encher a fila é
 * aberto a qualquer participante (veja `podeAdicionarMidia`), porque quem entra
 * numa sala precisa poder contribute com alguma coisa — e a mídia que entra é
 * identificada por `addedBy`, então não há um vídeo sem dono.
 *
 * Quem só adiciona não ganha nenhum poder sobre o que já está tocando. É a
 * diferença entre "colocar um filme na fila" e "mandar na fila".
 */
export function canControl(room: Room, sessionId: string): boolean {
  return room.openControl || room.hostId === sessionId;
}

/**
 * Quem pode **adicionar** mídia à sala.
 *
 * Qualquer participante conectado. A validação real é estar na sala — o que
 * `addUser` garante e o que os handlers checam ao ler a sala —, mais as
 * validações específicas de cada fonte: tamanho e tipo do arquivo no upload,
 * `mimeType` de vídeo e `canDownload` no Drive, e uma transmissão por vez na
 * tela compartilhada.
 *
 * Nenhum destes caminhos concede poder de host. O `canControl` acima é
 * independente e continua de pé.
 */
export function podeAdicionarMidia(room: Room, sessionId: string): boolean {
  return Boolean(room.users[sessionId]);
}

// --- Transmissões ao vivo ---------------------------------------------------

/**
 * `streams` pode não existir em sala gravada antes do recurso, então a leitura
 * sempre passa por aqui.
 */
export function streamsDe(room: Room): Record<string, LiveStream> {
  if (!room.streams) room.streams = {};
  return room.streams;
}

export function getStream(room: Room, streamId: string): LiveStream | undefined {
  return streamsDe(room)[streamId];
}

/**
 * Registra uma transmissão e devolve o id.
 *
 * O dono é identificado pelo `userId`, e não pelo sessionId: a conexão pode
 * cair e voltar com outro socket, e a transmissão continua sendo a mesma. O
 * `ownerSessionId` é atualizado junto para que o relay de sinal encontre o
 * socket certo agora.
 */
export function startStream(
  room: Room,
  owner: User,
  title: string,
): LiveStream {
  const stream: LiveStream = {
    id: newId(),
    ownerSessionId: owner.sessionId,
    ownerUserId: owner.userId,
    ownerName: owner.name,
    title: title.slice(0, 60) || `${owner.name} compartilhando a tela`,
    startedAt: Date.now(),
  };
  streamsDe(room)[stream.id] = stream;
  return stream;
}

/**
 * Encerra a transmissão e tira da fila o item que a representava.
 *
 * Uma transmissão não é "pular faixa": ela está tocando agora, e quem chega
 * depois precisa ver que acabou. Por isso o item é removido e o player volta
 * para o vazio, em vez de ficar em um item morto.
 */
export function stopStream(room: Room, streamId: string): boolean {
  const streams = streamsDe(room);
  if (!streams[streamId]) return false;
  delete streams[streamId];

  const item = room.playlist.find((i) => i.kind === 'stream' && i.streamId === streamId);
  if (!item) return true;

  const eraATocando = room.currentIndex === room.playlist.indexOf(item);
  room.playlist = room.playlist.filter((i) => i.id !== item.id);

  if (eraATocando) {
    // Não tenta escolher a próxima: uma fila que tinha só a transmissão (ou que
    // era a última) fica sem nada tocando, que é o estado correto.
    const seguinte = room.playlist[Math.min(room.currentIndex, room.playlist.length - 1)];
    room.currentIndex = seguinte ? room.playlist.indexOf(seguinte) : -1;
    if (!seguinte) room.isPlaying = false;
  } else {
    // A faixa removida estava antes da que toca: o índice anda junto, senão a
    // sala pula uma faixa.
    room.currentIndex = Math.max(0, room.currentIndex - 1);
  }

  commitPosition(room, 0);
  return true;
}

/**
 * Remove transmissões cujo dono saiu.
 *
 * Chamado no `disconnect`. Sem isto, uma transmissão que morre junto com a
 * janela de quem transmitia ficaria no estado da sala para sempre, com todo
 * mundo esperando um stream que nunca chega.
 */
export function dropStreamsOwnedBy(room: Room, sessionId: string): string[] {
  const removidas: string[] = [];
  for (const stream of Object.values(streamsDe(room))) {
    if (stream.ownerSessionId === sessionId) {
      stopStream(room, stream.id);
      removidas.push(stream.id);
    }
  }
  return removidas;
}

/**
 * Projeta a posição do vídeo para agora. É esta função que faz um usuário
 * atrasado entrar exatamente no mesmo segundo que os demais.
 */
export function projectedPosition(room: Room, now = Date.now()): number {
  if (!room.isPlaying) return room.position;
  return room.position + (now - room.updatedAt) / 1000;
}

/** Congela a posição atual antes de aplicar uma mudança de estado. */
export function commitPosition(room: Room, position?: number) {
  const now = Date.now();
  room.position = Math.max(0, position ?? projectedPosition(room, now));
  room.updatedAt = now;
}

export function snapshot(room: Room): RoomSnapshot {
  const now = Date.now();
  // Só inclui usuários conectados no snapshot enviado aos clientes
  const connectedUsers = Object.values(room.users).filter(u => u.connected);
  // Envia apenas as últimas 100 mensagens para o cliente
  const recentMessages = (room.messages ?? []).slice(-100);
  // `ownerSessionId` fica de fora: é o socket de uma instância específica, que
  // o cliente não consegue usar (ver o comentário em `RoomSnapshot.streams`).
  const streams = Object.values(streamsDe(room)).map(({ ownerSessionId: _omit, ...pub }) => pub);
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    hostUserId: room.hostUserId,
    openControl: room.openControl,
    hasPassword: Boolean(room.passwordHash),
    users: connectedUsers,
    playlist: room.playlist,
    currentIndex: room.currentIndex,
    isPlaying: room.isPlaying,
    position: projectedPosition(room, now),
    serverTime: now,
    // Vai junto para o cliente poder avisar que a sala encerra, em vez de o
    // socket cair do nada quando a chave sumir.
    expiresAt: expiresAt(room),
    messages: recentMessages,
    streams,
  };
}

/**
 * Só para o endpoint de saúde/monitoramento. KEYS bloqueia o Redis por um
 * instante proporcional ao tamanho do banco. Aceitável para um health
 * check ocasional, mas troque por SCAN se o número de salas crescer muito.
 */
export async function roomCount(): Promise<number> {
  const keys = await redis.keys('room:*');
  return keys.length;
}
