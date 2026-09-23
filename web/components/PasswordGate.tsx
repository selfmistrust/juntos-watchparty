import { LockSimple } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { JoinError } from '@/types';

interface Props {
  roomId: string;
  error: JoinError;
  onSubmit: (password: string) => void;
}

export function PasswordGate({ roomId, error, onSubmit }: Props) {
  const [password, setPassword] = useState('');

  const submit = () => {
    if (password) onSubmit(password);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="animate-fade-up w-full max-w-sm">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <LockSimple size={18} weight="fill" />
        </span>

        <p className="mt-4 font-mono text-2xs text-ink-faint">sala {roomId}</p>
        <h1 className="mt-2 font-display text-3xl leading-tight tracking-tight text-ink">
          Essa sala tem senha
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          {error.reason === 'wrong_password'
            ? 'A senha digitada não confere. Tente de novo.'
            : 'Peça a senha para quem te mandou o link.'}
        </p>

        <input
          autoFocus
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Senha da sala"
          className="mt-6 h-12 w-full rounded-xl border border-hairline bg-raised px-4 text-[0.9375rem] text-ink placeholder:text-ink-faint transition-colors duration-150 focus:border-accent/60 focus:outline-none"
        />
        {error.reason === 'wrong_password' && (
          <p className="mt-2 text-2xs text-live/90">{error.message}</p>
        )}

        <Button onClick={submit} disabled={!password} className="mt-3 w-full">
          Entrar
        </Button>
      </div>
    </div>
  );
}
