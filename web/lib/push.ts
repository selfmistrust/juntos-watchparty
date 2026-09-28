/**
 * Inscrição em push, do lado do navegador.
 *
 * É a quarta camada de aviso de menção, e a única em que o servidor não fala com
 * o app por socket: aqui o site pode estar **fechado**, e é o próprio navegador
 * quem mostra o aviso.
 *
 * ## Por que isto não pede permissão de notificação
 *
 * São duas permissões diferentes, e confundir as duas é o erro clássico:
 *
 *   - `Notification.requestPermission()` é quem autoriza o aviso **com a aba
 *     aberta**. É a terceira camada, e já existia.
 *   - `PushManager.subscribe()` é quem registra este endereço para o servidor
 *     falar com o navegador depois. Autorizar a instância de push é automático,
 *     depois que a permissão de notificação foi concedida.
 *
 * Pedir as duas em separado daria dois botões para a mesma decisão. Aqui a
 * permissão de notificação é o botão, e a inscrição é consequência dele.
 *
 * ## A chave pública vem do servidor, e não do build
 *
 * `NEXT_PUBLIC_*` é embutido no bundle, e uma chave trocada obrigaria novo build
 * em todo mundo que já tem o site em cache. Buscando em `/api/push/public-key` a
 * troca é só reiniciar o servidor, e um servidor sem chaves simplesmente responde
 * que o recurso não existe — que é o estado de uma instalação sem push, e não um
 * erro.
 */

const ARQUIVO_SW = '/push-sw.js';

/** `true` quando o navegador tem o que registrar um endereço de push. */
export function suportaPush(): boolean {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  return window.isSecureContext;
}

function urlBase(): string {
  const bruto =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_SERVER_URL) || 'http://localhost:4000';
  return bruto.replace(/\/+$/, '');
}

/**
 * Converte a chave VAPID (base64url) para o `Uint8Array` que a API exige.
 *
 * O `ArrayBuffer` é explícito porque `new Uint8Array(n)` é `Uint8Array<ArrayBufferLike>`
 * nos tipos novos do TypeScript, e `ArrayBufferLike` inclui `SharedArrayBuffer` —
 * que `PushSubscriptionOptionsInit.applicationServerKey` não aceita. A diferença
 * não aparece em execução; aparece no typecheck, que é onde ela precisa aparecer.
 */
function chaveParaBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const bruto = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const saida = new Uint8Array(new ArrayBuffer(bruto.length));
  for (let i = 0; i < bruto.length; i += 1) saida[i] = bruto.charCodeAt(i);
  return saida;
}

async function chavePublica(): Promise<string | null> {
  try {
    const r = await fetch(`${urlBase()}/api/push/public-key`, { cache: 'no-store' });
    // 503 é a resposta de um servidor sem chaves. Não é erro: é "push não está
    // ligado aqui", e as outras três camadas continuam valendo.
    if (!r.ok) return null;
    const corpo = (await r.json()) as { publicKey?: string };
    return typeof corpo.publicKey === 'string' && corpo.publicKey ? corpo.publicKey : null;
  } catch {
    return null;
  }
}

/**
 * Registra o endereço de push deste navegador.
 *
 * Devolve `true` só quando o registro **chegou ao servidor**. Devolver `true`
 * porque o `subscribe` local funcionou deixaria a UI prometendo um aviso que
 * ninguém consegue enviar, que é a mesma mentira de "notificações: ligado" com a
 * permissão negada.
 */
export async function registrarPush(userId: string): Promise<boolean> {
  if (!suportaPush() || !userId) return false;

  const publica = await chavePublica();
  if (!publica) return false;

  try {
    const registro = await navigator.serviceWorker.register(ARQUIVO_SW, { scope: '/' });
    const assinatura = await registro.pushManager.subscribe({
      // O navegador descarta a inscrição se o site não mostrar nenhuma notificação
      // a partir dela. O aviso de menção é uma notificação, então isto é
      // verdade — mas vale dizer: é por isso que a camada de dentro do app não
      // pode ser a única, ou o navegador cancela o registro por conta própria.
      userVisibleOnly: true,
      applicationServerKey: chaveParaBytes(publica),
    });

    const r = await fetch(`${urlBase()}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, subscription: assinatura.toJSON() }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Cancela a inscrição e avisa o servidor, para não sobrar endereço morto. */
export async function removerPush(userId: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;

  try {
    const registros = await navigator.serviceWorker.getRegistrations();
    for (const registro of registros) {
      const assinatura = await registro.pushManager.getSubscription();
      if (!assinatura) continue;
      const endpoint = assinatura.endpoint;
      await assinatura.unsubscribe();
      await fetch(`${urlBase()}/api/push/unsubscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, endpoint }),
      }).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

/** Se este navegador já tem endereço registrado, para o botão não mentir. */
export async function temPush(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;
  try {
    const registros = await navigator.serviceWorker.getRegistrations();
    for (const registro of registros) {
      if (await registro.pushManager.getSubscription()) return true;
    }
    return false;
  } catch {
    return false;
  }
}
