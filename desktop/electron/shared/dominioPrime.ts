/**
 * Domínios que a view do Prime Video pode navegar sozinha.
 *
 * ## Por que este arquivo existe separado
 *
 * A regra é do `main` do Electron, e a suíte de testes roda a partir de `server`,
 * onde o pacote `electron` não está instalado — então o módulo do `main` não pode
 * ser importado por ela. A versão anterior dessa regra vivia em
 * `server/src/prime.ts`, e o `main` tinha **a sua própria cópia**.
 *
 * Duas cópias de uma lista de domínios é a forma mais barata de um bug que só
 * aparece em produção: alguém ajusta uma, a outra continua igual, e nenhum teste
 * percebe porque o teste exercita a que ele mudou. Este arquivo não importa nada,
 * então o `main` e o teste usam a mesma.
 *
 * ## A regra, e por que não é só `endsWith`
 *
 * A versão anterior era `host === 'amazon.com' || host.endsWith('.amazon.com')`.
 * Isso **rejeita `www.amazon.com.br`**: `amazon.com.br` não termina em
 * `amazon.com`, porque o final de verdade é `.com.br`. O resultado era o login
 * inteiro fora do aplicativo — o redirecionamento para a loja regional saía
 * para o navegador do sistema, e a sessão `persist:juntos-prime` nunca era
 * completada. A pessoa logava no Chrome e voltava para um app que continuava
 * deslogado.
 *
 * A regra agora é: `amazon.<final>` onde `<final>` tem duas letras (código de
 * país) ou é `com`, com um `com.`/`co.` opcional antes — que é exatamente o
 * formato das lojas da Amazon (`amazon.com`, `amazon.com.br`, `amazon.co.uk`,
 * `amazon.de`).
 *
 * O `com`/`co` opcional é uma lista fechada de propósito. Aceitar qualquer
 * segundo nível abriria `amazon.evil.net`, e alguém que registrasse `evil.net`
 * poderia levar a view para lá. Fechar em `com` e `co` cobre todas as lojas da
 * Amazon que existem hoje, e uma loja nova é uma palavra nesta linha.
 *
 * ## O que não é decisão deste arquivo
 *
 * `primevideo.com` é o que identifica um título na fila, e essa regra é outra,
 * mais estreita, em `server/src/prime.ts`: aqui vale todo o território da
 * Amazon, porque aqui o assunto é **para onde a pessoa pode navegar**.
 */

/** O serviço de catálogo e player. */
export const DOMINIO_PRIME = 'primevideo.com';

/**
 * Segundo nível que a Amazon usa nas lojas regionais: `.com.br`, `.co.uk`.
 *
 * Fechado em dois valores de propósito — ver o comentário do arquivo.
 */
const SEGUNDO_NIVEL = '(?:(?:com|co)\\.)?';

/** Código de país com duas letras, ou `com` sem código. */
const FINAL = '(?:[a-z]{2}|com)';

/**
 * `amazon.<com|co>.<final>`, com qualquer quantidade de subdomínios antes.
 *
 * O prefixo `(?:[a-z0-9-]+\.)*` é o que cobre `smile.amazon.com` e
 * `sso.amazon.com`, que são as superfícies de login da Amazon, e `www.`.
 *
 * Testado para rejeitar: `amazon.com.br.evil.net`, `amazon.com.evil.net`,
 * `amazon.evil.net`, `notamazon.com`.
 */
const REGEX_AMAZON = new RegExp(`^(?:[a-z0-9-]+\\.)*amazon\\.${SEGUNDO_NIVEL}${FINAL}$`);

/** `true` para o catálogo e o player do Prime Video, em qualquer subdomínio. */
export function ehPrimeVideo(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === DOMINIO_PRIME || host.endsWith(`.${DOMINIO_PRIME}`);
}

/**
 * `true` para qualquer loja da Amazon, em qualquer país.
 *
 * Inclui as superfícies de login — `smile.amazon.com`, `sso.amazon.com`,
 * `auth-*.amazon.com` — sem precisar listar nenhuma delas: elas são subdomínios
 * de `amazon.<loja>`.
 */
export function ehAmazon(hostname: string): boolean {
  return REGEX_AMAZON.test(hostname.toLowerCase());
}

/**
 * A view pode navegar aqui sem sair do aplicativo?
 *
 * `false` não é bloqueio: quem chama manda a URL para o navegador do sistema, e
 * a pessoa continua onde estava. É o que impede um link de terceiro — um
 * anúncio, uma "política de privacidade" — de tomar a área do player e deixar a
 * pessoa presa sem barra de endereço, sem volta e sem saber que saiu do app.
 */
export function ehDominioPermitido(hostname: string): boolean {
  return ehPrimeVideo(hostname) || ehAmazon(hostname);
}
