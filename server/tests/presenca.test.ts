import assert from 'node:assert/strict';
import { test } from 'node:test';

/*
 * `rooms.ts` importa o Redis para persistir a sala, e o cliente real tentaria
 * conectar em `127.0.0.1:1` — o mesmo endereço recusado do resto da suíte. O
 * módulo é importado **depois** do desligamento, como nos outros arquivos, para
 * que o erro de conexão não fique pendurado segurando o processo.
 */
process.env.REDIS_URL = 'redis://127.0.0.1:1';
const { redis, pubClient, subClient } = await import('../src/redis.js');
for (const cliente of [redis, pubClient, subClient]) cliente.disconnect();

const {
  addUser,
  markUserDisconnected,
  cleanupStaleUsers,
  transferirHost,
  PRESENCE_TIMEOUT_MS,
} = await import('../src/rooms.js');

/*
 * A janela de ausência e a host são duas perguntas com duas janelas.
 *
 * Quem pode ser citada dura `PRESENCE_TIMEOUT_MS`. Quem segura o controle sai no
 * instante em que o socket morre. Misturar as duas coisas dá um dos dois
 * defeitos, e ambos são ruins:
 *
 *   - hosttransferida só na limpeza -> a sala fica parada enquanto a janela de
 *     ausência corre, porque o `hostId` aponta para um socket morto;
 *   - ausente apagado no disconnect -> a menção com o site fechado perde o
 *     destinatário, que é o que o push precisa.
 *
 * A janela de ausência era de 30 segundos e virou 15 minutos, que é o que segura
 * um aviso de menção com o site fechado. Esse é o número que estes testes
 * protectem: qualquer um que reduza a janela de volta para segundos quebra a
 * quarta camada de aviso sem nenhum teste ficar vermelho.
 */

type Sala = Parameters<typeof addUser>[0];

function sala(host: boolean) {
  const room = {
    id: 'sala-presenca',
    name: 'Sala',
    hostId: '',
    hostUserId: null,
    openControl: false,
    users: {},
    playlist: [],
    currentIndex: -1,
  } as unknown as Sala;

  const h = addUser(room, 's-h', 'u-h', 'Hospedeira');
  const v = addUser(room, 's-v', 'u-v', 'Visitante');
  if (host) room.hostId = h.sessionId;
  return { room, h, v };
}

test('a janela de ausencia cobre um cafe, e nao segundos', () => {
  /*
   * Este é o número que sustenta o aviso com o site fechado. Quem fecha a aba
   * precisa continuar na sala por tempo suficiente para ainda ser citado por
   * nome; volta para 30s e a menção deixa de resolver contra qualquer pessoa.
   */
  assert.ok(
    PRESENCE_TIMEOUT_MS >= 10 * 60_000,
    `PRESENCE_TIMEOUT_MS e ${PRESENCE_TIMEOUT_MS}ms: curto demais para o site fechado ser alcancavel`,
  );
});

test('quem fechou a aba continua na sala e continua sendo citable', () => {
  const { room, h } = sala(true);

  markUserDisconnected(room, h.sessionId);

  // Continua na sala: e daqui que `extrairMencoes` tira quem pode ser citado.
  assert.equal(room.users[h.sessionId]?.name, 'Hospedeira');
  assert.equal(room.users[h.sessionId]?.connected, false);
});

test('a host passa na hora em que o socket morre, com o ausente ainda na sala', () => {
  const { room, h, v } = sala(true);

  markUserDisconnected(room, h.sessionId);
  const trocou = transferirHost(room);

  assert.equal(trocou, true, 'a host deveria ter passado');
  assert.equal(room.hostId, v.sessionId, 'a visita connected deveria ter herdado o controle');
  assert.equal(room.hostUserId, 'u-v');
  // O ponto do teste: a sala **nao** ficou parada. As duas pessoas continuam na
  // sala — a que saiu segue citable — e ainda assim ninguem depende do socket
  // dela para dar play.
  assert.equal(Object.keys(room.users).length, 2, 'a ausente continua na sala, e por isso ainda e citavel');
  assert.equal(room.users[room.hostId]?.connected, true, 'e quem herdou o controle esta vivo');
});

test('transferir de host nao mexe quando o host atual continua vivo', () => {
  const { room, h } = sala(true);

  const trocou = transferirHost(room);

  assert.equal(trocou, false, 'nao havia o que transferir');
  assert.equal(room.hostId, h.sessionId, 'o host vivo continua no comando');
});

test('sala sem ninguem vivo fica sem host, e nao com host morto', () => {
  const { room, h, v } = sala(true);

  markUserDisconnected(room, h.sessionId);
  markUserDisconnected(room, v.sessionId);
  transferirHost(room);

  // Host morto e pior do que host nenhum: `canControl` com `hostId` apontando
  // para um socket que nao existe da a sala um controle que nao responde a
  // ninguem. Sem host, o estado e honesto e o reconectar devolve o controle.
  assert.equal(room.hostId, null);
  assert.equal(room.hostUserId, null);
});

test('quem some da janela de ausencia deixa de ser citable', () => {
  const { room, h } = sala(true);

  markUserDisconnected(room, h.sessionId);
  // O `lastSeen` fica no passado alem da janela, que e o que a varredura olha.
  const user = room.users[h.sessionId];
  if (user) user.lastSeen = Date.now() - PRESENCE_TIMEOUT_MS - 1_000;

  const removidos = cleanupStaleUsers(room);

  assert.equal(removidos.length, 1);
  assert.equal(room.users[h.sessionId], undefined, 'a partir daqui o nome nao casa mais com ninguem');
});

test('quem esta vivo nunca e varrido pela janela de ausencia', () => {
  const { room, h, v } = sala(true);

  const removidos = cleanupStaleUsers(room);

  assert.equal(removidos.length, 0);
  assert.equal(room.users[h.sessionId]?.name, 'Hospedeira');
  assert.equal(room.users[v.sessionId]?.name, 'Visitante');
});
