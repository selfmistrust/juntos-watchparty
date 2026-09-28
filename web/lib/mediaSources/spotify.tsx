import type { MediaSourceProvider } from './types';

/**
 * Marca do Spotify.
 *
 * Fonte: "Spotify icon", Wikimedia Commons — o ícone de brands do Font Awesome 5
 * recolorido, autoria Font Awesome/Spotify. O arquivo está marcado como domínio
 * público **e** com a flag `trademarked`, e é usado aqui só para identificar a
 * integração, que é uso nominativo de marca. Não é endosso.
 *
 * https://commons.wikimedia.org/wiki/File:Spotify_icon.svg
 *
 * Duas coisas no arquivo original precisam de ajuste, e as duas seriam bug:
 *
 * 1. **`viewBox` é `0 0 496 512`, e não um quadrado.** A largura e a altura do
 *    viewBox são diferentes, então o glifo é mais alto que largo. Num card o
 *    ícone ocupa uma caixa de tamanho fixo, e `width={size} height={size}`
 *    achataria o círculo em elipse. A altura sai da proporção, como o Drive faz
 *    com os 800×741 dele.
 * 2. **Os dois caminhos têm cores diferentes e ambas são necessárias.** O
 *    círculo é `fill="#1ed760"` e as três curvas não têm `fill` — o arquivo
 *    original depende do preto padrão do SVG. Aqui as curvas ganharam
 *    `fill="#000000"` explícito, e o `<svg>` **não** leva `fill="none"`.
 *
 *    Isso não é preciosismo: a primeira versão deste componente copiou o
 *    `fill="none"` que o Drive usa, e o efeito foi o glifo virar só o círculo
 *    verde, sem as curvas. Como o `fill` é herdado, `none` na raiz cascateia
 *    para o caminho que não declara cor — e nada avisa. Medido em canvas: 7136
 *    pixels verdes e **0** escuros. Com o `fill` explícito no caminho, a marca
 *    não depende mais de um padrão herdado para existir.
 *
 *    Converter para `currentColor` — o que os outros ícones fazem — continua
 *    fora de questão: pintaria círculo e curvas da mesma cor, e o glifo
 *    sumiria. As cores ficam como no original, pelo mesmo motivo pelo qual o
 *    Drive mantém o gradiente: uma marca que perde a cor perde o que a faz
 *    reconhecível.
 *
 * Não há `id`, `mask` nem `linearGradient` neste arquivo, então não existe o
 * risco de colisão de id que obrigou a renomear o `a`/`b`/`c`/`d` do Drive e o
 * `clipPath` da Globoplay.
 */
function SpotifyMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size * (512 / 496)} viewBox="0 0 496 512" role="img" aria-label="Spotify">
      <path
        fill="#1ed760"
        d="M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8Z"
      />
      <path
        fill="#000000"
        d="M406.6 231.1c-5.2 0-8.4-1.3-12.9-3.9-71.2-42.5-198.5-52.7-280.9-29.7-3.6 1-8.1 2.6-12.9 2.6-13.2 0-23.3-10.3-23.3-23.6 0-13.6 8.4-21.3 17.4-23.9 35.2-10.3 74.6-15.2 117.5-15.2 73 0 149.5 15.2 205.4 47.8 7.8 4.5 12.9 10.7 12.9 22.6 0 13.6-11 23.3-23.2 23.3zm-31 76.2c-5.2 0-8.7-2.3-12.3-4.2-62.5-37-155.7-51.9-238.6-29.4-4.8 1.3-7.4 2.6-11.9 2.6-10.7 0-19.4-8.7-19.4-19.4s5.2-17.8 15.5-20.7c27.8-7.8 56.2-13.6 97.8-13.6 64.9 0 127.6 16.1 177 45.5 8.1 4.8 11.3 11 11.3 19.7-.1 10.8-8.5 19.5-19.4 19.5zm-26.9 65.6c-4.2 0-6.8-1.3-10.7-3.6-62.4-37.6-135-39.2-206.7-24.5-3.9 1-9 2.6-11.9 2.6-9.7 0-15.8-7.7-15.8-15.8 0-10.3 6.1-15.2 13.6-16.8 81.9-18.1 165.6-16.5 237 26.2 6.1 3.9 9.7 7.4 9.7 16.5s-7.1 15.4-15.2 15.4z"
      />
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
