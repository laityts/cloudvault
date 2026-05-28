import { createSignal } from 'solid-js';

export interface ContextMenuState<T = unknown> {
  open: boolean;
  x: number;
  y: number;
  target: T | null;
}

/** Shared hook for context-menu state and viewport-aware positioning.
 *  Pass an estimated menu size; positions are clamped to viewport. */
export function createContextMenu<T = unknown>(estimatedSize = { w: 220, h: 280 }) {
  const [state, setState] = createSignal<ContextMenuState<T>>({
    open: false,
    x: 0,
    y: 0,
    target: null,
  });

  const open = (event: MouseEvent | PointerEvent, target: T) => {
    event.preventDefault?.();
    let x = event.clientX;
    let y = event.clientY;
    if (typeof window !== 'undefined') {
      if (x + estimatedSize.w > window.innerWidth - 8) {
        x = Math.max(8, window.innerWidth - estimatedSize.w - 8);
      }
      if (y + estimatedSize.h > window.innerHeight - 8) {
        y = Math.max(8, window.innerHeight - estimatedSize.h - 8);
      }
    }
    setState({ open: true, x, y, target });
  };

  const close = () => setState((s) => ({ ...s, open: false }));

  return { state, open, close };
}
