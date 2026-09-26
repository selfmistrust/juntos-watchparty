'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { YoutubeSearchPanel } from '@/components/media/YoutubeSearchPanel';
import type { MediaSourceContext } from '@/lib/mediaSources';

/**
 * Guarda o contexto e a abertura do painel de busca do YouTube.
 *
 * Vive aqui e não dentro do `YoutubeSearchPanel` para que o painel possa ser
 * desmontado quando fechado, sem perder o contexto de quem está na sala.
 */
export function useYoutubePanel(): {
  open: boolean;
  panel: ReactNode;
  openFor: (context: MediaSourceContext) => void;
} {
  const [context, setContext] = useState<MediaSourceContext | null>(null);

  // Estáveis: um provider que só pode ser montado por hook depende delas, e
  // uma identidade nova a cada render faria o modal reconsultar as fontes sem
  // parar.
  const openFor = useCallback((ctx: MediaSourceContext) => setContext(ctx), []);
  const close = useCallback(() => setContext(null), []);

  return {
    open: context !== null,
    panel: context ? <YoutubeSearchPanel open context={context} onClose={close} /> : null,
    openFor,
  };
}
