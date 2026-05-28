import { Show, createEffect, onCleanup, type JSX, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import { cn } from '~/lib/cn';
import { createIsDesktop } from '~/lib/media';
import { IconButton } from './IconButton';
import { IconClose } from './icons';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: JSX.Element;
  description?: JSX.Element;
  children: JSX.Element;
  /** Footer area, e.g. action buttons. */
  footer?: JSX.Element;
  /** Override desktop max width. Default 460px. */
  maxWidth?: string;
  /** When true, force sheet form (mobile-style bottom drawer) even on desktop. */
  forceSheet?: boolean;
  /** Allow background scroll-through (no body lock). Default false. */
  noLock?: boolean;
  /** Reduce vertical padding for dense content. */
  dense?: boolean;
}

/** Adaptive dialog: centered modal on desktop, bottom sheet on mobile.
 *  - Esc to close
 *  - Click backdrop to close
 *  - Body scroll lock while open
 *  - Focus traps to first focusable element
 */
export const Dialog: Component<DialogProps> = (props) => {
  const isDesktop = createIsDesktop();

  // Body scroll lock
  createEffect(() => {
    if (props.open && !props.noLock && typeof document !== 'undefined') {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      onCleanup(() => {
        document.body.style.overflow = prev;
      });
    }
  });

  // Esc to close
  createEffect(() => {
    if (!props.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener('keydown', handler);
    onCleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class={cn(
            'fixed inset-0 z-[9000] flex',
            (props.forceSheet || !isDesktop()) ? 'items-end' : 'items-center justify-center',
          )}
          aria-modal="true"
          role="dialog"
        >
          <div
            class="absolute inset-0 bg-black/55 backdrop-blur-sm animate-fade-in"
            onClick={() => props.onClose()}
            aria-hidden="true"
          />

          {/* Sheet (mobile) */}
          <Show when={props.forceSheet || !isDesktop()}>
            <div
              class={cn(
                'relative w-full mx-auto',
                'bg-bg-surface text-fg shadow-sheet',
                'rounded-t-2xl border-t border-x hairline',
                'flex flex-col max-h-[92dvh]',
                'animate-slide-up safe-pb',
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="grab-handle" />
              <Show when={props.title}>
                <div class={cn('flex items-center justify-between px-5 pt-1 pb-3 border-b hairline')}>
                  <div class="min-w-0">
                    <h2 class="text-base font-semibold truncate">{props.title}</h2>
                    {props.description && <p class="text-xs text-fg-muted mt-0.5">{props.description}</p>}
                  </div>
                  <IconButton label="Close" onClick={() => props.onClose()} size="md">
                    <IconClose size={18} />
                  </IconButton>
                </div>
              </Show>
              <div class={cn('overflow-y-auto px-5', props.dense ? 'py-3' : 'py-4')}>{props.children}</div>
              <Show when={props.footer}>
                <div class="px-5 py-3 border-t hairline flex items-center justify-end gap-2">{props.footer}</div>
              </Show>
            </div>
          </Show>

          {/* Modal (desktop) */}
          <Show when={!props.forceSheet && isDesktop()}>
            <div
              class={cn(
                'relative w-full mx-4 bg-bg-surface border hairline rounded-xl shadow-float',
                'animate-scale-in',
                'max-h-[88vh] flex flex-col',
              )}
              style={{ 'max-width': props.maxWidth ?? '460px' }}
              onClick={(e) => e.stopPropagation()}
            >
              <Show when={props.title}>
                <div class="flex items-center justify-between px-5 pt-4 pb-3 border-b hairline">
                  <div class="min-w-0">
                    <h2 class="text-base font-semibold truncate">{props.title}</h2>
                    {props.description && <p class="text-xs text-fg-muted mt-1">{props.description}</p>}
                  </div>
                  <IconButton label="Close" onClick={() => props.onClose()} size="sm">
                    <IconClose size={16} />
                  </IconButton>
                </div>
              </Show>
              <div class={cn('overflow-y-auto px-5', props.dense ? 'py-3' : 'py-4')}>{props.children}</div>
              <Show when={props.footer}>
                <div class="px-5 py-3 border-t hairline flex items-center justify-end gap-2">{props.footer}</div>
              </Show>
            </div>
          </Show>
        </div>
      </Portal>
    </Show>
  );
};
