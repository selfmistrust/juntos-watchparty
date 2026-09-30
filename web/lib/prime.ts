/**
 * Regras de URL do Prime Video, do lado do navegador.
 *
 * ## Espelho de `server/src/prime.ts`, e por que existe duas vezes
 *
 * O renderer não importa nada de `server/` — o `server` é outro pacote, com
 * outro `tsconfig`, e acoplá-lo arrastaria Node para dentro do bundle. A
 * validação fica nos dois lados porque os dois precisam: o cliente evita
 * oferecer um botão que não funciona, e o servidor não confia no cliente.
 *
 * As duas cópias não podem divergir. `web/tests/primeIntegracao.test.ts` roda a
 * mesma lista de casos nas duas e falha se algum delas discordar — e a falha
 * importa: o cliente aceitando uma URL que o servidor recusa dá "esse
 * endereço não é uma página de título" para quem está com o botão na mão.
 *
 * ## O que não aparece aqui
 *
 * Cookie, token, sessão, manifesto de vídeo, URL de HLS/MPD, chave de DRM.
 * Nenhum deles é lido, guardado ou enviado — nem em memória. O Prime Video
 * entrega o vídeo de cada pessoa direto para o aparelho dela, e o Juntos não
 * participa dessa entrega.
 */

/** Domínio aceito, e a regra de subdomínio. */
const DOMINIO = 'primevideo.com';

/** Onde a integração começa: o catálogo oficial, aberto em outra aba. */
export const HOME_PRIME = 'https://www.primevideo.com/';

/** Teto de tamanho. Uma URL de verdade cabe folgada; um payload não. */
const TAMANHO_MAXIMO = 2048;

/**
 * Caminhos de página de título.
 *
 * O Prime Video usa três formatos em circulação — `/detail/<slug>/<asin>`,
 * `/detail/<asin>` e `/dp/<asin>` — e o que interessa é o primeiro segmento.
 *
 * Não há tentativa de adivinhar o formato do identificador: o ASIN da Amazon
 * é opaco e muda de formato sem aviso. Um regex apertado no corpo da URL
 * deixaria de reconhecer títulos válidos sem nenhum aviso — o botão
 * simplesmente deixaria de aparecer.
 */
const CAMINHOS_DE_TITULO = ['detail', 'title', 'dp'] as const;

/**
 * Devolve a URL canônica de um título do Prime, ou `null` se não for uma.
 *
 * `https:` e não "começa com https": `javascript:alert(1)//https://…` passa
 * num `startsWith`, e é exatamente o tipo de coisa que esta função existe para
 * impedir.
 */
export function normalizarUrlDoPrime(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  if (url.length === 0 || url.length > TAMANHO_MAXIMO) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;

  /*
   * O ponto antes do domínio é obrigatório, senão `evilprimevideo.com` — que
   * termina em `primevideo.com` — passaria. E a comparação é no hostname, que
   * é só a parte antes da primeira barra, então `primevideo.com.atacante.net`
   * também não passa.
   */
  const host = parsed.hostname.toLowerCase();
  if (host !== DOMINIO && !host.endsWith(`.${DOMINIO}`)) return null;

  /*
   * Query e âncora saem. O identificador do título está no caminho, então elas
   * nunca carregam a identidade do conteúdo — carregam é rastreamento de
   * campanha (`ref_=`) e, em alguns links, identificadores de sessão que não
   * precisam viajar entre participantes.
   *
   * Remover também torna o item canônico: duas pessoas que colaram o mesmo
   * título com `?ref_=` diferente recebem o mesmo endereço.
   */
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/** `true` quando a URL é a página de um título, e não a home ou o catálogo. */
export function ehPaginaDeTitulo(url: unknown): boolean {
  const normalizada = normalizarUrlDoPrime(url);
  if (!normalizada) return false;
  const segmentos = new URL(normalizada).pathname.split('/').filter(Boolean);
  /*
   * Dois segmentos, não um: `/detail/<slug>`, `/detail/<asin>` e `/dp/<asin>`.
   * `/detail` sozinho é a seção sem filme, e o botão "Assistir com a sala"
   * ficaria disponível numa página que não é de ninguém.
   */
  if (segmentos.length < 2) return false;
  const primeiro = segmentos[0];
  return CAMINHOS_DE_TITULO.includes(primeiro as (typeof CAMINHOS_DE_TITULO)[number]);
}

/**
 * Domina da URL para o texto do botão, sem o esquema e sem `www.`.
 *
 * O `www.` sai porque o texto do botão é curto e a URL é longa: em uma linha
 * só, o que a pessoa lê precisa ser o nome do filme, não o endereço.
 */
export function rotuloDoPrime(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '');
}
