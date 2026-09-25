'use client';

import { createPortal } from 'react-dom';

interface PortalProps {
  children: React.ReactNode;
}

/**
 * Renderiza filhos em um portal no final do body.
 * Útil para modais, dropdowns, tooltips que precisam escapar do stacking context.
 */
export function Portal({ children }: PortalProps) {
  return createPortal(children, document.body);
}