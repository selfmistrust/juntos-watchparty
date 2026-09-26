import { DotsSixVertical, Plus, Trash } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { MediaSourceModal } from '@/components/media/MediaSourceModal';
import type { UploadTokenResult } from '@/hooks/useRoom';
import type { PlaylistItem } from '@/types';

interface Props {
  playlist: PlaylistItem[];
  currentIndex: number;
  canControl: boolean;
  onAdd: (item: Omit<PlaylistItem, 'id' | 'addedBy' | 'addedById'>) => void;
  onRemove: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onSelect: (index: number) => void;
  requestUploadToken: (payload: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  }) => Promise<UploadTokenResult>;
}

export function PlaylistPanel({
  playlist,
  currentIndex,
  canControl,
  onAdd,
  onRemove,
  onReorder,
  onSelect,
  requestUploadToken,
}: Props) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const handleDrop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    setDragOver(null);
    if (from === null || from === to) return;
    onReorder(from, to);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MediaSourceModal
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        canControl={canControl}
        addToPlaylist={onAdd}
        requestUploadToken={requestUploadToken}
      />

      {/*
        * Topo da aba: um único botão. A busca do YouTube e o bloco de conta
        * ficaram dentro do modal de Aplicações — ter as duas coisas aqui e lá
        * duplicava a mesma integração em dois lugares, e era isso que poluía o
        * topo. A conta conectada continua visível na aba Pessoas, no perfil.
        *
        * O botão não é condicionado a `canControl`: adicionar à fila é uma
        * permissão diferente de controlar a reprodução, e o servidor já aceita
        * `playlist:add` de qualquer participante da sala. Quem decide se uma
        * fonte específica pode ser usada é o card dela, via `requiresControl` —
        * assim o modal abre para todo mundo e só as fontes que têm motivo real
        * para ser restritas aparecem bloqueadas, com a explicação.
        */}
      <div className="border-b border-hairline p-3">
        <Button onClick={() => setSourcesOpen(true)} className="h-10 w-full justify-center gap-2">
          <Plus size={16} weight="bold" />
          Adicionar de uma aplicação
        </Button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {playlist.length === 0 ? (
          <p className="px-6 pt-10 text-center text-sm text-ink-faint">
            A fila começa vazia. Adicione o primeiro vídeo acima.
          </p>
        ) : (
          <ul className="p-2">
            {playlist.map((item, index) => {
              const playing = index === currentIndex;
              return (
                <li
                  key={item.id}
                  draggable={canControl}
                  onDragStart={() => (dragFrom.current = index)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(index);
                  }}
                  onDragLeave={() => setDragOver((v) => (v === index ? null : v))}
                  onDrop={() => handleDrop(index)}
                  onDragEnd={() => {
                    dragFrom.current = null;
                    setDragOver(null);
                  }}
                  className={clsx(
                    'group flex items-center gap-2 rounded-lg p-2 transition-colors duration-150',
                    playing ? 'bg-accent-soft' : 'hover:bg-hover',
                    dragOver === index && 'ring-1 ring-accent/50',
                  )}
                >
                  {canControl && (
                    <DotsSixVertical
                      size={16}
                      className="shrink-0 cursor-grab text-ink-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 active:cursor-grabbing"
                    />
                  )}

                  <button
                    onClick={() => canControl && onSelect(index)}
                    disabled={!canControl}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed"
                  >
                    <span className="relative shrink-0">
                      {item.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.thumbnail} alt="" className="h-10 w-[4.4rem] rounded object-cover" />
                      ) : (
                        <span className="flex h-10 w-[4.4rem] items-center justify-center rounded bg-hover text-2xs text-ink-faint">
                          MP4
                        </span>
                      )}
                      {playing && (
                        <span className="absolute inset-0 flex items-center justify-center rounded bg-black/55">
                          <Equalizer />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={clsx(
                          'line-clamp-2 block text-[0.8125rem] leading-snug',
                          playing ? 'text-ink' : 'text-ink/85',
                        )}
                      >
                        {item.title}
                      </span>
                      <span className="block truncate text-2xs text-ink-faint">
                        {playing ? 'Tocando agora' : `por ${item.addedBy}`}
                      </span>
                    </span>
                  </button>

                  {canControl && (
                    <button
                      aria-label={`Remover ${item.title} da fila`}
                      onClick={() => onRemove(item.id)}
                      className="shrink-0 rounded p-1.5 text-ink-faint opacity-0 transition-all duration-150 hover:bg-white/10 hover:text-live group-hover:opacity-100"
                    >
                      <Trash size={15} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Três barras animadas: sinaliza a faixa em reprodução sem ocupar espaço. */
function Equalizer() {
  return (
    <span className="flex h-3 items-end gap-0.5">
      {['0ms', '150ms', '300ms'].map((delay, i) => (
        <span
          key={delay}
          className="w-0.5 animate-blink rounded-sm bg-accent"
          style={{ animationDelay: delay, height: `${[8, 12, 6][i]}px` }}
        />
      ))}
    </span>
  );
}
