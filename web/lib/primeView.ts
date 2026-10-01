import { useSyncExternalStore } from 'react';

/**
 * A PrimeVideoView está aberta?
 *
 * ## Por que um store de módulo, e não um estado na página
 *
 * Quem **abre** a view é o card "Prime Video", que vive no modal de
 * Aplicações, dentro do painel lateral. Quem precisa **saber** que ela está
 * aberta é o palco, do outro lado da janela. Entre os dois há três camadas —
 * `Sidebar`, `PlaylistPanel`, `MediaSourceModal` — e um estado na página
 * acabaria passando por prop drilling só para atravessar o layout.
 *
 * A alternativa seria pôr a decisão no servidor, e isso é pior: "a view do
 * Prime está aberta" é estado de **uma tela**, não da sala. Se fosse para a
 * sala, abrir o Prime numa janela mudaria o palco de todo mundo.
 *
 * ## Por que `useSyncExternalStore` e não um `useState` com lista de ouvintes
 *
 * O `set` pode vir de um clique (fora do React) e a leitura vem de um render.
 * Com um store externo e `useSyncExternalStore` o React cuida do
 * "será que mudou" entre o momento da escrita e o do render — inclusive quando
 * a escrita acontece durante um evento que já estava em andamento. Fazer isso
 * à mão é a origem clássica de "o painel não abriu na primeira vez".
 */

let aberto = false;
const ouvintes = new Set<() => void>();

function emitir(): void {
  // Cópia antes de iterar: um ouvinte que se desinscreve durante a notificação
  // mudaria a coleção no meio do laço.
  for (const ouvinte of [...ouvintes]) ouvinte();
}

function inscrever(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

/** A view do Prime está aberta agora? */
export function primeAberto(): boolean {
  return aberto;
}

/** Abre a view do Prime. Idempotente. */
export function abrirPrime(): void {
  if (aberto) return;
  aberto = true;
  emitir();
}

/**
 * Fecha a view do Prime.
 *
 * Quem chama precisa ter o componente da faixa montado para que o
 * `closePrimeView` chegue ao `main` — ou seja, fechar o store **é** o que
 * desmonta a faixa, e o `main` recebe o `closePrimeView` no cleanup dela. Por
 * isso o store não guarda a view: quem guarda é o componente, e o store só
 * guarda a pergunta.
 */
export function fecharPrime(): void {
  if (!aberto) return;
  aberto = false;
  emitir();
}

/** Assina a abertura e o fechamento, para o React. */
export function usePrimeAberto(): boolean {
  return useSyncExternalStore(inscrever, primeAberto, primeAberto);
}
