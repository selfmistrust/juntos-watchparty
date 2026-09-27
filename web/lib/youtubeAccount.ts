import { SERVER_URL } from '@/lib/socket';

export type YoutubeAccountStatus = {
  configured: boolean;
  connected: boolean;
  channelTitle?: string;
  channelId?: string;
};

/**
 * URL que começa o login do YouTube.
 *
 * `voltar` decide para onde o navegador vai quando o fluxo termina:
 *
 * - sem ele, o callback devolve a pessoa para `returnTo`, que é o app. É o
 *   comportamento do navegador, e está certo lá.
 * - `'pagina'`, o callback mostra a tela de conclusão do servidor. É o que o
 *   app desktop pede, porque o Google recusa autenticar dentro da janela do
 *   Electron: a autorização sai para o navegador do sistema, e sem isso o
 *   navegador abriria uma segunda cópia do Junto — que não é a janela em que a
 *   pessoa está. A janela do desktop se atualiza quando recebe o foco.
 */
export function youtubeConnectUrl(returnTo: string, voltar?: 'pagina'): string {
  const destino = `${SERVER_URL}/api/youtube/oauth/start?returnTo=${encodeURIComponent(returnTo)}`;
  return voltar ? `${destino}&voltar=${voltar}` : destino;
}

export async function fetchYoutubeStatus(): Promise<YoutubeAccountStatus> {
  const res = await fetch(`${SERVER_URL}/api/youtube/status`, { credentials: 'include' });
  if (!res.ok) throw new Error('status_unavailable');
  return (await res.json()) as YoutubeAccountStatus;
}

export async function disconnectYoutube(): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/youtube/oauth/disconnect`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('disconnect_failed');
}

export function youtubeOauthMessage(code: string | string[] | undefined): string | null {
  const value = Array.isArray(code) ? code[0] : code;
  switch (value) {
    case 'connected':
      return 'Conta do YouTube conectada.';
    case 'denied':
      return 'A autorização do YouTube foi recusada.';
    case 'not_configured':
      return 'A conexão com o YouTube ainda não está configurada no servidor.';
    case 'error':
      return 'Não foi possível conectar o YouTube. Tente de novo.';
    default:
      return null;
  }
}
