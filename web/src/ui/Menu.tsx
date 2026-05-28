import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type JSX,
  type Component,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { cn } from '~/lib/cn';

export interface MenuItem {
  label: string;
  icon?: JSX.Element;
  /** Visual treatment — danger turns the label red on hover. */
  tone?: 'default' | 'danger';
  /** When true, render a divider above this item instead. Use `label: ''` */
  divider?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export interface MenuProps {
  open: boolean;
  /** Anchor point. The menu opens to the right of x by default; flips if it overflows. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Lightweight context/dropdown menu rendered via Portal at fixed coords. */
export const Menu: Component<MenuProps> = (props) => {
  let menuEl: HTMLDivElement | undefined;
  const [adjusted, setAdjusted] = createSignal({ x: props.x, y: props.y });

  // Re-clamp position to viewport after mount
  createEffect(() => {
    if (!props.open) return;
    setAdjusted({ x: props.x, y: props.y });
    queueMicrotask(() => {
      if (!menuEl) return;
      const rect = menuEl.getBoundingClientRect();
      let nx = props.x;
      let ny = props.y;
      if (nx + rect.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - rect.width - 8);
      if (ny + rect.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - rect.height - 8);
      setAdjusted({ x: nx, y: ny });
    });
  });

  // Click-away
  createEffect(() => {
    if (!props.open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (menuEl && !menuEl.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    setTimeout(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('touchstart', onDown);
      window.addEventListener('keydown', onKey);
    }, 0);
    onCleanup(() => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    });
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={menuEl}
          class={cn(
            'fixed z-[9500] min-w-[200px] rounded-lg border hairline shadow-float',
            'bg-bg-surface backdrop-blur-md p-1 animate-scale-in',
          )}
          style={{ left: `${adjusted().x}px`, top: `${adjusted().y}px` }}
          role="menu"
        >
          {props.items.map((item) =>
            item.divider ? (
              <div class="my-1 border-t hairline" />
            ) : (
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  item.onClick?.();
                  props.onClose();
                }}
                class={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px]',
                  'text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed',
                  item.tone === 'danger' && 'hover:bg-danger/10 hover:text-danger',
                )}
              >
                {item.icon && <span class="text-fg-subtle">{item.icon}</span>}
                <span class="flex-1 truncate">{item.label}</span>
              </button>
            ),
          )}
        </div>
      </Portal>
    </Show>
  );
};
