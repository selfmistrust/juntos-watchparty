import { SERVER_URL } from '@/lib/socket';

/**
 * Cliente do Google Drive.
 *
 * O servidor cuida da conexão OAuth, do e-mail da conta e das permissões de
 * compartilhamento. Nenhum byte de vídeo passa por aqui: o `src` da faixa é
 * montado no cliente e lido do Google pelo service worker, com o token de quem
 * assiste.
 */

export type DriveAccountStatus = {
  configured: boolean;
  connected: boolean;
};

/** O que o servidor devolve ao registrar a faixa. */
export type DriveTrack = {
  fileId: string;
  name: string;
  duration?: number;
  size?: number;
};

export const GOOGLE_PICKER_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? '';
export const GOOGLE_CLOUD_PROJECT_NUMBER = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER ?? '';

export function drivePickerConfigured(): boolean {
  return Boolean(GOOGLE_PICKER_API_KEY && GOOGLE_CLOUD_PROJECT_NUMBER);
}

export async function fetchDriveStatus(): Promise<DriveAccountStatus> {
  const res = await fetch(`${SERVER_URL}/api/drive/status`, { credentials: 'include' });
  if (!res.ok) throw new Error('status_unavailable');
  return (await res.json()) as DriveAccountStatus;
}

export async function disconnectDrive(): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/drive/oauth/disconnect`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('disconnect_failed');
}

/**
 * URL que começa o login.
 *
 * No navegador é um redirecionamento: o cookie viaja na mesma aba e o callback
 * volta para o app. No app desktop o Google recusa autenticar dentro da janela
 * do Electron, e o `/start` não pode ser buscado pelo navegador do sistema — ele
 * forjaria uma sessão nova e ligaria a conta a ela. Por isso o desktop pede a
 * URL em JSON, que é o que `useDriveAccount` faz.
 */
export function driveConnectUrl(returnTo: string): string {
  return `${SERVER_URL}/api/drive/oauth/start?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function driveStartUrl(
  returnTo: string,
  voltar?: 'pagina',
): Promise<{ url: string } | { error: string }> {
  const res = await fetch(`${SERVER_URL}/api/drive/oauth/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo, ...(voltar ? { voltar } : {}) }),
  });
  const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!res.ok || !data?.url) return { error: data?.error ?? 'start_failed' };
  return { url: data.url };
}

export async function fetchDrivePickerToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/drive/picker-token`, { credentials: 'include', signal });
  const data = (await res.json().catch(() => null)) as { accessToken?: string } | null;
  if (!res.ok || !data?.accessToken) {
    throw new Error(res.status === 401 ? 'not_connected' : 'token_unavailable');
  }
  return data.accessToken;
}

/**
 * Registra o arquivo escolhido como faixa de Drive.
 *
 * O servidor confere o arquivo com a conta de quem chamou e devolve o `fileId`
 * e o nome. Não há URL de mídia, não há proxy e o bucket não entra: cada
 * pessoa vai ler o arquivo do Google com o token da própria conta.
 */
export async function registerDriveTrack(fileId: string, signal?: AbortSignal): Promise<DriveTrack> {
  const res = await fetch(`${SERVER_URL}/api/drive/track`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
    signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? 'track_failed');
  }
  const track = (await res.json()) as DriveTrack;
  if (!track?.fileId) throw new Error('track_failed');
  return track;
}
