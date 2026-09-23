const MAX_MESSAGES = 5;
const CHAT_WINDOW_MS = 3000;
/** Bloqueia "aaaaaaaaaaaa" e afins: mais de 10 repetições seguidas do mesmo caractere. */
const FLOOD_PATTERN = /(.)\1{10,}/;

/** Reações e sons com limitações para não virar flood visual/sonoro. */
const MAX_REACTIONS = 20;
const REACTION_WINDOW_MS = 4000;

/**
 * "Digitando...": o cliente já só emite na transição (começou/parou), não a
 * cada tecla, então esse teto é só para um cliente adulterado que ignore
 * isso e tente floodar a sala.
 */
const MAX_TYPING_EVENTS = 15;
const TYPING_WINDOW_MS = 4000;

/** Emissão de token de upload: os arquivos já são grandes, não precisa de muitos por minuto. */
const MAX_UPLOAD_TOKENS = 6;
const UPLOAD_WINDOW_MS = 60_000;

/** ~500 KB de data URL já cobre uma imagem 640px comprimida em JPEG com folga. */
const MAX_IMAGE_DATA_URL_LENGTH = 500_000;
/** URLs de GIF vêm de um provedor (Tenor/Giphy) e são curtas; nada perto disso é legítimo. */
const MAX_GIF_URL_LENGTH = 500;

const windows = new Map<string, number[]>();

/**
 * Janela deslizante em memória, por chave (ex.: `chat:<socket.id>`). Cada
 * socket vive em uma única instância do processo (o adapter do Redis só
 * cuida do broadcast entre instâncias), então não precisa compartilhar isso
 * entre servidores.
 */
function slidingWindowHit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  windows.set(key, timestamps);
  return timestamps.length > max;
}

export function isRateLimited(socketId: string): boolean {
  return slidingWindowHit(`chat:${socketId}`, MAX_MESSAGES, CHAT_WINDOW_MS);
}

export function isReactionRateLimited(socketId: string): boolean {
  return slidingWindowHit(`reaction:${socketId}`, MAX_REACTIONS, REACTION_WINDOW_MS);
}

export function isTypingRateLimited(socketId: string): boolean {
  return slidingWindowHit(`typing:${socketId}`, MAX_TYPING_EVENTS, TYPING_WINDOW_MS);
}

export function isUploadRateLimited(socketId: string): boolean {
  return slidingWindowHit(`upload:${socketId}`, MAX_UPLOAD_TOKENS, UPLOAD_WINDOW_MS);
}

export function clearRateLimit(socketId: string): void {
  windows.delete(`chat:${socketId}`);
  windows.delete(`reaction:${socketId}`);
  windows.delete(`upload:${socketId}`);
  windows.delete(`typing:${socketId}`);
}

/**
 * Filtro de conteúdo intencionalmente simples: corta o texto, recusa
 * flood de caractere repetido e normaliza espaços. Para uma sala aberta ao
 * público em geral, troque por uma lista de termos curada ou um serviço de
 * moderação.
 */
export function sanitizeMessage(raw: string): string | null {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  if (!text) return null;
  if (FLOOD_PATTERN.test(text)) return null;
  return text;
}

/** Legenda opcional de GIF/imagem: mesma limpeza da mensagem, mas pode ficar vazia. */
export function sanitizeCaption(raw: string | undefined): string {
  return sanitizeMessage(raw ?? '') ?? '';
}

/** Aceita só data URLs de imagem, dentro do teto de tamanho combinado com o cliente. */
export function sanitizeImageDataUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('data:image/')) return null;
  if (raw.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
  return raw;
}

/** Aceita só links https curtos que é o formato que o Giphy devolve. */
export function sanitizeGifUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^https:\/\//.test(raw)) return null;
  if (raw.length > MAX_GIF_URL_LENGTH) return null;
  return raw;
}
