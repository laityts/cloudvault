import type { Component } from 'solid-js';
import { IconButton } from './IconButton';
import { IconSun, IconMoon } from './icons';
import { Show } from 'solid-js';

export const ThemeToggle: Component<{
  theme: 'dark' | 'light';
  onToggle: () => void;
  size?: 'sm' | 'md';
}> = (props) => (
  <IconButton
    label={props.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    onClick={props.onToggle}
    size={props.size ?? 'md'}
  >
    <Show when={props.theme === 'dark'} fallback={<IconMoon size={16} />}>
      <IconSun size={16} />
    </Show>
  </IconButton>
);
