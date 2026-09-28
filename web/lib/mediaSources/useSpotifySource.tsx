'use client';

import { useMemo } from 'react';
import { useSpotifyAccount } from '@/hooks/useSpotifyAccount';
import { useSpotifyPanel } from '@/components/media/useSpotifyPanel';
import { spotifyProvider } from './spotify';
import type { MediaSourceAccount, MediaSourceProvider, MediaSourceState } from './types';
import { READY, unavailable } from './types';

/**
 * Provider do Spotify, com o painel de busca acoplado.
 *
 * Mesmo caminho do YouTube: o card no modal de Aplicações é a porta de entrada,
 * e o clique nele abre um painel com estado próprio (termo, resultados,
 * carregando, erro, login). A busca não cabe em duas linhas de card, e o modal
 * precisa poder fechar sem que a pessoa perca o que digitou.
 *
 * ## As quatro frases do `description`
 *
 * A descrição do card é a única linha onde a pessoa descobre o estado da fonte,
 * e ela tem duas linhas de espaço. São quatro casos, nesta ordem de gravidade:
 *
 *   servidor sem credenciais  a fonte não existe, e o card fica indisponível
 *   conta não conectada      a busca não roda; o clique ainda abre o painel
 *   conta_free               a busca e a fila funcionam, o áudio não
 *   conta conectada          a fonte funciona inteira
 *
 * `product` não decide o último caso. O `/me` devolve `premium` para Spotify
 * Lite e Premium Mini, que são planos só de celular e não reproduzem — então
 * dizer "áudio disponível" a partir de `/me` seria prometer algo que a conta não
 * pode cumprir. Por isso a frase conectada é neutra sobre áudio, e quem diz se o
 * som toca é o `account_error` do SDK, no painel.
 */
export function useSpotifySource(): {
  provider: MediaSourceProvider;
  panel: React.ReactNode;
} {
  const { status, loading, busy, message, error, reproduz, connect, disconnect } = useSpotifyAccount();

  const conta = useMemo<MediaSourceAccount>(
    () => ({
      configured: status.configured,
      connected: status.connected,
      detail: status.displayName ?? status.email ?? undefined,
      busy,
      message,
      error,
      connect,
      disconnect,
    }),
    [status, busy, message, error, connect, disconnect],
  );

  const { open, panel, openFor } = useSpotifyPanel(conta, reproduz === 'indisponivel' ? 'indisponivel' : 'desconhecido');

  const provider = useMemo<MediaSourceProvider>(() => {
    const descricao = !status.configured
      ? `${spotifyProvider.description} A integração não está configurada no servidor.`
      : !status.connected
        ? `${spotifyProvider.description} Conecte a sua conta no painel para buscar.`
        : status.product === 'free'
          ? `${spotifyProvider.description} A busca funciona; o áudio exige Spotify Premium.`
          : spotifyProvider.description;

    return {
      ...spotifyProvider,
      description: descricao,
      /**
       * `unavailable` e não `READY` quando o servidor não tem credenciais.
       *
       * É a única fonte que pode ficar realmente indisponível, e o motivo é
       * concreto: sem `SPOTIFY_CLIENT_ID`/`SECRET`/`REDIRECT_URI` não existe
       * login, e um card que abre um painel de busca que nunca vai responder é
       * pior do que um card que diz que não está pronto.
       */
      resolveState: async (): Promise<MediaSourceState> => {
        if (loading) return { available: true, loading: true };
        if (!status.configured) {
          return unavailable('O servidor não tem as credenciais do Spotify configuradas.');
        }
        return READY;
      },
      start: async (context) => {
        openFor(context);
      },
    };
  }, [status, loading, openFor]);

  return { provider, panel: open ? panel : null };
}
