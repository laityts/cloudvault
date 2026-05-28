import type { Component, JSX } from 'solid-js';
import { cn } from '~/lib/cn';

export const EmptyState: Component<{
  icon?: JSX.Element;
  title: string;
  description?: string;
  action?: JSX.Element;
  class?: string;
  size?: 'sm' | 'md';
}> = (props) => (
  <div
    class={cn(
      'flex flex-col items-center justify-center text-center',
      props.size === 'sm' ? 'py-10 gap-2' : 'py-16 gap-3',
      props.class,
    )}
  >
    {props.icon && <div class="text-fg-subtle opacity-70">{props.icon}</div>}
    <div>
      <p class={cn('font-medium text-fg', props.size === 'sm' ? 'text-sm' : 'text-[15px]')}>{props.title}</p>
      {props.description && (
        <p class={cn('text-fg-muted', props.size === 'sm' ? 'mt-0.5 text-xs' : 'mt-1 text-[13px]')}>
          {props.description}
        </p>
      )}
    </div>
    {props.action}
  </div>
);
