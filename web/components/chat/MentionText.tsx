'use client';

import { Fragment, useMemo } from 'react';
import { segmentarTexto, type AlvoDestaque } from '@/lib/mentionHighlight';

interface Props {
  texto: string;
  participantes: readonly AlvoDestaque[];
  /** `sessionId` de quem foi citado, como o servidor resolveu. */
  mencionados: readonly string[] | undefined;
  /** Abre o perfil de quem foi citado. */
  aoAbrirPerfil: (sessionId: string) => void;
}

/**
 * O texto da mensagem com o `@nome` destacado e clicável.
 *
 * ## Clicável, e por quê um botão dentro de texto
 *
 * A menção é a única parte da mensagem que **faz alguma coisa**: abrir o perfil
 * de quem foi citado. Deixar isso só no hover, ou só discoverível passando o
 * cursor, é transformar a única parte ativa do texto em parte inerte. Então cada
 * menção é um `<button>` — que também é o que dá foco por teclado e o que a
 * leitora de tela anuncia como algo clicável, sem nenhum atributo `aria`
 * inventado.
 *
 * ## Por que o botão é `inline`, e não um bloco
 *
 * Estar dentro de um parágrafo é o que faz `@Maria` quebrar linha no meio da
 * frase, como qualquer palavra. Um `div` aqui tiraria a menção do fluxo do
 * texto e ela apareceria numa linha sozinha, que é o jeito mais-feito de
 * arriscar um chat quebrar.
 *
 * ## O texto nunca é reescrito
 *
 * O que aparece é o que a pessoa digitou, e não o nome oficial de quem foi
 * citado. Reescrever a mensagem de outra pessoa é uma Gentileza que vira
 * mentira: "@maria" escrito em minúsculo continua sendo a mensagem dela.
 */
export function MentionText({ texto, participantes, mencionados, aoAbrirPerfil }: Props) {
  const segmentos = useMemo(
    () => segmentarTexto(texto, participantes, mencionados ?? []),
    [texto, participantes, mencionados],
  );

  return (
    <>
      {segmentos.map((seg, i) =>
        seg.tipo === 'texto' ? (
          <Fragment key={i}>{seg.texto}</Fragment>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => aoAbrirPerfil(seg.sessionId)}
            className="inline rounded bg-accent-soft px-0.5 font-medium text-accent underline decoration-accent/40 underline-offset-2 transition-colors duration-150 hover:decoration-accent"
            title={`Ver perfil de ${seg.nome}`}
          >
            {seg.texto}
          </button>
        ),
      )}
    </>
  );
}
