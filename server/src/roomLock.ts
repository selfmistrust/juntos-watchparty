/**
 * Lock por sala, dentro do processo.
 *
 * O estado da sala vive no Redis e o padrão de escrita em todo o `socket.ts` é
 * o mesmo: carregar, mutar, gravar. Duas requisições que caem nesse padrão ao
 * mesmo tempo fazem `GET` do mesmo estado e a segunda gravação apaga a primeira.
 * Não é teórico: dois `room:join` no mesmo instante deixavam a segunda pessoa
 * invisível — sem nome na lista, sem avatar, e com todo handler posterior
 * descartado em silêncio porque `room.users[socket.id]` não existia.
 *
 * O lock segura o trecho ler-mutar-gravar inteiro, e nada mais. Ele é por
 * sala, para que salas diferentes não fiquem esperando as umas das outras.
 *
 * **Limite conhecido:** o lock vale por processo. Com mais de uma instância do
 * servidor (o Render com load balancer pode ter), duas entradas que caíam em
 * instâncias diferentes ainda se perdem. Fechar isso exigiria `WATCH`/`MULTI`
 * do Redis, que é outra ordem de trabalho e reescreve o join inteiro.
 */

import { getRoom } from './rooms.js';
import type { Room } from './types.js';

/** Fila de um turno por sala. Guardada só enquanto houver alguém esperando. */
const filas = new Map<string, Promise<void>>();

/**
 * Roda `fn` em exclusivo por `roomId`.
 *
 * A rejeição da volta anterior **não** impede a próxima de rodar: uma exceção
 * em uma escrita não pode envenenar a sala para todo mundo até o fim dos
 * tempos. O erro volta para quem chamou, como sempre.
 */
export function withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const anterior = filas.get(roomId) ?? Promise.resolve();

  let liberar!: () => void;
  const meu = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  filas.set(roomId, meu);

  // `.then(fn, fn)`: o mesmo `fn` nos dois caminhos, para rodar tanto depois de
  // um sucesso quanto depois de uma falha.
  const resultado = anterior.then(fn, fn);

  const encerrar = () => {
    // Só apaga se a fila ainda for a nossa: se outra pessoa entrou depois, o
    // mapa já aponta para o turno dela e apagá-lo soltaria duas de uma vez.
    if (filas.get(roomId) === meu) filas.delete(roomId);
    liberar();
  };
  resultado.then(encerrar, encerrar);

  return resultado;
}

/**
 * Ler, mutar e gravar em um passo só, sob o lock.
 *
 * Devolve `undefined` quando a sala não existe, o que evita espalhar a checagem
 * por todo handler. `fn` recebe a sala já carregada e deve chamar
 * `persistRoom` se mudar algo — a regra do módulo é "quem persiste, segura o
 * lock", e essa função é o lugar onde isso acontece.
 */
export async function editarSala<T>(
  roomId: string,
  fn: (room: Room) => Promise<T> | T,
): Promise<T | undefined> {
  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room) return undefined;
    return fn(room);
  });
}

/** Salas com fila ativa. Só para diagnóstico em teste; a produção não chama. */
export function salasComFila(): number {
  return filas.size;
}
