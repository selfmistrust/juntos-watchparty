import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * Spotify: o que esta fonte não pode fazer.
 *
 * ## Por que quase tudo aqui é negativo
 *
 * A Spotify é a única fonte do app em que o caminho fácil é o errado. Existe
 * URL de preview, existe endpoint de playback, e existe sempre alguém disposto a
 * montar um proxy que "só passa o áudio". As quatro asserções mais duras deste
 * arquivo existem para que ninguém tenha essa ideia depois:
 *
 *   - a fila **não** guarda URL de áudio, porque não existe
 *   - o playback **não** chama a Web API direto, porque o único caminho que o
 *     Spotify autoriza é o player do SDK
 *   - os scopes **não** incluem escrita na biblioteca, porque o app escolhe
 *     músicas e não mexe no que a pessoa salvou
 *   - o refresh token **não** vai para o navegador
 *
 * Nenhuma dessas é uma escolha de estilo. As três primeiras são o contrato do
 * Spotify, e a quarta é a diferença entre uma hora de exposição e acesso
 *MqMn à conta.
 */
const provider = readFileSync(resolve(process.cwd(), '../web/lib/mediaSources/spotify.tsx'), 'utf8');
const playback = readFileSync(resolve(process.cwd(), '../web/lib/spotifyPlayback.ts'), 'utf8');
const oauth = readFileSync(resolve(process.cwd(), '../server/src/spotifyOAuth.ts'), 'utf8');
const rotas = readFileSync(resolve(process.cwd(), '../server/src/spotifyRoutes.ts'), 'utf8');
const modal = readFileSync(resolve(process.cwd(), '../web/components/media/MediaSourceModal.tsx'), 'utf8');
const painel = readFileSync(resolve(process.cwd(), '../web/components/media/SpotifyPanel.tsx'), 'utf8');
const tipos = readFileSync(resolve(process.cwd(), '../web/types/index.ts'), 'utf8');

function semComentario(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('o card do Spotify e o mesmo card dos outros', () => {
  /*
   * O modal desenha tudo por `SourceCard`, que não conhece a fonte. Então a
   * prova de que o Spotify entrou no layout igual é que o provider **não** traz
   * layout nenhum: só id, nome, descrição, ícone e cor. Qualquer classe de
   * espaçamento aqui dentro seria um card com formato diferente na mesma grade.
   */
  const c = semComentario(provider);
  const chaves = [...c.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(
    chaves,
    ['id', 'name', 'description', 'icon', 'accent'],
    'o provider so declara id, name, description, icon e accent: layout e do modal',
  );
  assert.ok(!/className/.test(c), 'e nenhuma classe: quem estiliza e o SourceCard');
});

test('o Spotify entra no fim da grade, sem mexer na ordem dos outros', () => {
  /*
   * A grade é de duas colunas e tinha cinco cards — um ímpar deixava a última
   * linha com um buraco. Acrescentar no fim fecha a linha; inserir no meio
   * trocaria de lugar o Drive e a Globoplay, e quem sabe de cabeça onde fica
   * cada fonte teria que procurar de novo.
   */
  const pos = modal.indexOf('.concat([spotify.provider])');
  assert.ok(pos !== -1, 'o Spotify precisa entrar por concat, e nao dentro do flatMap');
  const flatMap = modal.slice(modal.indexOf('MEDIA_SOURCES.flatMap'), pos);
  assert.ok(
    !flatMap.includes('spotify'),
    'e nenhum dos cards existentes pode passar a提到 o Spotify, que mudaria a ordem',
  );
  assert.ok(
    modal.indexOf('{spotify.panel}') !== -1,
    'o painel entra na lista de paineis, como o do YouTube e o do Drive',
  );
});

test('a fila nao guarda URL de audio do Spotify', () => {
  /*
   * `src` vazio, sempre. O Spotify nao tem URL de audio: o som vem do Web
   * Playback SDK. Um `src` aqui seria uma URL que nao existe, e o player cairia
   * num caminho de `<video>` que nunca vai tocar — com a faixa "carregando" para
   * sempre e nenhum erro.
   */
  const c = semComentario(painel);
  assert.match(
    c,
    /addToPlaylist\(\{\s*kind: 'spotify',\s*src: '',/,
    'o item entra com src vazio',
  );
  assert.ok(
    !/https:\/\/open\.spotify\.com/.test(c),
    'e nunca com uma URL do open.spotify.com, que nao serve audio',
  );
  assert.match(
    tipos,
    /spotifyUri\?: string;/,
    'a referencia da faixa viaja no spotifyUri, que e um identificador e nao um endereco',
  );
});

test('o playback nao chama a Web API do Spotify por fora do SDK', () => {
  /*
   * `PUT /me/player/play` com o token da pessoa no navegador seria um segundo
   * caminho de audio, fora do SDK -- que e o unico que o Spotify autoriza. E
   * seria desnecessario: a fila e de faixas, uma a uma, e `playTrack` do SDK
   * faz isso.
   */
  const c = semComentario(playback);
  assert.ok(
    !/api\.spotify\.com/.test(c),
    'nenhuma chamada direta a api.spotify.com dentro do playback',
  );
  assert.ok(!/me\/player\/play/.test(c), 'e em especial nenhum PUT /me/player/play');
  assert.match(c, /player\.playTrack\(id\)/, 'o audio entra pelo playTrack do SDK');
});

test('os scopes nao permitem escrever na biblioteca da pessoa', () => {
  /*
   * O app escolhe musicas para a sala. Ele nao cria playlist, nao salva faixa e
   * nao mexe no que a pessoa ja tinha. A lista de scopes e curta **por isso**:
   * sem `playlist-modify-private` e sem `user-library-modify`, e literalmente
   * impossivel para este codigo tocar na biblioteca.
   */
  const c = semComentario(oauth);
  const linhaScope = c.match(/const SCOPE = \[[^\]]*\]/);
  assert.ok(linhaScope, 'a lista de scopes precisa ser explicita, e nao uma string solta');
  assert.ok(!/playlist-modify/.test(c), 'sem permissao de modificar playlist');
  assert.ok(!/user-library-modify/.test(c), 'sem permissao de modificar a biblioteca');
  assert.ok(!/user-follow-modify/.test(c), 'e sem seguir gente em nome da pessoa');
  assert.match(linhaScope[0], /streaming/, 'com `streaming`, que e o que reproduz');
});

test('o refresh token nao sai do servidor', () => {
  /*
   * O Web Playback SDK chama `getOAuthToken` **na pagina**, entao o access token
   * tem que chegar ao navegador e nao ha como evitar. O refresh token nao
   * precisa, e ele e o que da acesso a conta. A rota `/access-token` devolve so
   * `token`.
   */
  const cRotas = semComentario(rotas);
  const rota = cRotas.slice(
    cRotas.indexOf("'/api/spotify/access-token'"),
    cRotas.indexOf("'/api/spotify/search'"),
  );
  assert.match(rota, /res\.json\(\{ token: result\.token \}\)/, 'a rota devolve so o token');
  assert.ok(
    !/refreshToken/.test(rota),
    'e nenhum refresh token atravessa essa rota: ele fica em encryptSecret no Redis',
  );
  assert.match(oauth, /encryptSecret\(JSON\.stringify\(record\)\)/, 'o token e guardado cifrado');
});

test('o uri do catalogo e validado antes de virar proxy', () => {
  /*
   * A rota de faixas recebe um `uri` do cliente e o costura numa URL da Web API.
   * Sem a trava, ela seria um proxy SSRF generico com a credencial da pessoa.
   */
  const c = semComentario(rotas);
  assert.match(
    c,
    /\^spotify:\(album\|playlist\):\[A-Za-z0-9\]\+\$/,
    'so album e playlist, e so com ids do Spotify',
  );
});

test('o premium nao e decidido pelo /me', () => {
  /*
   * A Web API devolve `product: "premium"` para Spotify Lite e Premium Mini, que
   * sao planos so de celular e nao reproduzem. Tratar esse campo como prova faria
   * o card prometer audio que a conta nao pode entregar.
   */
  const cPlayback = semComentario(playback);
  assert.match(
    cPlayback,
    /premium_necessario/,
    'o motivo premium_necessario existe e vem do SDK',
  );
  assert.match(
    cPlayback,
    /escutar\('account_error'/,
    'e ele e disparado pelo account_error do player, nao pelo /me',
  );
  /*
   * A verificação final é no texto **com** comentários, e não em `semComentario`:
   * a afirmação é justamente sobre um comentário, e comentário não sobrevive a
   * quem tira comentário. Foi o que fez este teste falhar na primeira vez.
   */
  const bruto = readFileSync(resolve(process.cwd(), '../web/lib/spotifyAccount.ts'), 'utf8');
  assert.match(
    bruto,
    /Não é prova de Premium/,
    'e o cliente registra em comentario que o product nao prova Premium',
  );
});
