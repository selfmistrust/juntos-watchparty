'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { CHAT_REACTION_EMOJIS, type ChatReactionEmoji } from '@/types';

/** Categorias de emojis para organização visual. */
const EMOJI_CATEGORIES: Record<string, ChatReactionEmoji[]> = {
  'Frequentes': ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '🎉', '🤔', '👏'],
  'Positivos': ['❤️', '👍', '🎉', '🔥', '👏', '😂', '😍', '🥰', '🤩', '😊'],
  'Negativos': ['👎', '😢', '😭', '😡', '😠', '🤬', '😱', '😨', '😰', '😥'],
  'Neutros': ['🤔', '😐', '😶', '🙄', '😏', '😴', '🤷', '🤷‍♂️', '🤷‍♀️', '🤦'],
  'Mãos': ['👏', '👍', '👎', '👋', '🤝', '✋', '🤚', '🖐', '✌️', '🤞'],
};

const ALL_EMOJIS = CHAT_REACTION_EMOJIS;

interface Props {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function EmojiPicker({ onSelect, onClose, anchorRef }: Props) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('Frequentes');
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredEmojis = useMemo(() => {
    if (!search.trim()) return EMOJI_CATEGORIES[activeCategory] || [];
    const query = search.toLowerCase();
    return ALL_EMOJIS.filter((e) => e.includes(query) || getEmojiName(e).includes(query));
  }, [search, activeCategory]);

  // Fecha ao clicar fora do picker
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;

      // Se o clique foi dentro do próprio picker, não faz nada
      if (containerRef.current && containerRef.current.contains(target)) {
        return;
      }

      // Se o clique foi no botão que abre/fecha o emoji, ignora para o onClick do botão tratar
      if (anchorRef?.current && anchorRef.current.contains(target)) {
        return;
      }

      onClose();
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, anchorRef]);

  return (
    <div
      ref={containerRef}
      className="animate-fade-up absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-hairline bg-surface shadow-lift"
    >
      {/* Header com Busca e Categorias - Mesma estrutura e classes do GifPicker */}
      <div className="flex flex-col gap-1.5 border-b border-hairline p-2">
        <div className="flex items-center gap-2">
          <MagnifyingGlass size={15} className="ml-1 shrink-0 text-ink-faint" />
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar emoji…"
            className="h-8 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar busca de emoji"
            className="rounded-md p-1 text-ink-faint transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        {/* Categorias. Quebram linha em vez de rolar na horizontal: com
            `overflow-x-auto` a última aba ("Mãos") ficava fora da tela em 320px,
            e a barra escondida (`scrollbar-hide`) não dava nenhuma pista de que
            dava para arrastar. Quebrando, todas ficam visíveis e o alvo de
            toque continua inteiro. `whitespace-nowrap` em cada botão impede que
            o texto da categoria quebre sozinho. */}
        <div className="flex flex-wrap gap-1 select-none" role="tablist">
          {Object.keys(EMOJI_CATEGORIES).map((cat) => (
            <button
              key={cat}
              role="tab"
              type="button"
              aria-selected={activeCategory === cat}
              onClick={() => {
                setActiveCategory(cat);
                setSearch('');
              }}
              className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                activeCategory === cat
                  ? 'bg-accent-soft text-accent'
                  : 'text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Grid de Emojis - Mantém o mesmo padronizado scroll-thin e altura max-h-56 do GifPicker */}
      <div className="scroll-thin max-h-56 overflow-y-auto overflow-x-hidden p-2">
        {filteredEmojis.length === 0 ? (
          <p className="py-6 text-center text-2xs text-ink-faint">
            Nenhum emoji encontrado.
          </p>
        ) : (
          <div className="grid grid-cols-8 gap-1">
            {filteredEmojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  onSelect(emoji);
                  // Não fecha o picker - permite selecionar múltiplos emojis
                }}
                className="flex h-9 w-9 items-center justify-center rounded-md text-xl transition-colors hover:bg-hover active:bg-hover active:scale-95 focus:outline-none focus:ring-1 focus:ring-accent"
                aria-label={getEmojiName(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function getEmojiName(emoji: string): string {
  const names: Record<string, string> = {
    '❤️': 'coração vermelho',
    '👍': 'joia',
    '👎': 'não gostei',
    '😂': 'rosto chorando de rir',
    '😮': 'rosto surpreso',
    '😢': 'rosto chorando',
    '🔥': 'fogo',
    '🎉': 'festa',
    '🤔': 'pensando',
    '👏': 'aplausos',
    '😍': 'olhos de coração',
    '🥰': 'sorriso com corações',
    '🤩': 'olhos de estrela',
    '😊': 'sorriso tímido',
    '😭': 'chorando muito',
    '😡': 'bravo',
    '😠': 'irritado',
    '🤬': 'xingando',
    '😱': 'gritando de medo',
    '😨': 'assustado',
    '😰': 'suando frio',
    '😥': 'aliviado mas triste',
    '😐': 'neutro',
    '😶': 'sem boca',
    '🙄': 'revirando os olhos',
    '😏': 'sorriso de lado',
    '😴': 'dormindo',
    '🤷': 'dando de ombros',
    '🤷‍♂️': 'homem dando de ombros',
    '🤷‍♀️': 'mulher dando de ombros',
    '🤦': 'batendo a testa',
    '👋': 'acenando',
    '🤝': 'apertando as mãos',
    '✋': 'mão aberta',
    '🤚': 'dorso da mão',
    '🖐': 'mão aberta com dedos separados',
    '✌️': 'sinal de paz',
    '🤞': 'dedos cruzados',
  };
  return names[emoji] || emoji;
}