'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { SpotifyPanel } from '@/components/media/SpotifyPanel';
import type { MediaSourceAccount, MediaSourceContext } from '@/lib/mediaSources';
import type { MotivoDoAudio } from '@/lib/spotifyPlayback';

/**
 * Guarda o contexto e a abertura do painel de busca do Spotify.
 *
 * Mesmo desenho de `useYoutubePanel`, e pela mesma razão: o painel precisa ser
 * desmontado quando fecha sem que o contexto de quem está na sala se perca, e
 * o provider que o monta depende de um `openFor` estável.
 */
export function useSpotifyPanel(
  account: MediaSourceAccount,
  motivo: MotivoDoAudio,
): {
  open: boolean;
  panel: ReactNode;
  openFor: (context: MediaSourceContext) => void;
} {
  const [context, setContext] = useState<MediaSourceContext | null>(null);

  const openFor = useCallback((ctx: MediaSourceContext) => setContext(ctx), []);
  const close = useCallback(() => setContext(null), []);

  return {
    open: context !== null,
    panel: context ? (
      <SpotifyPanel open context={context} account={account} motivo={motivo} onClose={close} />
    ) : null,
    openFor,
  };
}
