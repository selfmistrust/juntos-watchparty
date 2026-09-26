import { MonitorPlay } from '@phosphor-icons/react';
import type { MediaSourceProvider } from './types';
import { unavailable } from './types';

/**
 * Transmitir tela.
 *
 * Diferente do Drive e da Globoplay, aqui existe um caminho real no navegador
 * (`getDisplayMedia`), mas ele sozinho não serve: para a transmissão chegar
 * aos outros participantes da sala é preciso sinalização WebRTC no servidor e
 * um `MediaKind` novo ('stream'), com o `FilePlayer` aceitando um
 * `MediaStream` além de `src`. Nada disso existe ainda, e esta entrega não
 * toca no backend.
 *
 * Registrar o item como indisponível deixa o contrato honesto: o card existe,
 * explica o motivo, e a implementação futura é só preencher este provider —
 * o modal não muda.
 */
export const screenShareProvider: MediaSourceProvider = {
  id: 'screen',
  name: 'Transmitir tela',
  description: 'Compartilhe sua tela com a sala. Em breve.',
  icon: <MonitorPlay size={22} weight="bold" />,
  accent: 'text-teal-300',
  requiresControl: true,
  resolveState: async () =>
    unavailable('A transmissão para a sala precisa de sinalização no servidor. Em breve.'),
};
