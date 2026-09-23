import type { MediaKind } from '@/types';

export interface ParsedMedia {
  kind: MediaKind;
  src: string;
  title: string;
}

const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];

/**
 * Aceita link do YouTube (watch, youtu.be, shorts, embed) ou URL direta de vídeo.
 * Retorna null quando não dá para reproduzir — a UI usa isso para explicar o erro.
 */
export function parseMediaUrl(input: string): ParsedMedia | null {
  const raw = input.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (YT_HOSTS.includes(url.hostname)) {
    const id = extractYoutubeId(url);
    if (!id) return null;
    return { kind: 'youtube', src: id, title: 'Vídeo do YouTube' };
  }

  if (/\.(mp4|webm|ogg|m4v|mov)(\?|$)/i.test(url.pathname + url.search)) {
    const name = decodeURIComponent(url.pathname.split('/').pop() ?? 'Vídeo');
    return { kind: 'file', src: url.toString(), title: name };
  }

  return null;
}

function extractYoutubeId(url: URL): string | null {
  if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
  const v = url.searchParams.get('v');
  if (v) return v;
  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.findIndex((p) => p === 'shorts' || p === 'embed' || p === 'live');
  if (marker !== -1 && parts[marker + 1]) return parts[marker + 1];
  return null;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function youtubeThumb(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/** Mesma lista aceita pelo servidor em `isAllowedVideoFile` — mantém a mensagem de erro coerente. */
export const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv'];

export function hasAllowedVideoExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return false;
  return ALLOWED_VIDEO_EXTENSIONS.includes(fileName.slice(dot).toLowerCase());
}

/**
 * Carrega um arquivo de imagem local num <img> para poder redesenhá-lo num
 * canvas — passo comum às duas funções de compressão abaixo.
 */
function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error('decode_failed'));
      img.onload = () => resolve(img);
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Redimensiona a imagem para caber em `maxSize` no lado maior e reencoda
 * como JPEG. Existe para caber num payload de socket sem precisar de upload
 * para um servidor de arquivos — a imagem já sai pequena o bastante do
 * navegador.
 */
export async function compressImageFile(file: File, maxSize = 720, quality = 0.72): Promise<string> {
  const img = await loadImageFile(file);
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Mesma ideia, mas recorta um quadrado central — pensado para foto de avatar. */
export async function compressAvatarFile(file: File, size = 160, quality = 0.82): Promise<string> {
  const img = await loadImageFile(file);
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', quality);
}
