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

const { canControl, addUser, podeAdicionarMidia } = await import('../src/rooms.js');

/*
 * A separação entre **adicionar** e **controlar** é o que este arquivo trava.
 *
 * Pedir para qualquer participante poder enviar arquivo, escolher um vídeo do
 * Drive ou transmitir tela não pode virar "qualquer um manda na sala". São duas
 * permissões diferentes, e o teste pega o caso em que a segunda escorrega para a
 * primeira.
 *
 * A sala é montada à mão em vez de vir de `ensureRoom`, que grava no Redis. As
 * duas funções sob teste são puras — leem `room.users`, `room.hostId` e
 * `room.openControl` — e nada disso depende de persistência.
 */
type Sala = Parameters<typeof canControl>[0];

function salaComHost() {
  const room = {
    id: 'sala-teste',
    name: 'Sala',
    hostId: '',
    openControl: false,
    users: {},
    playlist: [],
    currentIndex: -1,
  } as unknown as Sala;
  const host = addUser(room, 'host-1', 'u-host', 'hospedeira');
  const visita = addUser(room, 'visitante-1', 'u-visita', 'visitante');
  room.hostId = host.sessionId;
  return { room, host, visita };
}

test('qualquer participante na sala pode adicionar mídia', () => {
  const { room, visita } = salaComHost();
  // Sem `openControl` e sem ser host: é o caso comum numa sala privada.
  assert.equal(room.openControl, false);
  assert.equal(podeAdicionarMidia(room, visita.sessionId), true);
});

test('quem não está na sala não pode adicionar mídia', () => {
  const { room } = salaComHost();
  // A sessão que saiu, ou nunca entrou, não é participante. `addUser` é a única
  // porta de entrada, e checar por ela é mais barato do que confiar no
  // handshake do socket.
  assert.equal(podeAdicionarMidia(room, 'ninguem-1'), false);
  assert.equal(podeAdicionarMidia(room, ''), false);
});

test('quem só adiciona não ganha poder de reprodução', () => {
  const { room, visita } = salaComHost();
  // Este é o teste que importa: `podeAdicionarMidia` e `canControl` precisam
  // discordar. Se algum dia a primeira chamar a segunda, a sala perde o
  // sentido — e este teste falha.
  assert.equal(podeAdicionarMidia(room, visita.sessionId), true);
  assert.equal(canControl(room, visita.sessionId), false);
});

test('abrir o controle continua sendo o que dá play e pause para todos', () => {
  const { room, visita } = salaComHost();
  room.openControl = true;
  assert.equal(canControl(room, visita.sessionId), true);
});

test('o host sempre pode, independente de openControl', () => {
  const { room, host } = salaComHost();
  room.openControl = false;
  assert.equal(canControl(room, host.sessionId), true);
  // E o host é participante, claro: as duas permissões andam juntas.
  assert.equal(podeAdicionarMidia(room, host.sessionId), true);
});
