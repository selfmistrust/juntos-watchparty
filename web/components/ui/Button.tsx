import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

type Variant = 'primary' | 'ghost' | 'outline';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

/*
 * `whitespace-nowrap` + `min-w-0` aqui valem para todo botão do app.
 *
 * As alturas são fixas (`h-9`/`h-11`), então um rótulo longo que quebrasse de
 * linha não esticaria a caixa — transbordaria por cima e por baixo dela, e o
 * texto ficaria cortado sem nenhuma reticência, que é o pior dos dois
 * mundos. O `nowrap` garante que nunca há segunda linha. O `min-w-0` é o que
 * permite o botão encolher dentro de um pai flex, que é o passo anterior
 * para o `truncate` poder aparecer: sem ele o botão mantém a largura do
 * conteúdo e empurra quem está do lado.
 *
 * Rótulo de comprimento variável entra em `<TruncatedText>`, que devolve a
 * reticência e o `title` quando o texto foi de fato cortado.
 */
const base =
  'inline-flex min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover active:bg-accent',
  ghost: 'text-ink-muted hover:bg-hover hover:text-ink',
  outline: 'border border-hairline bg-raised text-ink hover:border-white/20 hover:bg-hover',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-5 text-[0.9375rem]',
};

export function Button({ variant = 'primary', size = 'md', className, children, ...rest }: ButtonProps) {
  return (
    <button className={clsx(base, variants[variant], sizes[size], className)} {...rest}>
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, active, className, children, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        className={clsx(
          'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 ease-out',
          // Só onde o ponteiro é grosso (celular/tablet): 36px fica pequeno
          // demais para o dedo. No desktop o `h-9 w-9` de antes é preservado.
          '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
          active ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-white/10 hover:text-ink',
          'disabled:cursor-not-allowed disabled:opacity-40',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';
