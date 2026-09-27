'use client';

import { useMemo } from 'react';
import { useYouTubeAccount } from '@/hooks/useYouTubeAccount';
import type { MediaSourceAccount, MediaSourceProvider, MediaSourceState } from './types';
import { READY, checking } from './types';
import { youtubeProvider } from './youtube';
import { useYoutubePanel } from '@/components/media/useYoutubePanel';

/**
 * Provider do YouTube, com o painel de busca acoplado.
 *
 * A busca fica em um painel separado, aberto depois que a pessoa escolhe o
 * YouTube no modal. Duas razões: a busca tem estado próprio (termo, resultados,
 * carregando, erro) e um card de duas linhas não comporta isso; e o modal
 * precisa poder fechar sem que a pessoa perca o que digitou.
 *
 * ## A conta foi para o painel
 *
 * A linha de conta ficava *abaixo* do botão do card, e só o YouTube tinha uma.
 * Isso tornava a grade irregular: o card do YouTube crescia ~47px, o Dispositivo
 * da mesma linha era esticado até a altura dele, e o modal inteiro ficava
 * torto por causa de um botão.
 *
 * O botão de conectar é uma ação, e ação fica onde a pessoa já está. O clique no
 * card abre o painel, e o painel mostra o login. O card continua dizendo o
 * estado — em uma frase na descrição, que é o que a linha de baixo fazia.
 *
 * O painel é devolvido pelo hook e renderizado pelo modal — assim o modal não
 * conhece a integração, só recebe um ReactNode para desenhar.
 */
export function useYoutubeSource(): {
  provider: MediaSourceProvider;
  panel: React.ReactNode;
} {
  const { status, loading, busy, message, error, connect, disconnect } = useYouTubeAccount();

  /*
   * O estado da conta, na forma que o painel de busca desenha.
   *
   * Sai daqui e não do `YoutubeSearchPanel` porque os dois precisam do mesmo
   * objeto: o painel desenha, e o card resume em uma frase. Calcular nos dois
   * lugares seria o caminho para eles divergirem, que foi exatamente o problema
   * que o projeto já teve com a conta aparecendo no perfil e na busca.
   */
  const conta = useMemo<MediaSourceAccount>(
    () => ({
      configured: status.configured,
      connected: status.connected,
      detail: status.channelTitle,
      busy,
      message,
      error,
      connect,
      disconnect,
    }),
    [status, busy, message, error, connect, disconnect],
  );

  // O painel recebe a conta pelo hook, e não por um contexto: ele é montado por
  // `useYoutubePanel`, que só precisa repassá-la como prop. Um contexto aqui
  // seria uma camada a mais para um consumidor só.
  const { open, panel, openFor } = useYoutubePanel(conta);

  // O provider é memoizado: sem isso ele mudaria de identidade a cada render,
  // e o modal — que depende da lista de fontes — reconsultaria o estado
  // indefinidamente, deixando os cards presos em "carregando".
  //
  // Espalha `youtubeProvider` em vez de repetir id/nome/descrição/ícone/cor
  // aqui: a versão daqui é a mesma fonte, só com o `resolveState`, o `start` e
  // a descrição, que dependem de coisas externas. Duplicar os campos fixos fazia
  // o ícone do YouTube ter duas definições para divergirem.
  const provider = useMemo<MediaSourceProvider>(() => {
    /*
     * A descrição carrega o estado da conta, que antes vivia na linha de baixo do
     * card. Uma frase, no mesmo espaço de duas linhas de qualquer outro card: a
     * grade continua uniforme e ninguém perde a informação.
     */
    const descricao = !conta.configured
      ? `${youtubeProvider.description} A integração não está configurada no servidor.`
      : conta.connected
        ? `${youtubeProvider.description} Conta conectada: ${conta.detail || 'sem nome'}.`
        : `${youtubeProvider.description} Conecte a conta no painel para buscar por termo.`;

    return {
      ...youtubeProvider,
      description: descricao,
      // Sem conta, a busca não roda, mas colar link continua funcionando, então
      // a fonte nunca fica realmente indisponível — só demora um instante.
      resolveState: async (): Promise<MediaSourceState> => (loading ? checking() : READY),
      start: async (context) => {
        openFor(context);
      },
    };
  }, [conta, loading, openFor]);

  return { provider, panel: open ? panel : null };
}
