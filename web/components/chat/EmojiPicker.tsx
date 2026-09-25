'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, MagnifyingGlass } from '@phosphor-icons/react';
import { CHAT_REACTION_EMOJIS, type ChatReactionEmoji } from '@/types';
import { Portal } from '@/components/ui/Portal';

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
  /** Callback quando um emoji é selecionado. */
  onSelect: (emoji: string) => void;
  /** Fecha o picker. */
  onClose: () => void;
  /** Referência ao botão que abriu o picker (para posicionamento). */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

export function EmojiPicker({ onSelect, onClose, anchorRef }: Props) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('Frequentes');
  const [showCategories, setShowCategories] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredEmojis = useMemo(() => {
    if (!search) return EMOJI_CATEGORIES[activeCategory] || [];
    return ALL_EMOJIS.filter((e) => e.includes(search) || getEmojiName(e).includes(search.toLowerCase()));
  }, [search, activeCategory]);

  // Fecha ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Foca input de busca ao abrir
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Posicionamento relativo ao anchor
  useEffect(() => {
    const anchor = anchorRef.current;
    const container = containerRef.current;
    if (!anchor || !container) return;

    const rect = anchor.getBoundingClientRect();
    container.style.top = `${rect.bottom + window.scrollY + 4}px`;
    container.style.left = `${rect.left + window.scrollX}px`;

    // Ajusta se passar da tela
    const containerRect = container.getBoundingClientRect();
    if (containerRect.right > window.innerWidth - 8) {
      container.style.left = `${window.innerWidth - containerRect.width - 8}px`;
    }
  }, [anchorRef]);

  return (
    <Portal>
      <div
        ref={containerRef}
        className="fixed z-50 w-72 rounded-xl border border-hairline bg-surface shadow-lg overflow-hidden animate-fade-up"
        role="dialog"
        aria-label="Seletor de emoji"
      >
        {/* Header com busca e categorias */}
        <div className="p-2 border-b border-hairline">
          <div className="relative mb-2">
            <MagnifyingGlass size={16} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar emoji..."
              className="w-full h-8 pl-8 pr-2 bg-raised rounded-lg text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="flex gap-1 overflow-x-auto pb-1" role="tablist">
            {Object.keys(EMOJI_CATEGORIES).map((cat) => (
              <button
                key={cat}
                role="tab"
                aria-selected={activeCategory === cat}
                onClick={() => {
                  setActiveCategory(cat);
                  setSearch('');
                }}
                className={`shrink-0 px-2 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  activeCategory === cat
                    ? 'bg-accent text-white'
                    : 'text-ink-muted hover:bg-hover hover:text-ink'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Grid de emojis */}
        <div className="max-h-60 overflow-y-auto p-2">
          {filteredEmojis.length === 0 ? (
            <p className="text-center text-2xs text-ink-faint py-4">Nenhum emoji encontrado</p>
          ) : (
            <div className="grid grid-cols-8 gap-1" role="listbox">
              {filteredEmojis.map((emoji) => (
                <button
                  key={emoji}
                  role="option"
                  onClick={() => {
                    onSelect(emoji);
                    onClose();
                  }}
                  className="flex h-10 items-center justify-center rounded-lg text-xl transition-colors hover:bg-hover active:bg-hover active:scale-95"
                  aria-label={getEmojiName(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer com fechar */}
        <div className="flex items-center justify-end gap-2 p-2 border-t border-hairline">
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <X size={14} />
            Fechar
          </button>
        </div>
      </div>
    </Portal>
  );
}

/** Nomes simples para acessibilidade dos emojis padrão. */
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