import { createSignal, onCleanup } from 'solid-js';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'cv-theme';

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  // Honor user system preference on first visit.
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyToHtml(theme: Theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
  root.setAttribute('data-theme', theme);
}

/** Read theme synchronously and apply to <html> — call once before mount to avoid FOUC. */
export function bootstrapTheme(): Theme {
  const t = readInitialTheme();
  applyToHtml(t);
  return t;
}

/** Reactive theme handle (intended to be called inside a Solid component). */
export function createTheme() {
  const [theme, setTheme] = createSignal<Theme>(readInitialTheme());

  // Sync DOM and storage when theme changes.
  const apply = (t: Theme) => {
    setTheme(t);
    applyToHtml(t);
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, t);
  };

  // React to OS theme changes only when user hasn't explicitly set a preference.
  if (typeof window !== 'undefined') {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => {
      if (localStorage.getItem(STORAGE_KEY)) return;
      apply(e.matches ? 'light' : 'dark');
    };
    mql.addEventListener('change', handler);
    onCleanup(() => mql.removeEventListener('change', handler));
  }

  return {
    theme,
    setTheme: apply,
    toggle: () => apply(theme() === 'dark' ? 'light' : 'dark'),
  };
}
