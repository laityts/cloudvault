import type { Component, JSX } from 'solid-js';
import { Show } from 'solid-js';
import { cn } from '~/lib/cn';
import { fileCategory, type FileCategory } from '~/lib/fileKind';
import {
  IconImage,
  IconVideo,
  IconAudio,
  IconPdf,
  IconArchive,
  IconCode,
  IconApp,
  IconFont,
  IconFile,
  IconFolder,
} from './icons';

const COLOR: Record<FileCategory | 'folder', string> = {
  image: 'bg-[color-mix(in_oklch,var(--pill-image),transparent_88%)] text-[var(--pill-image)]',
  video: 'bg-[color-mix(in_oklch,var(--pill-video),transparent_88%)] text-[var(--pill-video)]',
  audio: 'bg-[color-mix(in_oklch,var(--pill-audio),transparent_88%)] text-[var(--pill-audio)]',
  document: 'bg-[color-mix(in_oklch,var(--pill-doc),transparent_88%)] text-[var(--pill-doc)]',
  pdf: 'bg-[color-mix(in_oklch,var(--danger),transparent_88%)] text-danger',
  archive: 'bg-[color-mix(in_oklch,var(--pill-archive),transparent_88%)] text-[var(--pill-archive)]',
  code: 'bg-[color-mix(in_oklch,var(--pill-code),transparent_88%)] text-[var(--pill-code)]',
  app: 'bg-[color-mix(in_oklch,var(--pill-video),transparent_88%)] text-[var(--pill-video)]',
  font: 'bg-[color-mix(in_oklch,var(--pill-doc),transparent_88%)] text-[var(--pill-doc)]',
  other: 'bg-bg-hover text-fg-muted',
  folder: 'bg-brand-soft text-brand',
};

const ICON_MAP: Record<FileCategory, (size: number) => JSX.Element> = {
  image: (s) => <IconImage size={s} />,
  video: (s) => <IconVideo size={s} />,
  audio: (s) => <IconAudio size={s} />,
  document: (s) => <IconFile size={s} />,
  pdf: (s) => <IconPdf size={s} />,
  archive: (s) => <IconArchive size={s} />,
  code: (s) => <IconCode size={s} />,
  app: (s) => <IconApp size={s} />,
  font: (s) => <IconFont size={s} />,
  other: (s) => <IconFile size={s} />,
};

export interface FileIconProps {
  type?: string;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  asFolder?: boolean;
  thumbUrl?: string;
  class?: string;
  rounded?: 'sm' | 'md' | 'lg';
}

const BOX: Record<NonNullable<FileIconProps['size']>, string> = {
  xs: 'h-7 w-7',
  sm: 'h-9 w-9',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
  xl: 'h-16 w-16',
};
const ICON_SIZE: Record<NonNullable<FileIconProps['size']>, number> = {
  xs: 14,
  sm: 16,
  md: 18,
  lg: 22,
  xl: 28,
};
const ROUNDED = { sm: 'rounded', md: 'rounded-md', lg: 'rounded-lg' };

export const FileIcon: Component<FileIconProps> = (props) => {
  const size = () => props.size ?? 'sm';
  const category = () => fileCategory(props.type, props.name);
  const color = () => (props.asFolder ? COLOR.folder : COLOR[category()]);
  const renderIcon = () => (props.asFolder ? <IconFolder size={ICON_SIZE[size()]} /> : ICON_MAP[category()](ICON_SIZE[size()]));

  return (
    <div
      class={cn(
        'inline-flex items-center justify-center overflow-hidden shrink-0',
        BOX[size()],
        ROUNDED[props.rounded ?? 'md'],
        !props.thumbUrl && color(),
        props.thumbUrl && 'bg-bg-inset',
        props.class,
      )}
      aria-hidden="true"
    >
      <Show when={props.thumbUrl} fallback={renderIcon()}>
        <img
          src={props.thumbUrl}
          loading="lazy"
          class="h-full w-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
          alt=""
        />
      </Show>
    </div>
  );
};
