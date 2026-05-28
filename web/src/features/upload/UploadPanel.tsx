import { For, type Component } from 'solid-js';
import { cn } from '~/lib/cn';
import { ProgressBar, IconCheck, IconWarning, IconClose, IconUpload } from '~/ui';
import type { UploadItem } from './uploadManager';

export const UploadPanel: Component<{
  items: UploadItem[];
  onClear: () => void;
  onClose: () => void;
}> = (props) => {
  const uploadingCount = () => props.items.filter((i) => i.status === 'uploading' || i.status === 'pending').length;
  const totalCount = () => props.items.length;

  return (
    <div
      class={cn(
        'fixed z-[8000] surface border hairline rounded-xl shadow-float overflow-hidden',
        'bottom-3 right-3 w-[min(94vw,360px)]',
        'sm:bottom-4 sm:right-4 safe-pb',
      )}
    >
      <div class="flex items-center justify-between px-3.5 py-2.5 border-b hairline">
        <div class="flex items-center gap-2 min-w-0">
          <IconUpload size={14} class="text-fg-subtle shrink-0" />
          <span class="text-[12.5px] font-medium tabular">
            上传 {uploadingCount()} <span class="text-fg-subtle">/</span> {totalCount()}
          </span>
        </div>
        <div class="flex items-center gap-1">
          <button
            type="button"
            onClick={() => props.onClear()}
            class="text-[11px] text-fg-muted hover:text-fg px-1.5 h-7 rounded"
          >
            清除
          </button>
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
      <ul class="max-h-60 overflow-y-auto">
        <For each={props.items}>
          {(item) => (
            <li class="px-3.5 py-2 border-b hairline last:border-b-0">
              <div class="flex items-center gap-2">
                <div class="flex-1 min-w-0">
                  <div class="text-[12px] font-medium truncate" title={item.file.name}>
                    {item.file.name}
                  </div>
                  <ProgressBar
                    class="mt-1"
                    value={item.progress}
                    status={item.status === 'done' ? 'done' : item.status === 'error' ? 'error' : 'active'}
                  />
                </div>
                <span class="shrink-0 w-7 text-right tabular text-[11px]">
                  {item.status === 'done' ? (
                    <IconCheck size={14} class="text-ok inline" />
                  ) : item.status === 'error' ? (
                    <IconWarning size={14} class="text-danger inline" />
                  ) : (
                    `${item.progress}%`
                  )}
                </span>
              </div>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};
