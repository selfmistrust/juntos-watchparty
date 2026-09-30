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
  assert.equal(LARGURA_MIN_PAINEL, 320, 'o piso e 320px');
  assert.equal(LARGURA_MAX_PAINEL, 700, 'o teto e 700px');

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
    /role="separator"[\s\S]{0,200}?tabIndex=\{0\}/,
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

test('o painel de reacoes guarda margem da viewport, e nao so do botao', () => {
  /*
   * O sintoma: com o menu aberto, o conjunto batia na borda superior da janela e
   * cortava o cabeçalho da sala. Não faltava espaço — o cálculo estava 8px acima
   * do que devia, porque a folga entre o picker e o botão não era descontada do
   * `top` que posiciona o conjunto.
   *
   * Margem e folga são a mesma medida e não são o mesmo uso: a margem se guarda
   * da **borda da janela**, a folga se deixa entre o picker e o **botão**.
   */
  const c = semComentario(reacao);
  assert.match(
    c,
    /top = rect\.top - alturaTotal - FOLGA;/,
    'abrindo para cima, a folga e descontada do topo: senao encosta na borda',
  );
  assert.match(c, /top = rect\.bottom \+ FOLGA;/, 'e abrindo para baixo tambem');
  assert.match(
    c,
    /espacoAcima = rect\.top - MARGEM - FOLGA/,
    'e o espaco disponivel acima desconta as duas, nao so a margem',
  );
  assert.match(
    c,
    /espacoAbaixo = window\.innerHeight - rect\.bottom - MARGEM - FOLGA/,
    'o mesmo abaixo: sem isto o "cabe abaixo" seria um Rotlieben sobre estimacao',
  );

  /*
   * O botão `⋯` sem o rótulo "mais".
   *
   * O texto alinhava a célula, e alinhamento é o que não podia continuar: cada
   * emoji mostra contagem embaixo, e a célula do botão ficava alta sozinha
   * quando não tinha, deixando o último item pendurado para baixo.
   */
  assert.ok(
    !/<span className="text-\[0\.625rem\]">mais<\/span>/.test(c),
    'o rotulo "mais" saiu: ele alinhava a celula e a barra ficava torta',
  );
  assert.match(c, /aria-label="Mais reações"/, 'e o botao continua nomeado para quem nao ve o glifo');
  assert.match(c, /aria-expanded=\{showFull\}/, 'e diz se o menu esta aberto');
  assert.match(
    c,
    /flex items-center gap-1 rounded-xl bg-surface/,
    'a barra usa items-center, e nao items-start que pendurava o ultimo item',
  );
});

test('o painel de reacoes mede o menu inteiro antes de escolher o lado', () => {
  /*
   * O defeito: o menu expandido e `absolute top-full`, ou seja, sai da caixa do
   * container para baixo — mas o `containerRect.height` media so a barra rapida.
   * O calculo dizia "cabe acima" com folga de 40px, posicionava, e o menu de
   * 200px aparecia em cima da barra de escrever, cortado pela viewport.
   */
  const c = semComentario(reacao);
  assert.match(
    c,
    /alturaTotal = containerRect\.height \+ \(alturaMenu > 0 \? alturaMenu \+ FOLGA : 0\)/,
    'a altura somada inclui o menu expandido',
  );
  assert.match(c, /const alturaMenu = menu\?\.offsetHeight \?\? 0;/, 'medido do no, nao estimado');

  /*
   * A regra: primeiro quem tem espaco para o **conjunto**, e so depois o lado.
   * Abrir a barra para cima porque ha espaco e o menu para baixo -- o que a
   * versao anterior fazia -- poe o menu exatamente onde nao ha espaco.
   */
  assert.match(c, /cabeAcima = espacoAcima >= alturaTotal/, 'a escolha compara o espaco com o total');
  assert.match(c, /cabeAbaixo = espacoAbaixo >= alturaTotal/, 'nos dois lados');
  assert.match(c, /if \(cabeAcima\) \{/, 'e o de cima vem primeiro');

  /*
   * `bottom-full` e `top-full` precisam combinar com o `top` escrito por JS, e o
   * estado que decide qual e lido no render do menu.
   */
  assert.match(
    c,
    /acimaDoBotao \? 'bottom-full mb-2' : 'top-full mt-2'/,
    'o menu cresce para longe do botao, do lado que o container escolheu',
  );

  /*
   * O teto do grid em `dvh` e nao em px: um `max-h-60` fixo num monitor de 600px
   * de altura entrega um menu que nao cabe em lugar nenhum.
   */
  assert.match(c, /max-h-\[min\(15rem,42dvh\)\]/, 'o grid tem teto em dvh, que acompanha a janela');
  assert.ok(!/max-h-60/.test(c), 'e nao um max-h fixo, que nao cabe em tela baixa');

  /*
   * A barra rapida e medida com a do container, e o `top` posiciona o **conjunto**
   * -- barra mais menu. A medicao tem que ser a do conjunto, senao o calculo de
   * "cabe acima" olha a barra sozinha e decide errado, que foi o defeito
   * original deste painel.
   */
  assert.ok(
    !/top = rect\.top - containerRect\.height/.test(c),
    'a altura medida e a do conjunto, nunca a da barra sozinha',
  );
});
