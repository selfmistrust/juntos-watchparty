import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * A versão do app desktop tem uma fonte só.
 *
 * ## O defeito que este arquivo previne
 *
 * A versão estava escrita à mão em dois lugares que não conversam: o
 * `package.json`, que o `electron-builder` usa para nomear o instalador, e uma
 * string no preload, que é o que a janela anunciaria.
 *
 * A divergência era silenciosa e sem nenhum aviso. Subir o `package.json` para
 * 1.0.1 gerava `Juntos Setup 1.0.1.exe` e uma janela que se dizia 1.0.0 — e o
 * número que diverge é justamente o que a pessoa usa para dizer qual build
 * está instalada quando algo dá errado. Pior, o main já tinha um handler
 * `desktop:versao` devolvendo `app.getVersion()` que **ninguém chamava**: o
 * código certo existia, desligado, ao lado do errado em uso.
 */
const raiz = resolve(process.cwd(), '..');
const preload = readFileSync(resolve(raiz, 'desktop/electron/preload/index.ts'), 'utf8');
const main = readFileSync(resolve(raiz, 'desktop/electron/main/index.ts'), 'utf8');
const pkg = readFileSync(resolve(raiz, 'desktop/package.json'), 'utf8');

/** Tira comentarios de bloco e de linha, para medir codigo e nao prosa. */
function codigo(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('nenhuma versao escrita a mao no preload', () => {
  /*
   * A string literal e o defeito. Qualquer `version: '1.0.x'` aqui e uma
   * segunda fonte, e a segunda fonte e sempre a que fica velha.
   */
  const semComentario = codigo(preload);
  assert.ok(
    !/version:\s*['"]\d+\.\d+\.\d+['"]/.test(semComentario),
    'a versao do preload nao pode ser literal: ela tem de vir do processo principal',
  );
  assert.match(
    semComentario,
    /version:\s*ipcRenderer\.sendSync\('desktop:versao'\)/,
    'e tem de ser lida pelo canal que o main atende',
  );
});

test('o canal da versao existe dos dois lados', () => {
  /*
   * O handler morto é o detalhe que faz este arquivo existir. Ele estava
   * registrado como `ipcMain.handle`, que só responde a `invoke` — e o preload
   * nunca invocava. Registrar o canal num lado e não no outro é o modo mais
   * barato de um `sendSync` quebrar: ele devolve `undefined` e a versão some da
   * tela sem erro nenhum.
   */
  const semComentario = codigo(main);
  assert.match(
    semComentario,
    /ipcMain\.on\('desktop:versao'/,
    'o main precisa atender o canal com on, porque o preload usa sendSync',
  );
  assert.match(semComentario, /evento\.returnValue = app\.getVersion\(\)/, 'e devolver a versão real');
  assert.ok(
    !/ipcMain\.handle\('desktop:versao'/.test(semComentario),
    'handle nao responde a sendSync e deixaria o canal sem resposta',
  );
});

test('o package.json e a unica versao escrita', () => {
  const versao = JSON.parse(pkg) as { version: string };
  assert.match(versao.version, /^\d+\.\d+\.\d+$/, 'a versao do app precisa ser semver simples');

  /*
   * `electron-builder` tira o nome do instalador daqui, então o nome do arquivo
   * e a versão mostrada precisam ser o mesmo número. Isto não prova que o
   * empacotamento deu certo — prova que as duas pontas da conversa não podem
   * divergir por construção.
   */
  assert.ok(
    !new RegExp(`${versao.version.replace(/\./g, '\\.')}\\b[^\\n]*['"]\\d+\\.\\d+\\.\\d+['"]`).test(
      codigo(preload),
    ),
    'o preload nao pode mencionar outra versao que nao a do package.json',
  );
});
