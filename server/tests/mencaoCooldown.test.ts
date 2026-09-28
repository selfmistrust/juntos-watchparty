import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limparMencoes, podeTocarMencao } from '../src/chatGuard';

/*
 * O cooldown de menção.
 *
 * ## O que este arquivo protege
 *
 * A pessoa citada. Sem o limite, qualquer mensagem com `@Nome` tocaria o som na
 * máquina dela — e "qualquer mensagem" inclui alguém segurando o `@` e
 * mandando mensagem atrás de mensagem, que é a forma mais barata de transformar
 * uma sala em lugar insuportável.
 *
 * Por isso o limite é por **par** remetente→citado, e não por remetente. Com
 * limite por remetente, bastariam duas pessoas se alternando para manter o som
 * de alguém tocando sem parar, e a vítima do som não teria como escapar: o
 * número de pessoas na sala é o que amplifica, não a origem.
 *
 * ## Por que cooldown e não janela deslizante
 *
 * A pessoa citada precisa de um silêncio de verdade entre um toque e o
 * seguinte, para conseguir ler e responder. Janela deslizante conta eventos;
 * aqui o que importa é o intervalo.
 *
 * ## Cada teste usa ids próprios, e isso é obrigatório
 *
 * O `Map` de carimbos é estado de **módulo** e sobrevive a todos os testes deste
 * arquivo. A primeira versão reaproveitava `a`→`b` em dois testes, e o segundo
 * falhava por causa do primeiro — não por defeito do cooldown, mas porque um
 * teste contaminou o próximo. O sintoma de um teste que falha sozinho e passa
 * na suíte é quase sempre isso.
 */

/** Socket_ids únicos por teste, para o `Map` de módulo não vazar de um para o outro. */
function pares(nomes: string[]): string[] {
  return nomes.map((n) => `${n}-${Math.random().toString(36).slice(2, 10)}`);
}

test('o primeiro toque passa e o segundo não', () => {
  const [de, para] = pares(['de', 'para']);
  assert.equal(podeTocarMencao(de, para), true, 'o primeiro toque é livre');
  assert.equal(podeTocarMencao(de, para), false, 'o segundo, logo em seguida, é barrado');
  assert.equal(podeTocarMencao(de, para), false, 'e continua barrado');
});

test('o limite é por par, e não por remetente', () => {
  /*
   * O caso que justifica o desenho. Um teto por remetente não resolveria:
   * bastariam duas pessoas se alternando para manter o som de alguém tocando.
   */
  const [alvo, a, b, c] = pares(['alvo', 'a', 'b', 'c']);
  assert.equal(podeTocarMencao(a, alvo), true);
  assert.equal(podeTocarMencao(b, alvo), true, 'outro remetente ainda pode, e isso é o problema');
  assert.equal(podeTocarMencao(c, alvo), true);

  // Cada um dos três já gastou o seu toque naquele par:
  assert.equal(podeTocarMencao(a, alvo), false);
  assert.equal(podeTocarMencao(b, alvo), false);
  assert.equal(podeTocarMencao(c, alvo), false);
});

test('um par não bloqueia os outros', () => {
  /*
   * Sem isto, citar alguém que te mencionou antes deixaria você sem poder
   * mencionar de volta, e o efeito seria "menção funciona uma vez por pessoa
   * para sempre" — o que ninguém entenderia.
   */
  const [a, b, c, d] = pares(['a', 'b', 'c', 'd']);
  assert.equal(podeTocarMencao(a, b), true);
  assert.equal(podeTocarMencao(a, c), true, 'outro citado não é afetado');
  assert.equal(podeTocarMencao(a, d), true);
});

test('mencionar a si mesmo tem par próprio e não trava os outros', () => {
  const [a, b] = pares(['a', 'b']);
  assert.equal(podeTocarMencao(a, a), true);
  assert.equal(podeTocarMencao(a, a), false);
  assert.equal(podeTocarMencao(a, b), true, 'o par com a si mesmo não afeta o resto');
});

test('a limpeza apaga os dois lados do par', () => {
  /*
   * Duas varreduras, e a segunda é a que ninguém lembra: as menções **feitas
   * para** o socket que saiu também ocupam memória, e a chave delas começa pelo
   * **outro** remetente. Limpar só pelo prefixo deixaria o `Map` crescendo com
   * uma entrada por par, e watch party tem gente entrando e saindo a noite
   * toda.
   */
  podeTocarMencao('saiu', 'fica');
  podeTocarMencao('fica', 'saiu');

  limparMencoes('saiu');

  // O par cujo remetente saiu foi limpo:
  assert.equal(podeTocarMencao('saiu', 'fica'), true, 'quem saiu pode tocar de novo');
  // E o par cujo citado saiu também:
  assert.equal(podeTocarMencao('fica', 'saiu'), true, 'e quem citou o que saiu também');
});

test('a limpeza não mexe nos pares de terceiros', () => {
  podeTocarMencao('x', 'y');
  limparMencoes('z');
  assert.equal(
    podeTocarMencao('x', 'y'),
    false,
    'sair outra pessoa não pode liberar o toque de quem continua na sala',
  );
});
