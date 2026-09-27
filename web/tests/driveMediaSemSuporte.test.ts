import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicarToken } from '@/lib/driveMedia';

/*
 * Este caso vive em arquivo próprio, e a razão é estrutural.
 *
 * O módulo cacheia a promise de `register()` — é isso que garante um worker só
 * por página, e o que impede o log `[drive] registration criada` de sair duas
 * vezes. O cache atravessa o `beforeEach` de um arquivo de teste, então um teste
 * que muda o `navigator` no meio da suíte deixa o módulo com o registro de outro
 * ambiente, e o teste seguinte recebe um motivo que não é o seu.
 *
 * Um motivo falso é pior do que um teste que não roda: faz o conserto parecer
 * testado quando não foi. Separar o arquivo isola o módulo, sem precisar de um
 * gancho de teste na produção.
 *
 * Aqui `navigator.serviceWorker` nunca é instalado, que é justamente a condição
 * que o caso exercita.
 */

test('sem service worker a publicação falha com o motivo, e sem tentar registrar', async () => {
  assert.equal('serviceWorker' in navigator, false, 'este arquivo não instala service worker');
  const resultado = await publicarToken('token-de-teste');
  assert.deepEqual(resultado, { ok: false, motivo: 'sem_suporte' });
});
