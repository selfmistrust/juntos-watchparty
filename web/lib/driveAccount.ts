import { SERVER_URL } from '@/lib/socket';

/**
 * Cliente do Google Drive.
 *
 * O servidor cuida da conexão OAuth e do token. O cliente só escolhe o
 * arquivo e pede a concessão de reprodução: a partir daí o vídeo é servido por
 * `/api/drive/stream/<token>`, que encaminha o `Range` do `<video>` para o
 * Drive. Nenhum byte do arquivo passa pela memória do navegador.
 */

export type DriveAccountStatus = {
  configured: boolean;
  connected: boolean;
};

/** O que o servidor devolve ao pedir a reprodução de um arquivo. */
export type DriveStreamTarget = {
  /** Caminho da rota; a URL absoluta é `SERVER_URL` + este caminho. */
  path: string;
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
 * Pede ao servidor a concessão de reprodução de um arquivo escolhido.
 *
 * O servidor monta a URL do Drive a partir do `fileId` e devolve um token
 * opaco; nada é baixado aqui. A URL que vai para a fila é `SERVER_URL` + path,
 * e é ela que o `<video>` vai pedir por partes.
 */
export async function requestDriveStream(fileId: string, signal?: AbortSignal): Promise<DriveStreamTarget> {
  const res = await fetch(`${SERVER_URL}/api/drive/stream-token`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
    signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? 'stream_failed');
  }
  const target = (await res.json()) as DriveStreamTarget;
  if (!target?.path) throw new Error('stream_failed');
  return target;
}
