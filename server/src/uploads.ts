import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import multer, { type FileFilterCallback } from 'multer';
import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';

/** Onde os vídeos enviados ficam gravados no disco do servidor. */
export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Teto de tamanho por arquivo, em bytes. Padrão: 1 GB. */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 1024) * 1024 * 1024;

/**
 * Extensão -> mimetypes aceitos. O mimetype sozinho não é confiável: browsers
 * mandam `application/octet-stream` ou até vazio para .mkv dependendo do SO,
 * então a extensão é o critério principal e o mimetype é só um reforço.
 */
const ALLOWED_TYPES: Record<string, string[]> = {
  '.mp4': ['video/mp4'],
  '.webm': ['video/webm'],
  '.mkv': ['video/x-matroska', 'video/webm'],
};

const randomName = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

function extensionOf(originalName: string): string {
  return path.extname(originalName || '').toLowerCase();
}

export function isAllowedVideoFile(originalName: string, mimetype: string): boolean {
  const ext = extensionOf(originalName);
  const accepted = ALLOWED_TYPES[ext];
  if (!accepted) return false;
  return mimetype === 'application/octet-stream' || mimetype === '' || accepted.includes(mimetype);
}

// --- Tokens de upload -------------------------------------------------
// Emitidos só pelo handler do socket (onde `socket.id` é a identidade real
// da conexão, não algo que o cliente possa forjar) depois de checar
// `canControl`. A rota HTTP que recebe o arquivo não tem essa noção de
// identidade, então ela só aceita o upload mediante um token válido.

interface UploadTokenData {
  roomId: string;
  socketId: string;
}

const TOKEN_TTL_SECONDS = 120;
const tokenKey = (token: string) => `upload:token:${token}`;

export async function createUploadToken(data: UploadTokenData): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex');
  await redis.set(tokenKey(token), JSON.stringify(data), 'EX', TOKEN_TTL_SECONDS);
  return token;
}

/** Consome o token (apaga na hora) — cada token vale para um único upload. */
export async function consumeUploadToken(token: string): Promise<UploadTokenData | null> {
  if (!token) return null;
  const raw = await redis.get(tokenKey(token));
  if (!raw) return null;
  await redis.del(tokenKey(token));
  return JSON.parse(raw) as UploadTokenData;
}

export function publicUploadUrl(baseUrl: string, storedFileName: string): string {
  return new URL(`/uploads/${storedFileName}`, baseUrl).toString();
}

/**
 * Reconhece uma URL como sendo um dos nossos próprios arquivos (pelo padrão
 * de nome aleatório que geramos) e apaga o arquivo correspondente. Usado ao
 * remover um item da fila — nunca mexe em URLs externas coladas pelo usuário.
 */
const OWN_UPLOAD_PATTERN = /\/uploads\/([a-z0-9]{20,32}\.(?:mp4|webm|mkv))(?:[?#]|$)/i;

export function deleteUploadIfOwned(url: string): void {
  const match = OWN_UPLOAD_PATTERN.exec(url);
  if (!match) return;
  const full = path.join(UPLOAD_DIR, match[1]);
  if (!full.startsWith(UPLOAD_DIR)) return;
  fs.unlink(full, () => {
    // Best-effort: se o arquivo já não existir, não há nada a fazer.
  });
}

export const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = extensionOf(file.originalname) || '.mp4';
    cb(null, `${randomName()}${ext}`);
  },
});

export const videoFileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  if (!isAllowedVideoFile(file.originalname, file.mimetype)) {
    cb(new Error('unsupported_type'));
    return;
  }
  cb(null, true);
};
