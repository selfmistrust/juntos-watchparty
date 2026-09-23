import bcrypt from 'bcryptjs';
import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';
import type { Room, RoomSnapshot, User } from './types.js';

/** IDs de sala curtos e fáceis de ditar por voz. */
export const newRoomId = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 12);
export const newId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

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

function emptyRoom(id: string, name?: string): Room {
  return {
    id,
    name: name?.trim() || 'Sessão sem título',
    hostId: null,
    openControl: false,
    users: {},
    playlist: [],
    currentIndex: -1,
    isPlaying: false,
    position: 0,
    updatedAt: Date.now(),
    createdAt: Date.now(),
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

export function addUser(
  room: Room,
  id: string,
  name: string,
  avatar?: { seed?: string; url?: string },
): User {
  const color = NAME_COLORS[Object.keys(room.users).length % NAME_COLORS.length];
  const user: User = {
    id,
    name: name.slice(0, 24) || 'Convidado',
    color,
    // Sem semente própria, usa o id do socket — determinístico e sempre disponível.
    avatarSeed: avatar?.seed?.slice(0, 40) || id,
    avatarUrl: avatar?.url,
  };
  room.users[id] = user;
  if (!room.hostId) room.hostId = id;
  return user;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Cor de nome escolhida pelo próprio usuário, substituindo a atribuída automaticamente. */
export function setUserColor(room: Room, id: string, color: string): boolean {
  const user = room.users[id];
  if (!user || !HEX_COLOR.test(color)) return false;
  user.color = color;
  return true;
}

/**
 * Troca a semente do DiceBear e/ou a foto customizada. `url: ''` limpa a
 * foto e volta a usar o avatar gerado a partir da semente.
 */
export function setUserAvatar(room: Room, id: string, avatar: { seed?: string; url?: string }): boolean {
  const user = room.users[id];
  if (!user) return false;
  if (avatar.url !== undefined) {
    user.avatarUrl = avatar.url.length > 0 ? avatar.url : undefined;
  }
  if (avatar.seed) user.avatarSeed = avatar.seed.slice(0, 40);
  return true;
}

export function removeUser(room: Room, id: string): User | undefined {
  const user = room.users[id];
  delete room.users[id];
  if (room.hostId === id) {
    // O host sai: o participante mais antigo assume para a sala não travar.
    room.hostId = Object.keys(room.users)[0] ?? null;
  }
  return user;
}

export function canControl(room: Room, userId: string): boolean {
  return room.openControl || room.hostId === userId;
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
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    openControl: room.openControl,
    hasPassword: Boolean(room.passwordHash),
    users: Object.values(room.users),
    playlist: room.playlist,
    currentIndex: room.currentIndex,
    isPlaying: room.isPlaying,
    position: projectedPosition(room, now),
    serverTime: now,
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
