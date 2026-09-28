'use client';

import { useEffect, useRef, useState } from 'react';
import { BellSimple, SpeakerHigh, SpeakerSlash, X } from '@phosphor-icons/react';
import { IconButton } from '@/components/ui/Button';
import type { PreferenciasMencao } from '@/lib/mentionPreferences';

interface Props {
  prefs: PreferenciasMencao;
  /** `true` quando a permissão do sistema já foi pedida alguma vez. */
  jaPediu: boolean;
  onMudar: (patch: Partial<PreferenciasMencao>) => void;
  /** Pedir permissão é gesto: só acontece quando a pessoa mexe no interruptor. */
  aoPedirPermissao: () => void;
}

/**
 * Preferências de menção.
 *
 * ## Onde isso mora, e por que
 *
 * Num popover ancorado no cabeçalho do chat, e não numa página de ajustes.
 *
 * A preferência é de quem está **naquele momento** com o chat aberto, e é uma
 * decisão de sessão, não de conta: "não me perturbe agora" é o que alguém liga
 * durante o filme. Uma página de ajustes seria três cliques para desligar o
 * som de um convite que chegou agora, e a pessoa acabaria não desligando.
 *
 * ## "Não perturbe" vem primeiro, e não no fim
 *
 * É o interruptor que as pessoas procuram quando estão vendo filme. Se ficasse
 * depois dos outros dois, a pessoa desligaria som e notificação, receberia
 * mesmo assim a aba piscando, e concluiria que o botão não funciona.
 */
export function MentionPreferences({
  prefs,
  jaPediu,
  onMudar,
  aoPedirPermissao,
}: Props) {
  const [aberto, setAberto] = useState(false);
  const caixaRef = useRef<HTMLDivElement>(null);

  /*
   * Fecha fora do clique. Um popover que só fecha no botão é um popover que
   * some do foco de quem só queria ler o feed de novo.
   */
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (!caixaRef.current?.contains(e.target as Node)) setAberto(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAberto(false);
    };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [aberto]);

  const notificar = prefs.notificacoes && !prefs.naoPerturbe;
  const som = prefs.som && !prefs.naoPerturbe;

  return (
    <div className="relative" ref={caixaRef}>
      <IconButton
        label="Preferências de menção"
        onClick={() => setAberto((v) => !v)}
        active={aberto || !prefs.naoPerturbe}
      >
        <BellSimple size={17} />
      </IconButton>

      {aberto && (
        <div className="animate-fade-up absolute right-0 top-full z-40 mt-2 w-64 rounded-xl border border-hairline bg-popover/95 p-3 shadow-lg backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-ink">Menções</p>
            <IconButton dense label="Fechar" onClick={() => setAberto(false)}>
              <X size={14} />
            </IconButton>
          </div>

          <Linha
            rotulo="Não perturbe"
            dica="Silencia som, notificação e destaque da aba"
            ligado={prefs.naoPerturbe}
            onMudar={(v) => onMudar({ naoPerturbe: v })}
          />
          <Linha
            rotulo="Som de menção"
            dica={
              som && prefs.som
                ? 'Toca quando alguém te menciona'
                : prefs.naoPerturbe
                  ? 'Desligado enquanto "não perturbe" estiver ligado'
                  : 'Desligado'
            }
            ligado={som}
            bloqueado={prefs.naoPerturbe}
            onMudar={(v) => onMudar({ som: v })}
            icone={som ? <SpeakerHigh size={15} /> : <SpeakerSlash size={15} />}
          />
          <Linha
            rotulo="Notificação do sistema"
            dica={
              notificar
                ? 'Só quando a aba estiver em segundo plano'
                : prefs.naoPerturbe
                  ? 'Desligado enquanto "não perturbe" estiver ligado'
                  : 'Precisa da permissão do navegador'
            }
            ligado={notificar}
            bloqueado={prefs.naoPerturbe}
            /*
             * Ligar a notificação é o gesto que autoriza o pedido de
             * permissão, e é a única chance de pedir. Deixar o `requestPermission`
             * no mount daria "denied" garantido nos navegadores que exigem
             * gesto, e o interruptor ficaria ligado sem nunca notificar.
             */
            onMudar={(v) => {
              if (v && !jaPediu) {
                aoPedirPermissao();
                return;
              }
              onMudar({ notificacoes: v });
            }}
          />
        </div>
      )}
    </div>
  );
}

function Linha({
  rotulo,
  dica,
  ligado,
  bloqueado,
  onMudar,
  icone,
}: {
  rotulo: string;
  dica: string;
  ligado: boolean;
  bloqueado?: boolean;
  onMudar: (v: boolean) => void;
  icone?: React.ReactNode;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg px-1 py-1.5 ${
        bloqueado ? 'opacity-55' : 'cursor-pointer hover:bg-hover'
      }`}
    >
      <input
        type="checkbox"
        checked={ligado}
        disabled={bloqueado}
        onChange={(e) => onMudar(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs text-ink">
          {icone}
          {rotulo}
        </span>
        <span className="mt-0.5 block text-2xs leading-snug text-ink-faint">{dica}</span>
      </span>
    </label>
  );
}
