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

/** Só pode ser resumido por aqui: `postMessage` sem porta não tem resposta. */
const TIMEOUT_TOKEN_MS = 5000;

function temSuporte(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Registra o worker, uma vez por sessão da página.
 *
 * O `localhost:3210` do app desktop conta como contexto seguro, então o worker
 * funciona igual na web. Devolve `null` onde service worker não existe, e o
 * player cai no aviso de "não disponível neste navegador".
 */
export function registrarMediaWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!temSuporte()) return Promise.resolve(null);
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
 * Espera a página estar **de fato** controlada pelo worker.
 *
 * Registrar não é controlar. No primeiro carregamento o worker nasce
 * `installing`, e a página só passa a ser controlada depois do `activate` e do
 * `clients.claim()` — o `controller` é `null` até lá. Sem esperar isso, o
 * `postMessage` do token vai para o vazio e o `<video>` recebe 401 do worker,
 * que é exatamente o player preto em 0:00 sem nenhuma mensagem.
 *
 * O `controllerchange` é o sinal. Se a página já estava controlada — a segunda
 * faixa, ou um refresh — resolve na hora.
 */
function esperarControle(): Promise<boolean> {
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', aoMudar);
      resolve(ok);
    };
    const aoMudar = () => {
      if (navigator.serviceWorker.controller) done(true);
    };
    // O `claim()` pode não acontecer — se o `register` foi rejeitado, ou se o
    // navegador decidiu não ativar. Sem este limite a página ficaria esperando
    // para sempre, que é pior que falhar visível.
    const timer = setTimeout(() => done(false), TIMEOUT_TOKEN_MS);
    navigator.serviceWorker.addEventListener('controllerchange', aoMudar);
  });
}

/**
 * Entrega o access token ao worker e **espera confirmação**.
 *
 * O token fica no IndexedDB da origem, e é por isso que sobrevive ao worker ser
 * encerrado pelo navegador no meio da sessão. `null` limpa — é o que a
 * desconexão da conta chama.
 *
 * A confirmação importa: `postMessage` é assíncrono e sem retorno, então
 * publicar o token e montar o `<video>` no mesmo tique dá ao vídeo a chance de
 * pedir o primeiro intervalo antes de o token existir. Com a porta, o
 * `<video>` só aparece depois que o token está gravado.
 *
 * Devolve `false` em vez de falhar calado: sem token nenhum o player vai
 * carregar e falhar, e um player preto sem explicação é a pior coisa que um
 * player de vídeo pode fazer.
 */
export async function publicarToken(accessToken: string | null): Promise<boolean> {
  if (!temSuporte()) return false;
  await registrarMediaWorker();
  if (!(await esperarControle())) return false;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return false;

  return new Promise<boolean>((resolve) => {
    const porta = new MessageChannel();
    const fechar = (ok: boolean) => {
      clearTimeout(timer);
      /*
       * Fechar as duas portas não é detalhe: um `MessagePort` aberto segura o
       * event loop do Node, e em teste isso vira processo que não termina. No
       * navegador o custo é zero, então a mesma linha serve aos dois.
       */
      porta.port1.close();
      porta.port2.close();
      resolve(ok);
    };
    const timer = setTimeout(() => fechar(false), TIMEOUT_TOKEN_MS);
    porta.port1.onmessage = (evento) => fechar((evento.data as { ok?: boolean } | null)?.ok === true);
    worker.postMessage(
      accessToken
        ? { type: 'juntos:drive-token', token: accessToken }
        : { type: 'juntos:drive-clear' },
      [porta.port2],
    );
  });
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
