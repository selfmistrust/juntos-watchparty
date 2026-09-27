'use client';

import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** O texto exibido. Também é o que vai para o `title`. */
  text: string;
  /**
   * `truncate` (uma linha) é o padrão. Quem precisa de duas linhas passa
   * `lineClamp={2}` — o corte continua sendo medido, porque o
   * `scrollHeight` acusa a linha que sobrou fora da caixa.
   */
  className?: string;
  /** Quantas linhas cabem antes de cortar. 1 (padrão) deixa o `truncate` para trás. */
  lineClamp?: 1 | 2 | 3;
}

/**
 * Texto de uma linha só, com reticências, e `title` **só quando o texto
 * realmente foi cortado**.
 *
 * A parte não óbvia é o `title` condicional. Botão com tooltip incondicional
 * mostra a dica mesmo com o texto inteiro à vista, o que vira ruído: o mesmo
 * "Entrar na sala" aparecendo em dez botões da tela. Aqui o `title` só existe
 * quando há algo escondido, que é a única vez em que ele carrega informação.
 *
 * A medição também é refeita quando o elemento muda de tamanho, e não só no
 * primeiro render: o painel recolapsa, a fonte carrega, o nome da sala muda de
 * comprimento. Sem o `ResizeObserver`, o `title` ficaria preso ao layout
 * inicial e apareceria em texto que já não estava cortado — ou sumiria de
 * texto que passou a estar.
 *
 * Detecta os dois eixos: `scrollWidth` para a reticência da direita e
 * `scrollHeight` para a linha de baixo cortada pelo `line-clamp`.
 */
export function TruncatedText({ text, className, lineClamp = 1 }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [title, setTitle] = useState<string | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const medir = () => {
      const cortado =
        el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      // `undefined` quando não corta: o React descarta o atributo, e não basta
      // string vazia, que ainda renderiza o tooltip.
      setTitle(cortado ? text : undefined);
    };

    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <span
      ref={ref}
      title={title}
      className={clsx('min-w-0', lineClamp === 1 && 'truncate', className)}
      /*
       * O clamp vai por estilo inline, e não pela classe `line-clamp-N`.
       *
       * `line-clamp` depende de `display: -webkit-box`. O chamador passou
       * `block` no `className` nos três usos de duas linhas, e no Tailwind quem
       * vence um conflito de `display` é a ordem no CSS gerado, não a ordem no
       * atributo — então o `block` vencia, o clamp ficava silenciosamente
       * desligado, e o texto crescia sem limite. No card do "Transmitir tela"
       * foram quatro linhas e 36px a mais de altura, com a grade desalinhada.
       *
       * Estilo inline ganha de classe, e `truncate` (uma linha) dispensa
       * `display`, então o caminho de uma linha segue como estava.
       */
      style={
        lineClamp === 1
          ? undefined
          : {
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: lineClamp,
              overflow: 'hidden',
            }
      }
    >
      {text}
    </span>
  );
}
