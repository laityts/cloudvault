import { onCleanup } from 'solid-js';

interface Options {
  /** ms before longpress fires. */
  delay?: number;
  /** Movement threshold in px that cancels the gesture. */
  moveThreshold?: number;
  /** Called after `delay` ms of stationary touch. Receives the original event. */
  onLongPress: (e: TouchEvent) => void;
}

/** Attach long-press detection to an element. Cleans up on component dispose.
 *  Usage:
 *    <div use:longpress={{ onLongPress: () => ... }} />
 *  or imperatively: longpress(el, () => opts);
 */
export function longpress(el: HTMLElement, accessor: () => Options) {
  let timer: number | null = null;
  let startX = 0;
  let startY = 0;
  let triggered = false;

  const opts = accessor();
  const delay = opts.delay ?? 480;
  const moveThreshold = opts.moveThreshold ?? 8;

  const clear = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    triggered = false;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    timer = window.setTimeout(() => {
      triggered = true;
      opts.onLongPress(e);
    }, delay);
  };

  const onMove = (e: TouchEvent) => {
    if (timer == null) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > moveThreshold || Math.abs(t.clientY - startY) > moveThreshold) {
      clear();
    }
  };

  const onEnd = (e: TouchEvent) => {
    clear();
    if (triggered) {
      // Prevent the synthetic click after a successful long press
      e.preventDefault();
      triggered = false;
    }
  };

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: true });
  el.addEventListener('touchend', onEnd);
  el.addEventListener('touchcancel', clear);

  onCleanup(() => {
    clear();
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd);
    el.removeEventListener('touchcancel', clear);
  });
}

/** Register the directive type for Solid's `use:` JSX attribute. */
declare module 'solid-js' {
  namespace JSX {
    interface Directives {
      longpress: Options;
    }
  }
}
