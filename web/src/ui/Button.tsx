import { splitProps, type JSX, type Component } from 'solid-js';
import { cn } from '~/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leadingIcon?: JSX.Element;
  trailingIcon?: JSX.Element;
  block?: boolean;
}

const SIZES: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-lg',
};

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand text-fg-onAccent font-medium hover:bg-brand-hover active:translate-y-px disabled:opacity-50',
  secondary:
    'bg-bg-raised text-fg hairline border hover:bg-bg-hover disabled:opacity-50',
  ghost: 'text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40',
  danger:
    'bg-transparent text-danger border hairline border-danger/30 hover:bg-danger/10 disabled:opacity-50',
  outline:
    'bg-transparent text-fg border hairline hover:bg-bg-hover hover:border-line-strong disabled:opacity-50',
};

export const Button: Component<ButtonProps> = (props) => {
  const [local, rest] = splitProps(props, [
    'variant',
    'size',
    'loading',
    'leadingIcon',
    'trailingIcon',
    'block',
    'class',
    'children',
    'disabled',
  ]);
  return (
    <button
      type="button"
      {...rest}
      disabled={local.disabled || local.loading}
      class={cn(
        'inline-flex items-center justify-center whitespace-nowrap select-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base',
        SIZES[local.size ?? 'md'],
        VARIANTS[local.variant ?? 'secondary'],
        local.block && 'w-full',
        (local.disabled || local.loading) && 'cursor-not-allowed',
        local.class,
      )}
    >
      {local.loading ? <span class="spinner" /> : local.leadingIcon}
      {local.children && <span class={cn('truncate', local.loading && 'opacity-70')}>{local.children}</span>}
      {local.trailingIcon}
    </button>
  );
};
