import { Readable } from 'node:stream';
import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';
import { getValidAccessToken } from './driveOAuth.js';

/**
 * Reprodução de um arquivo do Drive, sem esperar o download inteiro.
 *
 * ## O que mudou
 *
 * Até aqui a integração copiava o arquivo do Drive para o bucket antes de
 * qualquer reprodução. Para um episódio isso significava esperar duas
 * transferências inteiras e sequenciais — baixar do Google e depois subir para
 * o R2, sempre pela mesma conexão de quem escolheu. Um mkv de 2,2 GB levava
 * cerca de uma hora, e o pico de memória no navegador era de aproximadamente
 * duas vezes o tamanho do arquivo.
 *
 * Aqui o vídeo passa pelo servidor, mas **por partes**. A rota de mídia
 * encaminha o cabeçalho `Range` do `<video>` para a Drive API e repassa os
 * bytes, então a reprodução começa assim que o primeiro bloco chega, o seek
 * funciona, e a sincronização da sala continua operando sobre `position` como
 * em qualquer outro arquivo.
 *
 * ## O que isso custa
 *
 * O vídeo deixa de ser "grátis" no servidor: agora o Render é o gargalo de
 * banda, e cada espectador puxa um stream próprio. É uma troca consciente, e
 * vale registrar aqui porque o comentário de `storage.ts` dizia o contrário.
 * O R2 continua sendo usado no envio comum e não é caminho do Drive.
 *
 * ## A identidade do proxy
 *
 * A rota não valida `Origin` — uma requisição de `<video>` não manda esse
 * cabeçalho, e `isTrustedOrigin` a rejeitaria. A proteção é posse do link: o
 * `src` do item carrega um token de 128 bits, criado pelo servidor, que aponta
 * para `{ sessionId, fileId }` guardado no Redis.
 *
 * Duas coisas fecham o resto: o servidor **nunca** aceita uma URL vinda do
 * cliente para ser buscada — a URL do Drive é montada aqui, a partir do
 * `fileId` que ele próprio validou — e o token morre junto com a sala, na
 * remoção do item e no vencimento. Um link de bucket público, que é o que
 * existe hoje para envio comum, não tem nenhuma das duas garantias.
 */

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** Mesmo formato validado no cliente: o id vai para dentro de um caminho de URL. */
const FILE_ID = /^[A-Za-z0-9_-]{10,256}$/;
const STREAM_TOKEN = /^[a-z0-9]{32}$/;
const STREAM_PATH = '/api/drive/stream/';

/** 32 caracteres do mesmo alfabeto do resto do projeto: opaco e não adivinhável. */
const newStreamToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 32);

/**
 * Uma sala vive no máximo 24 h (`ROOM_MAX_LIFETIME_MS`), então o token pode
 * viver o mesmo prazo. Não é renovado na leitura de propósito: um token
 * esquecido numa sala abandonada precisa sumir sozinho.
 */
const STREAM_TTL_SEC = 24 * 60 * 60;

export type DriveStreamGrant = {
  /** Sessão que concedeu o acesso. O token do Drive é dela, e só dela. */
  sessionId: string;
  fileId: string;
  name: string;
  mimeType: string;
  size?: number;
  durationMs?: number;
};

/**
 * Uma concessão por sala pode ser revogada quando a pessoa desconecta a conta.
 *
 * Sem o índice, o efeito seria só funcional: a rota pararia de servir porque o
 * token do Drive foi apagado, mas o registro do `fileId` ficaria no Redis até
 * o TTL. Desconectar é um pedido de parada, e o registro de qual arquivo era
 * também é dado do usuário.
 */
const MAX_CONCESSOES_POR_SESSAO = 50;
const indiceDe = (sessionId: string) => `drive:streams:${sessionId}`;

async function lembrarConcessao(sessionId: string, token: string): Promise<void> {
  const raw = await redis.get(indiceDe(sessionId));
  let tokens: string[] = [];
  if (raw) {
    try {
      tokens = JSON.parse(raw) as string[];
    } catch {
      tokens = [];
    }
  }
  if (tokens.includes(token)) return;
  await redis.set(
    indiceDe(sessionId),
    JSON.stringify([...tokens, token].slice(-MAX_CONCESSOES_POR_SESSAO)),
    'EX',
    STREAM_TTL_SEC,
  );
}

/** Usado ao desconectar o Drive: apaga as reproduções que a conta sustentava. */
export async function apagarConcessoesDaSessao(sessionId: string): Promise<void> {
  const raw = await redis.get(indiceDe(sessionId));
  if (!raw) return;
  try {
    const tokens = JSON.parse(raw) as string[];
    for (const token of tokens) await redis.del(chaveDe(token));
  } catch {
    // Índice corrompido: apagar a chave é o bastante para não vazar nada.
  }
  await redis.del(indiceDe(sessionId));
}

export type DriveStreamTarget = {
  token: string;
  /** Caminho; o cliente compõe a URL absoluta com o `SERVER_URL` que já tem. */
  path: string;
  name: string;
  duration?: number;
  size?: number;
};

export type DriveStreamFailure = 'not_connected' | 'bad_file' | 'not_a_video' | 'no_download' | 'unavailable';

/** `bytes=0-1023`, `bytes=1024-`, `bytes=-500`. Um intervalo só, sem vírgula. */
const RANGE = /^bytes=(\d*)-(\d*)$/;

/** Reconhece o `src` de um item que é servido por esta rota. */
export function extrairTokenDeSrc(src: unknown): string | null {
  if (typeof src !== 'string' || !src.includes(STREAM_PATH)) return null;
  const depois = src.slice(src.indexOf(STREAM_PATH) + STREAM_PATH.length);
  const token = depois.split(/[?#/]/)[0];
  return STREAM_TOKEN.test(token) ? token : null;
}

function chaveDe(token: string): string {
  return `drive:stream:${token}`;
}

export async function lerStream(token: string): Promise<DriveStreamGrant | null> {
  if (!STREAM_TOKEN.test(token)) return null;
  const raw = await redis.get(chaveDe(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DriveStreamGrant;
    if (!parsed.sessionId || !parsed.fileId || !parsed.name) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function apagarStream(token: string): Promise<void> {
  if (!STREAM_TOKEN.test(token)) return;
  await redis.del(chaveDe(token));
}

/**
 * Cria a concessão de reprodução para um arquivo escolhido no Picker.
 *
 * A URL do Drive é montada aqui e o `fileId` é validado aqui. Nada do que o
 * cliente manda entra no caminho da requisição — se este módulo aceitasse uma
 * URL, a rota viraria um proxy aberto para qualquer endereço.
 */
export async function criarStream(
  sessionId: string,
  fileId: string,
): Promise<{ ok: true; target: DriveStreamTarget } | { ok: false; reason: DriveStreamFailure }> {
  if (!FILE_ID.test(fileId)) return { ok: false, reason: 'bad_file' };

  const oauth = await getValidAccessToken(sessionId);
  if (!oauth.ok) return { ok: false, reason: oauth.reason === 'not_connected' ? 'not_connected' : 'unavailable' };

  const url = new URL(`${DRIVE_FILES}/${fileId}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,videoMediaMetadata(durationMillis),capabilities(canDownload)');
  url.searchParams.set('supportsAllDrives', 'true');

  let file: {
    name?: string;
    mimeType?: string;
    size?: string;
    videoMediaMetadata?: { durationMillis?: string };
    capabilities?: { canDownload?: boolean };
  };
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${oauth.accessToken}` } });
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    file = (await response.json()) as typeof file;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (!file.mimeType?.startsWith('video/')) return { ok: false, reason: 'not_a_video' };
  // A documentação manda checar antes de servir: o dono do arquivo pode ter
  // bloqueado o download, e aí o `<video>` ficaria em erro sem explicação.
  if (file.capabilities?.canDownload === false) return { ok: false, reason: 'no_download' };

  const grant: DriveStreamGrant = {
    sessionId,
    fileId,
    name: file.name || 'Vídeo',
    mimeType: file.mimeType,
    size: file.size ? Number(file.size) : undefined,
    durationMs: file.videoMediaMetadata?.durationMillis
      ? Number(file.videoMediaMetadata.durationMillis)
      : undefined,
  };

  const streamToken = newStreamToken();
  await redis.set(chaveDe(streamToken), JSON.stringify(grant), 'EX', STREAM_TTL_SEC);
  await lembrarConcessao(sessionId, streamToken);

  return {
    ok: true,
    target: {
      token: streamToken,
      path: `${STREAM_PATH}${streamToken}`,
      name: grant.name,
      duration: grant.durationMs ? Math.round(grant.durationMs / 1000) : undefined,
      size: grant.size,
    },
  };
}

/** Normaliza o `Range` que o navegador mandou. `null` quando não há. */
export function rangeDe(header: unknown): string | null {
  if (typeof header !== 'string' || !header) return null;
  // Mais de um intervalo faria o Drive responder `multipart/byteranges`, que
  // não é o que o `<video>` espera. Rejeitar é melhor que translatingo errado.
  if (!RANGE.test(header)) return null;
  return header;
}

/**
 * Abre o arquivo no Drive já com o `Range` que o navegador pediu.
 *
 * A resposta volta com o corpo ainda não consumido: quem chama decide se
 * repassa ao cliente ou descarta, e nenhum byte é lido aqui.
 */
export async function abrirArquivo(
  grant: DriveStreamGrant,
  range: string | null,
  accessToken: string,
  signal: AbortSignal,
): Promise<Response> {
  const url = new URL(`${DRIVE_FILES}/${grant.fileId}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');

  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (range) headers.Range = range;

  return fetch(url, { headers, signal });
}

/** Repassa os cabeçalhos que importam para um `<video>` com `Range`. */
export function repassarCabecalhos(upstream: Response, res: { set: (k: string, v: string) => void }): void {
  res.set('Accept-Ranges', 'bytes');
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.set('Content-Type', contentType);
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) res.set('Content-Length', contentLength);
  // `206` responde com o intervalo devolvido; é ele que o player usa para
  // montar a duração de um item que ele ainda não conhece inteira.
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) res.set('Content-Range', contentRange);
}

/** O corpo do Drive como stream do Node, para o `pipe` não segurar nada. */
export function corpoComoStream(upstream: Response): Readable {
  // `Readable.fromWeb` só existe para `ReadableStream` real; o `fetch` do Node
  // sempre entrega uma, mas o tipo do DOM não é o de `node:stream`.
  return Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>);
}
