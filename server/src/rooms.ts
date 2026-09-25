import bcrypt from 'bcryptjs';
import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';
import type { Room, RoomSnapshot, User } from './types.js';

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
 * TTLs do Redis (renovados a cada `saveRoom`). Uma sala ativa nunca chega
 * perto de 6h porque toda ação a renova; ela só expira de fato se todo mundo
 * sair E ninguém voltar dentro da janela curta abaixo.
 */
const ACTIVE_TTL_SECONDS = 6 * 60 * 60;
const EMPTY_TTL_SECONDS = 10 * 60;

/** Tempo (ms) sem heartbeat para considerar sessão offline. */
export const PRESENCE_TIMEOUT_MS = 30_000;

/** Intervalo da limpeza de sessões abandonadas. */
export const CLEANUP_INTERVAL_MS = 10_000;

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

async function saveRoom(room: Room): Promise<void> {
  const ttl = Object.keys(room.users).length > 0 ? ACTIVE_TTL_SECONDS : EMPTY_TTL_SECONDS;
  await redis.set(key(room.id), JSON.stringify(room), 'EX', ttl);
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
      color: pickColor(room, color) || existingUser.color,
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

export function canControl(room: Room, sessionId: string): boolean {
  return room.openControl || room.hostId === sessionId;
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
    messages: recentMessages,
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
