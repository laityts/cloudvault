import { Show, createEffect, onCleanup, type JSX, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import { cn } from '~/lib/cn';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: JSX.Element;
  side?: 'left' | 'right';
  /** Custom width in pixels (desktop) or fraction (mobile). Default 280px / 86vw. */
  width?: string;
}

/** Slide-in drawer for navigation. Always animates from the edge.
 *  Mobile-first; on desktop you usually render the sidebar inline instead. */
export const Drawer: Component<DrawerProps> = (props) => {
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    onCleanup(() => {
      document.body.style.overflow = prev;
    });
  });

  const side = () => props.side ?? 'left';

  return (
    <Show when={props.open}>
      <Portal>
        <div class="fixed inset-0 z-[8500]" role="dialog" aria-modal="true">
          <div
            class="absolute inset-0 bg-black/55 backdrop-blur-sm animate-fade-in"
            onClick={() => props.onClose()}
            aria-hidden="true"
          />
          <aside
            class={cn(
              'absolute top-0 bottom-0 bg-bg-surface border hairline shadow-float',
              'flex flex-col',
              side() === 'left' ? 'left-0 border-r animate-slide-right' : 'right-0 border-l',
            )}
            style={{ width: props.width ?? 'min(86vw, 320px)' }}
          >
            {props.children}
          </aside>
        </div>
      </Portal>
    </Show>
  );
};
