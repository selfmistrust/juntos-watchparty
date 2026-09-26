import type { Config } from 'tailwindcss';

/**
 * Design system "Sala escura".
 * Base neutra fria em 4 degraus + um único accent violeta.
 * Regra: o accent só aparece em ação, estado ao vivo e foco — nunca como decoração.
 */
const config: Config = {
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    // `lib` entra porque os providers de mídia vivem aqui e carregam classes
    // de cor no próprio arquivo (`accent` de cada card do modal). Sem este
    // glob, `text-sky-300`, `text-teal-300` e as cores de marca custom não
    // eram geradas e caíam silenciosamente na cor herdada — o ícone ficava
    // cinza sem nenhum aviso do Tailwind.
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: '#08080A',
        surface: '#101014',
        raised: '#17171C',
        hover: '#1E1E25',
        hairline: 'rgba(255,255,255,0.07)',
        ink: {
          DEFAULT: '#ECECEF',
          muted: '#8C8C99',
          faint: '#5B5B66',
        },
        accent: {
          DEFAULT: '#7C5CFF',
          hover: '#8F73FF',
          soft: 'rgba(124,92,255,0.14)',
        },
        live: '#FF4D6D',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.25rem',
      },
      boxShadow: {
        lift: '0 18px 40px -22px rgba(0,0,0,0.9)',
        focus: '0 0 0 2px #08080A, 0 0 0 4px #7C5CFF',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(255,77,109,0.5)' },
          '100%': { boxShadow: '0 0 0 7px rgba(255,77,109,0)' },
        },
        blink: {
          '0%, 100%': { opacity: '0.25' },
          '50%': { opacity: '1' },
        },
        'float-up': {
          '0%': { transform: 'translateY(0) scale(0.6)', opacity: '0' },
          '12%': { transform: 'translateY(-8%) scale(1)', opacity: '1' },
          '85%': { opacity: '1' },
          '100%': { transform: 'translateY(-115%) scale(1.05)', opacity: '0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in': 'slide-in 200ms cubic-bezier(0.22, 1, 0.36, 1)',
        'pulse-ring': 'pulse-ring 1.8s ease-out infinite',
        blink: 'blink 1.4s ease-in-out infinite',
        'float-up': 'float-up 3s ease-out forwards',
      },
    },
  },
  plugins: [],
};

export default config;
