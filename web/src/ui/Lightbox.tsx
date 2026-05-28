import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { IconButton } from './IconButton';
import { IconChevronLeft, IconChevronRight, IconClose, IconDownload } from './icons';
import { cn } from '~/lib/cn';

export interface LightboxImage {
  id: string;
  name: string;
  src: string;
  downloadUrl?: string;
}

export interface LightboxProps {
  open: boolean;
  images: LightboxImage[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}

export const Lightbox: Component<LightboxProps> = (props) => {
  const [dragX, setDragX] = createSignal(0);
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDX = 0;
  let touchDY = 0;
  let touching = false;

  const next = () => {
    if (props.images.length === 0) return;
    props.onIndexChange((props.index + 1) % props.images.length);
  };
  const prev = () => {
    if (props.images.length === 0) return;
    props.onIndexChange((props.index - 1 + props.images.length) % props.images.length);
  };

  // Keyboard navigation while open
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touching = true;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!touching) return;
    const t = e.touches[0];
    touchDX = t.clientX - touchStartX;
    touchDY = t.clientY - touchStartY;
    if (Math.abs(touchDX) > Math.abs(touchDY)) {
      setDragX(touchDX);
      e.preventDefault();
    }
  };
  const onTouchEnd = () => {
    touching = false;
    const threshold = window.innerWidth * 0.18;
    if (touchDX > threshold) prev();
    else if (touchDX < -threshold) next();
    setDragX(0);
    touchDX = 0;
    touchDY = 0;
  };

  const current = () => props.images[props.index];

  return (
    <Show when={props.open && current()}>
      <Portal>
        <div
          class="fixed inset-0 z-[9200] flex items-center justify-center bg-black/92 animate-fade-in"
          role="dialog"
          aria-modal="true"
          onClick={() => props.onClose()}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {/* Header bar */}
          <div
            class="absolute top-0 left-0 right-0 flex items-center justify-between px-3 py-3 sm:px-5 z-10"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center gap-2 text-white/85 min-w-0">
              <span class="text-[13px] font-mono tabular-nums shrink-0">
                {props.index + 1} <span class="text-white/45">/</span> {props.images.length}
              </span>
              <span class="text-[13px] truncate hidden sm:inline">{current()!.name}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <Show when={current()!.downloadUrl}>
                <a
                  href={current()!.downloadUrl}
                  download=""
                  class="inline-flex h-10 w-10 items-center justify-center rounded-md text-white/85 hover:bg-white/10"
                  aria-label="Download"
                >
                  <IconDownload size={18} />
                </a>
              </Show>
              <IconButton
                label="Close"
                onClick={() => props.onClose()}
                size="md"
                class="text-white/85 hover:bg-white/10"
              >
                <IconClose size={18} />
              </IconButton>
            </div>
          </div>

          {/* Prev/Next — desktop only */}
          <div class="absolute inset-y-0 left-0 hidden md:flex items-center pl-3" onClick={(e) => e.stopPropagation()}>
            <IconButton label="Previous" onClick={prev} size="lg" class="text-white/85 bg-white/10 hover:bg-white/20">
              <IconChevronLeft size={22} />
            </IconButton>
          </div>
          <div class="absolute inset-y-0 right-0 hidden md:flex items-center pr-3" onClick={(e) => e.stopPropagation()}>
            <IconButton label="Next" onClick={next} size="lg" class="text-white/85 bg-white/10 hover:bg-white/20">
              <IconChevronRight size={22} />
            </IconButton>
          </div>

          {/* Image */}
          <div
            class={cn(
              'max-w-[92vw] max-h-[82dvh] flex items-center justify-center',
              'transition-transform will-change-transform',
            )}
            style={{ transform: `translateX(${dragX()}px)` }}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={current()!.src}
              alt={current()!.name}
              class="max-w-full max-h-[82dvh] object-contain select-none"
              draggable={false}
            />
          </div>

          {/* Filename on mobile */}
          <div class="absolute left-0 right-0 bottom-4 sm:hidden text-center text-[13px] text-white/75 px-6 truncate" onClick={(e) => e.stopPropagation()}>
            {current()!.name}
          </div>
        </div>
      </Portal>
    </Show>
  );
};
