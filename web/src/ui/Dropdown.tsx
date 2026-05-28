import { createSignal, type JSX, type Component } from 'solid-js';
import { Menu, type MenuItem } from './Menu';
import { cn } from '~/lib/cn';
import { IconChevronDown } from './icons';

export interface DropdownProps {
  label: JSX.Element;
  items: MenuItem[];
  align?: 'start' | 'end';
  class?: string;
}

export const Dropdown: Component<DropdownProps> = (props) => {
  let triggerEl: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });

  const toggle = () => {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    setPos({
      x: props.align === 'end' ? rect.right - 200 : rect.left,
      y: rect.bottom + 4,
    });
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={triggerEl}
        type="button"
        onClick={toggle}
        class={cn(
          'inline-flex items-center gap-1.5 h-8 px-2.5 text-[13px] rounded-md',
          'bg-bg-raised border hairline text-fg-muted hover:bg-bg-hover hover:text-fg',
          'focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base',
          props.class,
        )}
      >
        {props.label}
        <IconChevronDown size={14} />
      </button>
      <Menu open={open()} x={pos().x} y={pos().y} items={props.items} onClose={() => setOpen(false)} />
    </>
  );
};
