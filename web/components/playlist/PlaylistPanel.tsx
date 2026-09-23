import { DotsSixVertical, MagnifyingGlass, Plus, Trash, WaveTriangle } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { VideoUploadField } from '@/components/playlist/VideoUploadField';
import type { UploadTokenResult } from '@/hooks/useRoom';
import { parseMediaUrl, youtubeThumb } from '@/lib/media';
import { SERVER_URL } from '@/lib/socket';
import type { PlaylistItem, YoutubeResult } from '@/types';

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

type Status = { kind: 'idle' } | { kind: 'error'; message: string } | { kind: 'loading' };

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
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YoutubeResult[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  /**
   * Um único campo resolve os dois casos: se o texto for uma URL reproduzível,
   * entra direto na fila; caso contrário, vira uma busca no YouTube.
   */
  const submit = useCallback(async () => {
    const value = query.trim();
    if (!value) return;

    const parsed = parseMediaUrl(value);
    if (parsed) {
      onAdd({
        kind: parsed.kind,
        src: parsed.src,
        title: parsed.title,
        thumbnail: parsed.kind === 'youtube' ? youtubeThumb(parsed.src) : undefined,
      });
      setQuery('');
      setResults([]);
      setStatus({ kind: 'idle' });
      return;
    }

    setStatus({ kind: 'loading' });
    try {
      const res = await fetch(`${SERVER_URL}/api/youtube/search?q=${encodeURIComponent(value)}`);
      if (res.status === 501) {
        setStatus({
          kind: 'error',
          message: 'A busca precisa de uma chave da YouTube API. Cole um link para adicionar mesmo assim.',
        });
        return;
      }
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { items: YoutubeResult[] };
      setResults(data.items);
      setStatus({ kind: 'idle' });
    } catch {
      setStatus({ kind: 'error', message: 'A busca não respondeu. Tente de novo ou cole um link.' });
    }
  }, [onAdd, query]);

  const addResult = (result: YoutubeResult) => {
    onAdd({ kind: 'youtube', src: result.videoId, title: result.title, thumbnail: result.thumbnail });
    setResults([]);
    setQuery('');
  };

  const handleDrop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    setDragOver(null);
    if (from === null || from === to) return;
    onReorder(from, to);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-hairline p-3">
        <div className="flex items-center gap-2 rounded-xl border border-hairline bg-raised px-3 transition-colors duration-150 focus-within:border-accent/60">
          <MagnifyingGlass size={16} className="shrink-0 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Buscar no YouTube ou colar um link"
            className="h-10 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <Button size="sm" onClick={submit} disabled={!query.trim() || status.kind === 'loading'} className="h-7 px-2.5">
            {status.kind === 'loading' ? <WaveTriangle size={14} className="animate-pulse" /> : <Plus size={14} weight="bold" />}
            Add
          </Button>
        </div>
        {status.kind === 'error' && (
          <p className="animate-fade-up mt-2 text-2xs leading-relaxed text-live/90">{status.message}</p>
        )}

        <VideoUploadField canControl={canControl} requestUploadToken={requestUploadToken} onUploaded={onAdd} />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {results.length > 0 && (
          <div className="border-b border-hairline bg-surface/60 p-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-2xs text-ink-faint">Resultados da busca</span>
              <button onClick={() => setResults([])} className="text-2xs text-ink-faint hover:text-ink">
                limpar
              </button>
            </div>
            {results.map((r) => (
              <button
                key={r.videoId}
                onClick={() => addResult(r)}
                className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-150 hover:bg-hover"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.thumbnail} alt="" className="h-10 w-[4.4rem] shrink-0 rounded object-cover" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block text-[0.8125rem] leading-snug text-ink">{r.title}</span>
                  <span className="block truncate text-2xs text-ink-faint">{r.channel}</span>
                </span>
              </button>
            ))}
          </div>
        )}

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
