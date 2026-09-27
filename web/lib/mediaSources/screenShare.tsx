import { MonitorPlay } from '@phosphor-icons/react';
import type { MediaSourceProvider } from './types';
import { unavailable } from './types';

/**
 * Transmitir tela — a base fixa do card.
 *
 * `resolveState` e `description` são preenchidos por `useScreenShare`, porque
 * dependem de estar ou não dentro do app desktop. O que mora aqui é o que não
 * muda: id, nome, ícone e a exigência de ser host.
 *
 * Nenhuma versão disso entrega a tela aos outros participantes ainda: para
 * isso falta sinalização WebRTC no servidor, um `MediaKind` novo ('stream') e
 * o `FilePlayer` aceitando `MediaStream` além de `src`. Nada disso existe, e
 * esta entrega não toca no backend. O que o app desktop entrega é a
 * **captura local** — inclusive o áudio do sistema, que o navegador não
 * oferece. A tela é selecionada e capturada aqui; chegar aos outros ainda não.
 */
export const screenShareProvider: MediaSourceProvider = {
  id: 'screen',
  name: 'Transmitir tela',
  description: 'Compartilhe sua tela com a sala.',
  icon: <MonitorPlay size={22} weight="bold" />,
  // Branco de propósito: as outras marcas do modal aparecem na cor oficial
  // delas, e o teal punha "Transmitir tela" no mesmo footing de uma integração
  // de terceiro que não existe. Ele não é uma aplicação, é um recurso do
  // navegador, então fica na cor neutra da interface.
  accent: 'text-white',
  /*
   * Sem `requiresControl`: transmitir tela é **adicionar** mídia, e qualquer
   * participante pode adicionar mídia à sala. Quem transmite não ganha poder
   * sobre o playback — o `stream:publish` continua exigindo `canControl` no
   * servidor, o que é uma permissão separada e mais restrita.
   *
   * Só uma transmissão por vez continua valendo, e a checagem está dentro do
   * lock: duas telas simultâneas exigiriam um modelo de composição que o app não
   * tem.
   */
  // Sobrescrito pelo hook; este é o caso do navegador, e existe para o tipo
  // do provider ficar completo mesmo se o hook não for montado.
  resolveState: async () => unavailable('Disponível só no app desktop.'),
};
