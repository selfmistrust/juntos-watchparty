import { redis } from './redis.js';
import { deleteObjects, listUploadedObjects, ownedKeyFromUrl } from './storage.js';
import type { Room } from './types.js';

/**
 * Só apaga um objeto depois desse tempo de vida. Dá folga para: um upload
 * que acabou de terminar mas cujo `playlist:add` ainda não foi persistido, e
 * evita qualquer disputa com um upload em andamento.
 */
const MIN_AGE_MS = 2 * 60 * 60 * 1000; // 2h

/** Varre todas as salas guardadas no Redis e reúne as keys de objeto ainda em uso. */
async function referencedKeys(): Promise<Set<string>> {
  const referenced = new Set<string>();
  let cursor = '0';

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'room:*', 'COUNT', 200);
    cursor = next;
    if (keys.length === 0) continue;

    const rooms = await redis.mget(...keys);
    for (const raw of rooms) {
      if (!raw) continue;
      let room: Room;
      try {
        room = JSON.parse(raw) as Room;
      } catch {
        continue; // sala com JSON inesperado — não é trabalho deste job consertar isso
      }

      for (const item of room.playlist) {
        if (item.kind !== 'file') continue;
        const key = ownedKeyFromUrl(item.src);
        if (key) referenced.add(key);
      }
    }
  } while (cursor !== '0');

  return referenced;
}

/**
 * Apaga, no bucket, todo objeto nosso que não apareça na fila de nenhuma
 * sala ainda viva no Redis e que já tenha passado da idade mínima de
 * segurança. Retorna um resumo pra log.
 */
export async function sweepOrphanedUploads(): Promise<{ scanned: number; deleted: number }> {
  const [referenced, objects] = await Promise.all([referencedKeys(), listUploadedObjects()]);
  const now = Date.now();

  const orphanKeys = objects
    .filter((o) => !referenced.has(o.key) && now - o.lastModified.getTime() >= MIN_AGE_MS)
    .map((o) => o.key);

  const deleted = orphanKeys.length > 0 ? await deleteObjects(orphanKeys) : 0;
  return { scanned: objects.length, deleted };
}

/**
 * Agenda a varredura: uma vez logo depois do boot (com um atraso curto, pra
 * não competir com a inicialização) e depois periodicamente.
 */
export function scheduleUploadCleanup(intervalMs = 6 * 60 * 60 * 1000): void {
  const run = () => {
    sweepOrphanedUploads()
      .then(({ scanned, deleted }) => {
        if (deleted > 0) {
          console.log(`[uploads] limpeza de órfãos: ${deleted}/${scanned} objeto(s) removido(s)`);
        }
      })
      .catch((err) => console.error('[uploads] falha na limpeza de órfãos:', err));
  };

  setTimeout(run, 60_000);
  setInterval(run, intervalMs);
}
