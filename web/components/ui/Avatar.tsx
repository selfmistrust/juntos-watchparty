import clsx from 'clsx';
import { dicebearUrl } from '@/lib/avatar';

interface AvatarProps {
  name: string;
  color: string;
  /** Semente do DiceBear. Ignorada quando avatarUrl está presente. */
  avatarSeed?: string;
  /** Foto customizada (data URL). Tem prioridade sobre o avatarSeed. */
  avatarUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'h-6 w-6 text-2xs',
  md: 'h-8 w-8 text-xs',
  lg: 'h-14 w-14 text-base',
};

export function Avatar({ name, color, avatarSeed, avatarUrl, size = 'md', className }: AvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const src = avatarUrl || (avatarSeed ? dicebearUrl(avatarSeed) : undefined);

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={clsx('shrink-0 rounded-full bg-raised object-cover', SIZES[size], className)}
        style={{ boxShadow: `inset 0 0 0 1px ${color}44` }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: `${color}22`, color, boxShadow: `inset 0 0 0 1px ${color}44` }}
    >
      {initial}
    </span>
  );
}
