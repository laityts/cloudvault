import { For, Show, createMemo, type Component } from 'solid-js';
import { cn } from '~/lib/cn';
import {
  ProgressBar,
  IconCheck,
  IconWarning,
  IconClose,
  IconUpload,
  IconPause,
  IconPlay,
  IconRefresh,
  IconWifiOff,
} from '~/ui';
import type { UploadItem } from './uploadManager';
import type { UploadManager } from './uploadManager';

const STATUS_LABEL: Record<UploadItem['status'], string> = {
  pending: '排队中',
  uploading: '上传中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
};

export const UploadPanel: Component<{
  manager: UploadManager;
  items: UploadItem[];
  offline: boolean;
  onClose: () => void;
}> = (props) => {
  const counts = createMemo(() => {
    const c = { uploading: 0, pending: 0, paused: 0, done: 0, error: 0, canceled: 0 };
    for (const i of props.items) c[i.status]++;
    return c;
  });

  const inFlightLabel = () => counts().uploading + counts().pending;
  const totalCount = () => props.items.length;

  // Bulk-action visibility: enable each only when at least one item qualifies.
  // 暂停 / 恢复 互斥：有进行中显示"全部暂停"；否则若有暂停项显示"全部恢复"。
  const showPauseAll = () => counts().uploading + counts().pending > 0;
  const showResumeAll = () => !showPauseAll() && !props.offline && counts().paused > 0;
  const canCancelAll = () =>
    counts().uploading + counts().pending + counts().paused > 0;
  const canRetryAll = () => !props.offline && counts().error + counts().canceled > 0;
  const canClear = () => counts().done + counts().error + counts().canceled > 0;

  return (
    <div
      class={cn(
        'fixed z-[8000] surface border hairline rounded-xl shadow-float overflow-hidden',
        'bottom-3 right-3 w-[min(94vw,380px)]',
        'sm:bottom-4 sm:right-4 safe-pb',
      )}
    >
      {/* Header */}
      <div class="flex items-center justify-between px-3.5 py-2.5 border-b hairline">
        <div class="flex items-center gap-2 min-w-0">
          <IconUpload size={14} class="text-fg-subtle shrink-0" />
          <span class="text-[12.5px] font-medium tabular">
            上传 {inFlightLabel()} <span class="text-fg-subtle">/</span> {totalCount()}
          </span>
        </div>
        <div class="flex items-center gap-0.5">
          <Show when={showPauseAll()}>
            <HeaderAction label="全部暂停" onClick={() => props.manager.pauseAll()}>
              <IconPause size={12} />
            </HeaderAction>
          </Show>
          <Show when={showResumeAll()}>
            <HeaderAction label="全部恢复" onClick={() => props.manager.resumeAll()}>
              <IconPlay size={12} />
            </HeaderAction>
          </Show>
          <Show when={canRetryAll()}>
            <HeaderAction label="全部重试" onClick={() => props.manager.retryAll()}>
              <IconRefresh size={12} />
            </HeaderAction>
          </Show>
          <Show when={canCancelAll()}>
            <HeaderAction label="全部取消" tone="danger" onClick={() => props.manager.cancelAll()}>
              <IconClose size={12} />
            </HeaderAction>
          </Show>
          <Show when={canClear()}>
            <button
              type="button"
              onClick={() => props.manager.clearCompleted()}
              class="text-[11px] text-fg-muted hover:text-fg px-1.5 h-7 rounded"
            >
              清除
            </button>
          </Show>
          <button
            type="button"
            onClick={() => props.onClose()}
            class="w-7 h-7 inline-flex items-center justify-center rounded text-fg-subtle hover:text-fg hover:bg-bg-hover"
            aria-label="Close"
          >
            <IconClose size={14} />
          </button>
        </div>
      </div>

      {/* Offline banner */}
      <Show when={props.offline}>
        <div class="flex items-center gap-2 px-3.5 py-2 bg-warn/12 border-b hairline text-[11.5px] text-warn">
          <IconWifiOff size={13} class="shrink-0" />
          <span>网络已断开，进行中的任务已自动暂停，恢复后将继续。</span>
        </div>
      </Show>

      {/* List */}
      <Show
        when={totalCount() > 0}
        fallback={
          <div class="px-4 py-8 text-center text-[12px] text-fg-subtle">
            暂无上传任务
          </div>
        }
      >
        <ul class="max-h-72 overflow-y-auto">
          <For each={props.items}>
            {(item) => <Row item={item} manager={props.manager} offline={props.offline} />}
          </For>
        </ul>
      </Show>
    </div>
  );
};

const HeaderAction: Component<{
  label: string;
  tone?: 'default' | 'danger';
  onClick: () => void;
  children: any;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    title={props.label}
    aria-label={props.label}
    class={cn(
      'w-7 h-7 inline-flex items-center justify-center rounded transition-colors',
      props.tone === 'danger'
        ? 'text-fg-subtle hover:bg-danger/10 hover:text-danger'
        : 'text-fg-subtle hover:bg-bg-hover hover:text-fg',
    )}
  >
    {props.children}
  </button>
);

const Row: Component<{
  item: UploadItem;
  manager: UploadManager;
  offline: boolean;
}> = (props) => {
  const isActive = () => props.item.status === 'uploading' || props.item.status === 'pending';
  const isPaused = () => props.item.status === 'paused';
  const isFinished = () =>
    props.item.status === 'done' ||
    props.item.status === 'error' ||
    props.item.status === 'canceled';

  const statusTone = () => {
    switch (props.item.status) {
      case 'done':
        return 'text-ok';
      case 'error':
        return 'text-danger';
      case 'canceled':
        return 'text-fg-subtle';
      case 'paused':
        return 'text-warn';
      default:
        return 'text-fg-muted';
    }
  };

  const statusText = () => {
    if (props.item.status === 'paused' && props.item.error === 'offline') return '离线已暂停';
    return STATUS_LABEL[props.item.status];
  };

  const progressStatus = (): 'active' | 'done' | 'error' => {
    if (props.item.status === 'done') return 'done';
    if (props.item.status === 'error') return 'error';
    return 'active';
  };

  return (
    <li class="px-3.5 py-2 border-b hairline last:border-b-0">
      <div class="flex items-center gap-2">
        <div class="flex-1 min-w-0">
          <div class="text-[12px] font-medium truncate" title={props.item.file.name}>
            {props.item.file.name}
          </div>
          <ProgressBar class="mt-1" value={props.item.progress} status={progressStatus()} />
          <div class="mt-1 flex items-center gap-1.5 text-[11px]">
            <span class={cn('tabular', statusTone())}>{statusText()}</span>
            <Show when={!isFinished()}>
              <span class="text-fg-subtle">·</span>
              <span class="tabular text-fg-subtle">{props.item.progress}%</span>
            </Show>
            <Show when={props.item.status === 'error' && props.item.error}>
              <span class="text-fg-subtle">·</span>
              <span class="truncate text-fg-subtle" title={props.item.error}>
                {props.item.error}
              </span>
            </Show>
            <Show when={isPaused() && !props.item.resumable}>
              <span class="text-fg-subtle">·</span>
              <span class="text-fg-subtle">恢复将从头上传</span>
            </Show>
          </div>
        </div>

        <div class="shrink-0 flex items-center gap-0.5">
          <Show when={props.item.status === 'done'}>
            <IconCheck size={14} class="text-ok mx-1.5" />
          </Show>

          <Show when={isActive()}>
            <RowAction label="暂停" onClick={() => props.manager.pause(props.item.id)}>
              <IconPause size={12} />
            </RowAction>
          </Show>
          <Show when={isPaused() && !props.offline}>
            <RowAction label="恢复" onClick={() => props.manager.resume(props.item.id)}>
              <IconPlay size={12} />
            </RowAction>
          </Show>
          <Show when={(props.item.status === 'error' || props.item.status === 'canceled') && !props.offline}>
            <RowAction label="重试" onClick={() => props.manager.retry(props.item.id)}>
              <IconRefresh size={12} />
            </RowAction>
          </Show>
          <Show when={props.item.status === 'error'}>
            <IconWarning size={14} class="text-danger mx-1" />
          </Show>
          <Show when={!isFinished()}>
            <RowAction
              label="取消"
              tone="danger"
              onClick={() => props.manager.cancel(props.item.id)}
            >
              <IconClose size={12} />
            </RowAction>
          </Show>
        </div>
      </div>
    </li>
  );
};

const RowAction: Component<{
  label: string;
  tone?: 'default' | 'danger';
  onClick: () => void;
  children: any;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    title={props.label}
    aria-label={props.label}
    class={cn(
      'w-6 h-6 inline-flex items-center justify-center rounded transition-colors',
      props.tone === 'danger'
        ? 'text-fg-subtle hover:bg-danger/10 hover:text-danger'
        : 'text-fg-subtle hover:bg-bg-hover hover:text-fg',
    )}
  >
    {props.children}
  </button>
);
