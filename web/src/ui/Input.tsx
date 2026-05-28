import { splitProps, type JSX, type Component } from 'solid-js';
import { cn } from '~/lib/cn';

export interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  leadingIcon?: JSX.Element;
  trailingIcon?: JSX.Element;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: 'h-8 text-[13px]',
  md: 'h-9 text-sm',
  lg: 'h-11 text-[15px]',
};

export const Input: Component<InputProps> = (props) => {
  const [local, rest] = splitProps(props, ['leadingIcon', 'trailingIcon', 'size', 'class']);
  return (
    <div class="relative w-full">
      {local.leadingIcon && (
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle">
          {local.leadingIcon}
        </span>
      )}
      <input
        {...rest}
        class={cn(
          SIZES[local.size ?? 'md'],
          local.leadingIcon && 'pl-9',
          local.trailingIcon && 'pr-9',
          local.class,
        )}
      />
      {local.trailingIcon && (
        <span class="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle">{local.trailingIcon}</span>
      )}
    </div>
  );
};

export interface LabelProps extends JSX.LabelHTMLAttributes<HTMLLabelElement> {
  hint?: string;
}
export const FieldLabel: Component<LabelProps> = (props) => {
  const [local, rest] = splitProps(props, ['hint', 'class', 'children']);
  return (
    <label {...rest} class={cn('block', local.class)}>
      <span class="text-xs font-medium text-fg-muted">{local.children}</span>
      {local.hint && <span class="block mt-0.5 text-[11px] text-fg-subtle">{local.hint}</span>}
    </label>
  );
};

export interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export const Toggle: Component<ToggleProps> = (props) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => !props.disabled && props.onChange(!props.checked)}
      class={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
        'focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base',
        props.checked ? 'bg-brand' : 'bg-bg-hover',
        props.disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        class={cn(
          'pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-soft transition-transform',
          props.checked && 'translate-x-4',
        )}
      />
    </button>
  );
};
