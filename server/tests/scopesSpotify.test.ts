import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * `spotifyOAuth.ts` importa o Redis, e o cliente real tentaria conectar em
 * `127.0.0.1:1` — o mesmo endereço recusado do resto da suíte, e que faz o
 * processo pendurar em retry. O módulo é importado **depois** do desligamento.
 */
process.env.REDIS_URL = 'redis://127.0.0.1:1';
const { redis, pubClient, subClient } = await import('../src/redis.js');
for (const cliente of [redis, pubClient, subClient]) cliente.disconnect();

const { escoposConhecidos, escoposFaltandoDoRegistro, SCOPES_NECESSARIOS } = await import(
  '../src/spotifyOAuth.js'
);

/**
 * Escopos lidos do **registro**, e não do token.
 *
 * ## O que mudou, e por que a versão anterior estava errada
 *
 * A primeira implementação lia o escopo decodificando o access token como JWT —
 * `split('.')`, `atob`, `JSON.parse` — e o `spotify_scope_ilegivel` nasceu de uma
 * falha dessa decodificação. Duas coisas estavam erradas ali.
 *
 * A primeira é que o Spotify **já entrega** o que concedeu: o campo `scope` na
 * resposta de `POST /api/token`. Guardar esse campo é verificável, porque é a
 * resposta da API. Inferir escopo a partir da forma do payload de um token é
 * palpite — e o token é opaco por contrato, justamente para que a API possa
 * mudar a Representação interna sem quebrar quem a consome.
 *
 * A segunda é que `[]` era usado para três coisas diferentes: "concederam zero
 * escopos", "não consegui ler o token" e "registro gravado antes do campo
 * existir". As três precisam de respostas diferentes, e uma lista vazia não
 * distingue nenhuma. Agora o "não sei" é `null`, e é o que pede uma reconexão.
 *
 * ## O que a assinatura nunca teve a ver
 *
 * A implementação antiga também não verificava assinatura, de propósito. Isso
 * continua verdade, e deixou de ser questão: não há mais nada assinado para
 * ler.
 */

const comScopes = (scopes: string[]) => ({ scopes }) as { scopes?: string[] };

test('le os escopos que o Spotify concedeu, gravados no registro', () => {
  assert.deepEqual(
    escoposConhecidos(comScopes(['streaming', 'user-read-email', 'user-read-private'])),
    ['streaming', 'user-read-email', 'user-read-private'],
  );
});

test('os escopos concedidos batem com os que a integração pede', () => {
  const faltando = escoposFaltandoDoRegistro(comScopes(SCOPES_NECESSARIOS));
  assert.deepEqual(
    faltando,
    [],
    'um escopo pedido e nao concedido e exatamente o que produz um 403 sem explicacao',
  );
});

test('escopo ausente e diferente de escopo desconhecido', () => {
  /*
   * A distinção inteira. Os dois casos pedem a mesma ação — uma reconexão — e é
   * por isso que a resposta é a mesma. O que muda é o que se pode afirmar, e
   * afirmar é o que tem sido o problema: "não tem escopo" é uma conclusão, e
   * "não sei o que tem" é o estado do conhecimento.
   */
  // Registro antigo: gravado antes do campo `scopes` existir. Não se assume que tem.
  assert.equal(escoposConhecidos({} as { scopes?: string[] }), null);
  assert.equal(escoposConhecidos(comScopes(undefined as unknown as string[])), null);
  assert.equal(escoposConhecidos(null), null);
  /*
   * E a consequência: um registro antigo não pode passar como se tivesse tudo, o
   * que faria o Spotify recusar com um 403 que ninguém soube antecipar.
   */
  assert.deepEqual(
    escoposFaltandoDoRegistro({} as { scopes?: string[]}),
    [...SCOPES_NECESSARIOS],
    'sem escopos registrados, tudo falta por precaution — e a reconexao preenche',
  );
});

test('escopo vazio e um escopo ausente, nao um escopo desconhecido', () => {
  /*
   * `[]` é o Spotify ter respondido sem nenhum escopo. Isso é conhecimento, não
   * falta de informação, e tratá-lo como "não sei" mandaria a pessoa reconectar
   * um token que ela jáutely não pode reproduce.
   */
  assert.deepEqual(escoposConhecidos(comScopes([])), []);
  assert.deepEqual(escoposFaltandoDoRegistro(comScopes([])), [...SCOPES_NECESSARIOS]);
});

test('o token nao e lido, e isso e garantido por teste', () => {
  /*
   * A forma antiga quebrava em silêncio: um `atob` que falha vira `[]`, e `[]`
   * entra na conta como "sem escopo". A regra agora é estrutural — não existe
   * mais função que decodifique o token — e este teste trava a regra, porque um
   * teste que afirma o resultado deixaria passar a reintrodução do defeito.
   */
  const fonte = readFileSync(resolve(process.cwd(), 'src/spotifyOAuth.ts'), 'utf8');
  const semComentario = fonte
    .replace(/(^|[\s'"`(])(\/\/[^\n]*)/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  for (const proibido of ['atob', 'base64url).toString', "split('.')", 'scopesDoToken']) {
    assert.ok(
      !semComentario.includes(proibido),
      `${proibido} nao pode voltar: o access token e opaco, e o escopo vem do endpoint de token`,
    );
  }
});

test('o pedido de escopo nao inclui escrita na biblioteca da pessoa', () => {
  /*
   * Já é coberto por `spotifyFonte.test.ts` no lado do web. Aqui é a lista que o
   * servidor manda de verdade, que é a que o Spotify avalia — e as duas podem
   * divergir sem nenhum aviso, já que uma é constante em cada projeto.
   */
  for (const perigoso of [
    'playlist-modify-private',
    'playlist-modify-public',
    'user-library-modify',
    'user-follow-modify',
  ]) {
    assert.ok(
      !SCOPES_NECESSARIOS.includes(perigoso),
      `${perigoso} nao pode estar no pedido: o app escolhe musica, nao mexe na biblioteca`,
    );
  }
});

test('o token guardado traz os escopos e a renovacao nao apaga', () => {
  /*
   * `completeOAuth` grava o `scope` da resposta do endpoint de token, e a
   * renovação só sobrescreve quando o Spotify devolve `scope`.
   *
   * A segunda metade é o detalhe que apaga tudo se estiver errado: o Spotify pode
   * omitir `scope` numa renovação, porque o token novo nasce com os mesmos
   * escopos do antigo. Tratar a omissão como lista vazia perderia, a cada hora,
   * a informação de escopo de uma conta perfeitamente autorizada — e o sintoma
   * seria "o Spotify precisa de uma nova autorização" para quem acabou de
   * autorizar.
   */
  const fonte = readFileSync(resolve(process.cwd(), 'src/spotifyOAuth.ts'), 'utf8');

  const gravando = fonte.slice(fonte.indexOf('await saveTokens(params.sessionId'));
  assert.match(
    gravando,
    /scopes: \(token\.scope \?\? ''\)\.split\(' '\)/,
    'o registro recebe o scope concedido, e nao o scope pedido',
  );
  assert.match(gravando, /filter\(Boolean\)/, 'e spaces sobrando nao viram escopo vazio na lista');

  const renovando = fonte.slice(fonte.indexOf('const refreshed: TokenRecord'));
  assert.match(
    renovando,
    /scopes: token\.scope[\s\S]{0,200}?\?\s*token\.scope\.split[\s\S]{0,200}?:\s*record\.scopes/,
    'a renovacao so sobrescreve quando o Spotify devolve scope; silencio nao e revogacao',
  );
});
