import {
  createContext,
  createSignal,
  For,
  useContext,
  type JSX,
  type Component,
  onCleanup,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { cn } from '~/lib/cn';
import { IconCheck, IconWarning, IconInfo, IconClose } from './icons';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  duration: number;
}

interface ToastContextValue {
  show: (message: string, opts?: { kind?: ToastKind; duration?: number }) => number;
  update: (id: number, message: string, opts?: { kind?: ToastKind; duration?: number }) => void;
  dismiss: (id: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue>();

let _id = 0;

const ICONS: Record<ToastKind, () => JSX.Element> = {
  info: () => <IconInfo size={16} />,
  success: () => <IconCheck size={16} />,
  error: () => <IconWarning size={16} />,
  warning: () => <IconWarning size={16} />,
};

const COLORS: Record<ToastKind, string> = {
  info: 'border-info/30 bg-info-soft text-info',
  success: 'border-ok/30 bg-ok-soft text-ok',
  error: 'border-danger/30 bg-danger-soft text-danger',
  warning: 'border-warn/30 bg-warn-soft text-warn',
};

export const ToastProvider: Component<{ children: JSX.Element }> = (props) => {
  const [toasts, setToasts] = createSignal<ToastItem[]>([]);
  const timers = new Map<number, number>();

  const dismiss = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.get(id);
    if (handle != null) {
      clearTimeout(handle);
      timers.delete(id);
    }
  };

  const show = (message: string, opts: { kind?: ToastKind; duration?: number } = {}) => {
    const id = ++_id;
    const duration = opts.duration ?? 3200;
    setToasts((prev) => [...prev, { id, kind: opts.kind ?? 'info', message, duration }]);
    if (duration > 0) {
      const handle = window.setTimeout(() => dismiss(id), duration);
      timers.set(id, handle);
    }
    return id;
  };

  const update = (id: number, message: string, opts: { kind?: ToastKind; duration?: number } = {}) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, message, kind: opts.kind ?? t.kind } : t)),
    );
    if (opts.duration != null) {
      const old = timers.get(id);
      if (old != null) {
        clearTimeout(old);
        timers.delete(id);
      }
      if (opts.duration > 0) {
        const handle = window.setTimeout(() => dismiss(id), opts.duration);
        timers.set(id, handle);
      }
    }
  };

  onCleanup(() => {
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
  });

  const ctx: ToastContextValue = {
    show,
    update,
    dismiss,
    success: (m, d) => show(m, { kind: 'success', duration: d }),
    error: (m, d) => show(m, { kind: 'error', duration: d }),
    info: (m, d) => show(m, { kind: 'info', duration: d }),
  };

  return (
    <ToastContext.Provider value={ctx}>
      {props.children}
      <Portal>
        <div
          aria-live="polite"
          aria-atomic="true"
          class="pointer-events-none fixed inset-x-0 top-3 z-[10000] flex flex-col items-center gap-2 px-3 sm:items-end sm:right-4 sm:left-auto sm:top-4"
        >
          <For each={toasts()}>
            {(t) => (
              <div
                class={cn(
                  'pointer-events-auto inline-flex items-center gap-2.5 rounded-md border hairline px-3.5 py-2.5 shadow-raised animate-slide-down',
                  'bg-bg-surface text-fg max-w-[380px] sm:min-w-[260px]',
                  COLORS[t.kind],
                )}
              >
                {ICONS[t.kind]()}
                <span class="text-[13px] font-medium leading-snug flex-1">{t.message}</span>
                <button
                  class="text-fg-subtle hover:text-fg shrink-0"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                >
                  <IconClose size={14} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Portal>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
