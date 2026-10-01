import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { ehPaginaDeTitulo, ehDominioDeNavegacao, normalizarUrlDoPrime } from '../src/prime.js';

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

test('a navegação da view aceita Prime e login, e manda o resto ao navegador', () => {
  for (const host of ['primevideo.com', 'www.primevideo.com', 'amazon.com', 'www.amazon.com', 'smile.amazon.com']) {
    assert.ok(ehDominioDeNavegacao(host), `${host} deveria navegar dentro da view`);
  }
  for (const host of ['evilprimevideo.com', 'primevideo.com.atacante.net', 'notamazon.com', 'google.com']) {
    assert.equal(ehDominioDeNavegacao(host), false, `${host} não deveria navegar dentro da view`);
  }
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
