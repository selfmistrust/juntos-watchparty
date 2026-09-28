'use client';

import { useEffect, useRef } from 'react';

interface Props {
  /** O texto do campo, caractere por caractere igual ao do `textarea`. */
  texto: string;
  /** Início da menção em curso, ou `undefined` quando não há nenhuma. */
  inicio?: number;
  /** Fim da menção em curso. */
  fim?: number;
  /** O `textarea` de verdade, para o espelho acompanhar a rolagem dele. */
  campoRef: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * O texto do campo, desenhado por baixo do `textarea`, com a menção em roxo.
 *
 * ## Por que um espelho, e não o `textarea` mesmo
 *
 * Um `<textarea>` não aceita marcação. Não há `::highlight`, não há `<mark>`, e
 * não há como colorir só uma parte do valor com CSS. Todo editor que faz isso
 * na web usa a mesma saída: um `div` com o mesmo texto **por trás** de um
 * `textarea` cujo texto é transparente, com o cursor visível por conta própria.
 *
 * O que se vê é o espelho. O que se digita é o `textarea`, invisível por cima.
 *
 * ## Por que o espelho tem que ser idêntico ao campo
 *
 * Se uma diferença de 1px em `padding`, uma linha a mais de `line-height` ou
 * uma fonte diferente, o espelho desalinha do campo e o roxo cai na palavra
 * errada — o defeito mais irritante possível, porque parece aleatório. Por isso
 * `CLASSE_METRICA` é exportado e o `textarea` o recebe junto: os dois
 * compartilham literalmente as mesmas classes de métrica, e não duas listas que
 * alguém pode divergentemente editar.
 *
 * ## A rolagem, por que é copiada e não herdada
 *
 * O campo tem `max-h-28` e rola quando a mensagem passa disso. O espelho é seu
 * próprio contêiner de rolagem e o `scrollTop` dele é copiado do campo por
 * listener. Sem isso, o roxo apareceria na linha errada justamente quando há
 * mais texto na tela — que é quando a pessoa está lendo para conferir o que
 * digitou.
 *
 * Copiar por listener e não por re-render: o `scrollTop` muda a cada pixel de
 * rolagem, e levá-lo por estado faria o `ChatPanel` re-renderizar a cada um
 * durante a digitação, com a lista de menções e o feed junto.
 *
 * `overflow: hidden` não impede rolagem por código: o elemento continua sendo
 * um contêiner de rolagem, só não tem barra. É o que se quer aqui.
 */
export const CLASSE_METRICA =
  'w-full whitespace-pre-wrap break-words py-1.5 text-sm font-sans leading-normal';

/**
 * Reserva a faixa da barra de rolagem nos dois.
 *
 * ## O defeito que isto corrige, medido
 *
 * Com o campo rolando (a partir de `max-h-28`), a área de texto do `textarea`
 * era 10px mais estreita que a do espelho: a barra de rolagem ocupa largura, e o
 * espelho, com `overflow: hidden`, não tem. O texto quebrava em pontos
 * diferentes e o roxo da menção caía sobre a palavra errada — o defeito mais
 * irritante possível num espelho, porque parece aleatório.
 *
 * Medido no navegador, com 14 repetições de "@Maria Silva linha N":
 *
 *     largura de conteúdo do campo:    1236px
 *     largura de conteúdo do espelho:  1246px   ← 10px de diferença
 *
 * `scrollbar-gutter: stable` reserva a faixa nos dois desde sempre, e os dois
 * quebram igual em qualquer altura de texto.
 *
 * ## E o ganho extra: o texto não salta de coluna
 *
 * Sem o gutter estável, a hora em que a 4ª linha aparece também estreita o
 * texto, e as linhas acima **re-quebram** para a esquerda. A pessoa vê o que
 * digitou mudar de lugar no instante em que digita — o pior momento para uma
 * mudança de layout. Com o gutter fixo, não há salto.
 *
 * O custo é a faixa reservada mesmo com uma linha só: ~10px, e o texto fica mais
 * estável por isso.
 *
 * ## `scroll-thin` também vai nos dois, e isso não é redundante
 *
 * Medido depois do gutter: o campo continuava 5px mais largo que o espelho. A
 * causa é que `scrollbar-gutter` reserva a largura da barra **daquele
 * contêiner**, e o espelho não tinha `scroll-thin` — então reservava os 15px da
 * barra padrão enquanto o campo reservava os 10px da fina. Dois números
 * diferentes para a mesma faixa reservada.
 */
export const GUTTER_ESTAVEL = 'scroll-thin [scrollbar-gutter:stable]';

export function MentionMirror({ texto, inicio, fim, campoRef }: Props) {
  const espelhoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const campo = campoRef.current;
    const espelho = espelhoRef.current;
    if (!campo || !espelho) return;
    const aoRolar = () => {
      espelho.scrollTop = campo.scrollTop;
    };
    campo.addEventListener('scroll', aoRolar, { passive: true });
    // Sincroniza na montagem também: o campo já pode estar rolado, se o
    // componente remontou com o rascunho longo.
    aoRolar();
    return () => campo.removeEventListener('scroll', aoRolar);
  }, [campoRef]);

  const temMencao = typeof inicio === 'number' && typeof fim === 'number' && fim > inicio;

  return (
    /*
     * `aria-hidden`: o espelho é uma cópia do valor, e um leitor de tela leria o
     * texto duas vezes — uma no `textarea`, outra aqui. Como não é interativo,
     * `aria-hidden` basta; não é preciso `inert`.
     *
     * O espaço no fim quando o texto é vazio é para o espelho ter a altura de uma
     * linha, igual ao campo. Um `div` sem texto tem altura zero, e o espelho
     * não apareceria embaixo do campo — que é o caso mais comum.
     */
    <div
      ref={espelhoRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden text-ink ${CLASSE_METRICA} ${GUTTER_ESTAVEL}`}
    >
      {temMencao ? (
        <>
          {texto.slice(0, inicio)}
          <span className="font-medium text-accent">{texto.slice(inicio, fim)}</span>
          {texto.slice(fim)}
        </>
      ) : (
        texto || ''
      )}
    </div>
  );
}
