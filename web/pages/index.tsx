import { ArrowRight, LockSimple } from '@phosphor-icons/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SERVER_URL } from '@/lib/socket';

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');

  const createRoom = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Sessão de hoje',
          password: protect && password ? password : undefined,
        }),
      });
      if (!res.ok) throw new Error();
      const { id } = (await res.json()) as { id: string };
      void router.push(`/room/${id}`);
    } catch {
      setError('O servidor não respondeu.');
      setCreating(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-8 sm:px-10">
      <header className="flex items-center justify-between">
        <span className="font-display text-lg tracking-tight">juntos</span>
      </header>

      <div className="grid flex-1 items-center gap-14 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20">
        <section>
          <h1 className="font-display text-[clamp(2.5rem,6vw,3.75rem)] font-semibold leading-[1.05] tracking-tight text-ink">
            Dê o play uma vez. Todo mundo assiste junto.
          </h1>
          <p className="mt-5 max-w-[46ch] text-[1.0625rem] leading-relaxed text-ink-muted">
            Sincronização automática para você e seus amigos assistirem juntos como se estivessem no mesmo sofá.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Button onClick={createRoom} disabled={creating} className="sm:w-auto">
              {creating ? 'Abrindo sala…' : 'Criar uma sala'}
              <ArrowRight size={17} weight="bold" />
            </Button>

            <div className="flex items-center gap-2 rounded-xl border border-hairline bg-raised px-3 transition-colors duration-150 focus-within:border-accent/60">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.trim().toLowerCase())}
                onKeyDown={(e) => e.key === 'Enter' && code && router.push(`/room/${code}`)}
                placeholder="código da sala"
                className="h-11 w-36 bg-transparent font-mono text-sm text-ink placeholder:text-ink-faint focus:outline-none"
              />
              <button
                onClick={() => code && router.push(`/room/${code}`)}
                disabled={!code}
                className="text-sm text-ink-muted transition-colors duration-150 hover:text-ink disabled:opacity-35"
              >
                entrar
              </button>
            </div>
          </div>

          {error && <p className="mt-4 text-sm text-live/90">{error}</p>}

          <div className="mt-4">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={protect}
                onChange={(e) => setProtect(e.target.checked)}
                className="peer sr-only"
              />
              <span className="relative h-5 w-9 shrink-0 rounded-full bg-white/12 transition-colors duration-200 ease-out peer-checked:bg-accent after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform after:duration-200 after:ease-out peer-checked:after:translate-x-4" />
              <LockSimple size={14} />
              Proteger com senha
            </label>

            {protect && (
              <input
                autoFocus
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Escolha uma senha para a sala"
                className="animate-fade-up mt-2 h-11 w-full max-w-xs rounded-xl border border-hairline bg-raised px-4 text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 focus:border-accent/60 focus:outline-none"
              />
            )}
          </div>

          <dl className="mt-10 grid max-w-md grid-cols-3 gap-6 border-t border-hairline pt-6">
            <Fact term="Sincronia" detail="Alinhamento contínuo da reprodução entre todos os usuários." />
            <Fact term="Fontes" detail="Suporte a vídeos do YouTube e arquivos locais." />
            <Fact term="Entrada" detail="Sem criar conta: informe um nome e entre na sala." />
          </dl>
        </section>

        <SyncHero />
      </div>
    </main>
  );
}

function Fact({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <dt className="text-sm text-ink">{term}</dt>
      <dd className="mt-1 text-[0.8125rem] leading-relaxed text-ink-faint">{detail}</dd>
    </div>
  );
}

/**
 * Hero: quatro pessoas em linhas do tempo separadas convergindo para o mesmo
 * ponto. É o produto inteiro em uma imagem, e acontece uma vez, ao carregar.
 */
function SyncHero() {
  const [synced, setSynced] = useState(false);
  const people = [
    { name: 'Ana', color: '#A78BFA', start: 18 },
    { name: 'Bia', color: '#7DD3FC', start: 71 },
    { name: 'Caio', color: '#5EEAD4', start: 44 },
    { name: 'Dri', color: '#FCD34D', start: 86 },
  ];

  useEffect(() => {
    const t = setTimeout(() => setSynced(true), 700);
    return () => clearTimeout(t);
  }, []);

  return (
    <section
      aria-hidden
      className="rounded-2xl border border-hairline bg-surface p-6 shadow-lift sm:p-8"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-muted">Sessão de hoje</span>
        <span className="flex items-center gap-1.5 text-2xs text-ink-faint">
          <span className="h-1.5 w-1.5 animate-pulse-ring rounded-full bg-live" />
          ao vivo
        </span>
      </div>

      <div className="mt-7 space-y-5">
        {people.map((person) => (
          <div key={person.name} className="flex items-center gap-3">
            <span className="w-10 shrink-0 text-2xs" style={{ color: person.color }}>
              {person.name}
            </span>
            <span className="relative h-0.5 flex-1 rounded-full bg-white/8">
              <span
                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-[1400ms] ease-out"
                style={{
                  width: `${synced ? 58 : person.start}%`,
                  background: person.color,
                  opacity: 0.45,
                }}
              />
              <span
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left] duration-[1400ms] ease-out"
                style={{ left: `${synced ? 58 : person.start}%`, background: person.color }}
              />
            </span>
          </div>
        ))}
      </div>

      <div className="mt-7 flex items-baseline justify-between border-t border-hairline pt-4">
        <span className="font-mono text-2xs text-ink-faint">
          {synced ? 'sincronizado' : 'reagrupando…'}
        </span>
        <span className="font-mono text-2xs tabular-nums text-ink-muted">14:22 / 24:31</span>
      </div>
    </section>
  );
}
