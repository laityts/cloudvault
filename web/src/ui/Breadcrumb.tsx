import type { Component, JSX } from 'solid-js';
import { For } from 'solid-js';
import { cn } from '~/lib/cn';
import { IconChevronRight } from './icons';

export interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

export const Breadcrumb: Component<{
  items: BreadcrumbItem[];
  rootLabel?: string;
  onRoot?: () => void;
  rootIcon?: JSX.Element;
  class?: string;
}> = (props) => (
  <nav class={cn('flex items-center gap-1 text-[13px] flex-wrap min-w-0', props.class)} aria-label="Breadcrumb">
    <button
      type="button"
      onClick={() => props.onRoot?.()}
      class={cn(
        'inline-flex items-center gap-1 px-2 h-7 rounded-md font-medium',
        'text-fg-muted hover:bg-bg-hover hover:text-fg transition-colors',
        props.items.length === 0 && 'bg-bg-hover text-fg',
      )}
    >
      {props.rootIcon}
      <span>{props.rootLabel ?? 'Home'}</span>
    </button>
    <For each={props.items}>
      {(item, i) => (
        <>
          <IconChevronRight size={12} class="text-fg-subtle shrink-0" />
          <button
            type="button"
            onClick={() => item.onClick?.()}
            class={cn(
              'h-7 px-2 rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg transition-colors truncate max-w-[180px]',
              i() === props.items.length - 1 && 'bg-bg-hover text-fg font-medium',
            )}
            title={item.label}
          >
            {item.label}
          </button>
        </>
      )}
    </For>
  </nav>
);
