import { For, Show, type Component } from 'solid-js';
import { cn } from '~/lib/cn';
import { fileCategory } from '~/lib/fileKind';
import { formatBytes, formatRelativeDate } from '~/lib/format';
import { FileIcon, IconCheck, IconLink, IconChevronUp, IconChevronDown, IconMoreVertical } from '~/ui';
import type { FileMeta } from '~/api/types';
import type { DashboardStore, SortKey } from './store';
import { longpress } from '~/lib/longpress';

void longpress; // keep import side-effect for `use:longpress`

export const FileGrid: Component<{
  files: FileMeta[];
  store: DashboardStore;
  onPreview: (f: FileMeta) => void;
  onMore: (e: MouseEvent, f: FileMeta) => void;
}> = (props) => (
  <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
    <For each={props.files}>
      {(f) => (
        <FileCard
          file={f}
          store={props.store}
          onPreview={() => props.onPreview(f)}
          onMore={(e) => props.onMore(e, f)}
        />
      )}
    </For>
  </div>
);

const FileCard: Component<{
  file: FileMeta;
  store: DashboardStore;
  onPreview: () => void;
  onMore: (e: MouseEvent) => void;
}> = (props) => {
  const selected = () => props.store.isSelected(props.file.id);
  const selectionMode = () => props.store.selected().size > 0;

  const onClick = (e: MouseEvent) => {
    if (selectionMode() || e.shiftKey) {
      if (e.shiftKey) props.store.selectRange(props.file.id);
      else props.store.toggleSelect(props.file.id);
    } else {
      props.onPreview();
    }
  };

  return (
    <div
      class={cn(
        'group relative surface border hairline rounded-lg p-2.5 cursor-pointer transition',
        'hover:border-line-strong hover:bg-bg-raised',
        selected() && 'ring-2 ring-brand ring-offset-2 ring-offset-bg-base border-brand bg-brand-soft',
      )}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMore(e);
      }}
      use:longpress={{
        onLongPress: (e) => {
          const t = e.touches[0];
          props.onMore({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} } as MouseEvent);
        },
      }}
    >
      {/* Selection checkmark */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          props.store.toggleSelect(props.file.id);
        }}
        class={cn(
          'absolute top-1.5 left-1.5 z-10 w-5 h-5 rounded-md border flex items-center justify-center transition',
          selected()
            ? 'bg-brand border-brand text-fg-onAccent'
            : 'bg-bg-surface/85 border-line opacity-0 group-hover:opacity-100',
          (selectionMode() || selected()) && 'opacity-100',
        )}
        aria-label={selected() ? 'Deselect' : 'Select'}
      >
        <Show when={selected()}>
          <IconCheck size={12} />
        </Show>
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          props.onMore(e);
        }}
        class="absolute top-1.5 right-1.5 z-10 w-7 h-7 inline-flex items-center justify-center rounded-md text-fg-subtle hover:bg-bg-hover hover:text-fg opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="More actions"
      >
        <IconMoreVertical size={14} />
      </button>

      {/* Thumb */}
      <div class="aspect-square rounded-md overflow-hidden bg-bg-inset flex items-center justify-center mb-2">
        <Show
          when={props.file.type?.startsWith('image/')}
          fallback={<FileIcon type={props.file.type} name={props.file.name} size="xl" rounded="md" />}
        >
          <img
            src={`/api/files/${props.file.id}/thumbnail`}
            alt=""
            loading="lazy"
            class="w-full h-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        </Show>
      </div>

      <div class="text-[12px] font-medium truncate" title={props.file.name}>
        {props.file.name}
      </div>
      <div class="flex items-center justify-between mt-0.5 text-[11px] text-fg-muted">
        <span class="tabular">{formatBytes(props.file.size)}</span>
        <Show when={props.file.shareToken}>
          <span class="text-brand inline-flex items-center gap-0.5">
            <IconLink size={10} />
          </span>
        </Show>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────

export const FileTable: Component<{
  files: FileMeta[];
  store: DashboardStore;
  onPreview: (f: FileMeta) => void;
  onMore: (e: MouseEvent, f: FileMeta) => void;
}> = (props) => {
  const allChecked = () =>
    props.files.length > 0 && props.files.every((f) => props.store.isSelected(f.id));

  return (
    <div class="surface border hairline rounded-xl overflow-hidden">
      <div class="hidden md:grid grid-cols-[36px_minmax(0,1fr)_96px_96px_140px_72px_36px] items-center px-3 py-2 text-[11px] uppercase tracking-wide text-fg-subtle bg-bg-inset/40 border-b hairline">
        <input
          type="checkbox"
          aria-label="Select all"
          checked={allChecked()}
          class="accent-[var(--brand)]"
          onChange={(e) => (e.currentTarget.checked ? props.store.selectAll() : props.store.clearSelection())}
        />
        <SortHeader k="name" label="名称" current={props.store.sortKey()} dir={props.store.sortDir()} onClick={() => props.store.toggleSort('name')} />
        <SortHeader k="type" label="类型" current={props.store.sortKey()} dir={props.store.sortDir()} onClick={() => props.store.toggleSort('type')} />
        <SortHeader k="size" label="大小" current={props.store.sortKey()} dir={props.store.sortDir()} onClick={() => props.store.toggleSort('size')} />
        <SortHeader k="date" label="修改时间" current={props.store.sortKey()} dir={props.store.sortDir()} onClick={() => props.store.toggleSort('date')} />
        <span class="text-right">分享</span>
        <span />
      </div>

      <ul class="divide-y hairline divide-line">
        <For each={props.files}>
          {(file) => (
            <FileRow file={file} store={props.store} onPreview={() => props.onPreview(file)} onMore={(e) => props.onMore(e, file)} />
          )}
        </For>
      </ul>
    </div>
  );
};

const SortHeader: Component<{
  k: SortKey;
  label: string;
  current: SortKey;
  dir: 'asc' | 'desc';
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class={cn(
      'inline-flex items-center gap-1 select-none text-left',
      props.current === props.k ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted',
    )}
  >
    <span>{props.label}</span>
    <Show when={props.current === props.k}>
      {props.dir === 'asc' ? <IconChevronUp size={11} /> : <IconChevronDown size={11} />}
    </Show>
  </button>
);

const FileRow: Component<{
  file: FileMeta;
  store: DashboardStore;
  onPreview: () => void;
  onMore: (e: MouseEvent) => void;
}> = (props) => {
  const selected = () => props.store.isSelected(props.file.id);

  const onRowClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('input,button,a')) return;
    if (e.shiftKey) props.store.selectRange(props.file.id);
    else if (e.metaKey || e.ctrlKey) props.store.toggleSelect(props.file.id);
    else props.onPreview();
  };

  return (
    <li
      class={cn(
        'grid items-center px-3 py-2.5 transition cursor-pointer',
        'grid-cols-[44px_minmax(0,1fr)_44px] md:grid-cols-[36px_minmax(0,1fr)_96px_96px_140px_72px_36px]',
        selected() ? 'bg-brand-soft' : 'hover:bg-bg-hover',
      )}
      onClick={onRowClick}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMore(e);
      }}
      use:longpress={{
        onLongPress: (e) => {
          const t = e.touches[0];
          props.onMore({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} } as MouseEvent);
        },
      }}
    >
      <span class="flex items-center justify-center md:justify-start">
        <input
          type="checkbox"
          checked={selected()}
          class="accent-[var(--brand)]"
          onClick={(e) => e.stopPropagation()}
          onChange={() => props.store.toggleSelect(props.file.id)}
          aria-label="Select"
        />
      </span>
      <div class="flex items-center gap-2.5 min-w-0">
        <FileIcon type={props.file.type} name={props.file.name} size="sm" rounded="md" />
        <div class="min-w-0">
          <div class="text-[13.5px] truncate" title={props.file.name}>
            {props.file.name}
          </div>
          <div class="md:hidden mt-0.5 text-[11px] text-fg-muted tabular">
            {formatBytes(props.file.size)} · {formatRelativeDate(props.file.uploadedAt)}
          </div>
          <Show when={props.store.search() && props.file.folder !== 'root'}>
            <button
              type="button"
              class="md:inline hidden text-[11px] text-fg-subtle truncate hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                props.store.setCurrentFolder(props.file.folder);
              }}
              title={props.file.folder}
            >
              {props.file.folder}
            </button>
          </Show>
        </div>
      </div>
      <span class="hidden md:flex">
        <span class={`pill pill-${fileCategory(props.file.type, props.file.name)}`}>
          {fileCategory(props.file.type, props.file.name)}
        </span>
      </span>
      <span class="hidden md:block text-[12px] text-fg-muted tabular">{formatBytes(props.file.size)}</span>
      <span class="hidden md:block text-[12px] text-fg-muted">{formatRelativeDate(props.file.uploadedAt)}</span>
      <span class="hidden md:flex justify-end">
        <Show when={props.file.shareToken}>
          <span class="inline-flex items-center gap-1 text-[11px] text-brand">
            <IconLink size={11} />
            {props.file.downloads > 0 ? props.file.downloads : ''}
          </span>
        </Show>
      </span>
      <span class="flex justify-end">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onMore(e);
          }}
          class="tap tap-md inline-flex items-center justify-center rounded-md text-fg-subtle hover:bg-bg-hover hover:text-fg"
          aria-label="More actions"
        >
          <IconMoreVertical size={14} />
        </button>
      </span>
    </li>
  );
};
