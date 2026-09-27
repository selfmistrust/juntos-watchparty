import { SERVER_URL } from '@/lib/socket';

/**
 * Cliente do Google Drive.
 *
 * ## O arquivo não sai daqui
 *
 * Nenhuma função deste arquivo baixa vídeo. O que sai daqui é:
 *
 * - o estado da conexão;
 * - a URL do Google para o consentimento;
 * - a **lista** de vídeos (metadados);
 * - a URL de download e um access token de **uma hora** para um arquivo.
 *
 * Os bytes vão do Drive direto para o bucket da sala, pelo navegador de quem
 * escolheu. O Render nunca vê o vídeo, que é o motivo de a integração existir
 * em vez de um proxy.
 */

export type DriveAccountStatus = {
  configured: boolean;
  connected: boolean;
  displayName?: string;
  email?: string;
};

export type DriveVideo = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  durationMs?: number;
};

/** O que o servidor devolve para um arquivo escolhido. */
export type DriveDownload = {
  url: string;
  token: string;
  name: string;
  mimeType: string;
  size?: number;
  durationMs?: number;
};

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

export async function listarVideosDrive(busca?: string): Promise<DriveVideo[]> {
  const url = new URL(`${SERVER_URL}/api/drive/arquivos`);
  if (busca?.trim()) url.searchParams.set('busca', busca.trim().slice(0, 120));
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(res.status === 401 ? 'not_connected' : 'list_failed');
  const data = (await res.json()) as { files?: DriveVideo[] };
  return data.files ?? [];
}

/**
 * URL e token para baixar um arquivo.
 *
 * O token é o **access token**, que o Google expira em uma hora. O refresh token
 * não sai do servidor em momento nenhum: ele fica no Redis e só o servidor o
 * usa. Um access token de leitura que vaza é ruim; um refresh token vazando
 * seria pior, e não acontece.
 */
export async function pedirDownload(fileId: string): Promise<DriveDownload> {
  const res = await fetch(`${SERVER_URL}/api/drive/arquivo/${encodeURIComponent(fileId)}/baixar`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'not_found' : 'download_failed');
  return (await res.json()) as DriveDownload;
}
