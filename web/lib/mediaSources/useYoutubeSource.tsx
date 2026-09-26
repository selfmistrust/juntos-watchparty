'use client';

import { YoutubeLogo } from '@phosphor-icons/react';
import { useMemo } from 'react';
import { useYouTubeAccount } from '@/hooks/useYouTubeAccount';
import type { MediaSourceProvider, MediaSourceState } from './types';
import { READY, checking } from './types';
import { useYoutubePanel } from '@/components/media/useYoutubePanel';

/**
 * Provider do YouTube, com o painel de busca acoplado.
 *
 * A busca fica em um painel separado, aberto depois que a pessoa escolhe o
 * YouTube no modal. Duas razões: a busca tem estado próprio (termo, resultados,
 * carregando, erro) e um card de duas linhas não comporta isso; e o modal
 * precisa poder fechar sem que a pessoa perca o que digitou.
 *
 * O painel é devolvido pelo hook e renderizado pelo modal — assim o modal não
 * conhece a integração, só recebe um ReactNode para desenhar.
 */
export function useYoutubeSource(): {
  provider: MediaSourceProvider;
  panel: React.ReactNode;
} {
  const { loading } = useYouTubeAccount();
  const { open, panel, openFor } = useYoutubePanel();

  // O provider é memoizado: sem isso ele mudaria de identidade a cada render,
  // e o modal — que depende da lista de fontes — reconsultaria o estado
  // indefinidamente, deixando os cards presos em "carregando".
  const provider = useMemo<MediaSourceProvider>(
    () => ({
      id: 'youtube',
      name: 'YouTube',
      description: 'Busque um vídeo ou cole um link do YouTube.',
      icon: <YoutubeLogo size={22} weight="fill" />,
      accent: 'text-live',
      // Sem conta, a busca não roda, mas colar link continua funcionando, então
      // a fonte nunca fica realmente indisponível — só demora um instante.
      resolveState: async (): Promise<MediaSourceState> => (loading ? checking() : READY),
      start: async (context) => {
        openFor(context);
      },
    }),
    [loading, openFor],
  );

  return { provider, panel: open ? panel : null };
}
