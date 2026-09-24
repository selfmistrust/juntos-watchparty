import path from 'node:path';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { customAlphabet } from 'nanoid';

/**
 * Cliente S3 genérico — funciona com Cloudflare R2, AWS S3 ou qualquer
 * provedor compatível, só trocando variáveis de ambiente. R2 é a opção
 * recomendada aqui: API S3-compatível e sem cobrança de saída (egress), o
 * que importa bastante servindo vídeo pra vários espectadores ao mesmo tempo.
 *
 * O vídeo NUNCA passa pelo nosso servidor: o cliente sobe direto pro bucket
 * usando uma URL assinada, e os espectadores também assistem direto de lá.
 * Isso elimina de vez o problema de timeout/memória/disco de hospedagens
 * como o free tier do Render — nosso processo só assina URLs, não move bytes.
 */
const REGION = process.env.S3_REGION ?? 'auto';
/** Endpoint da conta R2, ex.: https://<accountid>.r2.cloudflarestorage.com — vazio para AWS S3 "de verdade". */
const ENDPOINT = process.env.S3_ENDPOINT || undefined;
const BUCKET = process.env.S3_BUCKET ?? '';
/** Domínio público de leitura do bucket (custom domain ou o *.r2.dev), sem barra no final. */
const PUBLIC_BASE_URL = (process.env.S3_PUBLIC_URL ?? '').replace(/\/+$/, '');

if (!BUCKET || !PUBLIC_BASE_URL) {
  console.warn(
    '[storage] S3_BUCKET / S3_PUBLIC_URL não configurados — o upload de vídeo vai falhar até isso ser preenchido no .env.',
  );
}

export const s3 = new S3Client({
  region: 'auto',
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  },
});

/** Teto de tamanho por arquivo, em bytes. Padrão: 1 GB. Confiado na palavra do cliente — ver nota em socket.ts. */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 1024) * 1024 * 1024;

/** Validade da URL assinada de upload. Generosa de propósito: precisa cobrir o envio inteiro, não só o começo. */
const UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60; // 2h

/** Prefixo dos objetos no bucket, pra não colidir com outra coisa que o mesmo bucket venha a guardar. */
const KEY_PREFIX = 'uploads/';

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

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

const randomName = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);
/** Reconhece um objeto nosso pelo padrão de nome acima — nunca mexe em URL externa colada pelo usuário. */
const OWN_FILENAME = /^[a-z0-9]{20,32}\.(?:mp4|webm|mkv)$/i;

function extensionOf(originalName: string): string {
  return path.extname(originalName || '').toLowerCase();
}

export function isAllowedVideoFile(originalName: string, mimetype: string): boolean {
  const ext = extensionOf(originalName);
  const accepted = ALLOWED_TYPES[ext];
  if (!accepted) return false;
  return mimetype === 'application/octet-stream' || mimetype === '' || accepted.includes(mimetype);
}

export function publicUrlFor(key: string): string {
  return `${PUBLIC_BASE_URL}/${key}`;
}

/**
 * Gera a URL assinada de PUT que o CLIENTE usa pra mandar o arquivo direto
 * pro bucket. O `Content-Type` fica travado na assinatura — o cliente
 * precisa mandar exatamente o `contentType` devolvido aqui no header do PUT,
 * ou o provedor rejeita por assinatura inválida.
 */
export async function createUploadTarget(originalName: string): Promise<{
  key: string;
  uploadUrl: string;
  publicUrl: string;
  contentType: string;
}> {
  const ext = extensionOf(originalName) || '.mp4';
  const key = `${KEY_PREFIX}${randomName()}${ext}`;
  const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';

  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });

  return { key, uploadUrl, publicUrl: publicUrlFor(key), contentType };
}

/** Extrai a key de um dos nossos próprios objetos a partir da URL pública, ou `null` se não for nosso. */
export function ownedKeyFromUrl(url: string): string | null {
  if (!PUBLIC_BASE_URL || !url.startsWith(`${PUBLIC_BASE_URL}/`)) return null;
  const key = url.slice(PUBLIC_BASE_URL.length + 1).split(/[?#]/)[0];
  const name = key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
  return OWN_FILENAME.test(name) ? key : null;
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.error('[storage] falha ao apagar objeto', key, err);
  }
}

/** Usado ao remover um item da fila — apaga só se reconhecer o objeto como nosso. */
export async function deleteUploadIfOwned(url: string): Promise<void> {
  const key = ownedKeyFromUrl(url);
  if (key) await deleteObject(key);
}

/** Lista todos os objetos de vídeo enviados, com data de modificação — usado pela limpeza de órfãos. */
export async function listUploadedObjects(): Promise<{ key: string; lastModified: Date }[]> {
  const objects: { key: string; lastModified: Date }[] = [];
  let continuationToken: string | undefined;

  try {
    do {
      const res = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: KEY_PREFIX, ContinuationToken: continuationToken }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key && obj.LastModified) objects.push({ key: obj.Key, lastModified: obj.LastModified });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (err: any) {
    // Se o prefixo/pasta 'uploads/' não existir no bucket ainda ou estiver vazio, o R2 lança NoSuchKey/NotFound.
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return [];
    }
    throw err;
  }

  return objects;
}

/** Apaga várias chaves de uma vez (até 1000 por chamada, limite da API S3). */
export async function deleteObjects(keys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await s3.send(
      new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch.map((Key) => ({ Key })) } }),
    );
    deleted += res.Deleted?.length ?? batch.length;
  }
  return deleted;
}
