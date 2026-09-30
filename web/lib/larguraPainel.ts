/**
 * A largura do painel lateral, e onde ela é guardada.
 *
 * ## Por que isto é um módulo e não um `useState` na página
 *
 * Porque o valor tem três consumidores com três perguntas diferentes: a página
 * que aplica, a divisória que arrasta, e o `Sidebar` que desenha. E porque os
 * limites precisam ser **os mesmos** para os três — um `min` na divisória e outro
 * na leitura do `localStorage` é a forma mais rápida de o painel ficar 200px mais
 * estreito do que o mínimo, num recarregamento.
 *
 * **360px** e o piso, e ele veio da conta do composer -- nao de um gosto.
 *
 * A 360px sobram 318px dentro da barra do composer, e os quatro botoes (imagem,
 * GIF, emoji, enviar) com os vaos levam 150. Sobram 168px para o campo, ou 152px
 * de texto depois do `py-2`.
 *
 * A 320px sobrariam 112px de texto, e o placeholder "Mandar mensagem" mede cerca
 * de 110px: cabe por dois pixels e quebra em qualquer fonte um pouco maior. O
 * piso de 320 era meu, e estava errado.
 */
export const LARGURA_MIN_PAINEL = 360;

/**
 * **650px** e o teto: acima disso a coluna de mensagens fica mais larga que
 * qualquer TV com a janela dividida, e o video -- que e o produto -- some.
 *
 * O teto caiu de 700px porque, com o composer ocupando a largura toda, a leitura
 * fica confortavel e o que desaparece e justamente o filme.
 */
export const LARGURA_MAX_PAINEL = 650;

/**
 * O padrao, em 400px.
 *
 * 400 da ao campo 192px de texto: o placeholder inteiro com folga, e espaco para
 * o nome de quem manda ao lado do botao de enviar.
 */
export const LARGURA_PADRAO_PAINEL = 400;

const CHAVE = 'juntos:largura-painel';

/**
 * Cola a largura dentro dos limites, e arredonda.
 *
 * Arredondar não é vaidade: a divisória devolve `Math.round` a cada
 * `pointermove`, e um valor fracionário numa `style.width` produz um subpixel que
 * o `getBoundingClientRect` devolve de volta no arraste seguinte. O tremor de 1px
 * numa borda é mais visível que a perda de precisão que ele evita.
 */
export function limitaLargura(valor: number): number {
  if (!Number.isFinite(valor)) return LARGURA_PADRAO_PAINEL;
  return Math.min(LARGURA_MAX_PAINEL, Math.max(LARGURA_MIN_PAINEL, Math.round(valor)));
}

/**
 * Lê a largura guardada.
 *
 * Devolve `null` quando não há nada guardado, e `null` é um sinal de verdade
 * para a página: o valor é o padrão, e ainda vale escrever no `localStorage`
 * para o próximo carregamento.
 *
 * O `try` cobre o caso em que o `localStorage` lança — navegação privada no
 * Safari, e um valor gravado por uma versão antiga com outro formato. Um throw
 * aqui derrubaria a sala inteira, e a largura é a única coisa em discussão.
 */
export function lerLarguraDoPainel(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const bruto = window.localStorage.getItem(CHAVE);
    if (bruto === null) return null;
    const numero = Number(bruto);
    return Number.isFinite(numero) ? limitaLargura(numero) : null;
  } catch {
    return null;
  }
}

/**
 * Guarda a largura.
 *
 * Silencioso por design: falhar ao gravar significa que a largura não sobrevive
 * ao próximo `F5`, e isso não merece interromper um arraste que está funcionando.
 */
export function gravaLarguraDoPainel(largura: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHAVE, String(limitaLargura(largura)));
  } catch {
    /* Sem espaço, em modo privado, ou com o storage bloqueado. A largura vale só
       para esta sessão, e isso é aceitável. */
  }
}
