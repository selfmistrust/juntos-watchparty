'use client';

import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Portal } from '@/components/ui/Portal';
import { desktop, isDesktop } from '@/lib/desktop';
import { abrirPrime } from '@/lib/primeView';
import type { MediaSourceProvider } from './types';
import { READY } from './types';

/**
 * A Prime Video como fonte da fila.
 *
 * ## O clique no card não abre painel nenhum no desktop
 *
 * No desktop, clicar em "Prime Video" **abre a view**. A pessoa cai no site
 * oficial da Amazon, dentro da área do player, e faz login na conta dela.
 *
 * A versão anterior abria um painel com um campo para colar a URL — e esse
 * painel aparecia justamente no caminho que não tinha jeito de funcionar: o
 * componente que posiciona a view só era montado quando um item `prime` já
 * estava tocando, e o item só entrava na fila pelo botão que estava dentro
 * desse componente. Um campo para colar URL não era um plano B, era um beco sem
 * saída.
 *
 * Na web não existe view, e o Prime Video recusa ser exibido dentro de outro
 * site. O painel de lá diz isso em uma frase e oferece a outra aba. Sem campo,
 * sem colar, sem "Assistir com a sala" — porque o botão precisa da página que
 * a pessoa está vendo, e lá não há página nenhuma para ver.
 */

/**
 * Símbolo da Prime Video.
 *
 * A marca é a seta de "play" da Amazon dentro do anel de "smile". Aqui só a
 * seta: o card é um quadrado de 44px, e o anel é o detalhe que faz o símbolo
 * ser reconhecido — sem ele, é só um triângulo.
 *
 * Não é o logo oficial desenhado de memória: a Prime Video não publica um
 * pacote de ícone, e um arquivo inventado com o nome da marca é pior do que um
 * símbolo geométrico honesto. `currentColor` e o `accent` do card fazem o resto.
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
  /*
   * A descrição diz o que a pessoa vai ver nos dois lugares, porque no desktop
   * o card é o único ponto de entrada e não há painel para explicar depois.
   */
  description: 'O site oficial da Amazon, dentro do app. Logue na sua conta e escolha um título.',
  icon: <PrimeMark />,
  // Azul da marca.
  accent: 'text-[#00A8E1]',
  /*
   * `READY` nos dois lugares. O que muda entre desktop e web é o que o `start`
   * faz — abrir a view, ou explicar que ela não existe na web — e não a
   * disponibilidade: o card nunca fica cinza, porque uma fonte que funciona no
   * aplicativo e é explicada no navegador não é uma fonte indisponível.
   */
  fixedState: READY,
};

/**
 * A versão com o `start` que age.
 *
 * O `MediaSourceModal` troca o provider do registro por este pelo mapa
 * `comHook`, e é o que faz o clique ter efeito. `start` mora aqui e não no
 * objeto literal: um `start` nos dois lugares seria duas portas para a mesma
 * sala, e a que o modal não usa é a que volta quando alguém edita o arquivo
 * pela metade.
 */
export function usePrimeSource(): { provider: MediaSourceProvider; painel: ReactNode } {
  const [painelAberto, setPainelAberto] = useState(false);

  const provider = useMemo<MediaSourceProvider>(
    () => ({
      ...primeProvider,
      start: async () => {
        /*
         * Desktop: abre a view e pronto. Sem painel, sem modal, sem campo.
         *
         * O palco do Prime lê `usePrimeAberto()` e monta a faixa, que por sua
         * vez manda o retângulo para o `main` e posiciona a view. Uma
         * `openPrimeView` aqui também funcionaria, mas mandaria o retângulo
         * errado — quem manda o retângulo é quem mede a caixa.
         */
        if (desktop()) {
          abrirPrime();
          return;
        }
        // Web: o painel que explica, com a saída que funciona lá.
        setPainelAberto(true);
      },
    }),
    [],
  );

  // A web é o único lugar onde este painel existe, e ele nunca deveria estar
  // montado esperando: o texto é sobre a integração não existir ali.
  useEffect(() => {
    if (isDesktop()) setPainelAberto(false);
  }, []);

  const painel = useMemo(
    () =>
      painelAberto ? (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setPainelAberto(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Prime Video no aplicativo Desktop"
              className="animate-fade-up w-full max-w-md rounded-t-2xl border border-hairline bg-surface p-4 shadow-lift sm:rounded-2xl"
            >
              <h2 className="text-sm font-medium text-ink">Prime Video integrado</h2>
              {/*
                * Uma frase, e a saída que funciona aqui.
                *
                * A versão anterior desta tela pedia para colar o endereço da página
                * do título. Isso transformava a integração web num formulário
                * manual, e a integração web não existe: o Prime Video recusa ser
                * exibido dentro de outro site, e nenhuma versão deste app muda
                * isso.
                */}
              <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
                O Prime Video integrado está disponível no aplicativo Desktop, dentro da área do
                player. No navegador, o Prime Video não pode ser exibido aqui dentro.
              </p>
              <a
                href="https://www.primevideo.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-accent text-2xs font-medium text-white transition-opacity duration-150 hover:opacity-90"
              >
                Abrir o Prime Video
                <ArrowSquareOutIcon size={13} />
              </a>
              <button
                type="button"
                onClick={() => setPainelAberto(false)}
                className="mt-2 self-end text-2xs text-ink-faint transition-colors duration-150 hover:text-ink"
              >
                Fechar
              </button>
            </div>
          </div>
        </Portal>
      ) : null,
    [painelAberto],
  );

  return { provider, painel };
}
