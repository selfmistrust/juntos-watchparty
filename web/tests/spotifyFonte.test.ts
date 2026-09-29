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
    'e nenhum dos cards existentes pode passar a mencionar o Spotify, que mudaria a ordem',
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

test('o audio nunca passa pelo nosso servidor nem pelo navegador', () => {
  /*
   * Este teste estava escrito ao contrário, e foi ele que produziu o defeito.
   *
   * A versão anterior afirmava que `PUT /me/player/play` seria "um segundo caminho
   * de áudio, fora do SDK" e proibia a chamada. A conclusão estava errada: a via
   * documentada para carregar uma faixa no device do SDK **é** esse endpoint, o
   * corpo da requisição é um uri, e o som continua sendo entregue pelo player no
   * navegador. Proibir o endpoint deixou o player com
   * `Cannot perform operation, no list was loaded` — e a interface chamando isso
   * de "tocando".
   *
   * A propriedade que vale não é "não chamar o endpoint". É: nenhum áudio
   * atravessa esta aplicação. Nenhum byte, nenhuma URL de mídia, nenhum proxy.
   */
  const c = semComentario(playback);
  assert.ok(
    !/api\.spotify\.com/.test(c),
    'o cliente nunca fala direto com api.spotify.com: o token nao sai do servidor',
  );

  /*
   * O ponto que o teste antigo confiava poder medir é o corpo da requisição, e
   * ele tem que ser um uri. Um array de bytes aqui seria a linha em que esta
   * aplicação deixa de ser um cliente do Spotify e vira outra coisa.
   */
  const oauthC = semComentario(oauth);
  const play = oauthC.slice(oauthC.indexOf('export async function iniciarReproducao'));
  assert.match(play, /JSON\.stringify\(\{ uris: \[trackUri\] \}\)/, 'o corpo e um uri, nunca audio');
  assert.ok(
    !/r\.arrayBuffer|\.blob\(\)|Buffer\.from|base64/i.test(play),
    'e nenhuma leitura de corpo binario: nao existe download de audio',
  );

  const rotasC2 = semComentario(rotas);
  assert.ok(
    !/spotify.*proxy|stream.*spotify/i.test(rotasC2),
    'e nenhuma rota de proxy de midia do Spotify',
  );
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
   *
   * O limite de 1 a 64 caracteres foi acrescentado junto com o parse explicito:
   * `[A-Za-z0-9]+` aceitava qualquer tamanho, e a validação real — que é a de
   * `rotaDeContainer`, no modulo — ficava so na metade, num ponto onde a URL ja
   * estava sendo montada. As duas regras precisam dizer a mesma coisa, e o teste
   * confere as duas.
   */
  const c = semComentario(rotas);
  assert.match(
    c,
    /\^spotify:\(album\|playlist\):\[A-Za-z0-9\]\{1,64\}\$/,
    'a rota so aceita album e playlist, com id de 1 a 64 caracteres do Spotify',
  );
  const oauth = readFileSync(resolve(process.cwd(), '../server/src/spotifyOAuth.ts'), 'utf8');
  const modulo = semComentario(oauth);
  const rota = modulo.slice(modulo.indexOf('function rotaDeContainer'));
  assert.match(
    rota,
    /\^spotify:album:\(\[A-Za-z0-9\]\{1,64\}\)/,
    'e o modulo aceita a mesma faixa: as duas regras nao podem divergir',
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
    /\| 'premium'/,
    'o estado premium existe, e e distinto dos outros quatro',
  );
  assert.match(
    cPlayback,
    /escutar\('account_error',[\s\S]{0,200}?onEstado\('premium'\)/,
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

test('o palco nunca pede login para quem ja esta conectado', () => {
  /*
   * O defeito que a pessoa encontrou, e ele era um literal.
   *
   * `VideoStage` passava `conectado={false}` **fixo** para o palco, e o palco
   * respondia "Conecte sua conta do Spotify para ouvir" para alguém que tinha
   * acabado de buscar e enfileirar uma música com a conta conectada.
   *
   * A mensagem estava certa sobre o que o componente sabia — que era nada — e
   * errada sobre o mundo. É a forma mais cara de um texto fixo: mente com a
   * confiança de quem está medindo.
   */
  const palco = readFileSync(resolve(process.cwd(), '../web/components/player/VideoStage.tsx'), 'utf8');
  const c = semComentario(palco);

  assert.ok(
    !/conectado=\{false\}/.test(c),
    'nenhum conectado={false} fixo: o palco recebe o estado real',
  );
  assert.ok(
    !/reproduz=\{false\}/.test(c),
    'e nenhum reproduz={false} fixo, que era o outro literal',
  );
  assert.match(c, /estado=\{estadoDoPlayer\}/, 'o palco recebe o estado do player');
  assert.match(
    c,
    /const \{ estado: estadoDoPlayer \} = usePlayerSpotify\(\{/,
    'e o estado vem do hook, que e quem conversa com o SDK',
  );
  assert.match(
    c,
    /conectado: spotifyConectado/,
    'o hook recebe a conta do servidor, e nao um literal',
  );
  assert.match(
    c,
    /faixa: currentItem\?\.kind === 'spotify' \? currentItem\.spotifyUri : null/,
    'e a faixa que a sala esta tocando, para a reproducao comecar no ready',
  );
  /*
   * O texto de "conecte" só pode existir para o estado sem conta. Se a frase
   * volta a aparecer em qualquer outro estado, o defeito volta junto com ela —
   * e ele não volta sozinho, porque a tentação de simplificar os quatro
   * estados em um só é exatamente a que produziu o bug.
   */
  const texto = semComentario(playback).slice(semComentario(playback).indexOf('export function textoDoEstado'));
  assert.match(
    texto,
    /case 'sem_conta':[\s\S]{0,200}?Conecte sua conta do Spotify/,
    '"conecte sua conta" pertence so a sem_conta',
  );
  for (const [estado, marca] of [
    ['sem_token', 'Reconecte'],
    ['premium', 'Premium é necessário'],
    ['drm', 'não reproduz áudio'],
  ] as const) {
    assert.match(
      texto,
      new RegExp(`case '${estado}':[\\s\\S]{0,200}?${marca}`),
      `${estado} tem o seu proprio texto, e nao o de conectar`,
    );
  }
});

test('trocar de faixa nao desconta a conta', () => {
  /*
   * `usePlayerSpotify` monta o player uma vez, e só o `!conectado` — que vem de
   * `/api/spotify/status` — derruba a sessão. Um `account_error` do SDK muda o
   * estado de **reprodução** e mantém a conta conectada, e é essa separação que
   * impede o palco de pedir login depois de um erro de reprodução.
   */
  const palco = readFileSync(resolve(process.cwd(), '../web/components/player/SpotifyStage.tsx'), 'utf8');
  const c = semComentario(palco);
  const hook = c.slice(c.indexOf('export function usePlayerSpotify'));
  assert.match(
    hook,
    /if \(!opts\.conectado\) \{\s*setEstado\('sem_conta'\);/,
    'sem_conta e o unico caminho para o estado de conta',
  );
  assert.match(
    hook,
    /\[opts\.conectado\]/,
    'e a dependencia e a conta, nao a faixa nem a fila',
  );
  assert.ok(
    !/onEstado\('sem_conta'\)/.test(c.slice(c.indexOf('onEstado:'), c.indexOf('}, [opts.conectado]'))),
    'nenhum erro do SDK recai em sem_conta: premium e token tem estados proprios',
  );
});

test('os eventos do SDK sao tratados com estados proprios', () => {
  const c = semComentario(playback);
  for (const [evento, esperado] of [
    /*
     * `ready` leva a `pronto`, e nao a `tocando`. Um device conectado nao e uma
     * musica tocando: o `ready` nao afirma que ha faixa nem que ela comecou. A
     * versao anterior publicava `tocando` aqui, e o palco escrevia "Tocando pelo
     * Spotify" com `0:00 / 0:00` na barra e nenhum som.
     */
    ['ready', "'pronto'"],
    ['authentication_error', "'sem_token'"],
    ['account_error', "'premium'"],
    ['initialization_error', "'drm'"],
    ['autoplay_failed', "'autoplay'"],
  ] as const) {
    const bloco = c.slice(c.indexOf(`escutar('${evento}'`));
    const corpo = bloco.slice(0, bloco.indexOf('});'));
    assert.ok(corpo.length > 0, `${evento} precisa de um listener`);
    assert.match(corpo, new RegExp(`onEstado\\(${esperado}\\)`), `${evento} leva a ${esperado}`);
  }
  for (const evento of ['not_ready', 'playback_error', 'player_state_changed']) {
    assert.ok(c.includes(`escutar('${evento}'`), `${evento} tem listener`);
  }
  /*
   * `not_ready` também dispara quando o navegador suspende a aba, e o player
   * volta sozinho em alguns segundos. Traduzir isso para "não funciona aqui"
   * faria o palco mentir durante uma pausa de cinco segundos.
   */
  const nr = c.slice(c.indexOf("escutar('not_ready'"), c.indexOf("escutar('account_error'"));
  assert.ok(!nr.includes('onEstado('), 'not_ready nao muda o estado: o player volta sozinho');
  /*
   * Uma faixa ruim não é conta ruim: `playback_error` não derruba a sessão, e as
   * outras faixas da fila continuam tocando.
   */
  const pe = c.slice(c.indexOf("escutar('playback_error'"));
  assert.ok(
    !pe.slice(0, pe.indexOf('});')).includes('finalizar'),
    'playback_error nao finaliza: as outras faixas ainda tocam',
  );
});

test('a faixa so comeca depois do ready', () => {
  /*
   * O item 6 da correção: conta conectada -> faixa vira mídia atual -> obtém
   * token -> SDK conecta -> `ready(device_id)` -> começa reprodução.
   *
   * O passo que faltava era o último. Sem ele o player conectava e a sala ficava
   * em silêncio sem que nada dissesse por quê — e, pior, `playTrack` antes do
   * `ready` é recusado pelo SDK, o que produz o pior dos dois: a sala mostra
   * tocando, o palco não diz nada, e não sai som.
   */
  const palco = readFileSync(resolve(process.cwd(), '../web/components/player/SpotifyStage.tsx'), 'utf8');
  const c = semComentario(palco);
  const hook = c.slice(c.indexOf('export function usePlayerSpotify'));

  const efeito = hook.slice(
    hook.indexOf("if (estado !== 'pronto' || !opts.faixa || !opts.tocando) return;"),
  );
  assert.match(
    efeito.slice(0, efeito.indexOf('}, [estado')),
    /tocar\(opts\.faixa\)/,
    'a faixa nova e carregada no device do SDK',
  );
  assert.match(
    efeito.slice(0, efeito.indexOf('}, [estado')),
    /playerRef\.current\?\.play\(\)/,
    'e voltar a tocar a mesma faixa e um resume, nao recarregar do zero',
  );
  assert.ok(
    !/if \(estado !== 'pronto' \|\| !opts\.faixa\) return;\s*tocar/.test(c),
    'e a faixa nao carrega so com o ready: o play da sala tambem conta',
  );
  /*
   * A dependencia e `pronto`, e nao `tocando`. `tocando` passou a ser a leitura
   * do `player_state_changed`; depender dele aqui recarregaria a faixa a cada
   * mudanca de estado, e a musica nunca terminaria.
   */
  assert.match(
    efeito.slice(efeito.indexOf('}, [estado')),
    /\[estado, opts\.faixa, opts\.tocando, tocar\]/,
    'e a lista de dependencias nao inclui tocando, que e leitura do SDK',
  );
});

test('o pause da sala chega no Spotify', () => {
  /*
   * Sem isto o botão de play/pause da sala governa o vídeo e o stream, e a faixa
   * do Spotify segue tocando: a sala em pausa com áudio correndo. É um defeito
   * distinto do da mensagem, e silencioso.
   */
  const palco = readFileSync(resolve(process.cwd(), '../web/components/player/SpotifyStage.tsx'), 'utf8');
  const c = semComentario(palco);
  assert.match(
    c,
    /if \(estado !== 'tocando' \|\| opts\.tocando\) return;[\s\S]{0,120}?playerRef\.current\?\.pause\(\)/,
    'a sala em pause pausa o player do SDK',
  );
});

test('o painel nao inventa o estado do player', () => {
  /*
   * O painel tinha um aviso de Premium que aparecia **antes** de a pessoa
   * escolher a música, e a única forma de preenchê-lo era o provider inventar um
   * estado: o `account_error` do SDK só chega depois que uma faixa já virou a
   * mídia atual, porque o player só conecta quando há faixa tocando.
   *
   * Dizer "Reconecte" para uma conta recém-conectada seria a mesma mentira do
   * palco, com o texto trocado — e foi assim que o defeito se espalhou do palco
   * para o painel na primeira correção.
   */
  const painelC = semComentario(painel);
  assert.ok(
    !/estado: EstadoDoPlayer/.test(painelC) && !/textoDoEstado/.test(painelC),
    'o painel nao recebe nem traduz um estado de player',
  );

  const fonte = readFileSync(resolve(process.cwd(), '../web/lib/mediaSources/useSpotifySource.tsx'), 'utf8');
  const fonteC = semComentario(fonte);
  assert.match(fonteC, /useSpotifyPanel\(conta\)/, 'e o provider passa so a conta');
  assert.ok(
    !/useSpotifyPanel\([^)]*'(sem_conta|sem_token|premium|ambiente|sdk_bloqueado|drm|autoplay|pronto|tocando)'/.test(fonteC),
    'e nao um estado derivado da conta, que seria outra forma de inventar',
  );

  /*
   * O que o painel sabe de verdade continua sendo dito: a conta conectada ou
   * não, e o resultado da própria busca, com o 401 que prova sessão expirada.
   */
  assert.match(
    painelC,
    /e\.statusDoSpotify === 401/,
    'e o 401 da busca continua sendo tratado como sessao expirada',
  );
  assert.match(
    painelC,
    /cada pessoa usa a própria, e só ouve se tiver Spotify Premium/,
    'e o texto de conta desconectada continua dizendo que o audio exige Premium',
  );
});

test('so se chama metodo que existe no Spotify.Player', () => {
  /*
   * O erro real em produção, textualmente:
   *
   *   [spotify] playTrack recusado: TypeError: s.playTrack is not a function
   *   [spotify] playback_error: Cannot perform operation, no list was loaded.
   *
   * `playTrack`, `loadTrack` e `pauseTrack` estavam **declarados** no tipo
   * `PlayerBruto`, que é escrito à mão. O `tsc` não tem como discordar de um
   * tipo que o próprio código inventou; só a documentação discorda.
   *
   * Este teste amarra a lista do tipo à lista real da referência, e falha no
   * momento em que alguém acrescenta um método sem conferir.
   */
  const c = semComentario(playback);
  /*
   * A fatia vai ate o fim de `PlayerBruto`, e nao ate `PlayerWindow`: entre os
   * dois mora `WebPlaybackState`, cujos campos (`paused`, `position`) entrariam
   * na lista de metodos e acusariam um falso positivo.
   */
  const inicio = c.indexOf('interface PlayerBruto');
  const bloco = c.slice(inicio, c.indexOf('}', inicio));
  const declarados = [...bloco.matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]);

  const OFICIAIS = [
    'connect',
    'disconnect',
    'addListener',
    'removeListener',
    'getCurrentState',
    'setName',
    'getVolume',
    'setVolume',
    'pause',
    'play',
    'resume',
    'togglePlay',
    'seek',
    'previousTrack',
    'nextTrack',
    'activateElement',
  ];

  for (const nome of declarados) {
    assert.ok(
      OFICIAIS.includes(nome),
      `${nome} nao existe em Spotify.Player; a lista oficial esta em PlayerBruto`,
    );
  }
  for (const nome of OFICIAIS) {
    assert.ok(
      declarados.includes(nome),
      `${nome} existe em Spotify.Player e sumiu do tipo: a copia da referencia esta incompleta`,
    );
  }

  /*
   * E nenhum método pode ser chamado no corpo, porque um método chamado e um
   * método inventado que passou pelo typecheck.
   */
  for (const apelido of ['playTrack', 'loadTrack', 'pauseTrack', 'addToQueue', 'setTrack']) {
    assert.ok(
      !new RegExp(`player\\.${apelido}\\s*\\(`).test(c),
      `player.${apelido}() nao pode ser chamado: o metodo nao existe`,
    );
  }
});

test('a faixa e carregada pelo endpoint documentado, com o device do SDK', () => {
  /*
   * Não existe método de faixa no `Spotify.Player`, então a via oficial é
   * `PUT /me/player/play?device_id=...` com `{"uris":[...]}`. O corpo é um uri:
   * o áudio continua vindo do player do SDK neste navegador.
   */
  const oauthC = semComentario(oauth);
  const play = oauthC.slice(oauthC.indexOf('export async function iniciarReproducao'));
  assert.match(play, /\/me\/player\/play\?device_id=/, 'a chamada mira o device do SDK');
  assert.match(play, /JSON\.stringify\(\{ uris: \[trackUri\] \}\)/, 'e manda o uri da faixa, so');
  assert.match(play, /method: 'PUT'/, 'com PUT');
  assert.ok(
    !/audio|preview|mp3|bytes|buffer/i.test(play.replace(/\/\*[\s\S]*?\*\//g, '')),
    'e nada nesta funcao fala em bytes de audio: aqui so passa uri',
  );
  assert.match(play, /DEVICE_ID\.test\(deviceId\)/, 'o device_id e validado antes de virar query');
  assert.match(play, /URI_DE_TRACK\.test\(trackUri\)/, 'e o uri e validado como spotify:track:');

  const rotasC2 = semComentario(rotas);
  assert.match(
    rotasC2,
    /app\.post\('\/api\/spotify\/play'/,
    'e existe uma rota para isso, com o mesmo sessionId das outras',
  );

  const cliente = readFileSync(resolve(process.cwd(), '../web/lib/spotifyAccount.ts'), 'utf8');
  const clienteC = semComentario(cliente);
  const playCli = clienteC.slice(clienteC.indexOf('export async function playSpotifyTrack'));
  assert.match(
    playCli,
    /SERVER_URL\}\/api\/spotify\/play`[\s\S]{0,300}?credentials: 'include'/,
    'e o cliente manda credencial: sem cookie o servidor resolveria outra sessao',
  );
  assert.match(playCli, /body: JSON\.stringify\(\{ deviceId, uri \}\)/, 'passando o device e o uri');
});

test('carregar a faixa exige o scope que so foi adicionado agora', () => {
  /*
   * Token granted não cresce. Quem conectou antes desta mudança tem um token sem
   * `user-modify-playback-state` e o Spotify devolve 403 — e sem a checagem a
   * pessoa receberia "Premium insuficiente", que é falso, e iria comprar um plano
   * que já tem.
   */
  const oauthC = semComentario(oauth);
  assert.match(
    oauthC,
    /'user-modify-playback-state'/,
    'o scope esta no pedido de autorizacao',
  );
  const play = oauthC.slice(oauthC.indexOf('export async function iniciarReproducao'));
  assert.match(
    play,
    /faltando\.length > 0[\s\S]{0,400}?spotify_scope_faltando/,
    'e a falta de scope tem um motivo proprio, que nao e Premium nem Spotify',
  );
  assert.match(
    play,
    /reason: 'spotify_scope_faltando', status: 403/,
    'devolvendo 403 sem passar pelo Spotify, porque a checagem e nossa',
  );
});

test('pronto e tocando sao estados diferentes, e so o segundo afirma audio', () => {
  /*
   * O `ready` diz que o **device** existe. Não diz que há faixa, nem que ela
   * começou, nem que há áudio. A primeira versão publicava `tocando` no `ready`
   * e o palco escrevia "Tocando pelo Spotify, na sua conta" com nada carregado
   * e `0:00 / 0:00` na barra.
   */
  const c = semComentario(playback);
  const ready = c.slice(c.indexOf("escutar('ready'"), c.indexOf("escutar('player_state_changed'"));
  assert.match(ready, /onEstado\('pronto'\)/, 'o ready publica pronto');
  assert.ok(
    !/onEstado\('tocando'\)/.test(ready),
    'e nao publica tocando: device conectado nao e musica tocando',
  );

  const mudou = c.slice(c.indexOf("escutar('player_state_changed'"));
  assert.match(
    mudou.slice(0, mudou.indexOf('});')),
    /onEstado\(tocando \? 'tocando' : 'pronto'\)/,
    'e quem publica tocando e o player_state_changed, que e quem sabe',
  );

  /*
   * `player_state_changed` existia na interface desde o começo e nunca foi
   * registrado. O estado de reprodução não tinha fonte.
   */
  assert.ok(
    c.includes("escutar('player_state_changed'"),
    'o listener de player_state_changed existe de fato, e nao so no tipo',
  );

  // O texto de `pronto` e `tocando` nao vem de textoDoEstado, e sim do palco,
  // que so o diria quando o SDK confirmou.
  const texto = semComentario(playback).slice(
    semComentario(playback).indexOf('export function textoDoEstado'),
  );
  assert.ok(
    !/case 'pronto'/.test(texto) && !/case 'tocando'/.test(texto),
    'nenhum dos dois ganha aviso generico: so o palco fala de reproducao',
  );
  const palco = semComentario(
    readFileSync(resolve(process.cwd(), '../web/components/player/SpotifyStage.tsx'), 'utf8'),
  );
  assert.match(
    palco,
    /\{estado === 'tocando' && \([\s\S]{0,200}?Tocando pelo Spotify/,
    'e o palco so diz "Tocando pelo Spotify" no estado que o SDK confirmou',
  );
});

test('o audio preso por autoplay tem estado proprio e um caminho de saida', () => {
  /*
   * `autoplay_failed` é um evento da referência e não estava sendo tratado. Na
   * sala ele é o caso comum: a faixa vira mídia atual por decisão de outra
   * pessoa, sem gesto nenhum, e o navegador recusa o áudio.
   */
  const c = semComentario(playback);
  assert.ok(c.includes("escutar('autoplay_failed'"), 'o autoplay_failed tem listener');
  const bloco = c.slice(c.indexOf("escutar('autoplay_failed'"));
  assert.match(bloco.slice(0, bloco.indexOf('});')), /onEstado\('autoplay'\)/, 'e vira estado proprio');

  /*
   * O caminho de saída é um gesto real. Chamar `activateElement` no `ready` não
   * resolve, porque o `ready` acontece sem ninguém ter clicado em nada.
   */
  const palcoC = semComentario(
    readFileSync(resolve(process.cwd(), '../web/components/player/SpotifyStage.tsx'), 'utf8'),
  );
  assert.match(
    palcoC,
    /window\.addEventListener\('pointerdown', liberar[\s\S]{0,200}?window\.addEventListener\('keydown', liberar/,
    'e o gesto e escutado na janela: digitar no chat tambem e um gesto',
  );
  assert.match(palcoC, /p\.ativar\(\)/, 'chamando activateElement por dentro do gesto');
  const texto = semComentario(playback).slice(
    semComentario(playback).indexOf('export function textoDoEstado'),
  );
  assert.match(
    texto,
    /case 'autoplay':[\s\S]{0,200}?interagir com a página/,
    'e o texto diz o que a pessoa pode fazer, em vez de culpar a conta',
  );
});

test('quem autorizou antes do scope novo recebe um estado proprio', () => {
  /*
   * Token granted não cresce. Quem conectou antes de
   * `user-modify-playback-state` existir tem um token válido que não reproduz, e
   * o `/status` continua dizendo `connected: true` — a conta está lá, o
   * consentimento é que está desatualizado.
   *
   * Sem estado para isso o caminho é silencioso: o device conecta, o palco não
   * diz nada, e a pessoa conclui que o Spotify não funciona aqui. É o defeito
   * original com outro formato.
   */
  const c = semComentario(playback);
  assert.match(c, /\| 'sem_escopo'/, 'o estado existe');
  assert.match(
    c.slice(c.indexOf("case 'sem_escopo'")),
    /nova autorização para tocar nesta sala/,
    'e o texto diz o que fazer, sem culpar Premium nem a conta',
  );

  const palcoC = semComentario(
    readFileSync(resolve(process.cwd(), '../web/components/player/SpotifyStage.tsx'), 'utf8'),
  );
  const fn = palcoC.slice(palcoC.indexOf('const tocar = useCallback'));
  assert.match(
    fn.slice(0, fn.indexOf('}, []);')),
    /status === 403[\s\S]{0,200}?setEstado\('sem_escopo'\)/,
    'e o 403 de escopo vira esse estado no gancho, em vez de um log e nada',
  );
  assert.ok(
    !/setEstado\('premium'\)/.test(fn),
    'e nenhum 403 vira premium: so o account_error do SDK decide isso',
  );
});

test('o device_id do SDK nao e validado por formato', () => {
  /*
   * Regressao minha, vista na tela.
   *
   * O `ready` passou a exigir 32 caracteres hex, e a referencia do Spotify da
   * como exemplo `c349add90ccf047f4e737492b69ba912bdc55f6a` -- **40**. O id real
   * passou, o palco passou a dizer "Este ambiente nao e compativel com o Spotify
   * Connect" numa conta que funcionava, com a faixa na tela e nenhum som.
   *
   * E a mesma classe do `playTrack`: um formato escrito de imaginacao, que o
   * TypeScript aceita e o Spotify nunca pediu. A documentacao nao especifica
   * comprimento nem alfabeto, e por isso nao ha formato a checar.
   *
   * O teste usa o exemplo da propria referencia como caso de teste. Se o Spotify
   * mudar o formato do id, este teste avisa -- e nao a conta da pessoa.
   */
  const EXEMPLO_DA_REFERENCIA = 'c349add90ccf047f4e737492b69ba912bdc55f6a';
  assert.equal(EXEMPLO_DA_REFERENCIA.length, 40, 'o exemplo da referencia tem 40 caracteres');

  const c = semComentario(playback);
  const ready = c.slice(c.indexOf("escutar('ready'"), c.indexOf("escutar('player_state_changed'"));
  assert.ok(
    !/\^\[A-Fa-f0-9\]/.test(ready),
    'o ready nao exige hex: o comprimento do device_id nao esta especificado',
  );
  assert.match(
    ready,
    /deviceId\.trim\(\) === ''/,
    'e so recusa quando nao ha id nenhum, que e o unico caso sem saida',
  );

  /*
   * O exemplo da referencia tem que passar pela regra do servidor. Extrair o
   * regex do fonte e testa-lo e mais honesto do que reescrever a regra aqui: uma
   * copia no teste passaria mesmo se o codigo mudasse.
   */
  const oauthC = semComentario(oauth);
  const def = oauthC.slice(oauthC.indexOf('const DEVICE_ID')).match(/\/\^[^/]+\//);
  assert.ok(def, 'a regra do device_id existe no servidor');
  // Sem as barras: `new RegExp('/a/')` casa a string "/a/", e nao o padrao.
  const fonteDaRegra = def![0].slice(1, -1);
  assert.ok(
    new RegExp(fonteDaRegra).test(EXEMPLO_DA_REFERENCIA),
    'e o exemplo de 40 caracteres da referencia passa nela',
  );
  assert.ok(
    !/\{32\}/.test(fonteDaRegra),
    'o limite nao e 32: foi o que quebrou na tela',
  );

  const play = oauthC.slice(oauthC.indexOf('export async function iniciarReproducao'));
  assert.match(play, /DEVICE_ID\.test\(deviceId\)/, 'o servidor valida o device_id');
  assert.match(play, /encodeURIComponent\(deviceId\)/, 'e o que protege a query e o encode');
});

test('script bloqueado e DRM sao estados diferentes', () => {
  /*
   * `ambiente` significava quatro coisas: o script não carregou, `window.Spotify`
   * não apareceu, o `device_id` não passou no meu regex, e o `initialization_error`
   * de EME. Quatro causas com textos e ações diferentes, uma palavra.
   *
   * Foi por isso que a regressão do `device_id` ficou invisível: ela publicava
   * `ambiente`, e `ambiente` dizia "nao e compativel", que e uma afirmacao
   * plausivel demais para chamar atencao.
   */
  const c = semComentario(playback);
  assert.ok(!/\|\s*'ambiente'/.test(c), 'o estado ambiente some: ele nao significa nada');
  assert.match(c, /\| 'sdk_bloqueado'/, 'o script que nao carregou e culpa nossa');
  assert.match(c, /\| 'drm'/, 'e a falta de EME e do dispositivo');

  // O script nao carregou -> nosso, nao da pessoa.
  const carregou = c.slice(c.indexOf('const carregou = await carregarSdkSpotify()'));
  assert.match(
    carregou.slice(0, carregou.indexOf('const w = window')),
    /onEstado\('sdk_bloqueado'\)/,
    'e o script ausente aponta para sdk_bloqueado',
  );
  // EME -> do dispositivo.
  const init = c.slice(c.indexOf("escutar('initialization_error'"));
  assert.match(init.slice(0, init.indexOf('});')), /onEstado\('drm'\)/, 'e o EME aponta para drm');

  const texto = c.slice(c.indexOf('export function textoDoEstado'));
  assert.match(
    texto,
    /case 'sdk_bloqueado':[\s\S]{0,300}?não conseguiu carregar o player[\s\S]{0,120}?Recarregue/,
    'e cada um diz o que a pessoa pode fazer, em vez de "ambiente incompativel"',
  );
  assert.match(
    texto,
    /case 'drm':[\s\S]{0,400}?não reproduz áudio/,
    'o de DRM aceita a limitação, sem mandar comprar plano nem reconectar',
  );
});

test('o log da sessao usa hash e nunca o valor do cookie', () => {
  /*
   * "A busca funciona e o player não" é quase sempre uma divisão de sessão, e
   * nenhuma das duas rotas acusa nada. Para provar que são a mesma, os dois
   * precisam aparecer com o mesmo identificador — e o identificador não pode ser o
   * valor do cookie, porque o log fica num deploy com acesso de leitura.
   */
  const rotasC = semComentario(rotas);
  for (const [rotulo, fonte, padrao] of [
    ['status', rotasC, /\[spotify\] status session=\$\{hashDeSessao\(sessionId\)\}/],
    ['playback-token', rotasC, /\[spotify\] playback-token session=\$\{hashDeSessao\(sessionId\)\}/],
    ['search', semComentario(oauth), /\[spotify\] search session=\$\{hashDeSessao\(sessionId\)\}/],
  ] as const) {
    assert.match(fonte, padrao, `${rotulo} registra a sessao por hash`);
  }
  const oauthC = semComentario(oauth);
  const hash = oauthC.slice(oauthC.indexOf('export function hashDeSessao'));
  assert.match(hash, /createHash\('sha256'\)/, 'e o hash e SHA-256');
  assert.match(hash, /slice\(0, 8\)/, 'truncado: 8 caracteres bastam para comparar');
  /*
   * O prefixo cru já estava no log do callback, e é justamente a material de
   * sessão que a convenção existe para não expor. Oito caracteres de um
   * identificador de 32 não abrem nada por sorte — e um log não precisa ser
   * adivinhado para ser um vazamento.
   */
  assert.ok(
    !/sessionId\.slice\(0, 8\)/.test(rotasC),
    'e nenhum registro escreve um prefixo da sessao crua no log',
  );
  assert.ok(
    !/session=\$\{sessionId\}/.test(rotasC),
    'e nenhum registro escreve o valor cru da sessao no log',
  );
});
