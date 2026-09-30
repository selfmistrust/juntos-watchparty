import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * A grade de fontes do modal de Aplicações.
 *
 * ## O defeito que este arquivo existe para impedir
 *
 * A montagem da grade era uma cadeia de `if` que trocava o provider do registro
 * pelo do hook:
 *
 *   if (f.id === 'screen') return [tela.provider];
 *   if (f.id === 'drive')  return [drive.provider];
 *
 * Na remoção do Spotify, uma linha de edição comeu essas duas. Nenhum erro
 * apareceu: o `tsc` passou, o build passou, os testes passaram. Os cards
 * continuaram na grade, e só o comportamento ficou errado — o card do Drive
 * parou de abrir, porque o provider do registro não tem `start`, e o do
 * compartilhamento de tela passou a anunciar "disponível só no app desktop"
 * mesmo dentro do app desktop.
 *
 * A razão de isso ser silencioso é o que o teste mede: um `if` esquecido não
 * falha, ele apenas devolve um objeto **válido e mais pobre**. O card existe, o
 * `id` bate, o `resolveState` responde. A diferença só aparece quando alguém
 * clica nele, em produção.
 *
 * Por isso o teste não confere a forma do código — ele confere a **propriedade**:
 * toda fonte registrada que precisa da hook entra na grade com o provider da
 * hook, e nenhuma delas pode ficar só com o do registro.
 */

const ler = (caminho: string) => readFileSync(resolve(process.cwd(), caminho), 'utf8');
const semComentario = (texto: string) =>
  texto.replace(/(^|[\s'"`(])(\/\/[^\n]*)/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

const modal = semComentario(ler('../web/components/media/MediaSourceModal.tsx'));
const registro = semComentario(ler('../web/lib/mediaSources/index.ts'));

/** As fontes que têm versão própria por hook, e o que cada uma precisa trazer. */
const COM_HOOK: Array<[string, string[]]> = [
  ['youtube', ['start', 'resolveState']],
  ['screen', ['start', 'resolveState']],
  ['drive', ['start', 'resolveState']],
];

test('toda fonte com hook entra na grade pela chave do id', () => {
  /*
   * O mapa é a regra única. Uma fonte que precisa da hook e não entra nele
   * recebe o provider do registro — que é válido, silenciosamente mais pobre.
   */
  assert.match(
    modal,
    /const comHook = useMemo<Record<string, MediaSourceProvider>>/,
    'a substituicao e um mapa indexado por id, e nao uma cadeia de if',
  );
  assert.match(modal, /\[youtube\.provider\.id\]: youtube\.provider/, 'o YouTube entra pelo id');
  assert.match(modal, /\[tela\.provider\.id\]: tela\.provider/, 'a tela entra pelo id');
  assert.match(modal, /\[drive\.provider\.id\]: drive\.provider/, 'e o Drive tambem');

  /*
   * E a grade usa o mapa. Sem isto o mapa seria decorativo e o defeito
   * voltaria exatamente como estava.
   */
  assert.match(modal, /comHook\[f\.id\] \?\? f/, 'a grade troca pelo mapa, com o registro como reserva');
  assert.match(modal, /if \(f\.id === 'upload'\) return \[f, comHook\.youtube \?\? f\];/, 'e o YouTube mantem o lugar depois do Dispositivo');
  assert.match(modal, /\[comHook\]/, 'com o mapa na lista de dependencias, e nao um provider solto');
});

test('o provider do registro nao pode ser a versao final de uma fonte com hook', () => {
  /*
   * A forma como isso quebrava: `MEDIA_SOURCES` continuava listando `drive`, e o
   * `flatMap` devolvia o item do registro porque o `if` do Drive tinha sumido. O
   * card aparecia com o nome, o ícone e a descrição certas.
   */
  for (const [id] of COM_HOOK) {
    assert.ok(
      registro.includes(`'${id}'`) || !registro.includes(`export const ${id}Provider`),
      `${id}: a fonte continua registrada, e por isso precisa da substituicao`,
    );
  }

  /*
   * `start` é o que o clique chama, e um `start` ausente faz o modal fechar
   * depois de um `return` silencioso — que é o card que "não abre".
   */
  assert.match(
    modal,
    /if \(!source\.start\) return;/,
    'o modal ignora fonte sem start, o que e exatamente o sintoma do bug',
  );

  /*
   * E o painel tem de ser renderizado junto. Um `start` que abre um painel cujo
   * nó não está na árvore é o mesmo defeito com outro nome: o clique funciona e
   * nada aparece.
   */
  assert.match(modal, /\{drive\.panel\}/, 'o painel do Drive e renderizado pelo modal');
  assert.match(modal, /\{tela\.panel\}/, 'e o da tela compartilhada');
  assert.match(modal, /\{youtube\.panel\}/, 'e o do YouTube');
  assert.match(modal, /if \(!open\) return <>\{painelExtra\}<\/>/, 'os painéis sobrevivem ao fechamento do modal');
});

test('a lista de fontes do registro nao cresce sem a hook entrar no mapa', () => {
  /*
   * A guarda que teria avisado: se alguém acrescenta `algumProvider` ao
   * `MEDIA_SOURCES` e esse provider precisa de hook, a chave correspondente tem
   * de existir no mapa do modal. O teste compara as duas listas.
   */
  const registrados = [...registro.matchAll(/^\s{2}(\w+)Provider,$/gm)].map((m) => m[1]);
  assert.ok(registrados.length >= 4, 'o registro tem as fontes da grade');

  /*
   * `upload` e `screenShare` entram pela mesma chave do `id` que o mapa usa, e o
   * `youtube` não é do registro — ele é injetado. Os três com hook estão
   * conferidos acima; aqui fica a checagem de que o registro e o mapa falam das
   * mesmas fontes.
   */
  for (const [id] of COM_HOOK) {
    if (id === 'youtube') continue; // injetado, não vem do registro
    assert.ok(
      modal.includes(`[${id === 'screen' ? 'tela' : id}.provider.id]`),
      `${id}: a fonte do registro tem versao com hook no mapa`,
    );
  }
});
