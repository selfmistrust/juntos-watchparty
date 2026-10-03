import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { ehPaginaDeTitulo, normalizarUrlDoPrime } from '../src/prime.js';
import {
  AREA_DE_AUTENTICACAO,
  TAMANHO_MAXIMO_DA_URL,
  ehAmazon,
  ehDominioPermitido,
  ehMesmoRetangulo,
  ehPrimeVideo,
  ehRotaDeAutenticacao,
  retanguloDeAutenticacao,
  rotaDeAutenticacao,
  urlDeTitulo,
  validarUrlPrime,
} from '../../desktop/electron/shared/dominioPrime.js';

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
   * `executeJavaScript` existe no arquivo, e é o que a sonda de DRM usa — numa view
   * descartável, que **não** é a view do Prime. A regra precisa ser mais específica
   * que "não usa executeJavaScript": o que não pode é rodar qualquer coisa na view
   * que tem a particao do Prime.
   *
   * E a sonda roda com as mesmas restrições da view do Prime — sandbox, sem Node,
   * sem preload — porque é o que faz a resposta valer para o caso real. Um CDM que
   * funciona só fora do sandbox não serviria para nada aqui.
   */
  const sonda = main.slice(
    main.indexOf('function sondarDrm('),
    main.indexOf('function motivoDaSonda('),
  );
  assert.ok(sonda.length > 0, "a sonda de DRM existe");
  assert.match(
    sonda,
    /new WebContentsView\(\{[\s\S]{0,200}webPreferences: \{[\s\S]{0,120}?sandbox: true/,
    'a sonda de DRM roda numa view própria, em sandbox',
  );
  assert.ok(
    !/view\.webContents\.executeJavaScript/.test(main),
    'nunca injeta JavaScript na view que tem a sessão do Prime',
  );
  /*
   * ## Esta trava mudou de lado, e é o achado mais importante do diagnóstico
   *
   * A versão anterior exigia `loadURL('data:text/html…')`. Ela estava **prendendo
   * o defeito**: EME só funciona em contexto seguro, e `data:` tem origem opaca —
   * `window.isSecureContext` é `false` ali.
   *
   * O Chromium responde `SecurityError` a um `requestMediaKeySystemAccess` em página
   * insegura, **com ou sem CDM instalado**. A sonda antiga traduzia qualquer falha em
   * "sem DRM", então teria dito que este build não tem DRM mesmo num Chromium que tem —
   * e a conclusão da conversa inteira sairia de uma medição que não media nada.
   *
   * Por isso a sonda sobe um servidor próprio em `127.0.0.1`, que o Chromium trata como
   * potencialmente confiável, e registra `isSecureContext` no log: a sonda verifica a
   * própria precondição, e um resultado negativo só vale se a página rodou segura.
   */
  assert.ok(
    !/data:text\/html/.test(main),
    'e a sonda nao usa data:, que nao e contexto seguro e faria ela responder SecurityError com ou sem CDM',
  );
  assert.ok(
    /createServer\(/.test(main) && /listen\(0, '127\.0\.0\.1'/.test(main),
    'a pagina da sonda sobe num servidor na loopback, que o Chromium trata como potencialmente confiavel',
  );
  assert.ok(
    /contextoSeguro/.test(main),
    'e a sonda registra se rodou em contexto seguro, porque sem isso um negativo nao prova nada',
  );
  /*
   * E a precondição vem **primeiro** no motivo, antes do nome do erro. Um
   * `SecurityError` com `contextoSeguro: false` é a sonda feita no lugar errado, e
   * dizer "não tem DRM" aí seria concluir a partir de uma medição inválida.
   */
  /*
   * A conferência é no **corpo** da função.
   *
   * A versão anterior media as posições no arquivo inteiro, e o nome do parâmetro
   * `contextoSeguro` na assinatura já resolvia a ordem — a trava passava com as três
   * verificações invertidas no corpo. É a forma mais comum de uma asserção que não
   * mede nada: ela encontra o texto, e não a ordem do que ele governa.
   */
  const motivo = main.slice(
    main.indexOf('function motivoDaSonda('),
    main.indexOf('const SONDA_DE_EME'),
  );
  const abreCorpo = motivo.indexOf('{');
  assert.ok(abreCorpo > 0, "a funcao de motivo existe");
  const corpo = motivo.slice(abreCorpo);
  const posDe = (t: string) => corpo.indexOf(t);

  assert.ok(posDe('apiExiste') > 0, "o motivo checa se a API existe");
  assert.ok(posDe('contextoSeguro') > 0, "e se o contexto era seguro");
  assert.ok(
    posDe("!apiExiste") < posDe("!contextoSeguro"),
    'a ausencia da API vem antes do contexto seguro no motivo',
  );
  assert.ok(
    posDe("!contextoSeguro") < posDe("'disponivel'"),
    'e o contexto seguro vem ANTES de declarar que ha DRM: um SecurityError numa pagina insegura e a sonda mal feita, nao a ausencia de CDM',
  );
  assert.ok(
    corpo.indexOf("tentativas.some((t) => t.endsWith(': ok'))") > posDe("!contextoSeguro"),
    'e so depois das duas precondicoes vem a leitura das tentativas',
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
  main.indexOf('function sondarDrm'),
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
    /if \(wc\.session !== session\.fromPartition\(PARTICAO\)\) return;/,
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
  /*
   * O import do `main` virou varias linhas quando entraram as funcoes de layout,
   * entao a trava olha a origem e nao a forma. O que ela precisa garantir e que o
   * `main` pegue a regra no modulo compartilhado, e nao defina a dele.
   */
  assert.match(main, /import \{[\s\S]{0,400}?\} from '\.\.\/shared\/dominioPrime';/,
    'ele importa do modulo compartilhado, que e o mesmo que o teste exercita',
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

test('a URL de login da Amazon entra inteira: sem teto de 2048, sem apagar a query', () => {
  /*
   * ## O defeito que estes testes existem para pegar
   *
   * Havia UMA função, `normalizar`, que decidia se a URL era válida **e** apagava
   * `search` e `hash`. Uma função com duas responsabilidades é uma função em que
   * uma sempre atrapalha a outra:
   *
   *   apagar a query é o que se quer para a URL que vai para a fila
   *   apagar a query é o que destrói um login em andamento
   *
   * E ela tinha `url.length > 2048` como recusa. A URL mais longa do fluxo não é
   * a de um título: é a de **signin OpenID**, que carrega `openid.return_to` (uma
   * URL inteira, percent-encoded), `openid.assoc_handle`, `openid.mode`,
   * `openid.ns`, `openid.sig`, `openid.signed` e `location`. Na prática isso passa
   * de 2048 com folga.
   *
   * Com o teto antigo, `normalizar` devolvia `null`, o `will-navigate` chamava
   * `preventDefault()` e mandava a URL para o navegador do sistema — **e o login
   * nunca completava dentro do app**. Quem via o sintoma achava que o Prime estava
   * recusando carregar.
   */

  // Uma URL de signin OpenID de tamanho real.
  const openid =
    'https://www.amazon.com.br/ap/signin' +
    '?openid.pape.max_auth_age=0' +
    '&openid.return_to=' +
    encodeURIComponent('https://na.primevideo.com/region/na/auth/return?_encoding=UTF8&ref_=ab_dp_mw_ab_web') +
    '&openid.mode=id_token' +
    '&openid.ns=https%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fid_token' +
    '&openid.assoc_handle=' +
    encodeURIComponent('https://juntos-watchparty.example/handle/'.repeat(30)) +
    '&openid.signed=text,email,name,postal_code' +
    '&openid.sig=' +
    'A'.repeat(1200) +
    '&location=' +
    encodeURIComponent('https://www.amazon.com.br/ap/signin?ref_=ap_signin_query') +
    '&oauth_consumer_key=amzn1.application-oa2-client.abc123' +
    '&aws_bucket=prime-video' +
    '&aws_service=DeviceService';

  /*
   * O tamanho real, medido — e não estimado. A URL acima tem que passar de 2048,
   * senão o teste não prova nada: um teto de 2048 a aceitaria.
   */
  assert.ok(
    openid.length > 2048,
    `a URL de teste tem que passar de 2048, e tem ${openid.length}`,
  );

  const u = validarUrlPrime(openid);
  assert.ok(u, 'a URL de signin OpenID é válida e é aceita');
  assert.equal(u.hostname, 'www.amazon.com.br', 'e o hostname é da loja regional');
  assert.ok(u.search.length > 1000, 'a query do OpenID está inteira');
  assert.ok(u.toString().includes('openid.sig='), 'incluindo openid.sig');
  assert.ok(u.toString().includes('openid.return_to='), 'e openid.return_to');
  assert.ok(u.toString().includes('openid.assoc_handle='), 'e openid.assoc_handle');
  assert.ok(u.toString().includes('openid.mode='), 'e openid.mode');
  assert.ok(u.toString().includes('openid.ns='), 'e openid.ns');

  /*
   * A separação: o que a validação devolve é a URL **integral**.
   *
   * `validarUrlPrime` não pode ter lado nenhum. Se ela limpasse a query, a
   * chamada seguinte do Chromium seria uma URL diferente da que a Amazon emitiu, e
   * o fluxo morreria em silêncio — sem erro, sem log, só a tela branca.
   */
  assert.equal(u.toString(), openid, 'a URL devolvida é byte a byte a que entrou');

  /*
   * O teto continua existindo, mas em 16 KB.
   *
   * Não é decoração: sem teto, `shell.openExternal` receberia uma URL de
   * gigabytes. E o teto não pode ser tão baixo que recuse o fluxo real.
   */
  assert.ok(TAMANHO_MAXIMO_DA_URL >= 16 * 1024, 'o teto é de 16 KB ou mais');
  assert.ok(
    validarUrlPrime(`https://www.amazon.com/ap/signin?x=${'a'.repeat(TAMANHO_MAXIMO_DA_URL)}`) === null,
    'e uma URL acima dele ainda é recusada',
  );

  /*
   * A função é só validação. Scheme e domínio continuam sob controle.
   */
  assert.equal(validarUrlPrime('javascript:alert(1)//https://www.amazon.com/ap/signin'), null);
  assert.equal(validarUrlPrime('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(validarUrlPrime('file:///etc/passwd'), null);
  assert.equal(validarUrlPrime('https://evilprimevideo.com/detail/x'), null);
  assert.equal(validarUrlPrime('https://amazon.com.br.evil.net/ap/signin'), null);
  assert.equal(validarUrlPrime(''), null);
  assert.equal(validarUrlPrime(undefined), null);
  assert.equal(validarUrlPrime(null), null);
  assert.equal(validarUrlPrime(42), null);
});

test('a URL de mídia só existe quando a página é um título, e nunca serve para logar', () => {
  /*
   * `urlDeTitulo` é a forma segura, e é o que vai para a fila. Ela **não** pode
   * aparecer em lugar nenhum que continue um login — e o teste abaixo de
   * "nenhum lugar do fluxo…" confere isso no código.
   *
   * Aqui a pergunta éoutra: o que ela devolve, e quando.
   *
   * O caminho é o que identifica o título, e a query é o que se descarta. Num
   * título comprado, a query é material de sessão — e sessão não viaja entre
   * participantes.
   */
  const DE_TITULO = 'https://www.primevideo.com/detail/the-bear/0K9Y7ZQ1FQV0WZ4KQ0MDM0MVRW';

  const titulo = validarUrlPrime(`${DE_TITULO}?ref_=hmg_x&_encoding=UTF8#ancla`);
  assert.ok(titulo, 'a URL do título é válida');
  assert.equal(
    urlDeTitulo(titulo),
    DE_TITULO,
    'e sai sem query nem âncora, que é o que pode ir para a sala',
  );

  /*
   * E o que não é título devolve string vazia — inclusive uma URL de signin.
   *
   * A consequência que importa: `urlDeTitulo` de uma página de login é vazia, e
   * por isso **não pode** servir para continuar um login. Uma URL de signin com a
   * query removida não é "a mesma página": é outra página, que não autentica
   * ninguém.
   */
  const vazios = [
    'https://www.amazon.com.br/ap/signin?openid.sig=ABC&openid.mode=id_token',
    'https://www.amazon.com/ap/signin',
    'https://www.primevideo.com/',
    'https://www.primevideo.com/store',
    'https://www.primevideo.com/search?k=matrix',
    'https://www.primevideo.com/detail',
    'https://www.primevideo.com/details/algum-filme',
  ];

  for (const url of vazios) {
    const u = validarUrlPrime(url);
    assert.ok(u, `${url} é uma URL válida`);
    assert.equal(
      urlDeTitulo(u),
      '',
      `${url} não é de um título, e não pode virar item de fila`,
    );
  }

  /*
   * A paridade com o servidor.
   *
   * O servidor decide o que entra na fila; o desktop decide o que oferece o
   * botão "Assistir com a sala". Se as duas respostas divergissem, o sintoma seria
   * o botão aparecendo numa página cuja URL o servidor recusa — e nenhum dos dois
   * lados falharia, cada um no seu teste.
   *
   * É o mesmo motivo de `CONTAGEM_REGRESSIVA_MS` ter o valor nos dois lados: o
   * contrato atravessa um processo, e a única forma de ele não divergir é alguém
   * conferir.
   */
  for (const url of [
    DE_TITULO,
    'https://www.primevideo.com/detail/algum-filme',
    'https://www.primevideo.com/dp/0ABC',
    'https://www.primevideo.com/title/0ABC',
    'https://www.primevideo.com/detail/0ABC?ref_=x',
    ...vazios,
  ]) {
    const peloDesktop = urlDeTitulo(validarUrlPrime(url)) !== '';
    const peloServidor = ehPaginaDeTitulo(url);
    assert.equal(
      peloDesktop,
      peloServidor,
      `os dois lados precisam concordar em ${url}`,
    );
  }
});

test('nenhum lugar do fluxo de autenticação usa a URL canônica do título', () => {
  /*
   * `urlDeTitulo` é a forma segura e é o que vai para a fila. Ela **não** pode
   * aparecer em lugar nenhum que continue um login:
   *
   *   will-navigate              decide; a URL que o Chromium usa é a dele
   *   setWindowOpenHandler       decide; o Chromium navega o popup
   *   prime:navegar              carrega a URL integral
   *
   * E `descrever` — o que vai para o renderer — é o único lugar onde a forma
   * canônica aparece, e é o lugar certo: a fila precisa dela.
   */
  const main = semComentario(ler('../desktop/electron/main/prime.ts'));

  // 1. `prime:navegar` carrega a integral.
  const navegar = main.slice(main.indexOf("ipcMain.handle('prime:navegar'"), main.indexOf("ipcMain.handle('prime:pagina'"));
  assert.match(navegar, /validarUrlPrime\(url\)/, 'prime:navegar valida o que chegou');
  assert.match(
    navegar,
    /view\.webContents\.loadURL\(u\.toString\(\)\)/,
    'e carrega a URL que a validação devolveu — a integral',
  );
  assert.ok(
    !/urlDeTitulo/.test(navegar),
    'e em nenhum momento a forma canônica do título entra no caminho do login',
  );

  // 2. O filtro só decide, e não reconstrói.
  const filtro = main.slice(
    main.indexOf("app.on('web-contents-created'"),
    main.indexOf('function abrir('),
  );
  assert.match(filtro, /if \(validarUrlPrime\(url\)\) return;/, 'o filtro valida e deixa passar');
  assert.match(filtro, /evento\.preventDefault\(\)/, 'ou cancela');
  assert.ok(
    !/loadURL/.test(filtro),
    'e nunca chama loadURL: reescrever a URL teria dois pedidos de navegação em voo',
  );
  assert.ok(
    !/\.search\s*=/.test(filtro),
    'e nunca mexe em search',
  );

  // 3. O popup só decide, e a URL não é passada nas opções.
  const popup = main.slice(main.indexOf('setWindowOpenHandler'), main.indexOf("did-navigate'"));
  assert.match(popup, /validarUrlPrime\(url\)/, 'o popup valida o domínio');
  assert.match(popup, /action: 'allow'/, 'e deixa abrir');
  /*
   * A URL não pode aparecer em chave nenhuma da resposta do handler.
   *
   * A versão anterior procurava `url` nos 200 caracteres depois de
   * `overrideBrowserWindowOptions`, e a chave estava ANTES dele — o defeito
   * passava inteiro. Aqui a busca é na fatia toda.
   */
  assert.ok(
    !/\burl\s*:/.test(popup),
    'e a URL nao entra em chave nenhuma da resposta: o Chromium navega o popup para a que ele produziu',
  );
  const opcoes = main.slice(
    main.indexOf('function opcoesDaJanelaDeLogin'),
    main.indexOf('function instalarFiltroDeNavegacao'),
  );
  assert.match(
    opcoes,
    /partition: PARTICAO/,
    'e a janela do login usa a mesma particao da view, que e o que faz o POST cair no Prime',
  );

  // 4. `descrever` é onde a forma canônica aparece, e só encher o `url`.
  const descrever = main.slice(main.indexOf('function descrever'), main.indexOf('function publicar'));
  assert.match(
    descrever,
    /const midia = urlDeTitulo\(u\);\s*return \{\s*url: midia,/,
    'a forma canônica vai no campo url da página, que é o que a fila consome',
  );
  assert.ok(
    !/loadURL/.test(descrever),
    'e descrever não navega para lugar nenhum',
  );
});

test('o log não imprime a query da Amazon', () => {
  /*
   * ## Por que esta forma
   *
   * A primeira versão desta trava era um regex que proibia `search`, `hash`,
   * `cookie` e `token` na função de log. Duas coisas erradas nela:
   *
   *   proíbe também dizer que **havia** query, que é a informação que o log
   *   existe para dar;
   *   e o regex era frouxo o bastante para casar com `${u ? u.search` — sem
   *   fechamento nenhum, porque `[^}]*` atravessa o `?`. Ele acusava código que
   *   estava certo, que é o jeito mais rápido de desabilitar uma trava.
   *
   * A forma útil é mais estreita: **toda** menção a `search` em `registrar` tem
   * que ser a comparação com string vazia, e `hash` não pode aparecer.
   */
  const main = ler('../desktop/electron/main/prime.ts');
  const codigo = semComentario(main);

  const registrar = codigo.slice(
    codigo.indexOf('function registrar('),
    codigo.indexOf('function descrever('),
  );
  assert.ok(registrar.length > 0, 'a função de registro existe');

  /*
   * Toda ocorrência de `search` é a comparação que produz um booleano.
   *
   * `${u.search !== ''}` não vaza nada: vira `true` ou `false`. `${u.search}`
   * vazia a query inteira — que é o estado do fluxo OpenID, com `openid.sig`,
   * `openid.signed`, `openid.assoc_handle` e `location`.
   */
  const ocorrencias = registrar.match(/search/g) ?? [];
  assert.ok(ocorrencias.length > 0, 'e o log menciona search, porque é assim que diz que havia query');

  const permitidas = registrar.match(/u\.search !== ''/g) ?? [];
  assert.equal(
    ocorrencias.length,
    permitidas.length,
    'toda menção a search é a comparação com string vazia, e nenhuma outra',
  );

  // E o que não pode aparecer de jeito nenhum.
  for (const proibido of ['hash', 'searchParams', 'credentials', 'cookie', 'crud=']) {
    assert.ok(
      !new RegExp(`\\b${proibido}`, 'i').test(registrar),
      `o log não menciona ${proibido}`,
    );
  }

  /*
   * E os campos pedidos estão todos lá.
   *
   * É o que permite ler um relatório de bug e ver onde o login parou, sem abrir
   * nada que seja credencial.
   */
  for (const [campo, rotulo] of [
    ['${evento}', 'evento'],
    ['u.hostname', 'hostname'],
    ['u.pathname', 'pathname'],
    ['cru.length', 'urlLength'],
    ['u.search', 'hasQuery'],
    ['popup', 'popup'],
  ] as const) {
    assert.ok(registrar.includes(campo), `o log registra ${rotulo}`);
  }

  /*
   * O `pathname` é truncado.
   *
   * Um caminho de 4 KB numa linha de log não ajuda ninguém, e o log de um app
   * desktop é o que a pessoa cola num relatório de bug.
   */
  assert.match(
    registrar,
    /u\.pathname\.slice\(0, PATHNAME_NO_LOG\)/,
    'e o caminho vai cortado',
  );

  /*
   * Os eventos que importam estão todos registrados — é a lista que fecha o
   * diagnóstico do fluxo. Sem eles, um relatório de bug diz que "não entrou"
   * sem dizer onde parou.
   *
   * A checagem é pelo texto, e não por aspas: dois deles são registrados com
   * template literal (`view criada na particao ...`) e um com o prefixo `[prime]`
   * grudado na string. Procurar aspas acusaria código que está certo.
   */
  for (const evento of [
    'navegou',
    'navegou na pagina',
    'popup permitido',
    'popup bloqueado',
    'navegacao bloqueada',
    'navegar',
    'navegar recusado',
    'view criada na particao',
    'sessao criada sem override de UA',
    'view fechada',
    'view ligada',
  ]) {
    assert.ok(codigo.includes(evento), `o log registra "${evento}"`);
  }

  /*
   * E o campo `popup` é preenchido de verdade, e não por acaso.
   *
   * Os dois eventos de popup passam `true`; os de navegação passam o default
   * `false`. Um `popup` sempre falso deixaria o log incapaz de distinguir "a
   * janela de login abriu" de "a view navegou", que são justamente as duas
   * coisas que um bug de login precisa separar.
   */
  assert.match(registrar, /popup = false/, 'o campo popup tem valor padrao');
  assert.match(main, /registrar\('popup permitido', url, true\)/, 'e o popup permitido marca popup=true');
  assert.match(main, /registrar\('popup bloqueado', url, true\)/, 'e o popup bloqueado tambem');

  /*
   * O User-Agent fixo saiu, e a trava precisa se manter de pé.
   *
   * O UA fixo dizia `Chrome/130.0.0.0`, e o Electron 33 embarca outro Chromium.
   * Um UA que não bate com o motor faz a Amazon responder com uma variante
   * diferente de página, que é indistinguível de "o Prime não funciona aqui".
   *
   * Este é um teste: sem override, o Chromium manda o UA dele, que é o único que
   * ele consegue honour. Se o login funcionar assim, a linha volta a ser um
   * problema a investigar — e não antes.
   */
  assert.ok(
    !/setUserAgent/.test(codigo),
    'nenhuma chamada a setUserAgent na particao do Prime',
  );
  assert.ok(!/USER_AGENT/.test(codigo), 'e a constante do UA fixo tambem saiu do codigo');
  /*
   * O arquivo pode citar o UA antigo: o comentário que explica por que ele saiu
   * precisa nomeá-lo. O que não pode é ele existir como código.
   */
  assert.ok(!/Chrome\/130/.test(codigo), 'e o UA fixo saiu do codigo');

  /*
   * E o log diz qual UA a sessão está usando.
   *
   * Sem isso, um override que voltasse por outro caminho — uma configuração da
   * partição, um switch de linha de comando — não apareceria em lugar nenhum, e o
   * relatório de bug continuaria sem a informação que o explicaria.
   */
  assert.match(
    codigo,
    /sessao criada sem override de UA/,
    'e o log registra a decisao sobre o UA',
  );
  assert.match(
    codigo,
    /getUserAgent\(\)/,
    'incluindo o UA real que a sessao esta usando',
  );
});

test('o layout do login da Amazon fica numa caixa centralizada, e some quando ele volta', () => {
  /*
   * ## O defeito que este teste existe para pegar
   *
   * A view ocupava a área inteira do player — cerca de 1900 pixels numa janela
   * maximizada — em toda página, inclusive nas de login. A página de login da
   * Amazon é desenhada para uma janela de navegador comum: o contêiner do
   * formulário é posicionado numa medida que ela escolheu, e a 1900 pixels ele
   * cai na borda direita, fora do campo de visão. Quem via o sintoma descrevia
   * "o formulário aparece quase todo fora da tela, no lado direito", e era
   * exatamente isso.
   *
   * A correção não é no site da Amazon — é dar a ele a largura para a qual ele
   * foi desenhado. E é só isso: nenhum `loadURL`, nenhum cookie, nenhuma
   * sessão nova.
   */
  /*
   * ## As rotas de login
   *
   * A lista é fechada, e é o `/ap/` mais o nome que decide. A versão com
   * curinga — `ap/<qualquer coisa>` — pegaria `/ap/marketing`, que é uma tela de
   * campanha da Amazon, e o defeito viraria o oposto: uma tela de catálogo
   * espremida numa caixa de 650 pixels.
   */
  const deLogin = [
    'https://www.amazon.com.br/ap/signin?openid.sig=ABC&openid.mode=id_token',
    'https://www.amazon.com/ap/signin',
    'https://www.amazon.com/ap/signin-select',
    'https://www.amazon.com/ap/mfa',
    'https://www.amazon.com.br/ap/cvf',
    'https://www.amazon.co.uk/ap/challenge',
    'https://www.amazon.com/ap/register',
    'https://www.amazon.com/ap/forgotpassword',
    'https://www.amazon.com/ap/verifycode',
    'https://www.amazon.com/ap/otp',
  ];
  for (const url of deLogin) {
    const u = validarUrlPrime(url);
    assert.ok(u, `${url} e uma URL valida`);
    assert.ok(
      ehRotaDeAutenticacao(u),
      `${rotaDeAutenticacao(u)} e tela de login, e a view tem de encolher`,
    );
  }

  /*
   * E o que **nao** e tela de login nao encolhe — que e a metade da garantia que
   * importa, porque o custo de encolher a view no lugar errado e alto: o
   * catalogo do Prime fica espremido numa caixa, que e o sintoma que estamos
   * tentando eliminar.
   */
  const deCatalogo = [
    'https://www.primevideo.com/',
    'https://www.primevideo.com/detail/the-bear/0ABC?ref_=hmg_x',
    'https://www.primevideo.com/store',
    'https://www.primevideo.com/search?k=matrix',
    'https://www.amazon.com.br/',
    'https://www.amazon.com.br/gp/css/homepage.html',
    'https://www.amazon.com.br/ap/marketing',
    'https://www.amazon.com.br/ap/',
    'https://www.amazon.com.br/gp/help/customer/display.html',
    'https://www.amazon.com.br/ap/signinando',
  ];
  for (const url of deCatalogo) {
    const u = validarUrlPrime(url);
    assert.ok(u, `${url} e uma URL valida`);
    assert.equal(
      ehRotaDeAutenticacao(u),
      false,
      `${url} nao e tela de login, e a view tem de continuar na area toda`,
    );
  }

  /*
   * Antes da primeira navegacao nao ha rota nenhuma, e isso e resposta valida.
   *
   * `validarUrlPrime` devolve `null` para `about:blank`, e quem pergunta e o
   * codigo que posiciona a view — que e chamado exatamente quando a view acabou
   * de nascer e ainda nao foi navigatione.
   */
  assert.equal(rotaDeAutenticacao(null), '');
  assert.equal(ehRotaDeAutenticacao(null), false);

  /*
   * ## A caixa
   *
   * Centralizada na area do player, e do tamanho que o formulario da Amazon foi
   * desenhado para ter.
   */
  const area = { x: 0, y: 80, width: 1900, height: 780 };
  const caixa = retanguloDeAutenticacao(area);

  assert.equal(caixa.width, 650, 'a largura e a do formulario');
  assert.equal(caixa.height, 750, 'e a altura');
  assert.equal(
    caixa.x,
    Math.round((1900 - 650) / 2),
    'e fica no meio horizontal da area',
  );
  assert.equal(
    caixa.y,
    Math.round(80 + (780 - 750) / 2),
    'e no meio vertical',
  );
  assert.ok(
    caixa.x >= area.x && caixa.y >= area.y,
    'e nunca começa antes da area',
  );
  assert.ok(
    caixa.x + caixa.width <= area.x + area.width &&
      caixa.y + caixa.height <= area.y + area.height,
    'e nunca passa do fim da area',
  );

  /*
   * As medidas do enunciado, com a faixa em volta.
   */
  assert.ok(
    AREA_DE_AUTENTICACAO.largura >= 520 && AREA_DE_AUTENTICACAO.largura <= 650,
    'a largura cabe na faixa de 520 a 650',
  );
  assert.ok(
    AREA_DE_AUTENTICACAO.altura >= 650 && AREA_DE_AUTENTICACAO.altura <= 750,
    'e a altura cabe na de 650 a 750',
  );

  /*
   * ## A area estreita: a caixa tem de caber nela
   *
   * Janela pequena com o painel lateral aberto e a area do player fica com
   * pouco mais de 600 pixels. Um piso fixo de 520 caberia, mas o de 650 nao — e a
   * view ultrapassando a area cobre o chat de novo, que e o defeito que a
   * remoção da view do `contentView` resolveu.
   *
   * Por isso a funcao usa so `min`: o menor valor nao e um piso, e o que a area
   * permite.
   */
  for (const [w, h] of [
    [1900, 780],
    [700, 400],
    [640, 360],
    [420, 300],
    [120, 90],
  ]) {
    const pequena = { x: 300, y: 100, width: w, height: h };
    const r = retanguloDeAutenticacao(pequena);
    assert.ok(r.width <= w && r.height <= h, `a caixa cabe em ${w}x${h}`);
    assert.ok(r.width >= 1 && r.height >= 1, `e nao vira tamanho zero em ${w}x${h}`);
    assert.ok(
      r.x >= pequena.x && r.x + r.width <= pequena.x + w,
      `e fica dentro da area em ${w}x${h}`,
    );
    assert.ok(
      r.y >= pequena.y && r.y + r.height <= pequena.y + h,
      `e na vertical tambem em ${w}x${h}`,
    );
    assert.ok(
      Number.isInteger(r.x) && Number.isInteger(r.y) &&
        Number.isInteger(r.width) && Number.isInteger(r.height),
      `e sai em pixel inteiro em ${w}x${h}`,
    );
  }

  /*
   * E o que a funcao devolve nao depende do `this`, nem de nada la fora: a mesma
   * area produz a mesma caixa em duas chamadas seguidas.
   */
  assert.deepEqual(retanguloDeAutenticacao(area), caixa);
});

test('ehMesmoRetangulo separa "nao mudou" de "ainda nao apliquei"', () => {
  /*
   * `resize` dispara dezenas de vezes por segundo durante um arrasto de janela, e
   * `setBounds` a cada um deles e compositor trabalhando a toa. E o log e
   * ilegivel com uma linha por quadro.
   *
   * A distincao que importa e a do `null`: sem area conhecida ainda, nada foi
   * aplicado — e comparar `null` com `null` como iguais fecharia a porta antes de
   * a primeira aplicacao, e a view ficaria em `0,0,0,0`.
   */
  const r = { x: 10, y: 20, width: 650, height: 750 };

  assert.equal(ehMesmoRetangulo(r, { ...r }), true, 'o mesmo retangulo duas vezes');
  assert.equal(ehMesmoRetangulo(null, null), true, 'nada aplicado duas vezes');
  assert.equal(ehMesmoRetangulo(null, r), false, 'nada aplicado, e algo a aplicar');
  assert.equal(ehMesmoRetangulo(r, null), false, 'o inverso');

  for (const campo of ['x', 'y', 'width', 'height'] as const) {
    assert.equal(
      ehMesmoRetangulo(r, { ...r, [campo]: r[campo] + 1 }),
      false,
      `mexer em ${campo} conta como mudanca`,
    );
  }
});

test('a view so muda de tamanho: nenhum loadURL, nenhuma sessao, nenhum cookie', () => {
  /*
   * O motivo de `updatePrimeBounds` existir como uma funcao so, e nao espalhada
   * pelos gatilhos: mudar o layout **nao pode** passar por nenhum caminho que
   * toque navegacao ou sessao.
   *
   * A versao anterior do login falhava porque uma URL OpenID longa era barrada
   * na validacao e o POST do formulario ia para o navegador do sistema. Qualquer
   * "correcao" de layout que reabra um caminho de navegacao traz o defeito de
   * volta por outro nome.
   */
  const main = semComentario(ler('../desktop/electron/main/prime.ts'));

  const corpo = main.slice(
    main.indexOf('function updatePrimeBounds('),
    main.indexOf('function esquecerArea('),
  );

  assert.ok(corpo.length > 0, 'a funcao existe');

  // Nenhuma das tres coisas que quebrariam o login.
  assert.ok(!/loadURL/.test(corpo), 'nenhum loadURL: mudar tamanho nao e navegar');
  assert.ok(!/fromPartition/.test(corpo), 'nenhuma sessao nova');
  assert.ok(!/session\./.test(corpo), 'e nenhuma troca de sessao');
  assert.ok(!/cookie|Cookie/.test(corpo), 'e nenhum cookie');
  assert.ok(!/executeJavaScript|insertCSS|setUserAgent/.test(corpo), 'e nada injetado na pagina');

  // O que ela pode fazer: mover a view e ajustar o zoom.
  assert.match(corpo, /view\.setBounds\(destino\)/, 'a view e movida');
  assert.match(corpo, /setZoomFactor\(1\)/, 'e o zoom e garantido em 1');
  assert.match(corpo, /getZoomFactor\(\)/, 'depois de comparado, para nao chamar a toa');

  /*
   * O zoom so volta a 1 porque ele e medido antes: um `setZoomFactor(1)` sem
   * `getZoomFactor` seria uma chamada por quadro de arrasto de janela.
   */
  assert.ok(
    corpo.indexOf('getZoomFactor()') < corpo.indexOf('setZoomFactor(1)'),
    'e o zoom e lido antes de ser escrito',
  );

  /*
   * Os dois modos sao o unico par de decisao: caixa, ou area toda.
   *
   * E `retanguloDeAutenticacao` so aparece na escolha — nunca no `setBounds` de
   * outro lugar, e nunca dentro do `prime:navegar`, que e o caminho que carrega
   * a URL integral do login.
   */
  assert.match(
    corpo,
    /const destino = autenticando \? retanguloDeAutenticacao\(areaDoPlayer\) : areaDoPlayer;/,
    'a escolha e entre a caixa e a area, e nada mais',
  );

  const navegar = main.slice(
    main.indexOf("handle('prime:navegar'"),
    main.indexOf("handle('prime:pagina'"),
  );
  assert.ok(
    !/retanguloDeAutenticacao|updatePrimeBounds/.test(navegar),
    'e o prime:navegar nao tem nada de layout dentro',
  );
});

test('o layout e recalculado nos cinco momentos em que a area ou a rota mudam', () => {
  const main = ler('../desktop/electron/main/prime.ts');
  const codigo = semComentario(main);

  /*
   * A area muda por quatro motivos, e nenhum deles e a mesma coisa:
   *
   *   `prime:abrir`         o palco montou, ou o ResizeObserver disparou — e ele
   *                         cobre o painel, a divisoria e a tela cheia
   *   `did-navigate`        a rota mudou, e a rota decide o modo
   *   `did-navigate-in-page` a rota mudou sem sair da pagina
   *   `resize` da janela     o renderer as vezes nao chega, e o main se mexer
   *   tela cheia            a mesma medida, evento proprio
   *
   * Deixar um de fora e um retangulo que nao acompanha a janela — e o sintoma e
   * a view cobrindo o chat ou o cabecalho, que e o pior que pode acontecer.
   */
  const abrir = codigo.slice(
    codigo.indexOf('function abrir('),
    codigo.indexOf('function sondarDrm('),
  );
  assert.match(
    abrir,
    /areaDoPlayer = bounds;/,
    'prime:abrir guarda a area medida pelo renderer',
  );
  assert.match(abrir, /updatePrimeBounds\(\);/, 'e delega o posicionamento');

  const publicar = codigo.slice(
    codigo.indexOf('function publicar('),
    codigo.indexOf('function destruir('),
  );
  assert.match(
    publicar,
    /updatePrimeBounds\(\);/,
    'a mudanca de rota reposiciona a view',
  );

  const ligar = codigo.slice(codigo.indexOf('export function ligarPrimeJanela('));
  for (const evento of ['resize', 'enter-full-screen', 'leave-full-screen']) {
    assert.match(
      ligar,
      new RegExp(`janela\\.on\\('${evento}', \\(\\) => updatePrimeBounds\\(\\)\\)`),
      `a janela ${evento} reposiciona a view`,
    );
  }

  const destruir = codigo.slice(
    codigo.indexOf('function destruir('),
    codigo.indexOf('function abrir('),
  );
  assert.match(
    destruir,
    /esquecerArea\(\);/,
    'e fechar a view esquece a area, para a proxima sessao nao herdar o retangulo antigo',
  );

  /*
   * E `esquecerArea` limpa o que ela guardou. Deixar `retanguloAplicado` para
   * tras faz a comparacao dizer "nao mudou" na primeira chamada da proxima
   * sessao, e a view nasce em 0,0,0,0 — invisivel, sem erro, sem log.
   */
  const esquecer = codigo.slice(
    codigo.indexOf('function esquecerArea('),
    codigo.indexOf('function descrever('),
  );
  for (const campo of [
    'areaDoPlayer = null',
    'retanguloAplicado = null',
    'layoutRegistrado = null',
    'modoAutenticacao = false',
  ]) {
    assert.ok(esquecer.includes(campo), `esquecerArea limpa ${campo}`);
  }
});

test('o log do layout diz o modo, a rota, o retangulo e o zoom', () => {
  const main = ler('../desktop/electron/main/prime.ts');
  const codigo = semComentario(main);

  const corpo = codigo.slice(
    codigo.indexOf('function updatePrimeBounds('),
    codigo.indexOf('function esquecerArea('),
  );

  for (const campo of [
    'authMode=',
    'rota=',
    'pathname=',
    'bounds={',
    'area={',
    'zoomFactor=',
    'modo=',
  ]) {
    assert.ok(corpo.includes(campo), `o log traz ${campo.replace(/=$|=?\{$/, '')}`);
  }

  /*
   * Uma linha so, e nao cinco.
   *
   * Sao os mesmos dados que o enunciado pedia em linhas separadas, e numa linha
   * eles sao utilizaveis: da para ver o modo e o retangulo juntos, e ver o que
   * mudou de uma navegacao para a outra sem abrir o log de outro dia.
   */
  const linhas = corpo.match(/`\[prime\] layout/g) ?? [];
  assert.equal(linhas.length, 1, 'uma unica linha de log');

  /*
   * E ela so e escrita quando algo mudou de verdade.
   *
   * `resize` dispara dezenas de vezes por segundo, e uma linha por quadro torna
   * o arquivo ilegivel no exato momento em que a pessoa está tentando ler o
   * log para diagnosticar.
   */
  const abriu = '  if (!mudouBounds && !mudouModo) return;';
  assert.match(
    corpo,
    new RegExp(abriu.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'e a funcao sai antes quando nada mudou',
  );
  assert.match(corpo, /if \(linha !== layoutRegistrado\)/, 'e nao repete linha identica');

  /*
   * O `pathname` vai truncado, pelo mesmo motivo do log de navegação: uma URL
   * OpenID anexada ao pathname produz uma linha de log de 3 KB.
   */
  assert.match(
    corpo,
    /urlAtual\.pathname\.slice\(0, PATHNAME_NO_LOG\)/,
    'e o caminho vai cortado',
  );

  /*
   * E o `setBounds` está **dentro** do guarda de "mudou".
   *
   * Sem esta trava, `const mudouBounds = false` passava a suíte inteira: a
   * comparação existia, o log existia, `updatePrimeBounds` era chamado nos
   * lugares certos — e `setBounds` nunca acontecia, porque ninguém o alcançava.
   * A view ficava em `0,0,0,0`, invisível, sem erro e sem uma linha de log que
   * explicasse. É o defeito que a comparação existe para evitar, e o modo de
   * reintroduzi-lo é trocar a guarda, não apagá-la.
   */
  assert.match(
    corpo,
    /const mudouBounds = !ehMesmoRetangulo\(retanguloAplicado, destino\);/,
    'a mudanca e calculada comparando com o retangulo ja aplicado',
  );
  assert.match(
    corpo,
    /if \(mudouBounds\) \{[\s\S]{0,500}?view\.setBounds\(destino\);/,
    'e o setBounds acontece dentro do guarda',
  );

  /*
   * O zoom reported e o que ficou, e nao o que foi lido: quando o app corrige um
   * zoom herdado, o log precisa dizer 1 — o valor efetivo — ou a linha mente
   * sobre o estado da tela.
   */
  assert.match(
    corpo,
    /zoomFactor=\$\{zoom !== 1 \? 1 : zoom\}/,
    'e o log reporta o zoom efetivo',
  );
});

test('a permissão mediaKeySystem é liberada só para o Prime, e só a ele', () => {
  /*
   * ## A partição não tinha handler nenhum
   *
   * A do `defaultSession` — que libera `display-capture`, `media` e `fullscreen` —
   * não valia para a partição do Prime: `setPermissionRequestHandler` é por
   * sessão. Então a política do Prime era a do Electron para sessão sem handler, e
   * ninguém no projeto tinha escrito isso em lugar nenhum.
   *
   * Registrar um handler para tratar `mediaKeySystem` significa escolher a política
   * das outras permissões junto, porque não existe "delegar ao padrão". Por isso a
   * lista é explícita: o que não está nela é recusado, e o que entrou é o que o
   * site do Prime precisa.
   */
  const main = semComentario(ler('../desktop/electron/main/prime.ts'));

  /*
   * Da lista até o fim dos dois handlers.
   *
   * A versão anterior parava em `origemDoPrimeTemDrm`, que vem **antes** dos
   * handlers — e a fatia ficava sem nenhum deles, com o teste acusando código que
   * estava certo.
   */
  const permissoes = main.slice(
    main.indexOf('const PERMISSOES_DO_PRIME'),
    main.indexOf('function requestingUrlDoPedido('),
  );
  assert.ok(permissoes.length > 0, 'a lista de permissões do Prime existe');

  // 1. A permissão de DRM não está na lista genérica: ela é tratada à parte.
  assert.ok(
    !/PERMISSOES_DO_PRIME[\s\S]{0,400}?mediaKeySystem/.test(
      permissoes.slice(0, permissoes.indexOf('const PERMISSAO_DRM')),
    ),
    'mediaKeySystem fica fora da lista genérica, porque é escopada por domínio',
  );

  // 2. Os dois handlers, e não só um.
  assert.match(
    permissoes,
    /setPermissionCheckHandler\(/,
    'existe o handler de check, que é o que resolve na prática',
  );
  assert.match(
    permissoes,
    /setPermissionRequestHandler\(/,
    'e existe o de request, que a documentação exige junto',
  );
  /*
   * E registrado com uma função, não removido.
   *
   * `setPermissionRequestHandler(null)` casava com o `assert.match` do nome do método —
   * desregistrar o handler passava a trava. A trava tinha de ver o argumento.
   */
  assert.ok(
    !/setPermission(Request|Check)Handler\(null\)/.test(permissoes),
    'e nenhum dos dois e desregistrado: null devolve a politica do Electron para a particao',
  );
  assert.ok(
    /setPermissionRequestHandler\(\(_wc, permissao, callback, details\) =>/.test(permissoes),
    'e o de request recebe funcao, com os parametros que ele usa',
  );

  /*
   * Nenhum dos dois handlers pode liberar tudo.
   *
   * A trava olha **os handlers**, e não a fatia toda: `origemDoPrimeTemDrm` tem um
   * `return true` legítimo — é a resposta para um host que já foi conferido. Varrer a
   * fatia inteira acusaria a regra certa, e o jeito mais rápido de desabilitar uma
   * trava é fazê-la errar em código que está bom.
   */
  const handlers = main.slice(
    main.indexOf('function instalarPermissoesDoPrime('),
    main.indexOf('function origemDoPrime('),
  );
  assert.ok(handlers.length > 0, "os dois handlers estão na função de instalação");
  assert.ok(
    !/callback\(true\)/.test(handlers) && !/return true;/.test(handlers),
    'nenhum handler tem caminho que conceda sem consultar a regra',
  );
  assert.ok(
    /callback\(ok\)/.test(handlers),
    'e o callback sempre recebe o resultado da consulta',
  );

  /*
   * E a regra é o mesmo `ehDominioPermitido` da navegação.
   *
   * Uma lista de domínios própria aqui seria uma segunda porta que a regra de
   * domínio não fecha — e a regra de domínio é a única coisa que impede um
   * popup de terceiro de tomar a área do player.
   */
  const origem = main.slice(
    main.indexOf('function origemDoPrimeTemDrm('),
    main.indexOf('function instalarPermissoesDoPrime('),
  );
  assert.match(
    origem,
    /if \(ehDominioPermitido\(host\)\) return true;/,
    'e a regra é a mesma da navegação, e não uma lista nova',
  );

  /*
   * Mais a origem local do próprio app, e por quê.
   *
   * A sonda de DRM roda em `http://127.0.0.1`. Sem esta linha ela cairia em
   * `SecurityError` por falta de permissão, e o diagnóstico do build passaria a
   * medir a própria política em vez do CDM.
   *
   * E não abre nada: `mediaKeySystem` dá acesso ao que a **própria origem**
   * serve, e a página da sonda não serve conteúdo.
   */
  assert.match(
    origem,
    /host === '127\.0\.0\.1' \|\| host === 'localhost'/,
    'e a origem local do app, que é de onde a sonda roda',
  );

  /*
   * A URL do frame que pediu tem precedência sobre a do documento de topo.
   *
   * O Prime tem iframe de anúncio e de player de terceiros. Se o handler usasse
   * o `getURL()` do webContents, um iframe poderia pedir DRM em nome da página de
   * topo — que é exatamente o que a checagem de origem existe para impedir.
   */
  const pedido = main.slice(
    main.indexOf('function requestingUrlDoPedido('),
    main.indexOf('function requestingUrlDoWebContents('),
  );
  assert.match(pedido, /'requestingUrl' in details/, 'o requestingUrl do frame é lido');
  assert.match(
    main.slice(main.indexOf('function instalarPermissoesDoPrime(')),
    /requestingUrlDoPedido\(details, requestingUrlDoWebContents\(_wc\)\)/,
    'e ele tem precedência sobre o URL do webContents',
  );

  /*
   * Um `new URL` sem `try` derrubaria o processo principal.
   *
   * `requestingOrigin` vem do Chromium e a doc não promete que é sempre uma URL
   * bem formada; uma exceção aqui derrubaria o `main` inteiro, que é o app
   * inteiro. E a origem de um site que não é do Prime tem de dar `false`, não
   * erro.
   */
  assert.match(origem, /try \{/, 'a origem é lida dentro de um try');
  assert.match(origem, /\} catch \{\s*return false;/, 'e uma URL inválida recusa, não derruba');
  assert.match(origem, /typeof origem !== 'string'/, 'e o que não é string é recusado');

  /*
   * A lista precisa ter o que o player do Prime usa, ou a instalação quebra o
   * player em vez de só negar o DRM.
   *
   * `fullscreen` é o caso concreto: o botão de tela cheia do Prime pede
   * `fullscreen`, e uma política que recusa tudo por omissão transformaria o
   * diagnóstico de DRM em um player quebrado por outro motivo.
   */
  for (const necessaria of [
    'fullscreen',
    'automatic-fullscreen',
    'media',
    'clipboard-sanitized-write',
  ]) {
    assert.ok(
      new RegExp(`'${necessaria}'`).test(permissoes),
      `a permissão ${necessaria} continua liberada, porque o player precisa dela`,
    );
  }

  /*
   * E o que dá controle do aparelho a uma página de terceiro fica de fora.
   */
  for (const perigosa of [
    'geolocation',
    'notifications',
    'hid',
    'usb',
    'serial',
    'bluetooth',
    'midi',
    'payment-handler',
    'window-management',
    'local-network',
    'storage-access',
  ]) {
    assert.ok(
      !new RegExp(`'${perigosa}'`).test(permissoes),
      `${perigosa} nao entra na lista do Prime`,
    );
  }
});

test('o log de DRM separa os três casos, e não imprime nada de protegido', () => {
  const main = ler('../desktop/electron/main/prime.ts');
  const codigo = semComentario(main);

  /*
   * A linha de log é o diagnóstico que a pessoa entrega. Ela precisa responder:
   *
   *   `disponivel=false motivo=NotSupportedError`  o build não tem CDM
   *   `disponivel=false motivo=NotAllowedError`    a permissão foi negada
   *   `disponivel=false motivo=contexto nao seguro` a sonda rodou no lugar errado
   *   `disponivel=true  motivo=disponivel`          tem CDM — e aí o caso é outro
   *
   * Sem `tentativas` e sem `motivo`, um `false` não distingue "sem DRM" de
   * "permissão barrada", que são duas conclusões e duas decisões diferentes.
   */
  /*
   * `prime:pagina` vem **antes** de `prime:tem-drm` na ordem dos canais, e
   * `slice` com começo maior que o fim devolve string vazia — que produz um
   * `assert.ok` falhando sem dizer nada sobre o código. A fatia vai do canal até o
   * fim da função que registra todos.
   */
  const ipc = codigo.slice(
    codigo.indexOf("handle('prime:tem-drm'"),
    codigo.indexOf('export function ligarPrimeJanela('),
  );
  assert.ok(ipc.length > 0, 'o canal existe');
  for (const campo of [
    'drm disponivel=',
    'motivo=',
    'tentativas=[',
    'electron=',
    'chromium=',
  ]) {
    assert.ok(ipc.includes(campo), `a linha traz ${campo.replace(/=$|=?\[$/, '')}`);
  }
  /*
   * E o campo precisa do **valor**, não só do nome.
   *
   * Exigir `chromium=` passa quando alguém troca `${process.versions.chrome}` por
   * qualquer coisa — e o log continua com o nome do campo e sem o número, que é o
   * que responderia "qual build?".
   */
  assert.match(ipc, /chromium=\$\{process\.versions\.chrome\}/, 'a linha traz a versao do chromium do log de drm');
  assert.match(ipc, /electron=\$\{process\.versions\.electron\}/, 'e a do electron');

  /*
   * E o log escreve **antes** de responder.
   *
   * Se a pessoa relatar "a faixa não apareceu", o arquivo já tem o motivo — e
   * isso não pode depender de a UI ter chegado a perguntar.
   */
  assert.ok(
    ipc.indexOf('log(') < ipc.indexOf('return sonda.tem'),
    'e registra antes de responder a UI',
  );
  /*
   * E registra **sempre**.
   *
   * `if (sonda.tem) log(...)` continua escrevendo antes do `return`, e a asserção de
   * ordem não via a condição. É o pior defeito possível num diagnóstico: ele some
   * justamente no caso que a pessoa está tentando diagnosticar, e o arquivo de log fica
   * com a versão que funciona.
   */
  assert.ok(
    !/if\s*\([^)]*\)\s*log\(/.test(ipc),
    'e nao e condicional: um log que so escreve no caminho feliz nao diagnostica nada',
  );

  /*
   * O runtime na primeira linha do log do dia.
   *
   * A resposta da EME depende do build, e um bug report sem a versão é um bug
   * report que precisa de uma pergunta antes de ser lido. E o `chromium` vem de
   * `process.versions.chrome`, não de uma constante escrita à mão: é o número que
   * o motor realmente é, e é o que decide se um CDM aceito é o do motor que roda.
   */
  const boot = semComentario(ler('../desktop/electron/main/log.ts'));
  assert.match(boot, /process\.versions\.chrome/, 'o log de boot traz a versão do Chromium');
  assert.match(boot, /process\.versions\.electron/, 'e a do Electron');
  assert.match(boot, /app\.isPackaged/, 'e se o build está empacotado, que muda o VMP');
  assert.ok(
    !/Chrome\/\d+/.test(boot),
    'e nenhum número de Chromium escrito à mão, que seria uma segunda fonte',
  );
});

test('o diagnóstico do player ouve o console e não toca no DRM', () => {
  const main = ler('../desktop/electron/main/prime.ts');
  const codigo = semComentario(main);

  /*
   * As duas metades que o enunciado pede, e a terceira que ele não pede e que
   * importa mais.
   */
  const diagnostico = codigo.slice(
    codigo.indexOf('function diagnosticarPlayer('),
    codigo.indexOf('function registrarLinhaDoPlayer('),
  );
  assert.ok(diagnostico.length > 0, 'o gancho existe');
  assert.match(diagnostico, /console-message/, 'e ouve o console da view');

  /*
   * `webContents.debugger` veria o corpo da requisição de licença, e esse corpo
   * **é** a mensagem de solicitação de licença. A instrumentação que daria o
   * diagnóstico mais preciso é a que colocaria credencial de DRM no disco — e o
   * log de bug é o que a pessoa cola num relatório.
   */
  assert.ok(
    !/\.debugger\./.test(codigo),
    'nenhum debugger: ele veria o corpo da requisicao de licenca',
  );

  /*
   * Sem injeção e sem leitura de DOM. `executeJavaScript` existe no arquivo, mas
   * só na sonda, que roda em view descartável.
   */
  assert.ok(
    !/view\.webContents\.executeJavaScript/.test(codigo),
    'nada de executeJavaScript na view do Prime',
  );
  assert.ok(
    !/view\.webContents\.insertCSS|insertCSS\(/.test(codigo),
    'e nada de CSS injetado',
  );

  /*
   * O filtro: só entra no log o que for sobre DRM.
   *
   * Sem ele, o log recebe as centenas de `console.debug` de um player de vídeo, e
   * deixa de ser legível justamente quando alguém precisa dele.
   */
  /*
   * As duas configurações de `initDataTypes`.
   *
   * Nada exigia isso, e uma delas sumindo não quebra nada visível: a sonda passa a
   * pedir só `cenc`, e um CDM que só aceita a configuração vazia responde erro — que
   * o log reporta como "sem DRM", que é uma conclusão errada.
   *
   * E é a cobertura que o log de `tentativas` existe para mostrar: uma linha por
   * configuração, com o que cada uma respondeu.
   */
  const script = main.slice(
    main.indexOf('const SONDA_DE_EME'),
    main.indexOf('const SONDA_TIMEOUT_MS'),
  );
  assert.match(
    script,
    /for \(const initDataTypes of \[\['cenc'\], \[\]\]\)/,
    'a sonda tenta as duas configuracoes de initDataTypes',
  );
  assert.match(
    script,
    /tentativas\.push\(/,
    'e registra uma linha por configuracao, que e o que o log mostra',
  );

  const palavras = main.slice(
    main.indexOf('const PALAVRAS_DE_DRM'),
    main.indexOf('const CARACTERES_NO_LOG'),
  );
  for (const termo of [
    'widevine',
    'mediakeysystem',
    'notsupportederror',
    'notallowederror',
    'media_err',
    'license',
    'drm',
  ]) {
    assert.ok(
      new RegExp(`'${termo}'`, 'i').test(palavras),
      `o filtro reconhece ${termo}`,
    );
  }

  const registra = codigo.slice(
    codigo.indexOf('function registrarLinhaDoPlayer('),
  );
  /*
   * A forma exata, e não só o nome.
   *
   * `assert.match(/PALAVRAS_DE_DRM\.some/)` continua casando com um filtro que não
   * filtra — `if (false) return;` passa. O que distingue "filtra" de "filtra ao
   * contrário" é o `return` logo depois do `.some`, e é isso que a trava exige.
   */
  assert.match(
    registra,
    /if \(!PALAVRAS_DE_DRM\.some\(\(p\) => minuscula\.includes\(p\)\)\) return;/,
    'e a linha so entra se casar com o filtro: o return logo depois do some',
  );
  assert.match(
    registra,
    /const minuscula = texto\.toLowerCase\(\);/,
    'e a comparação é sem distinção de maiúsculas, porque o nome do erro vem em CA',
  );

  /*
   * A redação, e por que ela existe.
   *
   * `console.error` de um player carrega o objeto de erro inteiro, e o erro do
   * EME carrega em `message` coisas que descrevem a tentativa de decifrar. Licença
   * é base64 e mensagem do Widevine costuma ser hex — as duas são a mesma forma:
   * uma parede de caracteres sem espaço. Achatar isso corta o conteúdo e
   * preserva a frase que explica o erro.
   */
  const redigir = main.slice(
    main.indexOf('function redigir('),
    main.indexOf('function origemDaLinha('),
  );
  assert.match(
    redigir,
    /replace\(\/\[A-Za-z0-9\+\/_\=-\]\{40,\}\/g, '…'\)/,
    'uma sequencia longa e sem espacos vira reticencias',
  );
  assert.match(redigir, /CARACTERES_NO_LOG/, 'e a linha tem teto de tamanho');

  /*
   * A origem do script entra sem caminho e sem query: um `blob:` do player não
   * tem host, e o corpo do blob não é diagnóstico.
   */
  const origem = main.slice(
    main.indexOf('function origemDaLinha('),
    main.indexOf('function diagnosticarPlayer('),
  );
  assert.match(origem, /u\.origin === 'null'/, 'um blob ou data vira só o esquema');
  assert.match(origem, /: u\.origin/, 'e o resto é só a origem, sem caminho nem query');
});

test('o diagnóstico não promete que DRM disponível é Prime reproduzindo', () => {
  const main = ler('../desktop/electron/main/prime.ts');
  const codigo = semComentario(main);

  /*
   * `tem: true` é o **mínimo** — significa que este build tem CDM. Não significa
   * que o Prime Video vai tocar nele.
   *
   * Widevine disponível e o Prime aceitando o ambiente são duas perguntas
   * separadas, e a segunda só a Amazon responde. As duas respostas possíveis
   * depois de `disponivel=true` são:
   *
   *   CASO B  Widevine ok, permissão negada  → corrigir o handler (feito)
   *   CASO C  Widevine ok, permissão ok, Prime recusa  → incompatibilidade de
   *           ambiente, e não há o que fazer no cliente
   *
   * A diferença entre B e C é o que decide entre "reproduzir no Juntos", "mudar
   * o runtime" e "fallback para o navegador" — e ela não é respondível pelo
   * código do app.
   */
  assert.match(
    main,
    /\*\*Não\*\* significa que o\s*\n\s*\* Prime Video vai tocar nele/,
    'o comentario de SondaDrm diz que true não garante reprodução',
  );
  assert.match(
    main,
    /o Prime pode recusar clientes não oficialmente suportados|CASO C/,
    'e o caso em que o Prime recusa um cliente certificado está nomeado',
  );

  /*
   * A UI segue sem prometer: `primeCanPlayProtected` devolve um booleano, e a
   * faixa nunca diz que o título vai tocar — ela sempre deixa o caminho oficial
   * à mão.
   */
  const faixa = ler('../web/components/player/PrimeStage.tsx');
  assert.match(
    faixa,
    /não possui suporte DRM compatível com o Prime Video/,
    'a faixa diz o que falta, e não "o título está errado"',
  );
  assert.match(
    faixa,
    /Abrir no Prime Video/,
    'e dá o caminho do navegador, que é onde funciona',
  );

  /*
   * O fallback tem que existir **também** no modo navegação.
   *
   * O botão de abrir no navegador vivia atrás de `urlDaFaixa`, e `urlDaFaixa` só
   * existe com um item `prime` tocando. No modo navegação — o Prime aberto pelo
   * card, com o título escolhido à mão, que é exatamente quando o DRM falha —
   * o botão não aparecia. Era a pessoa sem nenhum caminho de saída.
   */
  assert.ok(
    !/\{urlDaFaixa && \(/.test(faixa),
    'o botão de abrir no navegador não depende mais de haver item na fila',
  );
  assert.match(
    faixa,
    /const abrirNoNavegador = urlDaFaixa \|\|/,
    'e ele usa a página atual quando não há item',
  );
  assert.match(
    faixa,
    /naPaginaDeTitulo \? pagina\?\.url : ''/,
    'que vem do main já sem query nem âncora, e por isso pode ir para window.open',
  );
});
