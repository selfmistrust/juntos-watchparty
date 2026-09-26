'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ScreenSharePanel } from '@/components/screen/ScreenSharePanel';
import { isDesktop } from '@/lib/desktop';
import type { MediaSourceContext, MediaSourceProvider, MediaSourceState } from './types';
import { READY, unavailable } from './types';
import { screenShareProvider } from './screenShare';

/**
 * Provider de "Transmitir tela" com o painel acoplado.
 *
 * Segue o mesmo caminho do YouTube: o painel tem estado próprio (lista de
 * fontes, escolha, pré-visualização) e um card de duas linhas não comporta
 * nada disso. O modal só recebe um `ReactNode` para desenhar.
 *
 * A diferença para o navegador é o `resolveState`: dentro do app desktop a
 * fonte fica disponível, porque o processo principal concede a captura. Fora
 * dele continua indisponível, com a explicação de sempre — e o texto dessa
 * explicação mudou, porque a parte de "falta sinalização no servidor" é a mesma
 * nos dois lugares, mas a de "o navegador não deixa" só existe no site.
 */
export function useScreenShare(): { provider: MediaSourceProvider; panel: ReactNode } {
  const [context, setContext] = useState<MediaSourceContext | null>(null);

  // Estável pelo mesmo motivo do `useYoutubePanel`: o provider é memoizado
  // abaixo, e uma identidade nova a cada render faria o modal reconsultar as
  // fontes sem parar.
  const openFor = useCallback((ctx: MediaSourceContext) => setContext(ctx), []);
  const close = useCallback(() => setContext(null), []);

  const provider = useMemo<MediaSourceProvider>(() => {
    const desktop = isDesktop();

    return {
      ...screenShareProvider,
      description: desktop
        ? 'Escolha uma tela ou janela para capturar, com áudio do sistema.'
        : 'Só funciona no app desktop. No navegador, o compartilhamento de tela não alcança a sala.',
      resolveState: async (): Promise<MediaSourceState> =>
        desktop ? READY : unavailable('Disponível só no app desktop, que captura o áudio do sistema.'),
      start: async (ctx) => {
        openFor(ctx);
      },
    };
  }, [openFor]);

  return {
    provider,
    panel: context ? <ScreenSharePanel open onClose={close} /> : null,
  };
}
