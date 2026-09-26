import { DeviceMobile } from '@phosphor-icons/react';
import type { MediaSourceProvider } from './types';
import { unavailable } from './types';

/**
 * Globoplay.
 *
 * Como o Drive, fica registrada e indisponível. A Globoplay não tem API pública
 * e o conteúdo é protegido por DRM, então reproduzir na Watch Party exigiria
 * outro modelo de produto (e provavelmente não é permitido pelo contrato).
 * A pessoa pode continuar colando links de vídeo do computador e do YouTube
 * como fazia antes — nada foi removido.
 */
export const globoplayProvider: MediaSourceProvider = {
  id: 'globoplay',
  name: 'Globoplay',
  description: 'Catálogo da Globoplay. Em breve.',
  icon: <DeviceMobile size={22} weight="bold" />,
  accent: 'text-violet-300',
  resolveState: async () => unavailable('A Globoplay não tem integração disponível.'),
};
