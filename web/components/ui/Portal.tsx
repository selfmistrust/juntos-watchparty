'use client';

import { useLayoutEffect, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface PortalProps {
  children: React.ReactNode;
}

/** Id do alvo dos portais, declarado em `_app.tsx`. */
const PORTAL_ROOT_ID = 'portal-root';

/**
 * `useLayoutEffect` no cliente (sem flash antes da pintura) e `useEffect` no
 * servidor, onde o primeiro gera aviso de SSR.
 */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Renderiza filhos em um ponto do DOM que herda a tipografia do design system.
 *
 * O alvo não pode ser o `document.body`: o `font-sans` e as variáveis do
 * `next/font` (`--font-inter`) ficam no wrapper de `_app.tsx`, que está dentro
 * do `#__next`. Conteúdo posto direto no `body` fica fora desse wrapper, a
 * variável `--font-inter` fica indefinida e o `font-family` inteiro cai no
 * invalid at computed-value time — voltando para a serifada do navegador. Foi o
 * que deixava os números e rótulos do ReactionPicker serifados.
 *
 * Por isso o alvo é o `#portal-root`, que fica dentro do wrapper de fonte.
 */
export function Portal({ children }: PortalProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    // O fallback mantém o componente funcionando mesmo se o alvo não exista
    // (por exemplo, em testes que renderizam a árvore sem o `_app`).
    setContainer(document.getElementById(PORTAL_ROOT_ID) ?? document.body);
  }, []);

  if (!container) return null;
  return createPortal(children, container);
}
