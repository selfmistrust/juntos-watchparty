const USER_ID_KEY = 'juntos:userId';

/**
 * Identidade estável do navegador, diferente do nome e do avatar (que a
 * pessoa pode trocar a qualquer momento). Vive no localStorage porque é ela
 * que permite ao servidor reconhecer quem reconectou:
 *
 * - reconectar sem duplicar a pessoa na lista da sala;
 * - manter o host quando o dono da sala dá F5;
 * - saber se a reação de uma mensagem é sua (o destaque não pode sumir
 *   só porque o `socket.id` mudou).
 *
 * Sem isso, o servidor recebia `userId: undefined` e tratava toda conexão
 * como a mesma pessoa.
 */
export function getUserId(): string {
  if (typeof window === 'undefined') return '';

  let id = window.localStorage.getItem(USER_ID_KEY);
  if (id) return id;

  // `crypto.randomUUID` não existe em navegadores antigos nem em contextos
  // não seguros, daí o `getRandomValues` como plano B.
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffffffff).toString(16)).join('');

  window.localStorage.setItem(USER_ID_KEY, generated);
  return generated;
}
