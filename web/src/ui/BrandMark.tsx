import { Show, type Component } from 'solid-js';
import { cn } from '~/lib/cn';
import type { BrandingData } from '~/api/types';
import { IconLogo } from './icons';

export const BrandMark: Component<{
  branding: BrandingData;
  size?: 'sm' | 'md' | 'lg';
  showName?: boolean;
  class?: string;
}> = (props) => {
  const size = () => props.size ?? 'sm';
  const iconBox = () =>
    size() === 'sm' ? 'h-7 w-7' : size() === 'md' ? 'h-9 w-9' : 'h-12 w-12';
  const iconSize = () => (size() === 'sm' ? 16 : size() === 'md' ? 20 : 28);
  const nameClass = () =>
    size() === 'sm' ? 'text-sm font-semibold' : size() === 'md' ? 'text-base font-semibold' : 'text-xl font-semibold';

  return (
    <div class={cn('inline-flex items-center gap-2.5', props.class)}>
      <div
        class={cn(
          'inline-flex items-center justify-center rounded-md overflow-hidden shrink-0',
          'bg-brand-soft text-brand',
          iconBox(),
        )}
      >
        <Show when={props.branding.siteIconUrl} fallback={<IconLogo size={iconSize()} />}>
          <img src={props.branding.siteIconUrl} alt="" class="h-full w-full object-contain" />
        </Show>
      </div>
      <Show when={props.showName !== false}>
        <span class={cn('text-fg truncate', nameClass())}>{props.branding.siteName}</span>
      </Show>
    </div>
  );
};
