/**
 * Endereço do site público, para o link de convite.
 *
 * Só o app desktop precisa disso. A janela dele roda em
 * `http://localhost:3210`, que só existe na máquina de quem tem o app aberto:
 * copiar a URL em que se está produziria um link que não abre para mais
 * ninguém. No navegador a origem atual já é a certa e esta variável nem é
 * usada.
 *
 * `NEXT_PUBLIC_SITE_URL` porque o valor é embutido no bundle em build — o mesmo
 * motivo do `NEXT_PUBLIC_SERVER_URL`. O `build-web.mjs` define em modo `--prod`,
 * e sem ele o código cai na URL atual, que é o comportamento de sempre no
 * navegador.
 */
const configurada = process.env.NEXT_PUBLIC_SITE_URL?.trim();

/**
 * Sem barra no fim, para concatenar com um caminho que já começa com `/`.
 * Uma barra sobrando produziria `https://...//room/x`, que funciona mas fica
 * feio no chat de quem recebeu.
 */
export const SITE_URL = (configurada ?? '').replace(/\/+$/, '');
