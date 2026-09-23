import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { searchGifs } from '@/lib/gifs';
import type { GifResult } from '@/types';

interface Props {
  onPick: (gif: GifResult) => void;
  onClose: () => void;
}

/** Busca com debounce simples — evita disparar uma requisição por tecla. */
export function GifPicker({ onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(debounce.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearched(false);
      return;
    }
    debounce.current = setTimeout(async () => {
      setLoading(true);
      try {
        const items = await searchGifs(q);
        setResults(items);
      } finally {
        setSearched(true);
        setLoading(false);
      }
    }, 380);
    return () => clearTimeout(debounce.current);
  }, [query]);

  return (
    <div className="animate-fade-up absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-hairline bg-surface shadow-lift">
      <div className="flex items-center gap-2 border-b border-hairline p-2">
        <MagnifyingGlass size={15} className="ml-1 shrink-0 text-ink-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar GIF"
          className="h-8 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar busca de GIF"
          className="rounded-md p-1 text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>

      <div className="scroll-thin grid max-h-56 grid-cols-3 gap-1.5 overflow-y-auto p-2">
        {!query.trim() && (
          <p className="col-span-3 py-6 text-center text-2xs text-ink-faint">Digite algo para buscar.</p>
        )}
        {loading && <p className="col-span-3 py-6 text-center text-2xs text-ink-faint">Buscando…</p>}
        {!loading && searched && results.length === 0 && (
          <p className="col-span-3 py-6 text-center text-2xs leading-relaxed text-ink-faint">
            Nada encontrado — ou a busca de GIFs ainda não foi configurada no servidor.
          </p>
        )}
        {!loading &&
          results.map((gif) => (
            <button
              key={gif.id}
              type="button"
              onClick={() => onPick(gif)}
              className="aspect-square overflow-hidden rounded-lg bg-raised transition-transform duration-150 ease-out hover:scale-[1.03]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={gif.preview || gif.url} alt={gif.title} className="h-full w-full object-cover" />
            </button>
          ))}
      </div>
    </div>
  );
}
