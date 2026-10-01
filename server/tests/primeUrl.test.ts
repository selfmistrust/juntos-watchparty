import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { ehPaginaDeTitulo, normalizarUrlDoPrime } from '../src/prime.js';
import { ehDominioPermitido, ehAmazon, ehPrimeVideo } from '../../desktop/electron/shared/dominioPrime.js';

/*
 * O Prime Video dentro do Junto: as regras de URL e o que a sala guarda.
 *
 * ## Por que estes testes existem
 *
 * A integração entrega duas coisas ao restante do app: uma URL que a pessoa
 * escolheu e um nome. As regras abaixo são o que garante que a primeira é um
 * endereço do Prime e nada mais — porque o `playlist:add` aceita qualquer URL,
 * e o botão "Abrir no Prime Video" da sala mostra o que estiver gravado.
 *
 * ## O que NÃO é testado aqui, e por quê
 *
 * Não há teste de reprodução de vídeo protegido. Não existe build do Electron
 * com o CDM do Widevine aqui, e nenhum teste poderia afirmar que o Prime
 * aceitou tocar um título: isso depende da conta, da assinatura e da checagem
 * de VMP do lado da Amazon. O que o app afirma é o oposto disso — que **não**
 * promete reproduzir dentro do app, e oferece a outra aba. Esse comportamento
 * está travado no teste estrutural de `web/tests/primeIntegracao.test.ts`.
 */

const raiz = (caminho: string) => resolve(process.cwd(), caminho);
const ler = (caminho: string) => readFileSync(raiz(caminho), 'utf8');
const semComentario = (texto: string) =>
  texto.replace(/(^|[\s'"`(])(\/\/[^\n]*)/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

test('a fila só aceita página de título, e o domínio é conferido à parte', () => {
  const titulos = [
    'https://www.primevideo.com/detail/the-bear/0K9Y7ZQ1FQV0WZ4KQ0MDM0MVRW',
    'https://www.primevideo.com/detail/amzn1.ask.0J2C1N0QKQ3KJ0ZW4KQ0MDM0MVRW',
    'https://www.primevideo.com/dp/amzn1.ask.0J2C1N0QKQ3KJ0ZW4KQ0MDM0MVRW',
    'https://primevideo.com/detail/algum-filme',
  ];

  for (const url of titulos) {
    assert.ok(normalizarUrlDoPrime(url), `deveria aceitar ${url}`);
    assert.ok(ehPaginaDeTitulo(url), `deveria reconhecer ${url} como página de título`);
  }

  /*
   * A home e o catálogo são URLs válidas do domínio, e ainda assim não
   * identificam um filme. A fila precisa da segunda resposta, e é por isso que
   * `playlist:add` pergunta as duas: uma URL do Prime que não é de título
   * mostraria a mesma coisa para todo mundo da sala.
   */
  for (const url of ['https://www.primevideo.com/', 'https://www.primevideo.com/store']) {
    assert.ok(normalizarUrlDoPrime(url), `${url} é do domínio, e o normalizador aceita`);
    assert.equal(ehPaginaDeTitulo(url), false, `${url} não é de um título`);
  }

  /*
   * Domínio e esquema. As três primeiras rejeições são o host e o caminho:
   *
   * A primeira é o `endsWith` mal feito. `evilprimevideo.com` termina em
   * `primevideo.com` sem o ponto antes, e é o jeito mais óbvio de deixar
   * passar. O inverso, `primevideo.com.atacante.net`, também é rejeitado: a
   * comparação é feita no hostname, que é só a parte antes da primeira barra.
   *
   * A segunda é o esquema. `javascript:alert(1)//https://www.primevideo.com/`
   * passa num `startsWith('https')` e é exatamente o tipo de coisa que a
   * validação existe para impedir.
   */
  const recusados = [
    'https://evilprimevideo.com/detail/algum-filme',
    'https://primevideo.com.atacante.net/detail/algum-filme',
    'javascript:alert(1)//https://www.primevideo.com/detail/x',
    'http://www.primevideo.com/detail/algum-filme',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    '',
  ];

  for (const url of recusados) {
    assert.equal(normalizarUrlDoPrime(url), null, `deveria recusar ${JSON.stringify(url)}`);
  }

  const naoTitulo = [
    'https://www.primevideo.com/',
    'https://www.primevideo.com/store',
    'https://www.primevideo.com/search?k=matrix',
    'https://www.primevideo.com/detail',
    'https://www.primevideo.com/details/algum-filme',
  ];

  for (const url of naoTitulo) {
    assert.equal(ehPaginaDeTitulo(url), false, `${url} não é a página de um título`);
  }
});

test('a URL guardada é canônica: sem query e sem âncora', () => {
  /*
   * Duas pessoas que colaram o mesmo título de links de campanha diferentes
   * precisam receber o mesmo endereço — senão a comparação entre a página
   * aberta na view e o que está na fila fica dependente de `?ref_=`.
   *
   * E a query não carrega a identidade do conteúdo: o identificador do título
   * está no caminho. O que ela traz é rastreamento, e isso não viaja entre
   * participantes.
   */
  const comRef = 'https://www.primevideo.com/detail/the-bear/0ABC?ref_=hmg_b2b_x&_encoding=UTF8';
  const semRef = 'https://www.primevideo.com/detail/the-bear/0ABC';
  assert.equal(normalizarUrlDoPrime(comRef), semRef);
  assert.equal(normalizarUrlDoPrime(`${semRef}#algum-ancora`), semRef);
});

test('a navegação aceita as lojas regionais da Amazon, e só elas', () => {
  /*
   * ## O defeito que este teste existe para pegar
   *
   * A regra anterior era `host.endsWith('.amazon.com')`. Isso **rejeita
   * `www.amazon.com.br`**: `amazon.com.br` não termina em `amazon.com`, porque o
   * final de verdade é `.com.br`.
   *
   * O efeito era o login inteiro fora do aplicativo: o redirecionamento para a
   * loja regional saía para o navegador do sistema, e a sessão
   * `persist:juntos-prime` nunca era completada. A pessoa logava no Chrome e
   * voltava para um app que continuava deslogado — o passo "login na conta
   * própria" do modelo do Rave, impossível.
   *
   * E `smile.amazon.com` e `sso.amazon.com` são as superfícies de login da
   * Amazon: qualquer subdomínio de `amazon.<loja>` passa, sem lista.
   */
  const passam = [
    'primevideo.com',
    'www.primevideo.com',
    'amazon.com',
    'www.amazon.com',
    'smile.amazon.com',
    'sso.amazon.com',
    // As lojas regionais. As duas primeiras são o caso que quebrava.
    'amazon.com.br',
    'www.amazon.com.br',
    'sso.amazon.com.br',
    'amazon.co.uk',
    'amazon.de',
    'amazon.co.jp',
    'amazon.com.mx',
    'amazon.com.au',
  ];

  for (const host of passam) {
    assert.ok(ehDominioPermitido(host), `${host} deveria navegar dentro da view`);
  }

  /*
   * E o segundo nível é fechado em `com` e `co` de propósito: aceitar qualquer
   * um abriria `amazon.evil.net`, e quem registrasse `evil.net` levaria a view
   * para lá.
   */
  for (const host of [
    'evilprimevideo.com',
    'primevideo.com.atacante.net',
    'notamazon.com',
    'amazon.com.br.evil.net',
    'amazon.com.evil.net',
    'amazon.evil.net',
    'amazon.zip',
    'google.com',
    'netflix.com',
  ]) {
    assert.equal(ehDominioPermitido(host), false, `${host} não deveria navegar dentro da view`);
  }

  /*
   * As duas perguntas são separadas, e a separação importa: `primevideo.com` é o
   * que identifica um título; as lojas da Amazon são para onde a pessoa pode
   * *ir* durante o login, e nada disso identifica um filme.
   */
  assert.ok(ehPrimeVideo('www.primevideo.com'));
  assert.equal(ehPrimeVideo('www.amazon.com.br'), false, 'a loja da Amazon não é o Prime');
  assert.ok(ehAmazon('www.amazon.com.br'), 'mas é onde o login acontece');
});

test('a validação é do servidor, e o item gravado é o que o servidor reescreveu', () => {
  const socket = ler('../server/src/socket.ts');
  const add = semComentario(socket).slice(
    semComentario(socket).indexOf("socket.on('playlist:add'"),
    semComentario(socket).indexOf("socket.on('upload:requestToken'"),
  );

  assert.ok(
    /item\.kind === 'prime'/.test(add),
    'o item prime é validado dentro do playlist:add',
  );
  assert.ok(
    /normalizarUrlDoPrime\(item\.primeUrl\)/.test(add),
    'e a URL que entra é a normalizada pelo servidor, não a que o cliente mandou',
  );
  assert.ok(
    /ehPaginaDeTitulo\(/.test(add),
    'e uma URL do Prime que não é de um título não entra: a home não identifica filme, e todo mundo veria a mesma coisa',
  );
  assert.ok(
    /\.\.\.\(primeUrl \? \{ primeUrl, src: '' \} : \{\}\)/.test(add),
    'o src fica vazio: não há mídia para um <video> tocar',
  );
  assert.ok(
    !/\.\.\.item,[\s\S]{0,400}primeUrl: item\.primeUrl/.test(add),
    'e o primeUrl do cliente não passa direto pelo spread',
  );
});

test('o que entra na fila pelo Prime é URL e nome — nada mais', () => {
  /*
   * A lista do que **não** pode viajar é mais importante que a do que pode, e é
   * por isso que o teste varre o código inteiro da integração atrás delas.
   *
   * A integração inteira é: `server/src/prime.ts`, `server/src/socket.ts`
   * (o trecho do prime), `web/lib/prime.ts`, `web/lib/mediaSources/prime.tsx`,
   * `web/components/player/PrimeStage.tsx`, `desktop/electron/main/prime.ts`.
   */
  const arquivos = [
    '../server/src/prime.ts',
    '../web/lib/prime.ts',
    '../web/lib/mediaSources/prime.tsx',
    '../web/components/player/PrimeStage.tsx',
    '../desktop/electron/main/prime.ts',
  ];

  /*
   * Nenhuma referência a cabeçalho de autenticação, a manifesto de vídeo ou a
   * chave. O comentário pode citar as palavras — é o código que não pode.
   */
  const proibidas = [
    /\bAuthorization\b/,
    /\bbearer\b/i,
    /\bset-cookie\b/i,
    /\bcookies?\b\s*[:=]/i,
    /#EXT-X-/,
    /\.mpd\b/i,
    /widevine.*licen[çc]a/i,
    /navigator\.credentials/i,
  ];

  for (const arquivo of arquivos) {
    const codigo = semComentario(ler(arquivo));
    for (const proibida of proibidas) {
      assert.ok(
        !proibida.test(codigo),
        `${arquivo} não deveria mencionar ${proibida} fora de comentário`,
      );
    }
  }
});

test('a view do Prime não recebe injeção de JavaScript do site', () => {
  const main = semComentario(ler('../desktop/electron/main/prime.ts'));

  /*
   * `executeJavaScript` existe no arquivo, e é o que a sonda de DRM usa — numa
   * view descartável em `data:`, não na página do Prime. A regra precisa ser
   * mais específica que "não usa executeJavaScript": o que não pode é rodar
   * qualquer coisa na view que tem a particao do Prime.
   */
  assert.ok(
    /new WebContentsView\(\{[\s\S]{0,200}webPreferences: \{ sandbox: true/.test(main),
    'a sonda de DRM roda numa view própria, em sandbox',
  );
  assert.ok(
    !/view\.webContents\.executeJavaScript/.test(main),
    'nunca injeta JavaScript na view que tem a sessão do Prime',
  );
  assert.ok(
    /loadURL\('data:text\/html/.test(main),
    'e a sonda pergunta a um data: URL, sem tocar no site',
  );

  /*
   * `sondagem` é a view da sonda. Se o nome da particao do Prime aparecesse
   * numa chamada a `executeJavaScript`, seria a view errada.
   */
  const linhasComProbe = main
    .split('\n')
    .filter((l) => l.includes('executeJavaScript'));
  assert.equal(linhasComProbe.length, 1, 'uma única chamada, a da sonda');
});

test('a sessão do Prime é persistente, isolada e local', () => {
  const main = semComentario(ler('../desktop/electron/main/prime.ts'));

  assert.match(
    main,
    /const PARTICAO = 'persist:juntos-prime';/,
    'a sessão sobrevive ao fechar o app, e o nome diz de quem é',
  );
  assert.match(
    main,
    /webPreferences: \{[\s\S]{0,160}partition: PARTICAO,[\s\S]{0,160}nodeIntegration: false,[\s\S]{0,160}contextIsolation: true,[\s\S]{0,160}sandbox: true/,
    'e a view do Prime não tem Node, não tem preload e roda em sandbox',
  );

  /*
   * O `persist:` grava em disco, nesta instalação. Nenhum caminho de rede
   * para fora: a sessão não é enviada para o servidor, e o `main` só manda a
   * URL e o título da página para o renderer.
   */
  assert.ok(
    !/session\.defaultSession|fromPartition\(['"]persist:juntos-prime['"]\)/.test(main),
    'o Prime não usa a sessão padrão do app',
  );
  assert.ok(
    !/send\(['"][^'"]*(cookie|token|session)/i.test(main),
    'e nada de sessão vai para o renderer',
  );
});

test('nem a web nem o desktop embutem o Prime em iframe ou <webview>', () => {
  const web = semComentario(ler('../web/lib/prime.ts'));
  const painel = semComentario(ler('../web/lib/mediaSources/prime.tsx'));
  const palco = semComentario(ler('../web/components/player/PrimeStage.tsx'));

  /*
   * A web não quebra CSP nem X-Frame-Options de ninguém: o caminho dela é
   * abrir outra aba. Um `<iframe>` do primevideo aqui seria a tentativa que a
   * especificação proíbe, e o site recusa de qualquer forma.
   */
  for (const [nome, codigo] of [
    ['lib/prime.ts', web],
    ['mediaSources/prime.tsx', painel],
    ['player/PrimeStage.tsx', palco],
  ] as const) {
    assert.ok(!/<iframe/i.test(codigo), `${nome} não pode embutir o Prime em iframe`);
    assert.ok(!/<webview/i.test(codigo), `${nome} não pode usar a tag <webview>`);
  }

  assert.match(
    painel,
    /target="_blank"/,
    'e o caminho da web é abrir o Prime em outra aba',
  );
  assert.match(
    palco,
    /window\.open\('https:\/\/www\.primevideo\.com\/', '_blank', 'noopener,noreferrer'\)/,
    'e o palco também avisa, no lugar da view, quando não há app desktop',
  );
});

test('o servidor não promete reproduzir o Prime: a contagem é o que sincroniza', () => {
  const socket = semComentario(ler('../server/src/socket.ts'));
  const palco = semComentario(ler('../web/components/player/PrimeStage.tsx'));
  const video = semComentario(ler('../web/components/player/VideoStage.tsx'));

  /*
   * Nenhum `player:*` para a faixa prime: play, pause e seek não têm efeito
   * sobre um vídeo que toca na conta da Amazon. Sem esta trava, alguém
   * acrescentaria a sincronização de posição "para o Prime também funcionar",
   * e o efeito seria um botão que acende e não move o filme de ninguém.
   */
  assert.match(socket, /socket\.on\('watch:ready'/, 'a prontidão é um evento próprio');
  assert.match(socket, /socket\.on\('watch:countdown'/, 'a contagem regressiva também');
  assert.match(socket, /socket\.on\('watch:resync'/, 'e o recomeço');

  assert.match(palco, /CONTAGEM_REGRESSIVA_MS/, 'a contagem usa o instante do servidor');
  assert.match(
    video,
    /\{currentItem && !isPrime && \(\s*<PlayerControls/,
    'e a barra de player fica de fora para o prime',
  );
  assert.match(
    palco,
    /primeCanPlayProtected/,
    'a tela pergunta ao motor se este build decifra, em vez de prometer que toca',
  );
});

test('a prontidão é só da faixa prime, e o contador morre quando a faixa muda', () => {
  const socket = ler('../server/src/socket.ts');
  const rooms = ler('../server/src/rooms.ts');
  const codigo = semComentario(socket);

  /*
   * Só a faixa `prime`.
   *
   * As outras fontes têm posição seekável, e a sincronização delas é o laço de
   * deriva do player. Se o contador existisse para elas, a sala teria dois
   * notarimentos de "está pronto" disputando a mesma tela, e ele mostraria
   * "pronto" para um vídeo que já está tocando sozinho.
   */
  const ready = codigo.slice(
    codigo.indexOf("socket.on('watch:ready'"),
    codigo.indexOf("socket.on('watch:countdown'"),
  );
  const resync = codigo.slice(
    codigo.indexOf("socket.on('watch:resync'"),
    codigo.indexOf("socket.on('room:setOpenControl'"),
  );
  assert.match(ready, /faixa\.kind !== 'prime'/, 'watch:ready so conta para faixa prime');
  assert.match(resync, /faixa\.kind !== 'prime'/, 'e o recomeço tambem');

  /*
   * Contar duas vezes é o jeito mais fácil de o contador mentir.
   *
   * Um `emit` repetido — clique duplo, reconexão, o botão apertado duas vezes
   * rápido — contaria a pessoa duas vezes, e a sala veria "3 de 2 prontos".
   */
  assert.match(
    ready,
    /base\.userIds\.filter\(\(id\) => id !== user\.userId\)/,
    'o userId é filtrado antes de entrar, então repetir o clique não soma duas vezes',
  );

  /*
   * `userId` e não `sessionId`.
   *
   * O `sessionId` é o socket de uma instância específica e muda a cada
   * reconexão: quem caiu e voltou apareceria como outra pessoa no contador, e a
   * sala nunca fecharia a contagem.
   */
  assert.match(ready, /user\.userId/, 'o contador guarda o userId, que sobrevive a reconexão');

  /*
   * Trocar de faixa zera.
   *
   * Quem estava pronto para o filme anterior precisa abrir o título novo antes
   * de apertar de novo. Dizer que está pronta para outro filme é mentira na
   * tela de todo mundo.
   */
  assert.match(
    semComentario(rooms),
    /export function limparReadiness\(room: Room\)/,
    'existe uma função só para zerar, e não uma linha repetida em cada lugar',
  );
  const trocas = codigo.match(/limparReadiness\(room\);/g) ?? [];
  assert.ok(
    trocas.length >= 3,
    'e ela é chamada onde a faixa muda: ao entrar na primeira, ao escolher e ao avançar',
  );
  assert.match(
    semComentario(rooms),
    /atual\.itemId !== room\.playlist\[room\.currentIndex\]\?\.id/,
    'e a leitura também confere: um contador preso na faixa antiga mostraria "3 de 4 prontos" para um título que ninguém abriu',
  );
});

test('as duas cópias da duração da contagem continuam iguais', () => {
  const web = ler('../web/types/index.ts');
  const server = ler('../server/src/types.ts');

  const pega = (texto: string) => /CONTAGEM_REGRESSIVA_MS = (\d+)/.exec(texto)?.[1];
  assert.ok(pega(web), 'o cliente declara a duração');
  assert.ok(pega(server), 'e o servidor também');
  assert.equal(
    pega(web),
    pega(server),
    'divergir faz duas pessoas darem play em instantes diferentes, que é o que a contagem evita',
  );
});

test('o clique no card abre a view no desktop, e não abre painel de URL', () => {
  /*
   * Este é o defeito que motivou a correção.
   *
   * O palco do Prime só era montado quando um item `prime` já estava tocando,
   * e o item só entrava na fila pelo botão que estava dentro desse palco. Um
   * clique no card, portanto, não tinha para onde abrir: aparecia um painel com
   * um campo para colar a URL, num caminho que não podia dar certo. O sintoma na
   * tela era "o Prime não pode ser incorporado, cole o endereço aqui" — que é
   * uma explicação inventada para um bug de montagem.
   *
   * As duas metades que precisam concordar:
   *
   *   o `start` do provider   abre o store, e não um painel
   *   o palco                 lê o store e monta a faixa, mesmo sem item
   */
  const provider = ler('../web/lib/mediaSources/prime.tsx');
  const store = ler('../web/lib/primeView.ts');
  const palco = ler('../web/components/player/VideoStage.tsx');
  const pagina = ler('../web/pages/room/[id].tsx');

  // 1. O `start` do desktop abre a view.
  assert.match(
    semComentario(provider),
    /if \(desktop\(\)\) \{\s*abrirPrime\(\);\s*return;\s*\}/,
    'no desktop o start abre a view e sai — nenhum painel',
  );

  // 2. Quem lê o store é a página, e ela passa para o palco.
  assert.match(
    semComentario(pagina),
    /usePrimeAberto\(\)/,
    'a página assina o store',
  );
  assert.match(
    pagina,
    /primeAberto=\{primeAbertoNoPalco\}/,
    'e repassa para o palco — um literal `false` aqui deixa o card sem efeito',
  );

  // 3. O palco monta a faixa do Prime mesmo sem item na fila.
  assert.match(
    semComentario(palco),
    /\)\s*:\s*primeAberto \? \([\s\S]{0,400}<PrimeViewport/,
    'sem item na fila e com o Prime aberto, quem entra é o PrimeViewport',
  );
  assert.ok(
    /<EmptyStage \/>/.test(palco),
    'e o palco vazio continua existindo para o caso de não haver nada aberto',
  );

  /*
   * "Assistir com a sala" mora na faixa, e é o botão que fecha o fluxo.
   *
   * Ele lê a página que a pessoa está vendo dentro da view — que é o que
   * `did-navigate`/pubblica no `main` — e vira item da fila. O item é
   * adicionado pelo palco, que já tem `actions.addToPlaylist`.
   */
  assert.match(
    semComentario(palco),
    /onAssistirComSala=\{\(url, titulo\) =>\s*actions\.addToPlaylist\(\{ kind: 'prime', src: '', primeUrl: url, title: titulo\.slice\(0, 200\) \}\)/,
    'o viewport entrega a página atual para a fila, pelo palco',
  );
  assert.match(
    semComentario(ler('../web/components/player/PrimeStage.tsx')),
    /disabled=\{!naPaginaDeTitulo\}/,
    'e o botão só fica ativo numa página de título — a home não identifica um filme',
  );

  // 4. O store é um store de verdade, e não um estado perdido.
  assert.match(
    semComentario(store),
    /useSyncExternalStore\(inscrever, primeAberto, primeAberto\)/,
    'a leitura é por useSyncExternalStore, que não perde escrita feita fora do React',
  );

  /*
   * Trocar de fonte fecha.
   *
   * Uma `WebContentsView` que continua filha do `contentView` continua no
   * hit-test, e o sintoma é o Prime engolindo clique do chat e dos controles
   * enquanto a tela mostra o vídeo de outra pessoa. Fechar o store é o que
   * desmonta a faixa, e o cleanup dela é quem chama `closePrimeView`.
   */
  assert.match(
    semComentario(palco),
    /useEffect\(\(\) => \{\s*if \(currentItem && currentItem\.kind !== 'prime'\) fecharPrime\(\);/,
    'sair do prime para outra fonte fecha o store',
  );
});

test('não existe mais campo de URL nem "não pode ser incorporado" no app desktop', () => {
  /*
   * O pedido é explícito: no desktop, nada de pedir URL colada. E na web o
   * campo também sai, porque ele transformava uma integração que não existe
   * ali num formulário manual.
   */
  const arquivos = [
    '../web/lib/mediaSources/prime.tsx',
    '../web/components/player/PrimeStage.tsx',
    '../web/lib/primeView.ts',
  ];

  for (const arquivo of arquivos) {
    const codigo = ler(arquivo);
    assert.ok(!/<input/i.test(codigo), `${arquivo} não pode ter campo de entrada`);
    assert.ok(
      !/Cole aqui o endereço/i.test(codigo),
      `${arquivo} não pode pedir para colar o endereço`,
    );
    assert.ok(
      !/não pode ser incorporado/i.test(codigo),
      `${arquivo} não pode dizer que o Prime não pode ser incorporado — no desktop ele é`,
    );
  }

  /*
   * A mensagem da web existe, e é o que sobra lá: uma frase e a outra aba.
   *
   * "Não pode" na web é verdade — o Prime Video recusa ser exibido dentro de
   * outro site — mas ela não pode ser a experiência **principal** da integração.
   */
  const painel = ler('../web/lib/mediaSources/prime.tsx');
  assert.match(
    painel,
    /disponível no aplicativo Desktop/,
    'a web diz que o integrado está no aplicativo Desktop',
  );
  assert.match(painel, /https:\/\/www\.primevideo\.com\//, 'e oferece a outra aba');
});

test('a view é removida do contentView, e nunca só escondida', () => {
  /*
   * "Esconder" não resolve. `setVisible(false)` desliga a renderização, mas a
   * view continua filha do `contentView` e continua entrando no hit-test do
   * Chromium. O defeito é invisível na tela e aparece como clique perdido.
   *
   * A regra do módulo inteiro fica sem `setVisible`: a view existe ou não é
   * filha de ninguém.
   */
  const main = semComentario(ler('../desktop/electron/main/prime.ts'));

  assert.ok(!/setVisible/.test(main), 'a view nunca é só escondida');
  assert.match(
    main,
    /paiDaView\.contentView\.removeChildView\(view\)/,
    'fechar é remover do contentView',
  );
  assert.match(main, /janela\.contentView\.addChildView\(view\)/, 'e abrir é adicionar');
  assert.match(main, /paiDaView = janela;/, 'o pai fica guardado, para remover no mesmo lugar');
  assert.match(
    main,
    /let paiDaView: BrowserWindow \| null = null;/,
    'e é uma variável própria, não a janela "da última vez"',
  );

  /*
   * Fechar a view não pode derrubar a janela dona.
   *
   * `dona` era zerada em `destruir()`, que é chamado quando a pessoa fecha o
   * Prime. O `prime:abrir` seguinte recebia `null` e não abria mais: o sintoma
   * seria "funcionou uma vez e nunca mais".
   */
  const destruir = main.slice(main.indexOf('function destruir'), main.indexOf('function abrir'));
  assert.ok(
    !/dona = null/.test(destruir),
    'destruir a view não pode zerar a janela dona',
  );
  assert.match(
    main,
    /BrowserWindow\.fromWebContents\(evento\.sender\)/,
    'e prime:abrir pega a janela pelo sender, e não por uma global',
  );

  /*
   * Quem decide o destino é o renderer.
   *
   * O main criava a view já carregando a home e a faixa carregava o título em
   * seguida: dois `loadURL` em sequência, e o primeiro chegava a aparecer —
   * um flash da home do Prime a cada troca de faixa.
   */
  const abrir = main.slice(
  main.indexOf('function abrir'),
  main.indexOf('function temDrm'),
);
  assert.ok(
    !/loadURL\(/.test(abrir),
    'abrir não carrega nada: quem manda no destino é quem sabe o que a pessoa está fazendo',
  );
  assert.ok(
    !/www\.primevideo\.com/.test(abrir),
    'e a URL do Prime nem aparece em abrir, com nome de constante ou literal',
  );
  assert.match(
    semComentario(ler('../web/components/player/PrimeStage.tsx')),
    /urlDaFaixa && urlDaFaixa !== '' \? urlDaFaixa : HOME_PRIME/,
    'e o renderer pede uma navegação só: o título se houver, a home se não',
  );
});

test('a view é reposicionada em todos os momentos em que o palco muda de tamanho', () => {
  /*
   * `WebContentsView` não faz parte do DOM, então o retângulo que o `main` usa
   * para ela não se ajusta sozinho. Se ficar obsoleto, a view cobre o que
   * estiver embaixo — e o pedido nomeia exatamente o que está embaixo do
   * player: cabeçalho, chat, fila, pessoas e os controles do Juntos.
   *
   * A falha é silenciosa: a tela continua parecendo correta, e o que quebra é o
   * clique. Por isso a trava é sobre **os dois** escutam, e não sobre um só.
   *
   *   `ResizeObserver`   divisória arrastada, painel ocultado, tela cheia
   *   `resize` da janela redimensionar, maximizar, mudar de monitor
   */
  const palco = semComentario(ler('../web/components/player/PrimeStage.tsx'));

  assert.match(
    palco,
    /new ResizeObserver\(mandarRetangulo\)/,
    'o ResizeObserver é o que cobre a divisória, o painel ocultado e o fullscreen',
  );
  assert.match(
    palco,
    /observador\.observe\(el\)/,
    'e ele observa a caixa, que é a que o palco redesenha',
  );
  assert.match(
    palco,
    /window\.addEventListener\('resize', mandarRetangulo\)/,
    'e o resize da janela cobre o redimensionar da janela',
  );

  /*
   * Os dois precisam sair no cleanup.
   *
   * Sem isso, cada montagem da faixa deixa um `ResizeObserver` vivoObservando
   * uma caixa que já não existe: a memória cresce a cada troca de faixa, e o
   * `openPrimeView` continua sendo chamado por um elemento morto.
   */
  assert.match(palco, /observador\?\.disconnect\(\)/, 'o observador é desconectado');
  assert.match(
    palco,
    /window\.removeEventListener\('resize', mandarRetangulo\)/,
    'e o listener da janela sai junto',
  );

  /*
   * O retângulo vai no `openPrimeView`, e não num `style`.
   *
   * Um `style` no elemento do renderer só move o que o renderer desenha — e a
   * view nativa é desenhada pelo Chromium, por cima. Seria um retângulo
   * perfeito de uma coisa que não se move.
   */
  assert.match(
    palco,
    /api\.openPrimeView\(\{\s*x: Math\.round\(r\.left \+ window\.scrollX\),\s*y: Math\.round\(r\.top \+ window\.scrollY\),\s*width: Math\.round\(r\.width\),\s*height: Math\.round\(r\.height\),?\s*\}\)/,
    'e a medida vai pelo IPC, com a soma do scroll',
  );

  /*
   * E fechar a view é explícito no cleanup.
   *
   * Sem o `closePrimeView` no cleanup, a view continua filha do `contentView`
   * depois que a faixa desmonta — que é o defeito de clique engolido.
   */
  assert.match(
    palco,
    /return \(\) => \{\s*void api\.closePrimeView\(\);\s*\};|void api\.closePrimeView\(\);/,
    'e o cleanup da faixa fecha a view',
  );
});

test('o login da Amazon acontece na sessão do Prime, e não no navegador do sistema', () => {
  /*
   * ## O defeito
   *
   * O `setWindowOpenHandler` mandava **toda** URL permitida para
   * `shell.openExternal`. O login da Amazon acontece em parte numa janela
   * separada, com formulário e POST.
   *
   * Mandar essa URL para o navegador do sistema significa que o POST vai para o
   * Chrome — e a sessão que completa o login é a do Chrome. A
   * `persist:juntos-prime` continua deslogada, a view volta para o Prime pedindo
   * login de novo, e a pessoa entra num ciclo.
   *
   * Não é um detalhe de implementação. É o passo inteiro quebrado, e ele é
   * justamente o que o modelo do Rave promete: *"you can sign in to that account
   * in Rave"*.
   */
  const main = semComentario(ler('../desktop/electron/main/prime.ts'));

  // 1. Popup de domínio permitido: janela de verdade, com a mesma partição.
  assert.match(
    main,
    /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]{0,400}action: 'allow'/,
    'um popup do Prime ou da Amazon vira janela, e não link externo',
  );
  assert.match(
    main,
    /overrideBrowserWindowOptions: opcoesDaJanelaDeLogin\(dona\)/,
    'com as opções que importam',
  );

  const opcoes = main.slice(main.indexOf('function opcoesDaJanelaDeLogin'), main.indexOf('function instalarFiltroDeNavegacao'));
  assert.match(
    opcoes,
    /partition: PARTICAO/,
    'a janela do login usa a MESMA partição da view: é o POST e os cookies que precisam cair aqui',
  );
  assert.match(opcoes, /nodeIntegration: false/, 'e sem Node');
  assert.match(opcoes, /contextIsolation: true/, 'e com isolamento de contexto');
  assert.match(opcoes, /sandbox: true/, 'e em sandbox');

  /*
   * `parent` faz a janela do login ser filha da principal. Sem isso ela é uma
   * janela solta: não agrupa na barra de tarefas e pode ficar atrás do app, e
   * o sintoma de um login que parece não ter acontecido.
   */
  assert.match(opcoes, /parent: janela \?\? undefined/, 'a janela do login é filha da principal');

  /*
   * 2. Popup de fora dos domínios: navegador do sistema.
   *
   * Um anúncio ou um link de terceiro não pode ficar dentro do app com a cara
   * dele — mas também não pode ser bloqueado em silêncio, porque a pessoa ficaria
   * presa numa tela que não reage.
   */
  assert.match(
    main,
    /setWindowOpenHandler[\s\S]{0,400}if \(\/\^https\?:\/\.test\(url\)\) void shell\.openExternal\(url\);[\s\S]{0,80}action: 'deny'/,
    'e um popup de fora vai para o navegador do sistema, em vez de ser bloqueado em silêncio',
  );

  /*
   * 3. `shell.openExternal` não pode estar no caminho do login.
   *
   * É a trava que pega a volta atrás. A regra é: `openExternal` só aparece
   * dentro de um ramo cujo teste de domínio **falhou**.
   */
  const handler = main.slice(
    main.indexOf('setWindowOpenHandler'),
    main.indexOf('did-navigate'),
  );
  const [ateAllow, doAllow] = handler.split("action: 'allow'");
  assert.equal(
    ateAllow.length > 0 && doAllow.length > 0,
    true,
    'o handler tem um caminho que recusa e um que deixa abrir',
  );
  assert.match(
    ateAllow,
    /openExternal\(/,
    'o caminho que recusa manda a URL para o navegador do sistema, em vez de sumir com ela',
  );
  assert.ok(
    !/openExternal/.test(doAllow),
    'e o caminho que vira janela de login não tem escape para o navegador do sistema -- é essa a linha que quebrava o login',
  );

  /*
   * 4. A navegação da janela do login também é filtrada.
   *
   * Um `will-navigate` preso à view não alcança o que nasce dentro dela. Sem o
   * gancho global, a janela de login navegaria para onde quisesse — inclusive
   * para uma página que imitasse a Amazon e trouxesse a pessoa a digitar a senha
   * num lugar que não é a Amazon, dentro de um app que tem cara de app
   * confiável.
   */
  assert.match(
    main,
    /app\.on\('web-contents-created',[\s\S]{0,300}wc\.session === session\.fromPartition\(PARTICAO\)/,
    'o filtro alcança todo WebContents da partição do Prime, e só ele',
  );
  assert.match(
    main,
    /instalarFiltroDeNavegacao\(\);\r?\n?\s*ipcMain\.handle/,
    'e ele é instalado junto com os canais IPC, uma vez só',
  );

  /*
   * 5. A regra de domínios não pode voltar a ser uma cópia dentro do main.
   *
   * Houve duas — uma em `server/src/prime.ts` e outra aqui — e o teste olhava
   * só uma delas. É a forma mais barata de um bug que só aparece em produção.
   */
  assert.ok(
    !/hostPermitido/.test(main),
    'o main não tem mais a sua própria função de dominio',
  );
  assert.ok(
    !/const DOMINIO_(PRIME|LOGIN)/.test(main),
    'e nem as constantes: a lista de dominios mora inteira no modulo compartilhado',
  );
  assert.match(
    main,
    /import \{ ehDominioPermitido \} from '\.\.\/shared\/dominioPrime'/,
    'ele importa do módulo compartilhado, que é o mesmo que o teste exercita',
  );
  assert.ok(
    !/DOMINIOS_DA_NAVEGACAO|ehDominioDeNavegacao/.test(
      ler('../server/src/prime.ts'),
    ),
    'e a cópia do servidor saiu: lá a regra não tem consumidor',
  );
});

test('a sincronização não injeta no player do Prime, e o motivo está escrito', () => {
  /*
   * ## Por que este teste existe
   *
   * A resposta certa para "como sincronizar o Prime" é "não dá", e uma resposta
 * negativa é a mais fácil de refazer sem perceber. A forma "suportada" de
 * corrigir isso é injetar na página: ler `video.currentTime` e chamar
 * `play()`.
   * Isso quebraria três das garantias da integração ao mesmo tempo, e as três
   * estão em outros testes deste arquivo — o que faz deste um teste de
   * *consistência*, e não só de presença.
   *
   * ## O que foi pesquisado, e não presumido
   *
   * - As APIs oficiais da Prime Video (Video Central) são Content API, para
   *   parceiros de **conteúdo** enviarem catálogo, e Analytics API, somente
   *   leitura, para parceiros elegíveis. Nenhuma expõe reprodução ou posição.
   * - A Watch Party nativa da Amazon foi lançada em 2020 e **removida em 2024**.
   * - Teleparty, Prime Party e WatchNest prometem a mesma coisa e são extensões de
   *   navegador: leem `video.currentTime` e chamam `play()` no contexto do site.
   *
   * A última é a que decide. A view é o site da Amazon, e injetar nela seria
   * também a única coisa que poderia extrair MPD, headers ou qualquer coisa do
   * stream.
   */
  const palco = ler('../web/components/player/PrimeStage.tsx');
  const video = ler('../web/components/player/VideoStage.tsx');
  const main = semComentario(ler('../desktop/electron/main/prime.ts'));

  // Nada de tocar no player de dentro.
  /*
   * O comentário acima cita `executeJavaScript` de propósito — é onde a pessoa
   * vai procurar. Por isso a regra é sobre o *código*, não sobre o arquivo:
   * citar o nome num comentário é a documentação que impede a feature.
   */
  const palcoCodigo = semComentario(palco);
  const videoCodigo = semComentario(video);
  assert.ok(!/executeJavaScript/.test(palcoCodigo), 'o palco não executa nada na view');
  assert.ok(!/executeJavaScript/.test(videoCodigo), 'e o VideoStage também não');
  assert.ok(
    !/querySelector|\.play\(\)|\.pause\(\)|currentTime\s*=/.test(palco),
    'e não mexe em currentTime, play ou pause do nada',
  );

  /*
   * O `executeJavaScript` que existe no `main` é o da sonda de DRM, numa view
   * descartável em `data:` — não na view que tem a sessão do Prime.
   */
  const linhas = main.split('\n').filter((l) => l.includes('executeJavaScript'));
  assert.equal(linhas.length, 1, 'uma única chamada, a da sonda');
  assert.ok(
    !/view\.webContents\.executeJavaScript/.test(main),
    'e nunca na view que tem a particao do Prime',
  );

  /*
   * O porque fica escrito onde ele vai ser consultado.
   *
   * O lugar onde alguém vai tentar acrescentar play/pause sincronizado é o bloco
   * de prontidão. Um "não" sem fonte na mesma tela vale mais do que um "não" num
   * documento que ninguém abre na hora de acrescentar a feature.
   */
  assert.match(
    palco,
    /Por que não é play\/pause sincronizado/,
    'o bloco de prontidão diz por que não há play/pause',
  );
  assert.match(palco, /Content API/, 'e cita a API oficial que foi verificada');
  assert.match(palco, /removida em[\s\S]{0,24}2024/, 'e que a Watch Party nativa saiu em 2024');
  assert.match(
    palco,
    /Teleparty, Prime Party, WatchNest/,
    'e como os terceiros fazem, para não parecer que ninguém pensou nisso',
  );

  /*
   * E o fallback existe de fato, inteiro: quem coordena começa a contagem, e
   * qualquer participante confirma e desfaz.
   */
  assert.match(palco, /onReady\(!jaPronto\)/, 'qualquer participante marca e desmarca');
  assert.match(palco, /onCountdown/, 'e quem conduz a sala começa a contagem');
  assert.match(palco, /onResync/, 'e recomeça do zero');
  assert.match(
    semComentario(ler('../server/src/socket.ts')),
    /if \(!canControl\(room, socket\.id\)\) return denied\(room\);\s*if \(typeof itemId !== 'string'\) return;\s*if \(!iniciarCountdown/,
    'a contagem exige controle da sala: uma pessoa sozinha não começa um filme para todo mundo',
  );
});
