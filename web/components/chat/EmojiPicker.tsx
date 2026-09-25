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

  // Posicionamento relativo ao anchor (abre acima se não houver espaço abaixo)
  useEffect(() => {
    const anchor = anchorRef.current;
    const container = containerRef.current;
    if (!anchor || !container) return;

    const rect = anchor.getBoundingClientRect();
    const containerHeight = 300; // altura aproximada do picker
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    // Decide se abre acima ou abaixo
    const openAbove = spaceBelow < containerHeight + 8 && spaceAbove > containerHeight + 8;

    if (openAbove) {
      container.style.top = `${rect.top + window.scrollY - containerHeight - 4}px`;
    } else {
      container.style.top = `${rect.bottom + window.scrollY + 4}px`;
    }
    container.style.left = `${rect.left + window.scrollX}px`;

    // Ajusta horizontal se passar da tela
    const containerRect = container.getBoundingClientRect();
    if (containerRect.right > window.innerWidth - 8) {
      container.style.left = `${window.innerWidth - containerRect.width - 8}px`;
    }
    if (containerRect.left < 8) {
      container.style.left = `8px`;
    }
  }, [anchorRef]);

  return (
    <Portal>
      <div
        ref={containerRef}
        className="fixed z-50 w-64 rounded-xl border border-hairline bg-surface shadow-lift overflow-hidden animate-fade-up"
        role="dialog"
        aria-label="Seletor de emoji"
      >
        {/* Header com busca e categorias */}
        <div className="px-1.5 py-1.5 border-b border-hairline">
          {/* Busca */}
          <div className="relative mb-1.5">
            <MagnifyingGlass size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar emoji..."
              className="w-full h-7 pl-7 pr-2 bg-raised rounded-lg text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Categorias */}
          <div className="flex gap-0.5 overflow-x-auto pb-1" role="tablist">
            {Object.keys(EMOJI_CATEGORIES).map((cat) => (
              <button
                key={cat}
                role="tab"
                aria-selected={activeCategory === cat}
                onClick={() => {
                  setActiveCategory(cat);
                  setSearch('');
                }}
                className={`shrink-0 px-1.5 py-0.5 rounded-md text-[0.625rem] font-medium transition-colors whitespace-nowrap ${
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

        {/* Grid de emojis */}
        <div className="max-h-56 overflow-y-auto p-1">
          {filteredEmojis.length === 0 ? (
            <p className="text-center text-2xs text-ink-faint py-3">Nenhum emoji encontrado</p>
          ) : (
            <div className="grid grid-cols-9 gap-0.5" role="listbox">
              {filteredEmojis.map((emoji) => (
                <button
                  key={emoji}
                  role="option"
                  onClick={() => {
                    onSelect(emoji);
                    onClose();
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-lg transition-colors hover:bg-hover active:bg-hover active:scale-95"
                  aria-label={getEmojiName(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer com fechar */}
        <div className="flex items-center justify-end gap-1.5 px-1.5 py-1 border-t border-hairline">
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[0.625rem] text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <X size={12} />
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