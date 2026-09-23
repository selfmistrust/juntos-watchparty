import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface TabDef<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
  badge?: number;
}

interface TabsProps<T extends string> {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
}

export function Tabs<T extends string>({ tabs, value, onChange }: TabsProps<T>) {
  return (
    <div role="tablist" className="relative grid border-b border-hairline" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={clsx(
              'relative flex h-12 items-center justify-center gap-2 text-sm transition-colors duration-150 ease-out',
              selected ? 'text-ink' : 'text-ink-faint hover:text-ink-muted',
            )}
          >
            {tab.icon}
            <span className="hidden sm:inline">{tab.label}</span>
            {tab.badge ? (
              <span className="absolute right-3 top-2.5 min-w-[1.1rem] rounded-full bg-accent px-1 text-center text-2xs font-semibold text-white">
                {tab.badge > 99 ? '99+' : tab.badge}
              </span>
            ) : null}
            <span
              className={clsx(
                'absolute inset-x-3 bottom-0 h-px origin-center bg-accent transition-transform duration-200 ease-out',
                selected ? 'scale-x-100' : 'scale-x-0',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
