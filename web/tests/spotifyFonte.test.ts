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

test('o icone do Spotify desenha o circulo e as tres curvas', () => {
  /*
   * Este teste existe por causa de um bug que só a medição de pixels pegou.
   *
   * O SVG de origem tem dois caminhos: o círculo com `fill="#1ed760"` e as três
   * curvas **sem `fill`**, o que as faz herdar o preto padrão do SVG. A primeira
   * versão deste componente copiou do Drive o `fill="none"` que o Drive usa no
   * `<svg>`, e como `fill` é herdado, `none` na raiz cascateou para o caminho
   * que não declara cor: o glifo virou só o círculo verde, sem as curvas.
   *
   * Nada disso quebra build, typecheck, lint ou teste. É o tipo de defeito que
   * passa inteiro e só aparece olhando a tela — e olhando a tela em cima de uma
   * faixa verde de 24px, o contorno some sem ninguém notar.
   *
   * Medido em canvas, antes e depois:
   *
   *   com fill="none" na raiz:   7136 verdes,    0 escuros
   *   com fill explicito no path: 5756 verdes, 1294 escuros
   *
   * A soma caiu porque as curvas agora cobrem parte do verde, que é o esperado.
   */
  const c = semComentario(provider);
  const svg = c.slice(c.indexOf('<svg'), c.indexOf('</svg>'));

  assert.ok(
    !/fill="none"/.test(svg.slice(0, svg.indexOf('>'))),
    'o <svg> nao pode ter fill="none": cascateia para os caminhos que nao declaram cor',
  );
  const caminhos = [...svg.matchAll(/<path\s+([^/>]*)\/>/g)].map((m) => m[1]);
  assert.equal(caminhos.length, 2, 'o glifo tem dois caminhos: o circulo e as curvas');
  for (const [i, attrs] of caminhos.entries()) {
    assert.match(
      attrs,
      /fill="#[0-9a-fA-F]{3,8}"/,
      `o caminho ${i} declara a propria cor, para nao depender do valor herdado`,
    );
  }
  assert.match(svg, /fill="#1ed760"/, 'o circulo e o verde da marca');
});

test('o icone do Spotify nao e achatado', () => {
  /*
   * O `viewBox` de origem e `0 0 496 512`: **nao e quadrado**. Num card o icone
   * ocupa uma caixa de tamanho fixo, e `width={size} height={size}` transformaria
   * o circulo em elipse. A altura sai da proporcao do viewBox, como o Drive faz
   * com os 800x741 dele.
   *
   * Medido com os atributos exatos do componente: 24 x 24.77, razao 0.969, contra
   * os 496/512 = 0.96875 do arquivo.
   */
  const c = semComentario(provider);
  const svg = c.slice(c.indexOf('<svg'), c.indexOf('</svg>'));
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  assert.ok(vb, 'o viewBox precisa vir do arquivo, para a proporcao nao ser adivinhada');
  const [, w, h] = vb.map(Number);
  assert.notEqual(w, h, `o viewBox ${vb[1]}x${vb[2]} nao e quadrado: a altura precisa sair da proporcao`);
  assert.match(
    svg,
    /height=\{size \* \(512 \/ 496\)\}/,
    'e a altura vem da proporcao do viewBox, e nao de um numero solto',
  );
});

test('o login do Spotify vai para o host do servidor, e nao para o site', () => {
  /*
   * Este teste existe por causa de um 404 real na primeira versão.
   *
   * O botão de conectar fazia `location.assign('/api/spotify/oauth/start')` — um
   * caminho **relativo**. O web está na Vercel e a API no Render, então o
   * navegador pedia a rota do servidor no site, que não existe lá. O botão
   * respondia 404, e a assinatura é idêntica à de um link quebrado: quem vê
   * aquilo não tem como saber que é o host errado em vez de OAuth falhando.
   *
   * A regra do projeto é uma só: `SERVER_URL`, de `@/lib/socket`. A primeira
   * versão do Spotify fez uma cópia da regra num `base()` local — que é
   * exatamente como os dois sites deixam de concordar em silêncio.
   */
  const conta = readFileSync(resolve(process.cwd(), '../web/hooks/useSpotifyAccount.tsx'), 'utf8');
  const cliente = readFileSync(resolve(process.cwd(), '../web/lib/spotifyAccount.ts'), 'utf8');

  const c = semComentario(conta);
  assert.match(
    c,
    /window\.location\.assign\(spotifyConnectUrl\(returnTo\)\)/,
    'o navegador segue a URL montada, e nao um caminho relativo',
  );
  assert.ok(
    !/location\.assign\('\/api\//.test(c),
    'nenhuma rota da API pode ser chamada com caminho relativo',
  );
  assert.ok(
    !/location\.(assign|href)\s*=\s*['"]\/api\//.test(c),
    'e nenhum location.href relativo para a API',
  );

  const cc = semComentario(cliente);
  assert.match(
    cc,
    /`\$\{SERVER_URL\}\/api\/spotify\/oauth\/start\?returnTo=\$\{encodeURIComponent\(returnTo\)\}`/,
    'a URL de login carrega o host do servidor e o destino de volta codificado',
  );
  assert.ok(
    !/function base\(\)/.test(cc),
    'e nao existe uma copia local da regra do host: SERVER_URL e a fonte unica',
  );
  assert.ok(
    !/NEXT_PUBLIC_SERVER_URL/.test(cc),
    'ler a variavel de novo aqui seria a segunda fonte, e a que divergiria',
  );
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
  /*
   * O corte é pela próxima rota **declarada**, e não por um nome fixo. A primeira
   * versão cortava em `'/api/spotify/search'`, e o teste passou a varrer a rota de
   * diagnóstico que foi inserida entre as duas — que devolve `temRefreshToken`,
   * uma variável booleana, e não o segredo. O teste acusou o acréscimo, não a
   * rota: o nome do fim era um detalhe, e a partir de agora ele é derivado.
   */
  const inicio = cRotas.indexOf("'/api/spotify/access-token'");
  assert.notEqual(inicio, -1, 'a rota de access-token precisa existir');
  const resto = cRotas.slice(inicio);
  const proxima = resto.slice(1).search(/\n\s*app\.(get|post)\(/);
  const rota = proxima === -1 ? resto : resto.slice(0, proxima + 1);

  assert.match(rota, /res\.json\(\{ token: result\.token \}\)/, 'a rota devolve so o token');
  assert.ok(
    !/refreshToken/.test(rota),
    'e nenhum refresh token atravessa essa rota: ele fica em encryptSecret no Redis',
  );
  assert.match(oauth, /encryptSecret\(JSON\.stringify\(record\)\)/, 'o token e guardado cifrado');
});

test('a rota de diagnostico devolve a forma do token, nunca o token', () => {
  /*
   * Existe porque um 403 do Spotify não aparece em lugar nenhum: o navegador
   * mostra só o status, o painel dizia "conectado", e o `/me` mente porque
   * responde para o token antigo. Os escopos do JWT são a única fonte que diz o
   * que este token pode fazer.
   *
   * A rota é pública — como todas as outras —, então a linha que a segura é esta:
   * o valor do access token não pode sair daqui, nem em parte.
   */
  const c = semComentario(rotas);
  const rota = c.slice(c.indexOf("'/api/spotify/token-info'"));
  assert.match(rota, /scopesDoToken\(record\.accessToken\)/, 'le os escopos do token');
  assert.ok(
    !/res\.json\(\{[^}]*token:\s*record\.accessToken/.test(rota),
    'e nunca responde com o access token da pessoa',
  );
  assert.ok(
    !/res\.json\(\{[^}]*refreshToken:\s*record\.refreshToken/.test(rota),
    'nem com o refresh token, mesmo que o nome do campo seja booleano em outro ponto',
  );
  assert.match(
    rota,
    /temRefreshToken:\s*Boolean\(record\.refreshToken\)/,
    'o refresh token aparece so como booleano, para dizer se existe',
  );
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
