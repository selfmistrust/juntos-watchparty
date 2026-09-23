import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

function connect(name: string): Redis {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  client.on('error', (err) => console.error(`[redis:${name}]`, err.message));
  client.on('connect', () => console.log(`[redis:${name}] conectado`));

  return client;
}

/** Leitura/escrita do estado das salas. */
export const redis = connect('data');

/**
 * O adapter do Socket.io precisa de duas conexões dedicadas, uma para
 * publicar eventos e outra para assinar — é assim que instâncias diferentes
 * do servidor entregam o broadcast (chat, play/pause) para os sockets
 * conectados em outra instância.
 */
export const pubClient = connect('pub');
export const subClient = connect('sub');
