import { SERVER_URL } from '@/lib/socket';

export type YoutubeAccountStatus = {
  configured: boolean;
  connected: boolean;
  channelTitle?: string;
  channelId?: string;
};

export function youtubeConnectUrl(returnTo: string): string {
  return `${SERVER_URL}/api/youtube/oauth/start?returnTo=${encodeURIComponent(returnTo)}`;
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
