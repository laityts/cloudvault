import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./web/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: 'var(--bg-base)',
          surface: 'var(--bg-surface)',
          raised: 'var(--bg-raised)',
          hover: 'var(--bg-hover)',
          inset: 'var(--bg-inset)',
        },
        fg: {
          DEFAULT: 'var(--fg-default)',
          muted: 'var(--fg-muted)',
          subtle: 'var(--fg-subtle)',
          onAccent: 'var(--fg-on-accent)',
        },
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
        },
        brand: {
          DEFAULT: 'var(--brand)',
          soft: 'var(--brand-soft)',
          hover: 'var(--brand-hover)',
        },
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        danger: 'var(--danger)',
        info: 'var(--info)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        none: '0',
        xs: '3px',
        sm: '5px',
        DEFAULT: '7px',
        md: '9px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
        full: '9999px',
      },
      spacing: {
        '4.5': '1.125rem',
        '13': '3.25rem',
        '15': '3.75rem',
        '18': '4.5rem',
        'safe-bottom': 'env(safe-area-inset-bottom)',
      },
      boxShadow: {
        soft: '0 1px 2px 0 oklch(0% 0 0 / 0.04), 0 1px 3px 0 oklch(0% 0 0 / 0.06)',
        raised: '0 4px 16px -2px oklch(0% 0 0 / 0.08), 0 2px 6px -1px oklch(0% 0 0 / 0.05)',
        float: '0 12px 32px -4px oklch(0% 0 0 / 0.18), 0 6px 14px -3px oklch(0% 0 0 / 0.10)',
        sheet: '0 -6px 24px -4px oklch(0% 0 0 / 0.18)',
        focus: '0 0 0 3px var(--brand-soft)',
      },
      animation: {
        'fade-in': 'fadeIn 160ms cubic-bezier(0.22, 1, 0.36, 1)',
        'scale-in': 'scaleIn 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-up': 'slideUp 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-down': 'slideDown 200ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-right': 'slideRight 260ms cubic-bezier(0.22, 1, 0.36, 1)',
        spin: 'spin 700ms linear infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.97)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideRight: {
          '0%': { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
