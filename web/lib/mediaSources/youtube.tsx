import { YoutubeLogo } from '@phosphor-icons/react';
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
  icon: <YoutubeLogo size={22} weight="fill" />,
  accent: 'text-live',
};
