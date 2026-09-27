import { desktop } from '@/lib/desktop';
import { SERVER_URL } from '@/lib/socket';

type PickerStart = { url: string; requestId: string; expiresAt: number };
type PickerResult =
  | { status: 'pending' }
  | { status: 'picked'; fileId: string }
  | { status: 'cancelled' }
  | { status: 'error' };

/** O timeout é de uma requisição HTTP; a escolha no navegador tem o prazo do OAuth. */
async function pickerRequest<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abortar = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abortar, { once: true });
  const timeout = window.setTimeout(abortar, 15_000);
  try {
    const res = await fetch(`${SERVER_URL}/api/drive/picker${path}`, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error('not_connected');
      if (res.status === 410) throw new Error('picker_expired');
      if (res.status === 503) throw new Error('picker_not_configured');
      throw new Error('picker_request_failed');
    }
    return res.status === 204 ? undefined as T : await res.json() as T;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Seleção cancelada', 'AbortError');
    if (controller.signal.aborted) throw new Error('timeout');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortar);
  }
}

function aguardar(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abortar = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Seleção cancelada', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abortar);
      resolve();
    }, 1500);
    signal.addEventListener('abort', abortar, { once: true });
  });
}

/**
 * Abre o OnePick do Google no navegador do sistema. Só a sessão que iniciou o
 * pedido pode ler o resultado; cookies do navegador externo não são usados.
 */
export async function escolherVideoNoNavegador(
  signal: AbortSignal,
  onOpened: () => void,
): Promise<string | null> {
  const bridge = desktop();
  if (!bridge) throw new Error('browser_open_failed');
  let request: PickerStart | null = null;
  try {
    request = await pickerRequest<PickerStart>('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnTo: window.location.href }),
    }, signal);
    signal.throwIfAborted();
    // A ponte pode recusar (`false`) ou rejeitar. Os dois viram o mesmo motivo,
    // senão o painel mostraria a mensagem genérica de cópia para um problema
    // que é só de abrir o navegador.
    const abriu = await bridge.openInSystemBrowser(request.url).catch(() => false);
    if (!abriu) throw new Error('browser_open_failed');
    signal.throwIfAborted();
    onOpened();

    while (Date.now() < request.expiresAt) {
      const result = await pickerRequest<PickerResult>(`/${request.requestId}`, { method: 'GET' }, signal);
      signal.throwIfAborted();
      if (result.status === 'picked') return result.fileId;
      if (result.status === 'cancelled') return null;
      if (result.status !== 'pending') throw new Error('picker_failed');
      await aguardar(signal);
    }
    throw new Error('picker_expired');
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  } finally {
    if (request) {
      // Também invalida o state se a aba foi fechada e a pessoa cancelou no app.
      // Uma resposta atrasada do navegador não pode iniciar outra cópia.
      void pickerRequest(`/${request.requestId}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}
