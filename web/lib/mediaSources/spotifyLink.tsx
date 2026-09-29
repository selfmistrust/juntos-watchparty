import { ArrowSquareOut } from '@phosphor-icons/react';
import { desktop } from '@/lib/desktop';
import type { MediaSourceProvider } from './types';
import { READY } from './types';

/**
 * Spotify não entra como fonte de mídia. Este card **não reproduz nada**.
 *
 * ## Por que existe, e por que é só um link
 *
 * A Spotify Developer Policy (III. Some prohibited applications) proíbe, entre
 * outras coisas:
 *
 *   - "Do not create any product or service which is integrated with streams or
 *      content from another service."
 *   - "Do not synchronize any sound recordings with any visual media, including
 *      any advertising, film, television program, slideshow, video, or similar
 *      content."
 *   - "Do not create any product or service which includes any non-interactive
 *      internet webcasting service. For example, you can't create an application
 *      which plays content from a single source to several simultaneous listeners."
 *   - "Do not permit any device or system to segue, mix, re-mix, or overlap any
 *      Spotify Content with any other audio content (including other Spotify
 *      Content)."
 *
 * E a Compliance Tips nomeia o caso do Juntos quase palavra por palavra:
 *
 *   "Synchronization: Syncing sound recordings accessed via the Spotify Platform
 *    with other recordings, lyrics, or video."
 *
 * O Juntos é uma sala de vídeo sincronizado com o YouTube e o Drive. Entregar
 * Spotify dentro disso acerta as quatro proibições de uma vez: a integração com
 * conteúdo de outro serviço, a sincronização de som com vídeo, o mesmo conteúdo
 * para vários ouvintes ao mesmo tempo, e a sobreposição do áudio do Spotify com o
 * áudio de outra fonte.
 *
 * Que cada pessoa use a **conta dela** não muda nada disso. A proibição não é
 * sobre quem tem a conta, é sobre o que o produto faz com o som.
 *
 * ## O que a política permite
 *
 * A mesma Compliance Tips sugere a alternativa: "linking to a playlist in
 * Spotify where the user can follow it manually, instead of building a
 * programmatic follow button into your app". E a Developer Policy obriga o
 * caminho inverso: "Metadata, cover art and Audio Preview Clips must be
 * accompanied by a link back to the applicable album, content or playlist on the
 * Spotify Service."
 *
 * Então o card abre o Spotify no navegador ou no app oficial, e a pessoa ouve por
 * lá, no tempo dela. Não há conta, não há OAuth, não há escopo, não há fila e
 * não há áudio passando por este servidor.
 *
 * ## Por que não usamos o logotipo do Spotify
 *
 * Usar a marca exigiria seguir as Branding Guidelines, e a leitura delas não é
 *necessária para isto funcionar. Um ícone genérico de "abre em outro lugar" diz
 * a mesma coisa e não cria a pergunta.
 */
const ABRE_SPOTIFY = 'https://open.spotify.com';

export const spotifyProvider: MediaSourceProvider = {
  id: 'spotify',
  name: 'Abrir no Spotify',
  /*
   * A linha tem que dizer as duas coisas, nesta ordem: que o Juntos não toca, e
   * o que ele faz. Uma pessoa que veio procurar música no quarto de toldo e lê
   * "Busque e adicione músicas" sai achando que funcionou.
   */
  description:
    'O Juntos não reproduz música do Spotify. Abre o app ou o site oficial, e você ouve por lá.',
  icon: <ArrowSquareOut size={22} weight="bold" />,
  /*
   * Cor neutra, e não o verde da marca. O card não é o Spotify: é um botão que
   * leva até lá, e parecer com a marca seria sugerir uma integração que não
   * existe.
   */
  accent: 'text-ink',
  /*
   * Sempre pronto, e sem consultar nada. Não há servidor no meio: abrir um
   * endereço público não pede configuração, não pede token e não pede que a
   * pessoa esteja com a conta conectada.
   */
  fixedState: READY,
  start: async () => {
    const api = desktop();
    /*
     * No desktop a janela é a sala, e navegar nela trocaria o Juntos pelo
     * Spotify. O app de desktop já expõe a ponte para abrir no navegador do
     * sistema, que é o comportamento certo aqui.
     */
    if (api) {
      await api.openInSystemBrowser(ABRE_SPOTIFY);
      return;
    }
    /*
     * `noopener` porque o destino é externo: sem ele, a página aberta tem acesso
     * a `window.opener` e pode navegar a aba do Juntos para onde quiser. Um link
     * para um endereço fixo não é risco por si, e o custo do atributo é zero.
     */
    window.open(ABRE_SPOTIFY, '_blank', 'noopener,noreferrer');
  },
};
