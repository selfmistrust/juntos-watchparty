'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Portal } from '@/components/ui/Portal';
import { BotaoAssistirComSala } from '@/components/player/PrimeStage';
import { desktop, isDesktop } from '@/lib/desktop';
import type { PrimePage } from '@/lib/desktop';
import type { MediaSourceContext, MediaSourceProvider } from './types';
import { READY } from './types';

/**
 * A Prime Video como fonte da fila, com o painel que escolhe o título.
 *
 * ## O que a fonte entrega
 *
 * Um `DraftMediaItem` com `kind: 'prime'`, a **URL** do título e o **nome**.
 * Só isso. Nada de cookie, token, cabeçalho, manifesto de vídeo ou chave de DRM:
 * o vídeo chega no aparelho de cada pessoa direto do Prime Video, e o nosso
 * servidor não participa dessa entrega.
 *
 * ## Por que um painel e não um card só
 *
 * Escolher um título precisa de duas coisas que um card não tem: ver onde a
 * pessoa está dentro do Prime, e um botão que só existe quando ela está na
 * página de um título. No desktop as duas vêm da view nativa; na web a URL é
 * colada. Mesmo assim é o mesmo painel nos dois, porque o modal de Aplicações
 * não deve saber a diferença — é o que `MediaSourceContext` garante.
 */

/**
 * Símbolo da Prime Video.
 *
 * A marca é a seta de "play" da Amazon dentro do anel de "s smile". Aqui só a
 * seta: o card é um quadrado de 44px, e o anel desmile é o detalhe que faz o
 * símbolo ser reconhecido — sem ele, é só um triângulo.
 *
 * Não é o logo oficial da marca desenhado de memória: a Prime Video não
 * publica um pacote de ícone, e um arquivo inventado com o nome da marca é pior
 * que um símbolo geométrico honesto. `currentColor` e o `accent` do card fazem
 * o resto.
 */
function PrimeMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Prime Video">
      <path d="M4.5 2.6a1.4 1.4 0 0 0-.5 1.1v16.6a1.4 1.4 0 0 0 2.2 1.14l11.9-8.3a1.4 1.4 0 0 0 0-2.28l-11.9-8.3A1.4 1.4 0 0 0 4.5 2.6Z" />
    </svg>
  );
}

export const primeProvider: MediaSourceProvider = {
  id: 'prime',
  name: 'Prime Video',
  description: 'Catálogo da Prime Video. Logue na sua conta e escolha um título.',
  icon: <PrimeMark />,
  // Azul da marca. Continua aparecendo quando o item está na fila.
  accent: 'text-[#00A8E1]',
  /*
   * `READY`, e não `unavailable(...)`: a fonte funciona no desktop e na web
   * (com caminho diferente em cada uma), então ela nunca está indisponível. O
   * que muda é o que o painel oferece — e isso é decidido lá dentro, pelo que
   * a plataforma de fato permite.
   */
  fixedState: READY,
  /*
   * `start` mora no hook, e não aqui.
   *
   * O `MediaSourceModal` troca este provider pelo do hook pelo mapa
   * `comHook`, e o do hook tem o `start` que abre o painel. Um `start` aqui
   * seria um segundo caminho para a mesma sala, e o caminho que o modal não
   * usa é o que volta quando alguém edita o arquivo pela metade.
   */
};

export function usePrimeSource(): { provider: MediaSourceProvider; painel: ReactNode } {
  const [aberto, setAberto] = useState(false);
  const [context, setContext] = useState<MediaSourceContext | null>(null);
  const [pagina, setPagina] = useState<PrimePage | null>(null);
  const api = desktop();

  /*
   * A página do Prime muda quando a pessoa navega dentro da view nativa. Só o
   * `main` sabe disso, e ele avisa pelo `prime:pagina-mudou` — não há leitura de
   * DOM para fazer, e nenhuma injeção de JavaScript na página do Prime.
   */
  useEffect(() => {
    if (!api) return;
    let cancelado = false;
    void api.primePage().then((p) => {
      if (!cancelado) setPagina(p);
    });
    const parar = api.onPrimePage((p) => {
      if (!cancelado) setPagina(p);
    });
    return () => {
      cancelado = true;
      parar();
    };
  }, [api]);

  const adicionar = useCallback(
    (url: string, titulo: string) => {
      if (!context) return;
      context.addToPlaylist({
        kind: 'prime',
        src: '',
        primeUrl: url,
        title: titulo.slice(0, 200) || 'Título do Prime Video',
      });
      setAberto(false);
    },
    [context],
  );

  const provider = useMemo<MediaSourceProvider>(
    () => ({
      ...primeProvider,
      start: async (ctx: MediaSourceContext) => {
        setContext(ctx);
        setAberto(true);
      },
    }),
    [],
  );

  const painel = useMemo(
    () =>
      aberto ? (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setAberto(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Escolher um título do Prime Video"
              className="animate-fade-up flex w-full max-w-md flex-col gap-3 rounded-t-2xl border border-hairline bg-surface p-4 shadow-lift sm:rounded-2xl"
            >
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-ink">Prime Video</h2>
                <p className="mt-0.5 text-2xs leading-relaxed text-ink-faint">
                  {isDesktop()
                    ? 'A busca e o catálogo são os do Prime, dentro do app. Logue na conta que você vai assistir.'
                    : 'O Prime Video não pode ser exibido dentro desta página. Abra numa aba, escolha o título e cole o endereço.'}
                </p>
              </div>

              <div className="rounded-lg border border-hairline bg-raised p-3">
                <BotaoAssistirComSala pagina={pagina} onAdicionar={adicionar} />
              </div>

              <button
                type="button"
                onClick={() => setAberto(false)}
                className="self-end text-2xs text-ink-faint transition-colors duration-150 hover:text-ink"
              >
                Fechar
              </button>
            </div>
          </div>
        </Portal>
      ) : null,
    [aberto, pagina, adicionar],
  );

  return { provider, painel };
}
