/**
 * Domínios que a view do Prime Video pode navegar sozinha, e a validação da URL.
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
 * `amazon.com`, porque o final de verdade é `.com.br`.
 *
 * A regra agora é: `amazon.<final>` onde `<final>` tem duas letras (código de
 * país) ou é `com`, com um `com.`/`co.` opcional antes — que é o formato de
 * `amazon.com`, `amazon.com.br`, `amazon.co.uk` e `amazon.de`.
 *
 * Deliberadamente **não** é `includes('amazon')`: isso aceitaria
 * `amazon.com.br.evil.net` e `notamazon.com`. A lista é o regex abaixo.
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
 * O prefixo cobre `smile.amazon.com`, `sso.amazon.com` e `auth-*.amazon.com`, que
 * são as superfícies de login da Amazon, sem precisar listar nenhuma delas.
 */
const REGEX_AMAZON = new RegExp(`^(?:[a-z0-9-]+\\.)*amazon\\.${SEGUNDO_NIVEL}${FINAL}$`);

/** `true` para o catálogo e o player do Prime Video, em qualquer subdomínio. */
export function ehPrimeVideo(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === DOMINIO_PRIME || host.endsWith(`.${DOMINIO_PRIME}`);
}

/** `true` para qualquer loja da Amazon, em qualquer país. */
export function ehAmazon(hostname: string): boolean {
  return REGEX_AMAZON.test(hostname.toLowerCase());
}

/**
 * A view pode navegar aqui sem sair do aplicativo?
 *
 * `false` não é bloqueio: quem chama manda a URL para o navegador do sistema, e
 * a pessoa continua onde estava. É o que impede um link de terceiro — um anúncio,
 * uma "política de privacidade" — de tomar a área do player.
 */
export function ehDominioPermitido(hostname: string): boolean {
  return ehPrimeVideo(hostname) || ehAmazon(hostname);
}

/**
 * Teto de tamanho da URL.
 *
 * ## Por que 16 KB e não 2048
 *
 * A URL mais longa do fluxo não é a de um título: é a de **signin OpenID**. Ela
 * carrega `openid.return_to` (uma URL inteira, percent-encoded, portanto mais
 * longa que a original), `openid.assoc_handle`, `openid.mode`, `openid.ns`,
 * `openid.sig`, `openid.signed`, `location` e afins. Na prática isso passa de
 * 2048 caracteres com folga.
 *
 * Com o teto antigo, `validarUrlPrime` devolvia `null` para essa URL, o
 * `will-navigate` chamava `preventDefault()` e mandava para o navegador do
 * sistema — **e o login nunca completava dentro do app**. Quem via o sintoma
 * achava que era o Prime recusando; era o limite, aqui.
 *
 * 16 KB continua sendo um teto que impede entrada absurda, e é ordens de grandeza
 * acima de qualquer URL real do fluxo.
 */
export const TAMANHO_MAXIMO_DA_URL = 16 * 1024;

/**
 * Valida a URL. **Só** valida.
 *
 * Query e âncora são **preservadas**, e isso é o ponto inteiro da função.
 *
 * Durante a autenticação, o estado do fluxo OpenID está na query: sem
 * `openid.sig` e `openid.return_to` a Amazon não volta para o Prime e não grava a
 * sessão. Qualquer função que "normaliza" a URL removendo `search` destrói o
 * login — e é exatamente o que a versão anterior deste módulo fazia.
 *
 * ## A separação que substitui a antiga
 *
 * Antes havia uma função só, `normalizar`, que ao mesmo tempo decidia se a URL era
 * válida **e** apagava a query. Uma função com duas responsabilidades é uma
 * função em que uma delas sempre atrapalha a outra: apagar a query é útil para a
 * URL que vai para a fila, e destrutivo para a URL que continua um login.
 *
 * Aqui são duas:
 *
 *   `validarUrlPrime`  o endereço é do Prime ou da Amazon? Devolve **inteira**.
 *   `urlDeTitulo`      a página é de um filme? Devolve a forma segura de
 *                      compartilhar, e só existe nesse caso.
 *
 * E a regra de nunca usar a segunda para continuar uma autenticação é explícita
 * em `urlDeTitulo`, porque é o erro que a separação torna possível.
 */
export function validarUrlPrime(valor: unknown): URL | null {
  if (typeof valor !== 'string' || !valor) return null;
  if (valor.length > TAMANHO_MAXIMO_DA_URL) return null;

  let u: URL;
  try {
    u = new URL(valor);
  } catch {
    return null;
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!ehDominioPermitido(u.hostname)) return null;

  return u;
}

/**
 * Caminhos que são a página de um título.
 *
 * O primeiro segmento basta, e um identificador é obrigatório: `/detail` sozinho
 * é a seção sem filme, e oferecer "Assistir com a sala" ali não teria o que
 * compartilhar.
 */
const CAMINHOS_DE_TITULO = ['detail', 'title', 'dp'];

/**
 * `true` quando a URL é a página de um título, e não a home ou o catálogo.
 *
 * Fica privado de propósito: o servidor exporta um `ehPaginaDeTitulo` de mesmo
 * nome e outra assinatura, e dois nomes iguais com assinaturas diferentes
 * obrigam quem importa os dois a criar um apelido — que é onde a distinção
 * SOME. A pergunta pública aqui é `urlDeTitulo`, que já devolve vazio fora de
 * um título, e é isso que o main e o teste consomem.
 */
function ehPaginaDeTitulo(u: URL): boolean {
  const segmentos = u.pathname.split('/').filter(Boolean);
  if (segmentos.length < 2) return false;
  return CAMINHOS_DE_TITULO.includes(segmentos[0]);
}

/**
 * A URL segura do título, para ir para a fila e para os outros participantes.
 *
 * ## Só existe quando a página é de um título
 *
 * Fora disso, devolve string vazia. Uma URL de signin com a query removida não é
 * "a mesma página": é uma página diferente, que não autentica ninguém.
 *
 * ## Nunca use isto para continuar um login
 *
 * Esta é a regra que a separação entre as duas funções torna possível de
 * cumprir, e que é fácil de quebrar por um `loadURL(urlDeTitulo(u))` bem-intencionado
 * em algum canto. A URL de navegação é sempre a **integral**, de
 * `validarUrlPrime`.
 *
 * O que sai daqui é o que a sala recebe: endereço e nome. Sem query, sem âncora,
 * sem identificador de sessão, sem nada do fluxo de autenticação.
 */
export function urlDeTitulo(u: URL): string {
  if (!ehPaginaDeTitulo(u)) return '';
  const copia = new URL(u.toString());
  copia.search = '';
  copia.hash = '';
  return copia.toString();
}
