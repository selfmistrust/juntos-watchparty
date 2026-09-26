'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Options {
  /** Elemento colocado em tela cheia pelo navegador. */
  targetRef: React.RefObject<HTMLElement | null>;
}

interface FullscreenLandscape {
  /** O palco está em tela cheia — nativa ou pelo overlay de CSS. */
  isFullscreen: boolean;
  /** O palco precisa ser girado 90° porque a tela continua em pé. */
  rotate: boolean;
  /** Entra e sai da tela cheia. */
  toggle: () => void;
  /** Sai da tela cheia (inclusive pelo Esc ou pelo gesto do sistema). */
  exit: () => void;
}

const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' &&
  (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches);

/**
 * `lock`/`unlock` (Screen Orientation Lock API) não estão no `lib.dom` do
 * TypeScript. Android implementa; o resto do mundo não, e é por isso que os
 * dois são opcionais aqui.
 */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

const getOrientation = (): LockableOrientation | undefined =>
  typeof screen !== 'undefined' ? (screen.orientation as LockableOrientation | undefined) : undefined;

/**
 * Tenta travar a orientação em paisagem. Só funciona no Android e apenas já
 * em tela cheia; em qualquer outro lugar a promessa rejeita e quem assume é a
 * rotação por CSS.
 */
async function tryLockLandscape(): Promise<void> {
  const orientation = getOrientation();
  if (!orientation?.lock) return;
  try {
    await orientation.lock('landscape');
  } catch {
    // Alguns aparelhos só aceitam a variante com "any".
    try {
      await orientation.lock('any-landscape');
    } catch {
      // Sem travamento possível: o CSS assume.
    }
  }
}

function tryUnlockOrientation(): void {
  try {
    getOrientation()?.unlock?.();
  } catch {
    // Sem lock ativo não há o que destravar.
  }
}

/**
 * Tela cheia do player com o vídeo na horizontal no celular.
 *
 * Existem dois caminhos aqui, e qual deles roda depende do aparelho:
 *
 * 1. `screen.orientation.lock('landscape')` gira o celular de verdade. Só o
 *    Android implementa, e apenas já em tela cheia.
 * 2. Onde isso não existe (iOS), o palco é girado 90° por CSS e as dimensões
 *    são trocadas, para o vídeo ocupar a tela de lado mesmo assim. Os
 *    controles e a área de clique giram junto, por serem filhos do palco.
 *
 * Não é uma escolha fixa: o estado é recalculado a cada resize e virada de
 * tela. Assim, se o celular girar sozinho (Android), a rotação por CSS é
 * removida em vez de ser somada à rotação real.
 *
 * Devices with no Fullscreen API at all (older iPhone Safari) get a plain
 * fixed overlay, so the feature does not simply disappear there.
 */
export function useFullscreenLandscape({ targetRef }: Options): FullscreenLandscape {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rotate, setRotate] = useState(false);
  /** true quando a tela cheia é a nativa do navegador (top layer). */
  const usingNativeRef = useRef(false);
  const isFullscreenRef = useRef(false);

  isFullscreenRef.current = isFullscreen;

  const exit = useCallback(() => {
    setIsFullscreen(false);
    setRotate(false);
    if (!usingNativeRef.current) return;
    usingNativeRef.current = false;
    tryUnlockOrientation();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (isFullscreenRef.current) {
      exit();
      return;
    }

    // Estado otimista: a UI entra em tela cheia na hora, sem esperar a promessa
    // do navegador. Se a nativa entrar, o top layer assume; se for recusada
    // (ou demorar), o overlay de CSS já está no lugar e a experiência é a
    // mesma. Esperar a promessa travaria o botão em navegadores que pedem
    // um gesto que o autoplay já consumiu.
    setIsFullscreen(true);

    const target = targetRef.current;
    if (!document.fullscreenEnabled || !target) return;

    void target
      .requestFullscreen()
      .then(() => {
        usingNativeRef.current = true;
        // Melhor esforço: onde der, o aparelho gira de verdade.
        if (isTouchDevice()) void tryLockLandscape();
      })
      .catch(() => {
        // O navegador recusou (iframe sem allow, política da empresa...).
        // Fica no overlay de CSS, que já está ativo.
        usingNativeRef.current = false;
      });
  }, [exit, targetRef]);

  // Saiu pelo Esc, pelo gesto "voltar" do sistema ou pelo próprio navegador.
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement) return;
      if (!usingNativeRef.current) return;
      usingNativeRef.current = false;
      tryUnlockOrientation();
      setIsFullscreen(false);
      setRotate(false);
    };

    document.addEventListener('fullscreenchange', onChange);
    // Safari antigo só emite o evento com prefixo.
    document.addEventListener('webkitfullscreenchange', onChange as EventListener);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange as EventListener);
    };
  }, []);

  // Decide se o palco precisa ser girado. Recalculado a cada resize e virada
  // de tela para acompanhar tanto a rotação do aparelho quanto a do overlay.
  useEffect(() => {
    if (!isFullscreen || !isTouchDevice()) {
      setRotate(false);
      return;
    }

    const evaluate = () => setRotate(window.innerHeight > window.innerWidth);

    evaluate();
    window.addEventListener('resize', evaluate);
    window.addEventListener('orientationchange', evaluate);
    screen.orientation?.addEventListener?.('change', evaluate);

    return () => {
      window.removeEventListener('resize', evaluate);
      window.removeEventListener('orientationchange', evaluate);
      getOrientation()?.removeEventListener?.('change', evaluate);
    };
  }, [isFullscreen]);

  // Sair da página com a tela cheia ativa prenderia a orientação do aparelho.
  useEffect(() => () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    tryUnlockOrientation();
  }, []);

  return { isFullscreen, rotate, toggle, exit };
}
