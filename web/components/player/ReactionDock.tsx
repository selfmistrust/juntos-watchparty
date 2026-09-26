import clsx from 'clsx';
import { ALLOWED_REACTIONS, type ReactionEmoji } from '@/types';

interface Props {
  visible: boolean;
  onReaction: (emoji: ReactionEmoji) => void;
}

/**
 * Grupinho flutuante de emojis de reação, ancorado no canto do player: sobem
 * pela tela para quem está assistindo junto. Segue o mesmo esconde/mostra dos
 * controles do player, pra não poluir a tela parada.
 *
 * Havia aqui uma segunda fileira de efeitos sonoros (palmas, risada, uau,
 * tambor). Foi removida junto com o `lib/sfx` e o `sendSound`: o áudio era
 * sintetizado no cliente e tocado na hora, mas ainda emitia `sound:trigger`
 * para ecoar pros outros. Sem o botão, o resto viraria código morto — e o
 * `sfx` instalava listener global de clique no load da página só para
 * desbloquear o `AudioContext`, que é efeito colateral de manter algo que
 * ninguém mais aciona.
 */
export function ReactionDock({ visible, onReaction }: Props) {
  return (
    <div
      className={clsx(
        'absolute bottom-20 right-3 z-20 flex flex-col items-end gap-2 transition-opacity duration-200 lg:bottom-24 lg:right-5',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {/* Os alvos crescem só onde o dedo é o ponteiro: no desktop, 44px
          deixaria o grupo maior que o próprio player em telas baixas. No
          celular o emoji é discreto, então o alvo grande não rouba atenção. */}
      <div className="flex gap-0.5 rounded-full border border-white/10 bg-black/55 p-1.5 backdrop-blur-md">
        {ALLOWED_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onReaction(emoji)}
            aria-label={`Reagir com ${emoji}`}
            className="flex h-8 w-8 items-center justify-center rounded-full text-base transition-transform duration-150 ease-out hover:scale-125 active:scale-95 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
