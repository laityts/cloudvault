import { For, Show, type Component } from 'solid-js';
import { cn } from '~/lib/cn';
import {
  IconChevronRight,
  IconFolder,
  IconHome,
  IconLink,
  IconLock,
  IconWarning,
} from '~/ui';
import type { DashboardStore, FolderNode } from './store';

export const FolderTree: Component<{
  store: DashboardStore;
  onContextMenu?: (e: MouseEvent, folder: string) => void;
}> = (props) => {
  const onContext = (e: MouseEvent, folder: string) => {
    if (props.onContextMenu) {
      e.preventDefault();
      props.onContextMenu(e, folder);
    }
  };

  return (
    <nav class="flex flex-col text-[13px]" aria-label="Folders">
      <FolderRow
        active={props.store.currentFolder() === 'root'}
        onClick={() => props.store.setCurrentFolder('root')}
        depth={0}
        expandable
        expanded={!!props.store.expandedFolders().__root__}
        onToggleExpand={() => props.store.toggleExpand('__root__')}
        icon={<IconHome size={15} />}
        label="Home"
      />
      <Show when={props.store.expandedFolders().__root__}>
        <FolderTreeBranch
          nodes={props.store.folderTree()}
          depth={1}
          store={props.store}
          onContextMenu={onContext}
        />
      </Show>
    </nav>
  );
};

const FolderTreeBranch: Component<{
  nodes: FolderNode[];
  depth: number;
  store: DashboardStore;
  onContextMenu: (e: MouseEvent, folder: string) => void;
}> = (props) => (
  <For each={props.nodes}>
    {(node) => (
      <>
        <FolderRow
          active={props.store.currentFolder() === node.path}
          onClick={() => props.store.setCurrentFolder(node.path)}
          onContextMenu={(e) => props.onContextMenu(e, node.path)}
          depth={props.depth}
          expandable={node.children.length > 0}
          expanded={!!props.store.expandedFolders()[node.path]}
          onToggleExpand={() => props.store.toggleExpand(node.path)}
          icon={<IconFolder size={15} />}
          badge={
            node.excluded ? (
              <IconWarning size={11} class="text-danger" />
            ) : node.directlyShared ? (
              <IconLink size={11} class="text-brand" />
            ) : node.shared ? (
              <IconLock size={10} class="text-fg-subtle" />
            ) : null
          }
          label={node.name}
        />
        <Show when={node.children.length > 0 && props.store.expandedFolders()[node.path]}>
          <FolderTreeBranch
            nodes={node.children}
            depth={props.depth + 1}
            store={props.store}
            onContextMenu={props.onContextMenu}
          />
        </Show>
      </>
    )}
  </For>
);

const FolderRow: Component<{
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  icon: any;
  badge?: any;
  label: string;
}> = (props) => (
  <div
    onClick={() => props.onClick()}
    onContextMenu={(e) => props.onContextMenu?.(e)}
    class={cn(
      'group flex items-center gap-1.5 h-8 pr-2 cursor-pointer rounded-md mx-1 select-none',
      'hover:bg-bg-hover',
      props.active && 'bg-brand-soft text-brand',
      !props.active && 'text-fg-muted',
    )}
    style={{ 'padding-left': `${4 + props.depth * 14}px` }}
  >
    <Show
      when={props.expandable}
      fallback={<span class="w-4 h-4 inline-block" />}
    >
      <button
        type="button"
        class={cn(
          'shrink-0 w-4 h-4 inline-flex items-center justify-center rounded-sm text-fg-subtle hover:text-fg',
          props.expanded && 'rotate-90',
        )}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleExpand();
        }}
        aria-label={props.expanded ? 'Collapse' : 'Expand'}
      >
        <IconChevronRight size={12} />
      </button>
    </Show>
    <span class={cn('shrink-0', props.active ? 'text-brand' : 'text-fg-subtle')}>{props.icon}</span>
    <span class="truncate flex-1 text-[13px]">{props.label}</span>
    <Show when={props.badge}>
      <span class="shrink-0 ml-1">{props.badge}</span>
    </Show>
  </div>
);
