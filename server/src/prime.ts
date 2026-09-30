/**
 * Regras de URL do Prime Video, e o que o Juntos aceita guardar de um tÃ­tulo.
 *
 * ## O que viaja entre as pessoas
 *
 * SÃ³ a URL oficial do tÃ­tulo e o nome. Nunca cookie, nunca token, nunca
 * manifesto de vÃ­deo. A URL Ã© a **identidade** do conteÃºdo â€” Ã© o mesmo endereÃ§o
 * que a pessoa abriria no navegador â€” e o nome Ã© o texto que aparece na fila.
 * Nada mais Ã© necessÃ¡rio para o Prime decidir o que mostrar, porque quem decide
 * Ã© ele, logado na conta de cada participante.
 *
 * ## Por que a validaÃ§Ã£o Ã© do servidor, e nÃ£o sÃ³ da interface
 *
 * `playlist:add` recebe um objeto montado pelo cliente. Se o teste de domÃ­nio
 * ficasse sÃ³ na tela, um `socket.emit` escrito Ã  mÃ£o guardaria
 * `https://exemplo-qualquer/` como "tÃ­tulo do Prime", e o botÃ£o "Abrir no
 * Prime Video" da sala passaria a oferecer aquele endereÃ§o para todo mundo da
 * sala. EntÃ£o o servidor revalida, reescreve o resultado no item e descarta o
 * que o cliente mandou.
 */

/**
 * DomÃ­nio aceito, e a regra de subdomÃ­nio.
 *
 * `endsWith('.primevideo.com')` exige o ponto antes do domÃ­nio, entÃ£o
 * `evilprimevideo.com` â€” que terminaria em `primevideo.com` sem o ponto â€” nÃ£o
 * passa. O inverso, `primevideo.com.atacante.net`, tambÃ©m nÃ£o passa: a
 * comparaÃ§Ã£o Ã© feita no hostname, que Ã© sÃ³ a parte antes da primeira barra.
 */
const DOMINIO = 'primevideo.com';

/** Teto de tamanho, igual ao de `desktop:abrir-no-navegador`. Uma URL de verdade cabe folgada. */
const TAMANHO_MAXIMO = 2048;

/**
 * Caminhos de pÃ¡gina de tÃ­tulo.
 *
 * O Prime Video usa trÃªs formatos em circulaÃ§Ã£o, e todos os trÃªs aparecem em
 * links de compartilhamento:
 *
 *   /detail/the-bear/0K9Y7ZQ1FQV0WZ4KQ0MDM0MVRW   (filme e sÃ©rie, com slug)
 *   /detail/amzn1.ask.0J2C1N0QKQ3KJ0ZW4KQ0MDM0MVRW   (detalhe por ASIN)
 *   /dp/amzn1.ask.0J2C1N0QKQ3KJ0ZW4KQ0MDM0MVRW     (link curto)
 *
 * O que interessa Ã© o primeiro segmento. Deliberadamente **nÃ£o** hÃ¡ tentativa de
 * adivinhar o formato dos identificadores: o ASIN da Amazon Ã© opaco e muda de
 * formato sem aviso, e um regex apertado no corpo da URL deixaria de reconhecer
 * tÃ­tulos vÃ¡lidos sem nenhum aviso â€” o botÃ£o simplesmente sumiria.
 */
const CAMINHOS_DE_TITULO = ['detail', 'title', 'dp'] as const;

/** `true` para https num domÃ­nio do Prime Video, com query e Ã¢ncora jÃ¡ removidas. */
export function normalizarUrlDoPrime(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  if (url.length === 0 || url.length > TAMANHO_MAXIMO) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  /*
   * `https:` e nÃ£o "comeÃ§a com https". `javascript:alert(1)//https://â€¦` passa
   * num `startsWith` e Ã© exatamente o tipo de coisa que esta funÃ§Ã£o existe para
   * impedir. O parser tambÃ©m normaliza maiÃºsculas e espaÃ§os, o que um
   * `startsWith` nÃ£o faria.
   */
  if (parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase();
  if (host !== DOMINIO && !host.endsWith(`.${DOMINIO}`)) return null;

  /*
   * Query e Ã¢ncora saem. O ASIN do tÃ­tulo estÃ¡ no caminho, entÃ£o elas nunca
   * carregam a identidade do conteÃºdo â€” carregam Ã© rastreamento de campanha
   * (`ref_=`), sessÃ£o e, em alguns links, identificadores que nÃ£o precisam
   * viajar entre participantes.
   *
   * Remover tambÃ©m torna o item canÃ´nico: duas pessoas que colaram o mesmo
   * tÃ­tulo com `?ref_=` diferente recebem o mesmo endereÃ§o, e a comparaÃ§Ã£o da
   * pÃ¡gina atual com o que estÃ¡ na fila nÃ£o fica dependente de rastreamento.
   */
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/** `true` quando a URL normalizada Ã© a pÃ¡gina de um tÃ­tulo, e nÃ£o a home ou o catÃ¡logo. */
export function ehPaginaDeTitulo(url: unknown): boolean {
  const normalizada = normalizarUrlDoPrime(url);
  if (!normalizada) return false;
  const segmentos = new URL(normalizada).pathname.split('/').filter(Boolean);
  /*
   * Dois segmentos, nÃ£o um.
   *
   * Os trÃªs formatos sÃ£o `/detail/<slug>`, `/detail/<asin>` e `/dp/<asin>`:
   * sempre com um identificador depois do nome da seÃ§Ã£o. `/detail` sozinho Ã© a
   * seÃ§Ã£o sem filme, e aceitÃ¡-la colocaria na fila uma pÃ¡gina que mostra a
   * mesma coisa para todo mundo.
   */
  if (segmentos.length < 2) return false;
  const primeiro = segmentos[0];
  return CAMINHOS_DE_TITULO.includes(primeiro as (typeof CAMINHOS_DE_TITULO)[number]);
}

/**
 * DomÃ­nios por onde o Prime Video leva a pessoa durante o login.
 *
 * NÃ£o Ã© usado para decidir o que a fila guarda â€” ali a regra Ã© sÃ³ o domÃ­nio do
 * Prime. Ã‰ o filtro de navegaÃ§Ã£o da `WebContentsView` do desktop: o formulÃ¡rio
 * de login da Amazon aparece em `amazon.com`, e mandar a pessoa para o navegador
 * do sistema no meio do login seria trocar um formulÃ¡rio por uma ida e volta
 * sem aviso. Link de marketers e CDN vÃ£o para o navegador do sistema, porque
 * navigated dentro da view de verdade perde a pessoa no meio do app.
 */
export const DOMINIOS_DA_NAVEGACAO = [DOMINIO, 'amazon.com'] as const;

/** `true` para um domÃ­nio que a view do Prime pode navegar sozinha. */
export function ehDominioDeNavegacao(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return DOMINIOS_DA_NAVEGACAO.some((d) => host === d || host.endsWith(`.${d}`));
}
