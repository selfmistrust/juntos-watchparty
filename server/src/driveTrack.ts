import { redis } from './redis.js';
import { getValidAccessToken } from './driveOAuth.js';

/**
 * Validação do arquivo escolhido no Picker.
 *
 * Este módulo não serve vídeo, e é importante que continue assim: **o Render
 * não transporta byte de mídia**. Quem assiste pede os bytes direto ao Google,
 * com o token da própria conta, e o navegador monta a requisição por um service
 * worker. O R2 também não entra. O que o servidor faz é decidir quem pode ver
 * — e isso mora em `driveShare.ts`.
 *
 * Aqui a única responsabilidade é confirmar que o `fileId` que o cliente mandou
 * é mesmo um vídeo que aquela pessoa tem acesso, e devolver os dados que a fila
 * precisa. O id é validado contra a concessão de quem chamou: um id que ela não
 * escolheu volta 404 do Google, e o item nunca entra na fila.
 */

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** Mesmo formato validado no cliente: o id vai para dentro de um caminho de URL. */
const FILE_ID = /^[A-Za-z0-9_-]{10,256}$/;

export type DriveTrack = {
  fileId: string;
  name: string;
  duration?: number;
  size?: number;
};

export type DriveTrackFailure =
  | 'not_connected'
  | 'bad_file'
  | 'not_a_video'
  | 'no_download'
  | 'unavailable';

/** Um dia: o máximo de vida de uma sala. Ninguém assiste a uma faixa órfã. */
const TRACK_TTL_SEC = 24 * 60 * 60;
const trackKey = (fileId: string) => `drive:track:${fileId}`;

export function fileIdValido(fileId: unknown): fileId is string {
  return typeof fileId === 'string' && FILE_ID.test(fileId);
}

/**
 * Confere o arquivo e devolve o que a fila precisa mostrar.
 *
 * `capabilities.canDownload` é conferido porque a documentação do Google manda:
 * quem tem o arquivo pode bloquear o download, e aí o `<video>` falharia sem
 * nenhuma explicação para quem assiste.
 */
export async function criarFaixa(
  sessionId: string,
  fileId: string,
): Promise<{ ok: true; track: DriveTrack } | { ok: false; reason: DriveTrackFailure }> {
  if (!fileIdValido(fileId)) return { ok: false, reason: 'bad_file' };

  const oauth = await getValidAccessToken(sessionId);
  if (!oauth.ok) {
    return { ok: false, reason: oauth.reason === 'not_connected' ? 'not_connected' : 'unavailable' };
  }

  const url = new URL(`${DRIVE_FILES}/${fileId}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,videoMediaMetadata(durationMillis),capabilities(canDownload)');
  url.searchParams.set('supportsAllDrives', 'true');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let file: {
    name?: string;
    mimeType?: string;
    size?: string;
    videoMediaMetadata?: { durationMillis?: string };
    capabilities?: { canDownload?: boolean };
  };
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${oauth.accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // Um 404 aqui é o "você não escolheu este arquivo" do `drive.file`, e é o
    // motivo mais provável num teste mal feito. Vira `bad_file` para o painel
    // não sugerir algo que não vai funcionar.
    if (response.status === 404) return { ok: false, reason: 'bad_file' };
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    file = (await response.json()) as typeof file;
  } catch {
    clearTimeout(timeout);
    return { ok: false, reason: 'unavailable' };
  }

  if (!file.mimeType?.startsWith('video/')) return { ok: false, reason: 'not_a_video' };
  if (file.capabilities?.canDownload === false) return { ok: false, reason: 'no_download' };

  return {
    ok: true,
    track: {
      fileId,
      name: file.name || 'Vídeo',
      duration: file.videoMediaMetadata?.durationMillis
        ? Math.round(Number(file.videoMediaMetadata.durationMillis) / 1000)
        : undefined,
      size: file.size ? Number(file.size) : undefined,
    },
  };
}

/**
 * De quem é a concessão que deu acesso a este arquivo.
 *
 * O registro fica no servidor justamente para isso: a sessão de quem escolheu
 * não viaja no snapshot da sala, que todo mundo recebe. Sem ele, o `fileId`
 * solto no estado da sala seria um id que o servidor não sabe de quem é — e
 * Precisaria do e-mail de alguém para conceder acesso, o que abriria a porta
 * para Granted by no servidor o arquivo que ele não escolheu.
 */
export async function registrarDonoDoTrack(
  fileId: string,
  sessionId: string,
  name: string,
): Promise<void> {
  if (!fileIdValido(fileId)) return;
  const record = { sessionId, name, createdAt: Date.now() };
  await redis.set(trackKey(fileId), JSON.stringify(record), 'EX', TRACK_TTL_SEC);
}

export async function donoDoTrack(fileId: string): Promise<string | null> {
  if (!fileIdValido(fileId)) return null;
  const raw = await redis.get(trackKey(fileId));
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { sessionId?: string }).sessionId ?? null;
  } catch {
    return null;
  }
}
