'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A divisória entre o vídeo e o painel lateral.
 *
 * ## Onde a largura mora, e por que não no `Sidebar`
 *
 * A largura é do **layout**, não do painel. O `Sidebar` desenha o painel; quem
 * decide o espaço entre as duas colunas é a linha da página, e é por isso que o
 * `width` vive no estado da página e desce por prop. Um painel que guardasse a
 * própria largura não teria como saber a distância do mouse até a borda do vídeo.
 *
 * ## As quatro coisas que quebram sem querer
 *
 * Tres delas sao o motivo de o divisor existir como elemento so seu:
 *
 * **Seleção de texto.** Arrastar sobre a página seleciona a legenda e a faixa toda.
 * Por isso `user-select: none` fica ligado enquanto o arraste é ativo, e não
 * sempre — desativar sempre quebraria a seleção de quem quiser copiar um título
 * do chat.
 *
 * **Scroll do chat.** O `pointermove` é escutado na janela, não no divisor. Se
 * fosse no divisor, o ponteiro saindo da alça de 8px soltaria o arraste no meio —
 * e o cursor `col-resize` convida a arrastar rápido, para fora da alça.
 *
 * **Captura do ponteiro.** `setPointerCapture` prende os eventos no elemento, de
 * modo que o arraste continua mesmo com o cursor no meio da tela ou na borda da
 * janela. Sem isso, o arraste morre ao cruzar a borda.
 *
 * **Teclado.** Um divisor que só responde ao mouse não é alcançável. `role
 * "separator"` com `aria-valuenow` e as setas fazem a mesma coisa em 16px por
 * tecla, e é o que permite a quem não usa mouse redimensionar o painel.
 */
export function SidebarResizer({
  width,
  onChange,
  min,
  max,
  padrao,
}: {
  width: number;
  onChange: (width: number) => void;
  min: number;
  max: number;
  /** O valor do botão duplo. */
  padrao: number;
}) {
  const [arrastando, setArrastando] = useState(false);
  const [larguraTela, setLarguraTela] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  /** Largura do painel no instante em que o arraste começou. */
  const inicioRef = useRef({ x: 0, largura: 0 });

  /*
   * A largura do painel é medida a partir da borda **direita** da janela, e não
   * a partir do cursor. As duas dão o mesmo resultado durante o arraste, mas só a
   * segunda sobrevive a uma janela que muda de tamanho no meio: se a pessoa
   * redimensiona a janela enquanto arrasta, o offset do cursor deixa de valer e
   * o painel salta.
   */
  const larguraPeloBordaDireita = useCallback((): number | null => {
    /*
     * O `ref` pode estar vazio só se o `pointerdown` chegar antes do primeiro
     * render com o nó montado, e o `!` aqui transformaria isso num `TypeError`
     * dentro de um event handler — que o React engole e repete a cada arraste.
     * `null` faz o chamador não ter largura de partida, e ele devolve.
     */
    const no = ref.current;
    if (!no) return null;
    return larguraTela - no.getBoundingClientRect().right;
  }, [larguraTela]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Só o botão principal mexe na largura. O direito abriria um menu, e o
      // do meio anda a página — nenhum dos dois é redimensionar.
      if (e.button !== 0) return;
      e.preventDefault();
      const larguraInicial = larguraPeloBordaDireita();
      if (larguraInicial === null) return;
      inicioRef.current = { x: e.clientX, largura: larguraInicial };
      setArrastando(true);
      ref.current?.setPointerCapture(e.pointerId);
    },
    [larguraPeloBordaDireita],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!arrastando) return;
      const delta = e.clientX - inicioRef.current.x;
      const bruto = inicioRef.current.largura - delta;
      onChange(Math.min(max, Math.max(min, Math.round(bruto))));
    },
    [arrastando, max, min, onChange],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setArrastando(false);
    ref.current?.releasePointerCapture(e.pointerId);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const passo = e.shiftKey ? 40 : 16;
      if (e.key === 'ArrowLeft') onChange(Math.min(max, width + passo));
      else if (e.key === 'ArrowRight') onChange(Math.max(min, width - passo));
      else if (e.key === 'Home') onChange(max);
      else if (e.key === 'End') onChange(min);
      else if (e.key === 'Enter' || e.key === ' ') onChange(padrao);
      else return;
      // Sem isto a página rola junto com a tecla, e o foco pula para o vídeo.
      e.preventDefault();
    },
    [max, min, onChange, padrao, width],
  );

  /**
   * O botão duplo volta ao padrão.
   *
   * ## Por que ele é preciso
   *
   * A largura fica no `localStorage`, então mudar o valor padrão **não** muda a
   * tela de quem já arrastou. A pessoa fica com a largura antiga, sem caminho
   * para o valor novo a não ser o arraste inteiro de volta.
   *
   * Apagar a chave por conta própria seria o caminho curto e o errado: a largura
   * escolhida é uma preferência, e jogá-la fora sem a pessoa pedir é a mesma
   * coisa que o Spotify faz com os escopos — trocar de conta porque o app
   * decidiu.
   *
   * O duplo clique é o gesto de desfazer, e ele é reversível por natureza: quem
   * não gostar arrasta de novo. O `aria-label` cita o valor, para quem navega
   * por teclado saber o que o duplo clique faz antes de fazê-lo.
   */
  const onDoubleClick = useCallback(() => {
    onChange(padrao);
  }, [onChange, padrao]);

  /*
   * A janela muda de largura entre o `pointerdown` e o `pointermove` — a pessoa
   * redimensiona, maximiza, ou o app desktop ganha uma barra. Medir aqui evita
   * usar uma `larguraTela` de antes, que faria o painel inteiro andar errado a
   * cada arraste seguinte.
   */
  useEffect(() => {
    const medir = () => setLarguraTela(window.innerWidth);
    medir();
    window.addEventListener('resize', medir);
    return () => window.removeEventListener('resize', medir);
  }, []);

  /*
   * O `user-select` do `body` durante o arraste.
   *
   * Fica no `body` e não no divisor porque a seleção começa no elemento que está
   * sob o cursor, e o divisor tem 8px: um arrraste de 3px já passa por cima de
   * texto do vídeo. Aplicar no divisor seleciona o próprio divisor, que é vazio.
   */
  useEffect(() => {
    if (!arrastando) return;
    const anterior = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = anterior;
      document.body.style.cursor = '';
    };
  }, [arrastando]);

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Largura do painel lateral. Duplo clique volta ao padrão, ${padrao} pixels.`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={[
        'group relative z-10 hidden w-px shrink-0 cursor-col-resize touch-none lg:block',
        'focus-visible:outline-none focus-visible:bg-accent',
        arrastando ? 'bg-accent' : 'bg-transparent hover:bg-accent/40',
      ].join(' ')}
    >
      {/*
       * O alvo sensível são 13px e a linha visível são 1px.
       *
       * A linha é a que se vê; a área em volta é a que se acerta. Com 1px de
       * alvo, acertar a borda com o dedo é quase impossível, e a resposta a uma
       * alça impossível é não usar.
       *
       * `pointer-events-none` porque o span é só área: o arraste precisa
       * chegar no div, e um span que intercepta o clique roubaria o
       * `pointerdown` de metade da alça.
       */}
      <span className="pointer-events-none absolute -left-[6px] -right-[6px] top-0 bottom-0" />
    </div>
  );
}
