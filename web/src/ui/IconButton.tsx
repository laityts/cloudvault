import { splitProps, type JSX, type Component } from 'solid-js';
import { cn } from '~/lib/cn';

type Size = 'sm' | 'md' | 'lg';
type Variant = 'ghost' | 'subtle' | 'solid' | 'danger';

export interface IconButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  variant?: Variant;
  /** Accessible label — required because the button has no visible text. */
  label: string;
  active?: boolean;
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 w-8 md:h-7 md:w-7',
  md: 'h-10 w-10 md:h-9 md:w-9',
  lg: 'h-11 w-11',
};

const VARIANTS: Record<Variant, string> = {
  ghost: 'text-fg-muted hover:bg-bg-hover hover:text-fg',
  subtle: 'bg-bg-raised hairline border text-fg-muted hover:bg-bg-hover hover:text-fg',
  solid: 'bg-brand text-fg-onAccent hover:bg-brand-hover',
  danger: 'text-fg-muted hover:bg-danger/10 hover:text-danger',
};

export const IconButton: Component<IconButtonProps> = (props) => {
  const [local, rest] = splitProps(props, ['size', 'variant', 'label', 'active', 'class', 'children']);
  return (
    <button
      type="button"
      aria-label={local.label}
      title={local.label}
      {...rest}
      class={cn(
        'inline-flex items-center justify-center rounded-md transition-colors',
        'focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base',
        SIZES[local.size ?? 'md'],
        VARIANTS[local.variant ?? 'ghost'],
        local.active && 'bg-brand-soft text-brand',
        local.class,
      )}
    >
      {local.children}
    </button>
  );
};
