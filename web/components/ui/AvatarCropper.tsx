import { Check, X } from '@phosphor-icons/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cropAvatarFromImage, loadImageFile } from '@/lib/media';

interface Props {
  file: File;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}

const VIEWPORT = 240; // px — diâmetro do círculo de recorte na tela
const OUTPUT_SIZE = 160; // mesmo tamanho final que o corte automático antigo usava
const MAX_ZOOM = 3;

type Point = { x: number; y: number };

/**
 * Modal de recorte de avatar: em vez de cortar o centro automaticamente, a
 * pessoa escolhe o zoom (slider) e arrasta a foto até ficar do jeito que
 * gosta, antes de confirmar.
 */
export function AvatarCropper({ file, onCancel, onConfirm }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [broken, setBroken] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState<Point | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origin: Point } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImg(null);
    setBroken(false);
    setZoom(1);
    setCenter(null);
    loadImageFile(file)
      .then((loaded) => {
        if (cancelled) return;
        setImg(loaded);
        setCenter({ x: loaded.width / 2, y: loaded.height / 2 });
      })
      .catch(() => !cancelled && setBroken(true));
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (!img || !center) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6">
        <div className="animate-fade-up w-full max-w-xs rounded-2xl border border-hairline bg-surface p-5 shadow-lift">
          <p className="text-center text-sm text-ink-faint">
            {broken ? 'Não deu para abrir essa imagem.' : 'Abrindo imagem…'}
          </p>
          <Button variant="outline" onClick={onCancel} className="mt-4 w-full">
            {broken ? 'Voltar' : 'Cancelar'}
          </Button>
        </div>
      </div>
    );
  }

  const baseScale = VIEWPORT / Math.min(img.width, img.height);

  /** Mantém o centro dentro da imagem para o zoom/posição atuais não deixarem borda vazia à mostra. */
  const clampCenterAt = (point: Point, z: number): Point => {
    const s = baseScale * z;
    const half = VIEWPORT / 2 / s;
    return {
      x: img.width <= half * 2 ? img.width / 2 : Math.min(img.width - half, Math.max(half, point.x)),
      y: img.height <= half * 2 ? img.height / 2 : Math.min(img.height - half, Math.max(half, point.y)),
    };
  };

  const scale = baseScale * zoom;
  const dispW = img.width * scale;
  const dispH = img.height * scale;
  const halfNatural = VIEWPORT / 2 / scale;
  const offsetX = VIEWPORT / 2 - center.x * scale;
  const offsetY = VIEWPORT / 2 - center.y * scale;

  const changeZoom = (value: number) => {
    setZoom(value);
    setCenter((prev) => (prev ? clampCenterAt(prev, value) : prev));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, origin: center };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setCenter(
      clampCenterAt(
        { x: dragRef.current.origin.x - dx / scale, y: dragRef.current.origin.y - dy / scale },
        zoom,
      ),
    );
  };

  const stopDrag = () => {
    dragRef.current = null;
  };

  const confirm = () => {
    onConfirm(
      cropAvatarFromImage(
        img,
        { x: center.x - halfNatural, y: center.y - halfNatural, size: halfNatural * 2 },
        OUTPUT_SIZE,
      ),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6">
      <div className="animate-fade-up w-full max-w-xs rounded-2xl border border-hairline bg-surface p-5 shadow-lift">
        <div className="flex items-center justify-between">
          <h2 className="text-sm text-ink">Ajustar foto</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancelar"
            className="rounded-md p-1 text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        <div
          className="relative mx-auto mt-4 touch-none select-none overflow-hidden rounded-full bg-raised ring-1 ring-hairline"
          style={{ width: VIEWPORT, height: VIEWPORT, cursor: 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDrag}
          onPointerLeave={stopDrag}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img.src}
            alt="Pré-visualização da foto"
            draggable={false}
            className="pointer-events-none absolute left-0 top-0 max-w-none"
            style={{ width: dispW, height: dispH, transform: `translate(${offsetX}px, ${offsetY}px)` }}
          />
        </div>
        <p className="mt-2 text-center text-2xs text-ink-faint">Arraste para posicionar</p>

        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(e) => changeZoom(Number(e.target.value))}
          /* O `range` nativo tem ~16px de altura e é difícil de acertar no
             dedo. O `py-2` estende a área sensível para ~32px sem alterar a
             espessura visual do controle. */
          className="mt-1 w-full cursor-pointer py-2 accent-accent"
          aria-label="Zoom da foto"
        />

        <div className="mt-4 flex gap-2">
          <Button variant="outline" onClick={onCancel} className="flex-1">
            Cancelar
          </Button>
          <Button onClick={confirm} className="flex-1">
            <Check size={15} />
            Usar foto
          </Button>
        </div>
      </div>
    </div>
  );
}
