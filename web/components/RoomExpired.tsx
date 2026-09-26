import Link from 'next/link';
import { HourglassMedium } from '@phosphor-icons/react';
import { Button } from '@/components/ui/Button';

interface Props {
  roomId: string;
}

/**
 * A sala foi encerrada por ter atingido o tempo máximo de vida.
 *
 * É uma tela cheia, e não um aviso: o servidor já apagou a sala, então qualquer
 * tentativa de recarregar cairia no `ensureRoom` e criaria uma sala vazia com o
 * mesmo id — a pessoa entraria num chat sem histórico e sem ninguém, achando
 * que a sala emptied. Dizer o que aconteceu é o que separa "acabou" de
 * "quebrou".
 */
export function RoomExpired({ roomId }: Props) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="animate-fade-up w-full max-w-sm">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-raised text-ink-muted">
          <HourglassMedium size={18} weight="fill" />
        </span>

        <p className="mt-4 font-mono text-2xs text-ink-faint">sala {roomId}</p>
        <h1 className="mt-2 font-display text-3xl leading-tight tracking-tight text-ink">
          Esta sala foi encerrada
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Ela ficou aberta tempo demais e o histórico foi apagado. As pessoas que
          estavam aqui junto até o fim também já saíram.
        </p>

        <Link href="/" className="mt-3 block">
          <Button className="w-full">Criar uma sala nova</Button>
        </Link>
      </div>
    </div>
  );
}
