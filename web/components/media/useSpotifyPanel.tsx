'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { SpotifyPanel } from '@/components/media/SpotifyPanel';
import type { MediaSourceAccount, MediaSourceContext } from '@/lib/mediaSources';

/**
 * Guarda o contexto e a abertura do painel de busca do Spotify.
 *
 * Mesmo desenho de `useYoutubePanel`, e pela mesma razão: o painel precisa ser
 * desmontado quando fecha sem que o contexto de quem está na sala se perca, e
 * o provider que o monta depende de um `openFor` estável.
 *
 * ## Por que não recebe o estado do player
 *
 * A versão anterior recebia um `EstadoDoPlayer` para mostrar um aviso de plano
 * antes da pessoa escolher a música. Mas o `account_error` do SDK só chega
 * depois que uma faixa já virou a mídia atual, porque o player só conecta quando
 * há faixa tocando. O painel estava inconsistentemente a mostrar um estado que,
 * naquele momento, ele não podia conhecer.
 *
 * Aqui ele recebe só a conta — que vem do servidor e é a única coisa que ele
 * sabe de verdade.
 */
export function useSpotifyPanel(
  account: MediaSourceAccount,
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
      <SpotifyPanel open context={context} account={account} onClose={close} />
    ) : null,
    openFor,
  };
}
