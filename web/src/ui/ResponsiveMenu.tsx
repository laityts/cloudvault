import { Show, type Component } from 'solid-js';
import { Menu, type MenuItem } from './Menu';
import { Dialog } from './Dialog';
import { createIsDesktop } from '~/lib/media';
import { cn } from '~/lib/cn';

export interface ResponsiveMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** Title shown only in the mobile sheet form. */
  title?: string;
}

/** Renders as a floating Menu on desktop, but as an action Sheet on mobile.
 *  Keeps a single ergonomic API for callers. */
export const ResponsiveMenu: Component<ResponsiveMenuProps> = (props) => {
  const isDesktop = createIsDesktop();

  return (
    <Show
      when={isDesktop()}
      fallback={
        <Dialog
          open={props.open}
          onClose={props.onClose}
          forceSheet
          dense
          title={props.title}
        >
          <ul class="grid">
            {props.items.map((item) =>
              item.divider ? (
                <li class="border-t hairline my-1" />
              ) : (
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      if (item.disabled) return;
                      item.onClick?.();
                      props.onClose();
                    }}
                    disabled={item.disabled}
                    class={cn(
                      'flex items-center gap-3 w-full text-left h-12 px-2 rounded-md',
                      'hover:bg-bg-hover active:bg-bg-hover disabled:opacity-40',
                      item.tone === 'danger' && 'hover:bg-danger/10 hover:text-danger text-danger',
                    )}
                  >
                    <span class={item.tone === 'danger' ? 'text-danger' : 'text-fg-subtle'}>{item.icon}</span>
                    <span class="text-[14px]">{item.label}</span>
                  </button>
                </li>
              ),
            )}
          </ul>
        </Dialog>
      }
    >
      <Menu open={props.open} x={props.x} y={props.y} items={props.items} onClose={props.onClose} />
    </Show>
  );
};
