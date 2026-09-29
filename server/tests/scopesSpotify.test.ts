import assert from 'node:assert/strict';
import { test } from 'node:test';

/*
 * `spotifyOAuth.ts` importa o Redis, e o cliente real tentaria conectar em
 * `127.0.0.1:1` — o mesmo endereço recusado do resto da suíte, e que faz o
 * processo pendurar em retry. O módulo é importado **depois** do desligamento.
 */
process.env.REDIS_URL = 'redis://127.0.0.1:1';
const { redis, pubClient, subClient } = await import('../src/redis.js');
for (const cliente of [redis, pubClient, subClient]) cliente.disconnect();

const { scopesDoToken, SCOPES_NECESSARIOS } = await import('../src/spotifyOAuth.js');

/**
 * Leitura de escopos a partir do JWT.
 *
 * ## O bug que motivou isto
 *
 * O painel dizia "conectado" e a busca recebia 403 do Spotify. Os dois lados
 * estavam certos: o token existia no Redis, e o Spotify negava o endpoint. O que
 * o painel mostrava vinha do `/me` feito na hora da conexão — e o `/me` responde
 * para o token antigo mesmo quando o consentimento mudou.
 *
 * A busca usa o token **novo**. O campo `scope` do JWT é a única fonte que diz o
 * que este token pode fazer, e sem ela a causa de um 403 fica invisível: o
 * navegador mostra só o status, o log mostra só o status, e o painel mostra
 * "conectado".
 *
 * ## A assinatura não é verificada
 *
 * De propósito. Isto é leitura de diagnóstico, não validação: o valor não sai do
 * servidor, e a lista de escopos é pública — está na URL de autorização que a
 * pessoa já aceitou uma vez. Verificar a assinatura aqui seria trabalho sem
 * quem pedisse.
 */

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

const jwt = (payload: unknown): string => `${b64({ alg: 'none' })}.${b64(payload)}.assinatura`;

test('le os escopos que o token carrega', () => {
  assert.deepEqual(
    scopesDoToken(jwt({ scope: 'streaming user-read-email user-read-private' })),
    ['streaming', 'user-read-email', 'user-read-private'],
  );
});

test('os escopos do token batem com os que a integração pede', () => {
  const concedidos = scopesDoToken(jwt({ scope: SCOPES_NECESSARIOS.join(' ') }));
  assert.deepEqual(
    SCOPES_NECESSARIOS.filter((s) => !concedidos.includes(s)),
    [],
    'um escopo pedido e nao concedido e exatamente o que produz um 403 sem explicacao',
  );
});

test('token sem escopo nenhum devolve lista vazia, e nao exception', () => {
  /*
   * A rota de diagnóstico responde mesmo quando o token é inútil — e uma exceção
   * aqui viraria um 500, que é justamente o que veio a substituted.
   */
  assert.deepEqual(scopesDoToken(jwt({ exp: 1 })), []);
  assert.deepEqual(scopesDoToken(jwt({})), []);
});

test('token invalido devolve lista vazia em vez de derrubar a chamada', () => {
  for (const invalido of ['', 'nao-e-jwt', 'a.b', 'a.b.c.d', '...', 'a..c']) {
    assert.deepEqual(scopesDoToken(invalido), [], `"${invalido}" deveria devolver lista vazia`);
  }
});

test('o pedido de escopo nao inclui escrita na biblioteca da pessoa', () => {
  /*
   * Já é coberto por `spotifyFonte.test.ts` no lado do web. Aqui é a lista que o
   * servidor manda de verdade, que é a que o Spotify avalia — e as duas podem
   * divergir sem nenhum aviso, já que uma é constante em cada projeto.
   */
  for (const perigoso of ['playlist-modify-private', 'playlist-modify-public', 'user-library-modify', 'user-follow-modify']) {
    assert.ok(
      !SCOPES_NECESSARIOS.includes(perigoso),
      `${perigoso} nao pode estar no pedido: o app escolhe musica, nao mexe na biblioteca`,
    );
  }
});
