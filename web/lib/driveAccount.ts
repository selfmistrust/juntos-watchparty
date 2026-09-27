import { SERVER_URL } from '@/lib/socket';

/**
 * Cliente do Google Drive.
 *
 * O servidor fornece a conexão OAuth e o access token temporário. Metadados e
 * bytes são obtidos diretamente da Drive API pelo cliente que escolheu o vídeo
 * (navegador ou renderer do desktop) e a cópia vai direto para o bucket da sala.
 */

export type DriveAccountStatus = {
  configured: boolean;
  connected: boolean;
};

export type DriveVideo = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  durationMs?: number;
};

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

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

export async function fetchDriveVideo(fileId: string, accessToken: string, signal?: AbortSignal): Promise<DriveVideo> {
  if (!/^[A-Za-z0-9_-]{10,256}$/.test(fileId)) throw new Error('bad_file');
  const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,videoMediaMetadata(durationMillis)');
  url.searchParams.set('supportsAllDrives', 'true');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
  if (!res.ok) {
    if (res.status === 401) throw new Error('token_expired');
    if (res.status === 404) throw new Error('not_found');
    if (res.status === 403) throw new Error('drive_permission');
    throw new Error('metadata_failed');
  }

  const file = (await res.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
    videoMediaMetadata?: { durationMillis?: string };
  };
  if (!file.mimeType?.startsWith('video/')) throw new Error('not_a_video');
  return {
    id: file.id ?? fileId,
    name: file.name || 'Vídeo',
    mimeType: file.mimeType,
    size: file.size ? Number(file.size) : undefined,
    durationMs: file.videoMediaMetadata?.durationMillis
      ? Number(file.videoMediaMetadata.durationMillis)
      : undefined,
  };
}

export async function downloadDriveVideo(fileId: string, accessToken: string, signal?: AbortSignal): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{10,256}$/.test(fileId)) throw new Error('bad_file');
  const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
  if (!res.ok) {
    if (res.status === 401) throw new Error('token_expired');
    if (res.status === 404) throw new Error('not_found');
    if (res.status === 403) throw new Error('drive_permission');
    throw new Error('download_failed');
  }
  return res;
}
