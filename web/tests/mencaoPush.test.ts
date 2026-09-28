import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/*
 * O aviso de menção com o site fechado.
 *
 * São quatro camadas, e elas se decidem por um sinal simples:
 *
 *   aba em foco     som + aviso dentro do app   (hook)
 *   aba em segundo  Notification API           (hook, com o socket vivo)
 *   site fechado    Web Push + service worker  (servidor + este arquivo)
 *   Electron        janela alwaysOnTop + nativa (main do Electron)
 *
 * A terceira é a única em que o servidor não fala com o app por socket, e por
 * isso é a única que depende de um endereço registrado no navegador.
 *
 * ## A decisão que este arquivo impede
 *
 * Um service worker registrado na raiz **assume o controle** de tudo no escopo,
 * e a tentação natural é completar o pacote: um handler de `fetch`, um `caches`,
 * um `manifest`. Isso transforma o site em PWA — aparece o prompt de instalar, a
 * tela de início ganha um ícone, e o app passa a abrir sem rede, o que é uma
 * promessa que o Juntos não faz e não precisa fazer.
 *
 * Controlar não é interceptar: só passa pelo worker o que tem handler de `fetch`.
 * Sem `fetch` e sem `caches`, toda requisição do site continua indo direto para
 * a rede, e o arquivo existe só para o aviso aparecer. Esses testes existem para
 * essa linha não ser cruzada "só porque dava para acrescentar".
 */

const sw = readFileSync(resolve(process.cwd(), '../web/public/push-sw.js'), 'utf8');
const hook = readFileSync(resolve(process.cwd(), '../web/hooks/useMencoes.ts'), 'utf8');
const lib = readFileSync(resolve(process.cwd(), '../web/lib/push.ts'), 'utf8');
const sala = readFileSync(resolve(process.cwd(), '../web/pages/room/[id].tsx'), 'utf8');

/** Tira comentários, para a afirmação ser sobre código e não sobre prosa. */
function codigo(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('o service worker nao intercepta nada: nao ha fetch, nao ha caches', () => {
  /*
   * É a razão de o arquivo ser tão pequeno. Um `addEventListener('fetch')` aqui
   * passaria o typecheck, o lint e o build, e o efeito só apareceria como o site
   * deixando de recarregar direito depois de uma atualização — sem erro, sem aviso.
   */
  const c = codigo(sw);
  assert.ok(
    !/addEventListener\(\s*['"]fetch['"]/.test(c),
    'sem handler de fetch: é o que impede o site de virar PWA',
  );
  assert.ok(!/\bcaches\b/.test(c), 'e sem a API caches, que é o que faria o app abrir sem rede');
  assert.ok(!/skipWaiting/.test(c), 'e sem skipWaiting, que existe para trocar de versao de worker');
});

test('o service worker nao instala nada na tela de inicio', () => {
  /*
   * Instalar é o outro metade do "virar PWA": sem `manifest` com nome, ícones e
   * `display`, o navegador não oferece instalar o site e não cria ícone na tela
   * de início. O desktop já é o app instalado; no navegador ele funciona sem
   * isso.
   */
  const c = codigo(sw);
  assert.ok(!/addEventListener\(\s*['"]install['"]/.test(c), 'sem handler de install');
  assert.ok(!/manifest/i.test(c), 'e sem falar de manifest');
});

test('o aviso do push segura o worker vivo ate a notificacao existir', () => {
  /*
   * Sem `waitUntil`, o navegador pode encerrar o worker no meio do
   * `showNotification` e a notificação simplesmente não aparece — sem erro e sem
   * nenhum sinal no servidor, que viu o push como entregue. A impressão seria de
   * que o push não funciona.
   */
  assert.match(
    codigo(sw),
    /event\.waitUntil\(\s*self\.registration\.showNotification/,
    'o showNotification precisa estar dentro de um waitUntil',
  );
});

test('payload ilegivel ainda mostra um aviso', () => {
  /*
   * Um `json()` que lança não pode engolir o aviso. O servidor manda JSON
   * sempre, mas o aviso é a única pista de que alguém te chamou, e perdê-lo por
   * causa de um payload de terceiro é perder a menção inteira.
   */
  assert.match(
    codigo(sw),
    /catch\s*\{[\s\S]*?dados\s*=\s*\{/,
    'o catch precisa sair com um aviso padrão, e não sem nada',
  );
});

test('clicar no aviso prefere a aba que ja estava aberta', () => {
  /*
   * Fechar a aba e abrir outra é a diferença entre "a pessoa chega na sala" e
   * "a pessoa chega numa tela de criação de sala, tendo que caçar o link de novo".
   * Por isso o `matchAll` vem antes de qualquer `openWindow`.
   */
  const clique = codigo(sw).slice(codigo(sw).indexOf("notificationclick"));
  assert.match(clique, /matchAll/, 'procura as janelas abertas');
  assert.ok(
    clique.indexOf('matchAll') < clique.indexOf('openWindow'),
    'e so abre uma nova depois de não ter encontrado nenhuma',
  );
  assert.match(clique, /janela\.focus\(\)/, 'foca a aba que já estava na sala');
});

test('a inscricao e por userId, e nao por sessionId', () => {
  /*
   * O `sessionId` é o socket, e muda a cada reconexão e a cada F5. O endereço de
   * push fica guardado no servidor por `userId`, que é a identidade que sobrevive
   * a isso.
   *
   * Inscrever pela sessão deixaria para trás um endereço a cada recarga, e cada
   * menção passaria a pagar uma chamada de rede para um endereço morto. A lista
   * cresceria sem parar sem nenhum sintoma visível.
   */
  assert.match(
    sala,
    /meuUserId:\s*me\?\.userId/,
    'a sala entrega o userId ao hook, e nao o sessionId',
  );
  assert.match(
    hook,
    /registrarPush\(meuUserId\)/,
    'e a inscricao usa o userId',
  );
});

test('a inscricao espera as preferencias virem do armazenamento', () => {
  /*
   * `PADRAO_MENCAO` tem `notificacoes: true`. Sem a trava do `pronto`, o
   * efeito-age com o padrão **antes** de `lerPreferencias` devolver a escolha
   * real, e quem desligou as notificações veria registrar e cancelar o endereço a
   * cada carregamento de sala: duas chamadas ao servidor, para terminar
   * exatamente onde começou.
   */
  assert.match(hook, /const \[pronto, setPronto\] = useState\(false\)/, 'existe a trava');
  const efeito = hook.slice(hook.indexOf('registrarPush'));
  assert.match(
    efeito,
    /if \(!pronto\) return;/,
    'e o efeito de inscricao sai enquanto ela nao estiver pronta',
  );
});

test('a inscricao nao acontece no Electron', () => {
  /*
   * No desktop quem notifica é o processo principal, e o `Notification` do
   * Chromium não sobrevive ao app fechado. Um endereço registrado aqui nunca
   * receberia nada, e o servidor pagaria uma chamada que falha em toda menção.
   */
  assert.match(
    codigo(hook),
    /if \(isDesktop\(\)\) return;/,
    'o efeito de inscricao sai no desktop',
  );
});

test('a notificacao do sistema volta a ter som', () => {
  /*
   * Era `silent: true`. Com a aba em segundo plano a menção não fazia barulho
   * nenhum: quem assistia o vídeo em tela cheia numa aba de fundo não via o
   * aviso, não via o número na aba e não ouvia som. O pior caso, em que a
   * menção existe e não chega a ninguém.
   *
   * Com a aba em foco o som continua sendo o do app, que é o que dá a
   * identidade da menção. Aqui a notificação assume o som do navegador.
   */
  const c = codigo(hook);
  assert.ok(
    !/silent:\s*true/.test(c),
    'a notificacao do sistema nao pode ser muda quando a aba esta em segundo plano',
  );
  assert.match(c, /new Notification\(titulo, \{/, 'a notificacao continua sendo criada');
});

test('a chave publica vem do servidor, e nao do build', () => {
  /*
   * `NEXT_PUBLIC_*` entra no bundle. Uma chave trocada obrigaria novo build em
   * todo mundo que tem o site em cache, e o servidor sem chaves é uma
   * instalação válida — não um estado de erro. Por isso a chave é buscada, e um
   * 503 vira "push não está ligado aqui".
   */
  assert.match(lib, /\/api\/push\/public-key/, 'a chave publica e buscada em tempo de uso');
  assert.ok(
    !/NEXT_PUBLIC_VAPID/.test(lib),
    'e nao embutida no build, que obrigaria novo build a cada troca de chave',
  );
  assert.match(
    lib,
    /if \(!r\.ok\) return null;/,
    'um 503 de servidor sem chaves vira "nao ha push", e nao uma excecao',
  );
});

test('a inscricao so se diz pronta quando o servidor confirmou', () => {
  /*
   * Devolver `true` porque o `subscribe` local funcionou deixaria a interface
   * prometendo um aviso que ninguém consegue enviar. É a mesma mentira de
   * "notificações: ligado" com a permissão negada, que o hook já tratava
   * voltando a preferência para desligada.
   */
  assert.match(
    lib,
    /return r\.ok;[\s\S]{0,80}?\n\}/,
    'o retorno vem do status da resposta ao servidor',
  );
});
