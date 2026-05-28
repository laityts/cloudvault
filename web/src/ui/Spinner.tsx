import type { Component } from 'solid-js';
import { cn } from '~/lib/cn';

export const Spinner: Component<{ size?: number; class?: string; label?: string }> = (props) => {
  const size = props.size ?? 18;
  return (
    <span
      class={cn('spinner', props.class)}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-label={props.label ?? 'Loading'}
      role="status"
    />
  );
};
