import clsx from 'clsx';
import { ALLOWED_REACTIONS, ALLOWED_SOUNDS, type ReactionEmoji, type SoundId } from '@/types';

const SOUND_LABELS: Record<SoundId, { label: string; icon: string }> = {
  clap: { label: 'Palmas', icon: '👏' },
  laugh: { label: 'Risada', icon: '😂' },
  wow: { label: 'Uau', icon: '😮' },
  drum: { label: 'Rufar de tambor', icon: '🥁' },
};

interface Props {
  visible: boolean;
  onReaction: (emoji: ReactionEmoji) => void;
  onSound: (soundId: SoundId) => void;
}

/**
 * Dois grupinhos flutuantes ancorados no canto do player: emojis de reação
 * (sobem pela tela) e efeitos sonoros rápidos (tocam na hora, pra você e pra
 * quem está assistindo junto). Segue o mesmo esconde/mostra dos controles do
 * player, pra não poluir a tela parada.
 */
export function ReactionDock({ visible, onReaction, onSound }: Props) {
  return (
    <div
      className={clsx(
        'absolute bottom-20 right-3 z-20 flex flex-col items-end gap-2 transition-opacity duration-200 lg:bottom-24 lg:right-5',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <div className="flex gap-0.5 rounded-full border border-white/10 bg-black/55 p-1.5 backdrop-blur-md">
        {ALLOWED_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onReaction(emoji)}
            aria-label={`Reagir com ${emoji}`}
            className="flex h-8 w-8 items-center justify-center rounded-full text-base transition-transform duration-150 ease-out hover:scale-125 active:scale-95"
          >
            {emoji}
          </button>
        ))}
      </div>

      <div className="flex gap-0.5 rounded-full border border-white/10 bg-black/55 p-1.5 backdrop-blur-md">
        {ALLOWED_SOUNDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onSound(id)}
            title={SOUND_LABELS[id].label}
            aria-label={SOUND_LABELS[id].label}
            className="flex h-8 w-8 items-center justify-center rounded-full text-base transition-transform duration-150 ease-out hover:scale-125 active:scale-95"
          >
            {SOUND_LABELS[id].icon}
          </button>
        ))}
      </div>
    </div>
  );
}
