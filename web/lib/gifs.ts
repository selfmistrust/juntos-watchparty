import { SERVER_URL } from './socket';
import type { GifResult } from '@/types';

/**
 * Busca GIFs através do proxy do servidor (`/api/gifs/search`), que decide
 * entre Tenor e Giphy conforme a chave configurada. Nunca fala direto com o
 * provedor — mesmo padrão do proxy de busca do YouTube.
 */
export async function searchGifs(query: string): Promise<GifResult[]> {
  const url = new URL('/api/gifs/search', SERVER_URL);
  url.searchParams.set('q', query);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return [];
    const data = (await response.json()) as { items?: GifResult[] };
    return data.items ?? [];
  } catch {
    return [];
  }
}
