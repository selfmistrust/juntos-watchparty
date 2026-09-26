import { parseMediaUrl, youtubeThumb } from '@/lib/media';
import { SERVER_URL } from '@/lib/socket';
import type { YoutubeResult } from '@/types';
import type { DraftMediaItem, MediaSourceProvider } from './types';

export type { YoutubeResult } from '@/types';

/**
 * Traduz o que a pessoa digitou em um item de fila.
 *
 * Vale para YouTube e para URL direta de vídeo — o mesmo parsing já usado
 * pelo campo de busca da fila, extraído para aqui para que o modal e o painel
 * antigo não tenham duas versões da mesma regra.
 *
 * Retorna `null` quando o texto não é reproduzível, e o chamador decide o que
 * fazer (aqui, tentar a busca por termo).
 */
export function addYoutubeFromUrl(url: string): DraftMediaItem | null {
  const parsed = parseMediaUrl(url);
  if (!parsed) return null;
  return {
    kind: parsed.kind,
    src: parsed.src,
    title: parsed.title,
    thumbnail: parsed.kind === 'youtube' ? youtubeThumb(parsed.src) : undefined,
  };
}

/**
 * Busca por termo no YouTube.
 *
 * A busca depende de uma conta conectada ou de uma chave de API no servidor,
 * daí os status 501/401/403 terem mensagens próprias. Lançar a mensagem já
 * pronta evita que quem chama precise conhecer a API.
 */
export async function searchYoutube(query: string): Promise<YoutubeResult[]> {
  const res = await fetch(`${SERVER_URL}/api/youtube/search?q=${encodeURIComponent(query)}`, {
    credentials: 'include',
  });

  if (res.status === 501) {
    throw new Error(
      'A busca precisa de uma conta YouTube conectada ou de uma chave da API. Cole um link para adicionar mesmo assim.',
    );
  }
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error === 'youtube_reauth_required'
        ? 'A autorização do YouTube expirou ou foi revogada. Conecte a conta de novo.'
        : 'Conecte sua conta do YouTube para buscar, ou cole um link.',
    );
  }
  if (res.status === 403) {
    throw new Error('O YouTube recusou esta busca. Tente outro termo ou cole um link.');
  }
  if (!res.ok) {
    throw new Error('A busca não respondeu. Tente de novo ou cole um link.');
  }

  const data = (await res.json()) as { items: YoutubeResult[] };
  return data.items;
}

/**
 * Ícone do YouTube.
 *
 * Fonte: "YouTube full-color icon (2024)", Wikimedia Commons, domínio público
 * (original Google, vetorização Logopedia).
 * https://commons.wikimedia.org/wiki/File:YouTube_full-color_icon_(2024).svg
 *
 * O arquivo original vem como SVG do Inkscape com `width`/`height` em
 * milímetros, `version`, `xml:space` e um `<defs>` vazio. Nada disso é
 * necessário para renderizar, então o componente fica só com o `viewBox` e os
 * dois traços. O `viewBox` é o do original, sem recorte: medi o desenho
 * rasterizando e varrendo os pixels, e ele preenche a caixa de ponta a ponta.
 *
 * As cores ficam fixas (`#ff0033` e o branco do play) em vez de
 * `currentColor`: a marca do YouTube é esse vermelho específico, e o
 * `text-live` do design system é um vermelho-rosa diferente que não é o
 * vermelho do YouTube.
 */
function YoutubeMark({ width = 28 }: { width?: number }) {
  return (
    <svg
      width={width}
      height={width * (216.02286 / 313.23315)}
      viewBox="0 0 313.23315 216.02286"
      role="img"
      aria-label="YouTube"
    >
      {/* O `transform` do grupo é do arquivo original e não é opcional: sem
          ele os traços ficam 54 unidades à direita, com o lado direito cortado
          pelo `viewBox` e uma faixa vazia à esquerda. */}
      <g transform="translate(-54.079375,-5.2758072)">
        <path
          d="m 210.53177,221.29866 c 0,0 98.12514,0 122.46443,-6.48069 13.70449,-3.6724 24.01093,-14.2575 27.62825,-27.32688 6.68807,-23.97854 6.68807,-74.41988 6.68807,-74.41988 0,0 0,-50.117297 -6.68807,-73.879819 C 357.00713,25.79798 346.70069,15.42887 332.9962,11.864515 308.65691,5.2758072 210.53177,5.2758072 210.53177,5.2758072 c 0,0 -97.9062,0 -122.135976,6.5887078 -13.485335,3.564355 -24.010529,13.933465 -27.847831,27.326876 -6.468588,23.762522 -6.468588,73.879819 -6.468588,73.879819 0,0 0,50.44134 6.468588,74.41988 3.837302,13.06938 14.362496,23.65448 27.847831,27.32688 24.229776,6.48069 122.135976,6.48069 122.135976,6.48069 z"
          fill="#ff0033"
        />
        <path d="M 259.30109,113.28723 178.29251,67.382379 v 91.809711 z" fill="#ffffff" />
      </g>
    </svg>
  );
}

/**
 * Card do YouTube para o modal.
 *
 * Fica aqui, e não no modal, para que o modal não importe nada de ícone. O
 * `start` não é definido de propósito: quem define é o `useYoutubeSource`, que
 * precisa abrir o painel de busca e por isso tem de ser um hook.
 */
export const youtubeProvider: MediaSourceProvider = {
  id: 'youtube',
  name: 'YouTube',
  description: 'Busque um vídeo ou cole um link do YouTube.',
  icon: <YoutubeMark />,
  accent: 'text-[#FF0033]',
};
