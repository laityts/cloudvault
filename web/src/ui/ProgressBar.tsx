import type { Component } from 'solid-js';
import { cn } from '~/lib/cn';

export const ProgressBar: Component<{
  value: number;
  size?: 'thin' | 'normal';
  status?: 'active' | 'done' | 'error';
  class?: string;
}> = (props) => {
  const v = () => Math.max(0, Math.min(100, props.value));
  const status = () => props.status ?? 'active';
  return (
    <div
      class={cn(
        'w-full overflow-hidden rounded-full bg-bg-hover',
        props.size === 'thin' ? 'h-1' : 'h-1.5',
        props.class,
      )}
      role="progressbar"
      aria-valuenow={v()}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        class={cn(
          'h-full rounded-full transition-[width] duration-300 ease-out',
          status() === 'active' && 'bg-brand',
          status() === 'done' && 'bg-ok',
          status() === 'error' && 'bg-danger',
        )}
        style={{ width: `${v()}%` }}
      />
    </div>
  );
};
