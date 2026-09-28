import type { MediaSourceProvider } from './types';

/**
 * Marca do Spotify.
 *
 * O caminho é o glifo oficial da marca (o círculo com as três curvas), usado
 * como o Google Drive e a Globoplay são usados nos outros cards: o card precisa
 * ser reconhecível, e um ícone genérico de "música" não cumpre isso.
 *
 * Duas escolhas sobre o arquivo original:
 *
 * 1. `fill="currentColor"`, e não as cores fixas. A marca é verde, mas o card
 *    pinta o ícone com `source.accent`; fixar a cor aqui faria o verde ignorar o
 *    estado do card. O verde vem do `accent` abaixo, o que é o mesmo arranjo do
 *    YouTube.
 * 2. Nenhum `id` para renomear. Os outros SVGs da marca trazem `mask` e
 *    `linearGradient`, e `id` é global no documento — um id de uma letra colide
 *    com o de qualquer outro SVG inline da página. Este não tem nenhum, então não
 *    há o que renomear.
 */
function SpotifyMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 168 168" fill="currentColor" role="img" aria-label="Spotify">
      <path d="M158.51 142.801a12.252 12.252 0 0 1-16.77 4.932C97.335 129.882 50.916 127.326 3.77 135.48a12.252 12.252 0 0 1-3.9-24.053c48.774-8.369 96.383-5.2 140.72 12.428a12.252 12.252 0 0 1 4.92 18.946Zm16.766-34.215a15.315 15.315 0 0 1-20.967 6.801c-34.324-20.859-86.401-27.125-126.916-14.851a15.315 15.315 0 1 1-8.85-28.815c46.46-13.953 104.221-6.888 143.817 17.535a15.315 15.315 0 0 1 6.996 19.33Zm1.763-35.203a18.374 18.374 0 0 1-25.18 8.164C113.93 60.09 60.652 54.17 22.216 65.915a18.374 18.374 0 1 1-10.51-34.975c43.495-13.324 102.628-6.843 150.972 15.588a18.374 18.374 0 0 1 8.352 25.845Z" />
    </svg>
  );
}

/**
 * Spotify.
 *
 * ## Esta fonte não é como as outras, e a diferença está no áudio
 *
 * YouTube, Drive, arquivo e transmissão têm **um** player: o servidor decide o
 * que toca, e todo mundo vê e ouve a mesma coisa no mesmo instante. É o que faz
 * uma sala ser uma sala.
 *
 * O Spotify não tem URL de áudio. Quem entrega o som é o Web Playback SDK, e ele
 * toca **em cada navegador, com a conta de cada pessoa**, direto do Spotify. Não
 * há como transformar isso em um player único, porque o áudio não passa por
 * lugar nenhum que a gente controle.
 *
 * As consequências são reais e o código não as esconde:
 *
 *  - quem tem Spotify **Premium** ouve; quem não tem, vê a faixa e não ouve;
 *  - o play e o pause da sala chegam ao player de cada pessoa individualmente;
 *  - planos **só de celular** (Lite, Premium Mini) devolvem `product: "premium"`
 *    e falham na hora de tocar — o `/me` mente, e só o `account_error` do SDK
 *    denuncia.
 *
 * ## O que não existe aqui, de propósito
 *
 * Não há `src`, não há proxy, e não há extração. Um preview de 30 segundos não é
 * a música, e o Spotify não dá o arquivo — o player dele é a única forma de
 * ouvir, e é a forma que usamos.
 */
export const spotifyProvider: MediaSourceProvider = {
  id: 'spotify',
  name: 'Spotify',
  // O texto definitivo vem de `useSpotifySource`, que sabe se o servidor tem
  // credenciais e se a conta está conectada. Este é o estado do primeiro render.
  description: 'Ouça músicas e playlists com a sala.',
  icon: <SpotifyMark />,
  // Verde oficial (#1DB954). O `accent` é o que pinta o ícone do card.
  accent: 'text-[#1DB954]',
  /*
   * Sem `requiresControl`: a busca é de leitura, e qualquer participante pode
   * escolher uma música para a sala, exatamente como escolhe um vídeo do Drive
   * do próprio Drive. O áudio é de cada um, então não há o que serializar.
   */
};
