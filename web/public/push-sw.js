/*
 * Service worker de **push**, e só.
 *
 * ## Por que este arquivo não transforma o site em PWA
 *
 * Um service worker registrado na raiz assume o controle de tudo naquele
 * escopo, mas **controlar** não é **interceptar**: só o que tem um handler de
 * `fetch` passa por ele. Este arquivo não tem um. Toda requisição do site — HTML,
 * CSS, JavaScript, as fotos do avatar, a API — continua indo direto para a rede,
 * pelo caminho normal, sem passar por aqui.
 *
 * É por isso que não há `manifest`, nem `caches`, nem handler de `fetch`, nem
 * `skipWaiting`: cada um deles é o que realmente transforma um site em PWA.
 * Instalar, aparecer na tela de início e abrir sem rede são coisas que o Juntos não
 * promete e não precisa — o app já é um app instalado no desktop, e no navegador
 * ele funciona sem isso.
 *
 * O que este arquivo faz tem nome e é só uma coisa: aparecer quando chega um
 * aviso de menção com o site fechado, e levar a pessoa para a sala quando ela
 * clica nele.
 */

/* O prefixo é o que separa uma notificação nossa de qualquer outra do navegador. */
self.addEventListener('push', (evento) => {
  let dados = {};
  try {
    dados = evento.data ? evento.data.json() : {};
  } catch {
    // Payload ilegível não pode ser motivo para o aviso não aparecer: mostra o
    // que dá, que ainda é mais útil do que silêncio depois de alguém ter te
    // citado.
    dados = { title: 'Você foi mencionado', body: 'Abra o Juntos para ver.' };
  }

  const titulo = dados.title || 'Você foi mencionado';
  const opcoes = {
    body: dados.body || '',
    // O id da mensagem: duas menções da mesma mensagem não empilham dois avisos,
    // e a segunda substitui a primeira em vez de empurrar a anterior para fora.
    tag: dados.tag || 'juntos',
    // Ícone de menção, e não o favicon: o logo do site numa notificação de "fulano
    // te mencionou" parece o próprio fulano falando.
    icon: dados.icon || '/mention-48x48.png',
    badge: dados.badge || '/favicon.ico',
    data: { url: dados.roomId ? `/room/${dados.roomId}` : '/' },
  };

  /*
   * `waitUntil` segura o worker vivo até a notificação existir.
   *
   * Sem ele o navegador pode encerrar o worker no meio do `showNotification` e a
   * notificação simplesmente não aparece — sem erro, sem aviso, e com a impressão
   * de que o push simplesmente não funciona.
   */
  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

/*
 * Clicar no aviso leva para a sala, e de preferência para a aba que já estava
 * aberta.
 *
 * Fechar a aba e abrir outra é a diferença entre "a pessoa chega na sala" e "a
 * pessoa chega numa tela de criação de sala, tendo que caçar o link de novo". Por
 * isso o `clients.matchAll` vem antes de `openWindow`.
 */
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();

  const alvo = evento.notification.data && evento.notification.data.url;
  if (!alvo) return;

  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if (janela.url.includes(alvo) && 'focus' in janela) {
          return janela.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(alvo) : undefined;
    }),
  );
});
