/**
 * Reprodução de um arquivo do Google Drive dentro da sala.
 *
 * ## O caminho do vídeo
 *
 * Nenhum byte passa pelo nosso servidor nem pelo bucket. A URL que o `<video>`
 * recebe é um caminho da **própria origem** (`/__drive_media/<fileId>`), que o
 * service worker em `public/drive-media-sw.js` troca pela URL do Google e
 * acompanha com o token da conta de quem está assistindo. O navegador continua
 * pedindo intervalos, então seek funciona como em qualquer arquivo.
 *
 * ## O que cada pessoa precisa fazer
 *
 * O escopo `drive.file` só dá acesso a arquivo que a pessoa escolheu no
 * Picker. O Juntos concede a permissão `reader` no arquivo para quem está na
 * sala, mas isso não basta: falta o vínculo do app com aquele arquivo, que só
 * nasce quando a pessoa o escolhe. Por isso o Picker aqui é aberto já filtrado
 * para o arquivo da sala (`setFileIds`), e a pessoa confirma uma única vez. É o
 * preço de manter um escopo não sensível, que dispensa a avaliação de segurança
 * anual que um escopo restrito exigiria.
 */

const SW_URL = '/drive-media-sw.js';
const MEDIA_PREFIX = '/__drive_media/';

let registro: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Registra o worker, uma vez por sessão da página.
 *
 * O `localhost:3210` do app desktop conta como contexto seguro, então o worker
 * funciona igual na web. Devolve `null` onde service worker não existe, e o
 * player cai no aviso de "não disponível neste navegador".
 */
export function registrarMediaWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  if (!registro) {
    registro = navigator.serviceWorker.register(SW_URL, { scope: '/' }).catch((e) => {
      registro = null;
      console.warn('[drive] service worker não registrado', e);
      return null;
    });
  }
  return registro;
}

/**
 * Entrega o access token ao worker.
 *
 * Ele fica no IndexedDB da origem, e é por isso que sobrevive ao worker ser
 * encerrado pelo navegador no meio da sessão. `null` limpa — é o que a
 * desconexão da conta chama.
 */
export async function publicarToken(accessToken: string | null): Promise<void> {
  const sw = await registrarMediaWorker();
  const worker = sw?.active ?? navigator.serviceWorker.controller;
  if (!worker) return;
  if (accessToken) worker.postMessage({ type: 'juntos:drive-token', token: accessToken });
  else worker.postMessage({ type: 'juntos:drive-clear' });
}

/** A URL que o `<video>` recebe: mesma origem, para o worker poder interceptar. */
export function urlDeMidia(fileId: string): string {
  return `${MEDIA_PREFIX}${encodeURIComponent(fileId)}`;
}

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/**
 * Esta conta já tem acesso ao app sobre este arquivo?
 *
 * A resposta é a do próprio Google, e é a única confiável: o escopo
 * `drive.file` responde 404 justamente quando o vínculo não existe. Sem esta
 * checagem o `<video>` falharia e a pessoa não saberia se era falta de
 * permissão ou alguma coisa quebrada.
 */
export async function temAcessoAoArquivo(
  fileId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const url = new URL(`${DRIVE_FILES}/${fileId}`);
  url.searchParams.set('fields', 'id');
  url.searchParams.set('supportsAllDrives', 'true');
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
    return res.ok;
  } catch {
    return false;
  }
}
