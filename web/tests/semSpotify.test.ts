import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * A integração do Spotify foi removida do Juntos. Este arquivo existe para
 * impedir que ela volte sem decisão.
 *
 * ## A política, e por que ela chega tão longe
 *
 * O Spotify estava integrado como fonte de mídia: Web Playback SDK, OAuth,
 * `/api/spotify/*`, escopos, fila, estado e player. A Spotify Developer Policy
 * (III. Some prohibited applications) proíbe quatro das coisas que aquela
 * implementação fazia:
 *
 *   "Do not create any product or service which is integrated with streams or
 *    content from another service."
 *
 *   "Do not synchronize any sound recordings with any visual media, including any
 *    advertising, film, television program, slideshow, video, or similar content."
 *
 *   "Do not create any product or service which includes any non-interactive
 *    internet webcasting service. For example, you can't create an application
 *    which plays content from a single source to several simultaneous listeners."
 *
 *   "Do not permit any device or system to segue, mix, re-mix, or overlap any
 *    Spotify Content with any other audio content (including other Spotify
 *    Content)."
 *
 * E a Compliance Tips nomeia o caso do Juntos quase palavra por palavra:
 *
 *   "Synchronization: Syncing sound recordings accessed via the Spotify Platform
 *    with other recordings, lyrics, or video."
 *
 * O Juntos é uma sala de vídeo sincronizado. Entregar Spotify dentro disso acerta
 * as quatro de uma vez, e "cada pessoa usa a conta dela" não é a mesma coisa: a
 * proibição é sobre o que o produto faz com o som, não sobre quem tem a conta.
 *
 * O que sobrou é um link para o Spotify, que é a alternativa que a própria
 * Compliance Tips sugere ("linking to a playlist in Spotify where the user can
 * follow it manually") e que a Developer Policy exige para qualquer metadado
 * exibido ("must be accompanied by a link back to the applicable album, content
 * or playlist on the Spotify Service").
 */

const raiz = (caminho: string) => resolve(process.cwd(), caminho);
const ler = (caminho: string) => readFileSync(raiz(caminho), 'utf8');
const semComentario = (texto: string) =>
  texto.replace(/(^|[\s'"`(])(\/\/[^\n]*)/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

test('nao existe mais nenhum arquivo da integracao do Spotify', () => {
  /*
   * Lista fechada, e não uma varredura por "spotify" no nome: o nome de um
   * arquivo pode ser mudado, e o que não pode é a funcionalidade voltar com
   * outro nome. Os dois testes juntos fecham isso.
   */
  const removidos = [
    '../server/src/spotifyOAuth.ts',
    '../server/src/spotifyRoutes.ts',
    '../server/tests/scopesSpotify.test.ts',
    '../web/lib/spotifyAccount.ts',
    '../web/lib/spotifyPlayback.ts',
    '../web/lib/mediaSources/spotify.tsx',
    '../web/lib/mediaSources/useSpotifySource.tsx',
    '../web/hooks/useSpotifyAccount.tsx',
    '../web/components/media/SpotifyPanel.tsx',
    '../web/components/media/useSpotifyPanel.tsx',
    '../web/components/player/SpotifyStage.tsx',
    '../web/tests/spotifyFonte.test.ts',
    '../web/tests/spotifyBusca.test.ts',
    '../web/tests/spotify502.test.ts',
  ];
  for (const arquivo of removidos) {
    let existe = true;
    try {
      ler(arquivo);
    } catch {
      existe = false;
    }
    assert.equal(existe, false, `${arquivo} nao deveria existir: a integracao foi removida`);
  }
});

test('nenhum endpoint, escopo ou variavel do Spotify sobreviveu', () => {
  const fontes: Array<[string, string]> = [
    ['server/src/index.ts', ler('../server/src/index.ts')],
    ['server/src/types.ts', ler('../server/src/types.ts')],
    ['web/types/index.ts', ler('../web/types/index.ts')],
    ['web/pages/_app.tsx', ler('../web/pages/_app.tsx')],
    ['web/lib/mediaSources/index.ts', ler('../web/lib/mediaSources/index.ts')],
    ['web/components/media/MediaSourceModal.tsx', ler('../web/components/media/MediaSourceModal.tsx')],
    ['web/components/player/VideoStage.tsx', ler('../web/components/player/VideoStage.tsx')],
    ['web/components/player/PlayerControls.tsx', ler('../web/components/player/PlayerControls.tsx')],
  ];
  for (const [nome, texto] of fontes) {
    const c = semComentario(texto);
    for (const proibido of [
      '/api/spotify',
      'SPOTIFY_',
      'user-modify-playback-state',
      'streaming',
      'sdk.scdn.co',
      'Web Playback',
      'SpotifyStage',
      'useSpotifyAccount',
      'SpotifyAccountProvider',
      'spotifyUri',
      'playTrack',
    ]) {
      assert.ok(
        !c.includes(proibido),
        `${nome} ainda menciona "${proibido}": sobrou peca da integracao removida`,
      );
    }
  }
});

test('a fila nao tem mais o tipo de midia do Spotify', () => {
  /*
   * `MediaKind` estava com 'spotify' dos dois lados, servidor e web. Um item
   * antigo numa sala viva cairia num palco sem player e mostraria "Nenhum vídeo
   * na fila" para uma fila que tem uma faixa. As salas vivem na memória do
   * Render e morrem no deploy, então não há migração a fazer — mas o tipo não
   * pode continuar aceitando o valor.
   */
  for (const tipos of ['../server/src/types.ts', '../web/types/index.ts']) {
    const c = semComentario(ler(tipos));
    assert.ok(
      !/MediaKind\s*=\s*[^;]*'spotify'/.test(c),
      `${tipos} ainda aceita kind 'spotify'`,
    );
  }
  assert.match(
    semComentario(ler('../web/types/index.ts')),
    /MediaKind = 'youtube' \| 'file' \| 'stream' \| 'drive'/,
    'e o tipo ficou com as quatro fontes que continuam existindo',
  );
});

test('o Spotify que sobrou e um link, e ele diz que nao reproduz', () => {
  const c = semComentario(ler('../web/lib/mediaSources/spotifyLink.tsx'));
  const bruto = ler('../web/lib/mediaSources/spotifyLink.tsx');

  assert.match(c, /https:\/\/open\.spotify\.com/, 'aponta para o Spotify oficial');
  assert.match(
    c,
    /name: 'Abrir no Spotify'/,
    'e o nome do card diz abrir, e nao tocar',
  );
  assert.match(
    c,
    /não reproduz música do Spotify/,
    'e a descricao diz na frente que o Juntos nao reproduz',
  );
  assert.match(c, /fixedState: READY/, 'e nao ha servidor, token nem consulta nenhuma');
  assert.match(c, /openInSystemBrowser/, 'no desktop abre no navegador do sistema');
  assert.match(c, /noopener/, 'e na web abre sem dar acesso a opener');

  /*
   * A política de marca continua sem precisar de leitura: o card usa um ícone
   * genérico e não o logotipo do Spotify.
   */
  assert.ok(
    !/1DB954|viewBox="0 0 496 512"/.test(bruto),
    'o logotipo do Spotify nao e usado: assim as Branding Guidelines nao precisam ser lidas para isto',
  );
});

test('a justificativa da politica esta escrita onde o codigo vive', () => {
  /*
   * A remoção vai ser lida por alguém que só vai ver o diff. Se o porquê não
   * estiver no arquivo, a próxima pessoa volta com a mesma ideia e leva três
   * dias de player para o mesmo lugar.
   *
   * A comparação é feita sobre o texto normalizado, com o `*` de cada linha de
   * comentário removido antes de juntar os espaços. Uma citação quebrada em duas
   * linhas continua uma citação, e sem tirar o marcador o texto vira
   * "streams or * content from another service" -- que não é a frase de ninguém.
   * Um teste que exigisse a citação numa linha só só pegaria a formatação, e
   * não o conteúdo.
   */
  const bruto = ler('../web/lib/mediaSources/spotifyLink.tsx')
    .replace(/^[ \t]*\*[ \t]?/gm, '')
    .replace(/\s+/g, ' ');
  for (const citacao of [
    'Do not synchronize any sound recordings with any visual media',
    'several simultaneous listeners',
    'integrated with streams or content from another service',
    'Synchronization:',
  ]) {
    assert.ok(
      bruto.includes(citacao),
      `a citacao "${citacao}" sumiu do codigo que explica a decisao`,
    );
  }
});

test('as outras fontes continuam inteiras', () => {
  /*
   * A remoção mexeu em arquivos compartilhados: `MediaSourceModal`,
   * `VideoStage`, `PlayerControls`, `types` e o registro de fontes. Qualquer uma
   * delas podia ter derrubado o YouTube, o Drive, o upload ou a tela junto, e é
   * por isso que esta verificação existe.
   */
  const registro = semComentario(ler('../web/lib/mediaSources/index.ts'));
  for (const fonte of ['uploadProvider', 'driveProvider', 'globoplayProvider', 'screenShareProvider']) {
    assert.ok(registro.includes(fonte), `${fonte} sumiu do registro de fontes`);
  }

  const tipos = semComentario(ler('../web/types/index.ts'));
  for (const kind of ["'youtube'", "'file'", "'stream'", "'drive'"]) {
    assert.ok(tipos.includes(kind), `o tipo ${kind} sumiu de MediaKind`);
  }
  for (const campo of ['driveFileId', 'streamId', 'src', 'thumbnail', 'duration']) {
    assert.ok(tipos.includes(campo), `o campo ${campo} sumiu de PlaylistItem`);
  }

  const palco = semComentario(ler('../web/components/player/VideoStage.tsx'));
  for (const ramo of ["kind === 'youtube'", "kind === 'drive'", '<FilePlayer', '<YoutubePlayer', '<DriveVideo']) {
    assert.ok(palco.includes(ramo), `o palco perdeu o ramo ${ramo}`);
  }
  assert.ok(palco.includes('<EmptyStage'), 'e a fallback de item sem player continua la');

  const app = semComentario(ler('../web/pages/_app.tsx'));
  assert.ok(app.includes('YoutubeAccountProvider'), 'o provider do YouTube continua montado');
  assert.ok(app.includes('DriveAccountProvider'), 'e o do Drive tambem');
});
