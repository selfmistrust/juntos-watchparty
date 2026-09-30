import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  LARGURA_MAX_PAINEL,
  LARGURA_MIN_PAINEL,
  LARGURA_PADRAO_PAINEL,
  limitaLargura,
} from '../lib/larguraPainel';

/*
 * Quatro correções de interface numa tacada só: o scroll do chat ao enviar, a
 * posição do sino de notificações, a divisória redimensionável e o posicionamento
 * do painel de reações.
 *
 * Todas são de apresentação, e o risco delas não é quebrar a lógica — é quebrar
 * a **promessa** que a tela faz. Um scroll que anima o histórico inteiro diz "isto
 * está carregando" quando está apenas indo para o fim. Um painel de reações
 * cortado diz "não deu para clicar" quando o botão está ali, embaixo do corte.
 *
 * Por isso os testes abaixo verificam tanto o comportamento pedido quanto a
 * ausência do comportamento que ele substitui.
 */

const ler = (caminho: string) => readFileSync(resolve(process.cwd(), caminho), 'utf8');
const semComentario = (texto: string) =>
  texto.replace(/(^|[\s'"`(])(\/\/[^\n]*)/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

const chat = ler('../web/components/chat/ChatPanel.tsx');
const header = ler('../web/components/RoomHeader.tsx');
const painel = ler('../web/components/Sidebar.tsx');
const pagina = ler('../web/pages/room/[id].tsx');
const reacao = ler('../web/components/chat/ReactionPicker.tsx');
const resizer = ler('../web/components/player/SidebarResizer.tsx');

test('enviar uma mensagem leva ao fim sem animação', () => {
  /*
   * O defeito: `behavior: 'smooth'` num container com o histórico inteiro. A
   * pessoa lê o meio da conversa, aperta Enter, e a rolagem atravessa dezenas de
   * mensagens por um segundo e meio. O movimento é lento o bastante para parecer
   * travamento, e não há nenhum sinal de que a mensagem foi.
   *
   * O que substitui: um salto com `behavior: 'auto'`, no mesmo frame do clique.
   */
  assert.match(
    chat,
    /endRef\.current\?\.scrollIntoView\(\{ behavior: 'auto', block: 'end' \}\)/,
    'o salto usa behavior auto e block end',
  );
  assert.ok(
    !/behavior: 'smooth'[^\n]*block: 'end'/.test(chat),
    'e nenhum smooth com block end: seria a travessia do historico de novo',
  );

  /*
   * O efeito que rola a cada mensagem continua suave, e isso é intencional:
   * quem recebe vê a mensagem entrar uma linha abaixo, e um deslocamento de uma
   * linha é exatamente o que `smooth` faz bem. Trocá-lo também aqui tiraria a
   * suavidade de quem está lendo e não fez nada de errado.
   */
  assert.match(
    chat,
    /scrollIntoView\(\{ behavior: 'smooth', block: 'nearest' \}\)/,
    'o efeito de feed crescente continua suave, com block nearest',
  );

  /*
   * O salto tem que estar nos **três** caminhos de envio. Texto é o óbvio, e GIF
   * e imagem são a mesma situação: quem escolhe um GIF está no topo do histórico
   * e a animação longa voltaria por esse caminho.
   */
  for (const [nome, marca] of [
    ['send', /pularParaOFim\(\);\s*\n\s*onSend\(payload\);/],
    ['pickGif', /pularParaOFim\(\);\s*\n\s*onSendGif\(gif\);/],
    ['pickImage', /pularParaOFim\(\);\s*\n\s*onSendImage\(dataUrl\);/],
  ] as const) {
    assert.match(chat, marca, `${nome} tambem salta para o fim`);
  }
});

test('o sino de mencao foi para a barra superior, e em um lugar so', () => {
  /*
   * A posição antiga era o cabeçalho do painel de chat, e isso tinha duas
   * consequências. A óbvia é que o sino só aparecia depois de abrir o painel — ou
   * seja, nunca na hora em que a pessoa decide se quer ser interrompida. A menos
   * óbvia é que as três preferências valem para a sala inteira, e ficavam
   * escondidas atrás de um clique em "mostrar painel".
   */
  const c = semComentario(chat);
  assert.ok(!c.includes('MentionPreferences'), 'o chat nao monta mais as preferencias de mencao');
  assert.ok(!c.includes('mentionPrefs'), 'e nenhuma prop de mencao sobrou nele');

  const s = semComentario(painel);
  assert.ok(!s.includes('mentionPrefs'), 'e o Sidebar deixou de repassar as props de mencao');

  assert.match(header, /import \{ MentionPreferences \}/, 'a barra superior importa o componente');
  /*
   * O parêntese de fechamento fica **fora** do `&&` no JSX: é
   * `{cond && (<div>…)}` e não `{cond && <div>…}`. O `\{` da regex procurava a
   * chave de abertura e não a encontrava.
   */
  assert.match(
    header,
    /\(mentionPrefs && onMentionPrefs\) && \([\s\S]{0,200}?<MentionPreferences/,
    'e monta o botao quando a pagina tem as preferencias',
  );

  /*
   * A ordem pedida: avatares, convidar, notificacoes, painel. Os indices sao
   * lidos do JSX renderizado, não da **declaração**: `copyInvite` aparece no
   * `onClick` do botão (perto do topo do arquivo) e de novo no JSX mais abaixo,
   * e comparar o primeiro deles mediria a posição da função, não a ordem na tela.
   */
  const iAvatares = header.indexOf('visible.map');
  const iInvite = header.indexOf('<button\n          onClick={copyInvite}');
  const iMention = header.indexOf('<MentionPreferences');
  const iSidebar = header.indexOf('Ocultar painel');
  assert.ok(iAvatares > 0, 'os avatares continuam no cabecalho');
  assert.ok(iInvite > iAvatares, 'os avatares vem antes de Convidar');
  assert.ok(iMention > iInvite, 'o sino vem depois de Convidar');
  assert.ok(iSidebar > iMention, 'e antes do botao do painel');

  /*
   * Com o popover descendo da barra de 56px por cima do palco, o `z-30` é o que o
   * mantém visível. O palco usa `z-10`/`z-20` e o painel lateral não usa z, então
   * sem isto o popover abre atrás do vídeo.
   */
  assert.match(header, /z-30 flex shrink-0 items-center/, 'o wrapper do sino tem z-index');
});

test('a divisoria redimensiona o painel entre 320 e 700', () => {
  assert.equal(LARGURA_MIN_PAINEL, 360, 'o piso e 360px');
  assert.equal(LARGURA_MAX_PAINEL, 650, 'o teto e 650px');
  assert.equal(LARGURA_PADRAO_PAINEL, 400, 'e o padrao caiu para 400px');

  /*
   * A funcao de limite e o unico lugar onde os numeros valem, e a pagina, a
   * divisoria e o Sidebar leem de la. Um `min` duplicado em outro arquivo e a
   * forma mais rapida de o painel ficar mais estreito que o piso num
   * recarregamento, sem nenhum aviso.
   */
  assert.equal(limitaLargura(1), LARGURA_MIN_PAINEL, 'abaixo do piso, cola no piso');
  assert.equal(limitaLargura(9999), LARGURA_MAX_PAINEL, 'acima do teto, cola no teto');
  assert.equal(limitaLargura(Number.NaN), LARGURA_PADRAO_PAINEL, 'NaN volta ao padrao');
  assert.equal(limitaLargura(400.6), 401, 'e o valor e arredondado, nunca fracionario');

  const c = semComentario(resizer);
  assert.match(c, /cursor-col-resize/, 'o cursor e o de redimensionar coluna');
  assert.match(c, /setPointerCapture/, 'e o ponteiro e capturado, para o arraste sobreviver a borda da janela');
  assert.match(c, /touch-none/, 'com touch-action none, para o celular nao rolar a pagina');
  assert.match(c, /userSelect = 'none'/, 'e a selecao de texto e desligada durante o arraste');
  assert.match(
    c,
    /role="separator"[\s\S]{0,400}?tabIndex=\{0\}/,
    'e a alca e um separator focavel, com setas do teclado',
  );
  for (const tecla of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.ok(c.includes(`'${tecla}'`), `e a tecla ${tecla} redimensiona`);
  }

  /*
   * Abaixo de `lg` o layout e empilhado e nao existe borda vertical para
   * arrastar. Uma alca visivel ali seria um controle que nao faz nada.
   */
  assert.match(c, /hidden[\s\S]{0,80}?lg:block/, 'a alca so existe no desktop');
  assert.match(pagina, /\{sidebarOpen && \([\s\S]{0,80}?<SidebarResizer/, 'e so quando o painel esta aberto');

  /*
   * A largura guardada entra num efeito, e nao no inicializador do `useState`:
   * o inicializador roda no servidor, onde `localStorage` nao existe, e o
   * resultado e HTML divergente do primeiro render do cliente.
   */
  assert.match(pagina, /useEffect\(\(\) => \{\s*\n\s*const guardada = lerLarguraDoPainel\(\)/, 'a leitura da largura guardada e um efeito');
});

test('o painel acompanha a largura: nenhum filho tem tamanho fixo', () => {
  /*
   * A divisória ajustava a largura do `aside`, e os filhos continuavam com os
   * tamanhos deles. O sintoma era um chat que parecia espremido por dentro e
   * largo por fora, com o campo de mensagem centralizado num bloco estreito.
   *
   * Estes sao os tamanhos que causaram isso. é um `max-w` ou um `min-w`
   *_defaults_ que sobrevive ao `width` do pai.
   */
  const chat = semComentario(ler('../web/components/chat/ChatPanel.tsx'));
  const sidebar = semComentario(painel);
  const fila = semComentario(ler('../web/components/playlist/PlaylistPanel.tsx'));
  const pessoas = semComentario(ler('../web/components/people/PeoplePanel.tsx'));

  /*
   * O composer. `mx-auto` + `max-w-[21rem]` travava a barra em 336px dentro de
   * um painel de 320 a 650px: arrastar aumentava o painel e os 336px seguiam no
   * meio, com faixa vazia dos dois lados.
   */
  assert.ok(
    !/mx-auto[^"]*max-w-\[21rem\]/.test(chat),
    'o composer nao e mais centralizado com largura fixa',
  );
  assert.match(chat, /<div className="relative w-full">/, 'e ocupa a largura toda do pai');
  assert.ok(
    !/max-w-\[21rem\]/.test(chat),
    'e nao sobrou nenhum max-w de 21rem no chat',
  );

  /*
   * `min-w-0` e a condicao para o `width` do pai ser respeitado. Sem ele, um item
   * flex tem `min-width: auto` — ou seja, o conteudo — e uma mensagem com link
   * longo estica a coluna **por cima** da largura definida.
   */
  assert.match(
    sidebar,
    /'flex min-w-0 flex-col border-t border-hairline bg-surface'/,
    'o painel tem min-w-0: sem ele o conteudo desobedece ao width',
  );
  assert.match(
    sidebar,
    /<div className="min-h-0 min-w-0 flex-1 overflow-hidden">/,
    'e o corpo do painel tambem, no mesmo eixo',
  );
  assert.match(
    chat,
    /scroll-thin min-h-0 min-w-0 w-full flex-1 space-y-3 overflow-y-auto/,
    'a area de mensagens encolhe e ocupa a largura toda',
  );
  assert.match(chat, /animate-fade-up flex min-w-0 gap-2\.5/, 'e a linha da mensagem tambem');
  assert.match(
    chat,
    /<div className="shrink-0 border-t border-hairline p-3">/,
    'a barra do composer nao encolhe abaixo do conteudo',
  );

  for (const [nome, fonte] of [
    ['Fila', fila],
    ['Pessoas', pessoas],
  ] as const) {
    assert.match(
      fonte,
      /flex h-full min-h-0 min-w-0 flex-col/,
      `${nome}: a raiz encolhe em vez de esticar o painel`,
    );
  }
  assert.match(fila, /scroll-thin min-h-0 min-w-0 w-full flex-1/, 'a lista da Fila ocupa a largura');
  assert.match(fila, /group flex min-w-0 items-center gap-2/, 'e a linha do item tambem');

  /*
   * O composer tem `min-w-0` e `flex-1`, o que deixa os quatro botoes — que tem
   * `shrink-0` e medem 36px — consumirem a barra e o campo sobrar com algumas
   * dezenas de pixels. A quebra do placeholder em duas linhas, a palavra cortada
   * e o tracinho tracejado embaixo (o indicador de transbordo do textarea) sao o
   * mesmo problema: nao e o texto quebrando, e o campo sem largura.
   */
  assert.match(chat, /min-w-\[9rem\] flex-1 resize-none/, 'o campo do composer tem piso de largura');
  assert.ok(
    !/max-h-28 min-w-0 flex-1/.test(chat),
    'e nao min-w-0, que o deixava ser espremido a quase zero',
  );

  /*
   * A largura guardada nao muda quando o padrao muda, e a pessoa que ja arrastou
   * ficaria com a largura antiga sem caminho para a nova. O duplo clique na
   * divisoria e o caminho de volta, e e reversivel por natureza: quem nao gostar
   * arrasta de novo.
   */
  assert.match(resizer, /onDoubleClick=\{onDoubleClick\}/, 'o duplo clique na divisoria volta ao padrao');
  assert.match(resizer, /onChange\(padrao\);/, 'e aplica o valor padrao');
  assert.match(
    resizer,
    /'Enter' \|\| e\.key === ' '[\s\S]{0,40}?onChange\(padrao\)/,
    'e o teclado chega no padrao tambem, por Enter e espaco',
  );
  assert.match(pagina, /padrao=\{LARGURA_PADRAO_PAINEL\}/, 'a pagina passa o padrao para a divisoria');
  assert.match(pessoas, /<li key=\{user\.sessionId\} className="flex min-w-0 items-center/, 'e a linha de pessoa tambem');

  /*
   * Uma unica fonte de largura. A utilitaria `w-[23rem]` e o `style` inline brigam
   * em silencio -- o inline ganha por cascata, mas so enquanto ninguem mexer em
   * nenhuma das duas.
   */
  assert.match(
    sidebar,
    /largura \? 'lg:shrink-0' : 'lg:w-\[23rem\] lg:shrink-0'/,
    'a largura inicial so existe quando nao ha largura da divisoria',
  );
  /*
   * Nenhum reposicionamento manual de filho.
   *
   * A verificação olha `mx-auto` e `w-[` com número, e não `translate-x` genérico:
   * há um `translate-x-4` legítimo no `PeoplePanel`, que é a bolinha de um
   * interruptor sliding. Um teste que proibisse a palavra reprovaria um
   * interruptor, e o próximo que precisasse de um transform pararia de usar.
   */
  for (const [nome, fonte] of [
    ['chat', chat],
    ['Fila', fila],
    ['Pessoas', pessoas],
  ] as const) {
    assert.ok(
      !/w-\[\d+px\]/.test(fonte),
      `${nome}: nenhuma largura fixa em px nos filhos`,
    );
    assert.ok(
      !/style=\{\{[^}]*(width|left|marginLeft|translateX)/.test(fonte),
      `${nome}: e nenhum style de largura ou posicao nos filhos`,
    );
  }
});

test('o painel de reacoes e um container so, medido inteiro', () => {
  /*
   * O defeito era estrutural, e nao aritmetico: barra e painel eram dois
   * elementos, o menu era `absolute` dentro da barra, e o calculo media a barra
   * enquanto o menu pendurava fora dela. Uma medicao, um posicionamento -- e nao
   * como os dois discordariam entre si.
   */
  const c = semComentario(reacao);

  // Nenhum posicionamento interno: os dois sao irmaos num flex vertical.
  assert.ok(
    !/absolute (left-0 )?(top|bottom)-full/.test(c),
    'nenhum filho com top-full ou bottom-full: o menu nao pendura mais da barra',
  );
  assert.match(
    c,
    /fixed left-0 top-0 z-50 flex flex-col/,
    'e o container e um flex vertical so',
  );
  assert.match(
    c,
    /flex-col-reverse/,
    'que se inverte quando ancorado para baixo, para a barra ficar junto do botao',
  );

  /*
   * A medicao e da caixa do container -- que contem os dois -- e nao de uma
   * parcela. E o que garante que "cabe acima" seja verdade para o conjunto.
   */
  assert.match(c, /const \{ width, height \} = el\.getBoundingClientRect\(\);/, 'a caixa medida e a do container');
  assert.ok(
    !/alturaMenu|offsetHeight/.test(c),
    'e nao soma alturas de filhos: nao ha mais parcela a medir',
  );

  /*
   * A regra da colisao: cima primeiro, depois baixo, e no caso sem espaco em
   * nenhum dos dois o conjunto encosta na margem e o GRID rola dentro de si.
   */
  assert.match(c, /if \(height <= espacoAcima\)/, 'cima e a primeira tentativa');
  assert.match(c, /else if \(height <= espacoAbaixo\)/, 'e senao, baixo');
  assert.match(
    c,
    /proximoLado = espacoAcima >= espacoAbaixo \? 'cima' : 'baixo';/,
    'sem espaco nos dois, fica no lado com mais espaco',
  );
  assert.match(
    c,
    /y = proximoLado === 'cima' \? MARGEM : window\.innerHeight - height - MARGEM;/,
    'e encostado na margem, nunca fora da viewport',
  );
  assert.match(
    c,
    /y = Math\.min\(Math\.max\(MARGEM, y\), Math\.max\(MARGEM, window\.innerHeight - height - MARGEM\)\);/,
    'com trava final: um conjunto maior que a viewport nao vira topo negativo',
  );

  /*
   * Eixo horizontal: canto direito alinhado com o do botao.
   *
   * Centralizar no botao deixava o painel estendido para a esquerda por cima do
   * texto da mensagem -- que e a sobreposicao reportada.
   */
  assert.match(c, /let x = a\.right - width;/, 'o painel alinha pela borda direita do botao');
  assert.match(c, /const maxX = window\.innerWidth - MARGEM - width;/, 'e respeita a borda direita da viewport');
  assert.match(c, /if \(maxX < MARGEM\) x = MARGEM;/, 'e nao gera posicao impossivel se o painel for largo demais');

  /*
   * `transform` em vez de `left`/`top` no style. Nao e estetica: escrever `left`
   * num `fixed` a cada scroll do chat força layout do documento a cada quadro.
   */
  assert.match(c, /el\.style\.transform = `translate3d\(/, 'o movimento e por transform');
  assert.ok(!/el\.style\.(top|left)/.test(c), 'e nenhum top ou left escrito a mao');
});

test('o painel de reacoes e compacto, e so o grid rola', () => {
  const c = semComentario(reacao);

  // 320px de largura e 320px de altura, que e o que a especificacao pediu.
  assert.match(c, /max-h-80 w-80/, 'o painel tem 320px de largura e 320px de altura');

  /*
   * O teto vale para a **caixa**, e o grid e `flex-1` com `min-h-0`.
   *
   * Com `max-h` no grid, o cabecalho e o padding somados passariam do limite, e o
   * conjunto ultrapassaria a altura que a deteccao de colisao assumiu existir.
   * E `min-h-0` e obrigatorio num item flex com `overflow-y-auto`: sem ele o
   * grid nao encolhe abaixo do conteudo e o pai estoura em vez de rolar.
   */
  assert.match(
    c,
    /scroll-thin grid min-h-0 flex-1 grid-cols-8 gap-0\.5 overflow-y-auto/,
    'o grid e o unico que rola, e encolhe dentro do teto',
  );
  assert.match(c, /scroll-thin/, 'e com a scrollbar discreta do projeto');

  /*
   * Contagem sempre presente, invisivel quando zero.
   *
   * Sem isso a celula de quem tem reacao fica mais alta que a de quem nao tem, e
   * as linhas do grid ficam tortas -- o mesmo desalinhamento que o rotulo "mais"
   * causava na barra, voltando pela outra porta.
   */
  assert.match(
    c,
    /count > 0 \? \(hasCurrentUser \? 'text-accent' : 'text-ink-faint'\) : 'invisible'/,
    'a contagem reserva a linha mesmo valendo zero',
  );

  // A barra rapida continua pequena e horizontal.
  assert.match(
    c,
    /flex items-center gap-0\.5 rounded-xl border border-hairline bg-surface px-1\.5 py-1 shadow-lg/,
    'a barra rapida e horizontal e compacta',
  );
  assert.match(c, /h-8 w-8 flex-col items-center/, 'com celulas de 32px');

  // Portal e z-index: fora do container de scroll do chat, acima de tudo.
  assert.match(c, /from '@\/components\/ui\/Portal'/, 'o painel sai pelo Portal');
  assert.match(c, /z-50/, 'com z-index acima do chat, do input e do player');

  // O botao "..." continua nomeado e sem rotulo.
  assert.ok(
    !/text-\[0\.625rem\]">mais<\/span>/.test(c),
    'o rotulo "mais" nao voltou',
  );
  assert.match(c, /aria-label=\{showFull \? 'Menos reações' : 'Mais reações'\}/, 'e o botao muda de nome com o estado');
  assert.match(c, /aria-expanded=\{showFull\}/, 'e declara se o painel esta aberto');
});
