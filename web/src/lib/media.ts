import { createSignal, onCleanup } from 'solid-js';

export function createMediaQuery(query: string, defaultValue = false) {
  if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
    return () => defaultValue;
  }
  const mql = window.matchMedia(query);
  const [matches, setMatches] = createSignal(mql.matches);
  const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
  mql.addEventListener('change', handler);
  onCleanup(() => mql.removeEventListener('change', handler));
  return matches;
}

/** True when viewport is at least 768px wide (Tailwind md breakpoint). */
export function createIsDesktop() {
  return createMediaQuery('(min-width: 768px)', true);
}

/** True when viewport is at least 1024px wide (Tailwind lg). */
export function createIsLarge() {
  return createMediaQuery('(min-width: 1024px)', true);
}

export function createPrefersReducedMotion() {
  return createMediaQuery('(prefers-reduced-motion: reduce)', false);
}
