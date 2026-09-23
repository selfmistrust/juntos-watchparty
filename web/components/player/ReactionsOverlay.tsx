import type { FloatingReaction } from '@/types';

interface Props {
  reactions: FloatingReaction[];
}

/**
 * Camada absoluta sobre o vídeo: cada reação sobe do fundo até o topo e
 * desaparece sozinha (a remoção do estado já é agendada em useRoom). Aqui só
 * cabe desenhar — nada de timers, pra não duplicar a lógica de ciclo de vida.
 */
export function ReactionsOverlay({ reactions }: Props) {
  if (reactions.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {reactions.map((r) => (
        <span
          key={r.id}
          title={r.name}
          className="absolute bottom-0 select-none text-2xl drop-shadow-md animate-float-up sm:text-3xl"
          style={{ left: `${r.left}%`, animationDuration: `${r.duration}s` }}
        >
          {r.emoji}
        </span>
      ))}
    </div>
  );
}
