'use client';

import { MagnifyingGlass, WaveTriangle, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { useYouTubeAccount } from '@/hooks/useYouTubeAccount';
import { addYoutubeFromUrl, searchYoutube } from '@/lib/mediaSources';
import { Portal } from '@/components/ui/Portal';
import { Button } from '@/components/ui/Button';
import type { MediaSourceContext } from '@/lib/mediaSources';
import type { YoutubeResult } from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
  context: MediaSourceContext;
}

/**
 * Busca do YouTube em painel próprio, e não dentro do modal de Aplicações: a
 * busca é uma tarefa com estado (texto, resultados, carregando, erro) e
 * misturá-la com a grade de cards deixaria o modal pesado e imposible de
 * fechar sem perder o que foi digitado.
 *
 * A lógica de rede vem de `lib/mediaSources/youtube`, compartilhada com o
 * painel da fila — o que existia antes continua existindo, agora com a mesma
 * implementação nos dois lugares.
 */
export function YoutubeSearchPanel({ open, onClose, context }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YoutubeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status, connect } = useYouTubeAccount();

  const submit = useCallback(async () => {
    const value = query.trim();
    if (!value) return;

    // Link colado entra direto na fila, sem depender de API.
    const direto = addYoutubeFromUrl(value);
    if (direto) {
      context.addToPlaylist(direto);
      setQuery('');
      setResults([]);
      setError(null);
      onClose();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setResults(await searchYoutube(value));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A busca não respondeu. Tente de novo.');
    } finally {
      setLoading(false);
    }
  }, [context, onClose, query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const podeBuscar = status.configured || status.connected;

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Buscar no YouTube"
          className="animate-fade-up flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-hairline bg-surface shadow-lift sm:rounded-2xl"
        >
          <div className="flex items-center gap-2 border-b border-hairline p-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-hairline bg-raised px-3 transition-colors duration-150 focus-within:border-accent/60">
              <MagnifyingGlass size={16} className="shrink-0 text-ink-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                placeholder="Buscar no YouTube ou colar um link"
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
              />
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={!query.trim() || loading}
                className="h-7 shrink-0 px-2.5"
              >
                {loading ? <WaveTriangle size={14} className="animate-pulse" /> : 'Buscar'}
              </Button>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar busca"
              className="shrink-0 rounded-md p-2 text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink [@media(pointer:coarse)]:p-2.5"
            >
              <X size={16} />
            </button>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {error && <p className="animate-fade-up p-3 text-2xs leading-relaxed text-live/90">{error}</p>}

            {!podeBuscar && !error && (
              <div className="p-3">
                <p className="text-2xs leading-relaxed text-ink-faint">
                  Sem uma conta conectada, a busca não roda. Você ainda pode colar um link do YouTube
                  direto no campo acima.
                </p>
                <Button size="sm" onClick={connect} className="mt-2.5">
                  Conectar YouTube
                </Button>
              </div>
            )}

            {results.length > 0 && (
              <ul className="p-2">
                {results.map((r) => (
                  <li key={r.videoId}>
                    <button
                      type="button"
                      onClick={() => {
                        context.addToPlaylist({
                          kind: 'youtube',
                          src: r.videoId,
                          title: r.title,
                          thumbnail: r.thumbnail,
                        });
                        onClose();
                      }}
                      className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-150 hover:bg-hover [@media(pointer:coarse)]:py-3"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={r.thumbnail} alt="" className="h-10 w-[4.4rem] shrink-0 rounded object-cover" />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 block text-[0.8125rem] leading-snug text-ink">{r.title}</span>
                        <span className="block truncate text-2xs text-ink-faint">{r.channel}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {results.length === 0 && !error && !loading && query.trim() === '' && (
              <p className="px-4 py-8 text-center text-2xs leading-relaxed text-ink-faint">
                Busque por um termo ou cole o link de um vídeo.
              </p>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
