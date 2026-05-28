import { For, Show, createMemo, createResource, createSignal, type Component } from 'solid-js';
import {
  Drawer,
  Spinner,
  EmptyState,
  IconButton,
  IconLink,
  IconLock,
  IconClose,
  IconCopy,
  IconTrash,
  IconWarning,
  IconChevronRight,
  IconShare,
  IconFolder,
  FileIcon,
  useToast,
} from '~/ui';
import { listShares, revokeShare, revokeFolderShareLink, toggleFolderShare, toggleFolderExclude } from '~/api';
import type { SharedFileEntry, FolderShareLinkEntry } from '~/api/types';
import { formatAbsoluteDate, formatBytes } from '~/lib/format';
import { cn } from '~/lib/cn';

type Tab = 'files' | 'folders';
type StatusFilter = 'all' | 'active' | 'expired' | 'password';

const isExpired = (iso: string | null): boolean =>
  !!iso && new Date(iso) < new Date();

const folderName = (path: string) => path.split('/').pop() || path;

export const ShareManagerDrawer: Component<{
  open: boolean;
  onClose: () => void;
  onNavigate: (folder: string, fileId?: string) => void;
}> = (props) => {
  const toast = useToast();
  const [tab, setTab] = createSignal<Tab>('files');
  const [filter, setFilter] = createSignal<StatusFilter>('all');

  const [data, { refetch }] = createResource(
    () => props.open,
    async (isOpen) => (isOpen ? await listShares() : null),
  );

  const filteredFiles = createMemo<SharedFileEntry[]>(() => {
    const files = data()?.files ?? [];
    const f = filter();
    if (f === 'all') return files;
    if (f === 'active') return files.filter((x) => !isExpired(x.shareExpiresAt));
    if (f === 'expired') return files.filter((x) => isExpired(x.shareExpiresAt));
    return files.filter((x) => x.hasPassword);
  });

  const filteredFolderLinks = createMemo<FolderShareLinkEntry[]>(() => {
    const links = data()?.folderLinks ?? [];
    const f = filter();
    if (f === 'all') return links;
    if (f === 'active') return links.filter((x) => !isExpired(x.expiresAt));
    if (f === 'expired') return links.filter((x) => isExpired(x.expiresAt));
    return links.filter((x) => x.hasPassword);
  });

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  const onRevokeFile = async (file: SharedFileEntry) => {
    try {
      await revokeShare(file.id);
      toast.success('已撤销分享');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '撤销失败');
    }
  };

  const onRevokeFolderLink = async (folder: string) => {
    try {
      await revokeFolderShareLink(folder);
      toast.success('已撤销文件夹分享链接');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '撤销失败');
    }
  };

  const onUnshareFolder = async (folder: string) => {
    try {
      await toggleFolderShare(folder);
      toast.success('已取消公开访问');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const onUnexcludeFolder = async (folder: string) => {
    try {
      await toggleFolderExclude(folder);
      toast.success('已恢复');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  return (
    <Drawer open={props.open} onClose={props.onClose} side="right" width="min(94vw, 420px)">
      <div class="flex flex-col h-full">
        {/* Header */}
        <div class="flex items-center justify-between px-3.5 py-2.5 border-b hairline shrink-0">
          <div class="flex items-center gap-2 min-w-0">
            <IconLink size={15} class="text-fg-subtle shrink-0" />
            <span class="text-[13.5px] font-medium">分享管理</span>
          </div>
          <IconButton label="关闭" size="sm" onClick={props.onClose}>
            <IconClose size={14} />
          </IconButton>
        </div>

        {/* Tabs */}
        <div class="flex border-b hairline shrink-0">
          <TabButton active={tab() === 'files'} onClick={() => setTab('files')}>
            文件
            <Show when={data()?.files.length}>
              <span class="ml-1.5 text-fg-subtle tabular text-[11px]">
                {data()?.files.length}
              </span>
            </Show>
          </TabButton>
          <TabButton active={tab() === 'folders'} onClick={() => setTab('folders')}>
            文件夹
            <Show when={(data()?.folderLinks.length ?? 0) + (data()?.sharedFolders.length ?? 0) > 0}>
              <span class="ml-1.5 text-fg-subtle tabular text-[11px]">
                {(data()?.folderLinks.length ?? 0) + (data()?.sharedFolders.length ?? 0)}
              </span>
            </Show>
          </TabButton>
        </div>

        {/* Filter chips (only in files tab + folder-link sub-list) */}
        <div class="flex items-center gap-1 px-3 py-2 border-b hairline overflow-x-auto shrink-0">
          <FilterChip active={filter() === 'all'} onClick={() => setFilter('all')}>全部</FilterChip>
          <FilterChip active={filter() === 'active'} onClick={() => setFilter('active')}>未过期</FilterChip>
          <FilterChip active={filter() === 'expired'} onClick={() => setFilter('expired')}>已过期</FilterChip>
          <FilterChip active={filter() === 'password'} onClick={() => setFilter('password')}>带密码</FilterChip>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto">
          <Show
            when={!data.loading}
            fallback={
              <div class="flex items-center justify-center py-16">
                <Spinner size={20} />
              </div>
            }
          >
            <Show when={tab() === 'files'}>
              <Show
                when={filteredFiles().length > 0}
                fallback={
                  <EmptyState
                    class="py-12"
                    icon={<IconLink size={28} />}
                    title="暂无文件分享"
                    description="在文件菜单中创建分享链接后，会出现在这里"
                  />
                }
              >
                <ul class="divide-y hairline divide-line">
                  <For each={filteredFiles()}>
                    {(file) => (
                      <FileRow
                        file={file}
                        onCopy={() => copy(`${window.location.origin}/s/${file.shareToken}`)}
                        onRevoke={() => onRevokeFile(file)}
                        onLocate={() => {
                          props.onNavigate(file.folder, file.id);
                          props.onClose();
                        }}
                      />
                    )}
                  </For>
                </ul>
              </Show>
            </Show>

            <Show when={tab() === 'folders'}>
              {/* Folder share links */}
              <Show when={filteredFolderLinks().length > 0}>
                <SectionHeader>分享链接</SectionHeader>
                <ul class="divide-y hairline divide-line">
                  <For each={filteredFolderLinks()}>
                    {(link) => (
                      <FolderLinkRow
                        link={link}
                        onCopy={() => copy(`${window.location.origin}/s/${link.token}`)}
                        onRevoke={() => onRevokeFolderLink(link.folder)}
                        onLocate={() => {
                          props.onNavigate(link.folder);
                          props.onClose();
                        }}
                      />
                    )}
                  </For>
                </ul>
              </Show>

              {/* Public folders (no token, just toggled visible) */}
              <Show when={filter() === 'all' && (data()?.sharedFolders.length ?? 0) > 0}>
                <SectionHeader>公开访问的文件夹</SectionHeader>
                <ul class="divide-y hairline divide-line">
                  <For each={data()?.sharedFolders ?? []}>
                    {(folder) => (
                      <PublicFolderRow
                        folder={folder}
                        onUnshare={() => onUnshareFolder(folder)}
                        onLocate={() => {
                          props.onNavigate(folder);
                          props.onClose();
                        }}
                      />
                    )}
                  </For>
                </ul>
              </Show>

              {/* Excluded folders */}
              <Show when={filter() === 'all' && (data()?.excludedFolders.length ?? 0) > 0}>
                <SectionHeader>已排除的子文件夹</SectionHeader>
                <ul class="divide-y hairline divide-line">
                  <For each={data()?.excludedFolders ?? []}>
                    {(folder) => (
                      <ExcludedFolderRow
                        folder={folder}
                        onRestore={() => onUnexcludeFolder(folder)}
                      />
                    )}
                  </For>
                </ul>
              </Show>

              <Show
                when={
                  filteredFolderLinks().length === 0 &&
                  (filter() !== 'all' ||
                    ((data()?.sharedFolders.length ?? 0) === 0 &&
                      (data()?.excludedFolders.length ?? 0) === 0))
                }
              >
                <EmptyState
                  class="py-12"
                  icon={<IconFolder size={28} />}
                  title="暂无文件夹分享"
                  description="在文件夹菜单中开启公开或创建分享链接后会出现在这里"
                />
              </Show>
            </Show>
          </Show>
        </div>
      </div>
    </Drawer>
  );
};

const TabButton: Component<{ active: boolean; onClick: () => void; children: any }> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class={cn(
      'flex-1 h-9 text-[12.5px] font-medium border-b-2 transition-colors',
      props.active
        ? 'border-brand text-brand'
        : 'border-transparent text-fg-muted hover:text-fg',
    )}
  >
    {props.children}
  </button>
);

const FilterChip: Component<{ active: boolean; onClick: () => void; children: any }> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class={cn(
      'shrink-0 inline-flex items-center h-7 px-2.5 rounded-full text-[11.5px] font-medium border transition-colors',
      props.active
        ? 'bg-brand-soft border-brand/30 text-brand'
        : 'border-transparent text-fg-muted hover:bg-bg-hover',
    )}
  >
    {props.children}
  </button>
);

const SectionHeader: Component<{ children: any }> = (props) => (
  <div class="px-3.5 py-1.5 text-[10.5px] uppercase tracking-wide text-fg-subtle bg-bg-inset/40 border-b hairline">
    {props.children}
  </div>
);

const FileRow: Component<{
  file: SharedFileEntry;
  onCopy: () => void;
  onRevoke: () => void;
  onLocate: () => void;
}> = (props) => {
  const expired = () => isExpired(props.file.shareExpiresAt);
  return (
    <li class="px-3.5 py-2.5 hover:bg-bg-hover">
      <div class="flex items-start gap-2.5">
        <button
          type="button"
          onClick={props.onLocate}
          class="shrink-0 mt-0.5"
          aria-label="定位到文件"
        >
          <FileIcon type={props.file.type} name={props.file.name} size="sm" rounded="md" />
        </button>
        <div class="flex-1 min-w-0">
          <button
            type="button"
            onClick={props.onLocate}
            class="block w-full text-left text-[13px] font-medium truncate hover:text-brand"
            title={props.file.name}
          >
            {props.file.name}
          </button>
          <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-fg-muted tabular flex-wrap">
            <span class="truncate">{props.file.folder === 'root' ? 'Home' : props.file.folder}</span>
            <span class="text-fg-subtle">·</span>
            <span>{formatBytes(props.file.size)}</span>
            <Show when={props.file.downloads > 0}>
              <span class="text-fg-subtle">·</span>
              <span>{props.file.downloads} 次下载</span>
            </Show>
          </div>
          <div class="flex items-center gap-1.5 mt-1 flex-wrap">
            <Show when={props.file.hasPassword}>
              <Badge tone="muted"><IconLock size={9} />密码</Badge>
            </Show>
            <Show when={props.file.shareExpiresAt && !expired()}>
              <Badge tone="muted">至 {formatAbsoluteDate(props.file.shareExpiresAt!)}</Badge>
            </Show>
            <Show when={expired()}>
              <Badge tone="danger"><IconWarning size={9} />已过期</Badge>
            </Show>
            <Show when={!props.file.shareExpiresAt}>
              <Badge tone="ok">长期有效</Badge>
            </Show>
          </div>
        </div>
        <div class="shrink-0 flex items-center gap-0.5">
          <IconButton label="复制链接" size="sm" onClick={props.onCopy}>
            <IconCopy size={13} />
          </IconButton>
          <IconButton label="撤销分享" size="sm" variant="danger" onClick={props.onRevoke}>
            <IconTrash size={13} />
          </IconButton>
          <IconButton label="定位" size="sm" onClick={props.onLocate}>
            <IconChevronRight size={14} />
          </IconButton>
        </div>
      </div>
    </li>
  );
};

const FolderLinkRow: Component<{
  link: FolderShareLinkEntry;
  onCopy: () => void;
  onRevoke: () => void;
  onLocate: () => void;
}> = (props) => {
  const expired = () => isExpired(props.link.expiresAt);
  return (
    <li class="px-3.5 py-2.5 hover:bg-bg-hover">
      <div class="flex items-start gap-2.5">
        <button type="button" onClick={props.onLocate} class="shrink-0 mt-0.5" aria-label="定位">
          <FileIcon asFolder size="sm" rounded="md" />
        </button>
        <div class="flex-1 min-w-0">
          <button
            type="button"
            onClick={props.onLocate}
            class="block w-full text-left text-[13px] font-medium truncate hover:text-brand"
            title={props.link.folder}
          >
            {folderName(props.link.folder)}
          </button>
          <div class="text-[11px] text-fg-muted truncate">{props.link.folder}</div>
          <div class="flex items-center gap-1.5 mt-1 flex-wrap">
            <Show when={props.link.hasPassword}>
              <Badge tone="muted"><IconLock size={9} />密码</Badge>
            </Show>
            <Show when={props.link.expiresAt && !expired()}>
              <Badge tone="muted">至 {formatAbsoluteDate(props.link.expiresAt!)}</Badge>
            </Show>
            <Show when={expired()}>
              <Badge tone="danger"><IconWarning size={9} />已过期</Badge>
            </Show>
            <Show when={!props.link.expiresAt}>
              <Badge tone="ok">长期有效</Badge>
            </Show>
          </div>
        </div>
        <div class="shrink-0 flex items-center gap-0.5">
          <IconButton label="复制链接" size="sm" onClick={props.onCopy}>
            <IconCopy size={13} />
          </IconButton>
          <IconButton label="撤销链接" size="sm" variant="danger" onClick={props.onRevoke}>
            <IconTrash size={13} />
          </IconButton>
          <IconButton label="定位" size="sm" onClick={props.onLocate}>
            <IconChevronRight size={14} />
          </IconButton>
        </div>
      </div>
    </li>
  );
};

const PublicFolderRow: Component<{
  folder: string;
  onUnshare: () => void;
  onLocate: () => void;
}> = (props) => (
  <li class="px-3.5 py-2.5 hover:bg-bg-hover">
    <div class="flex items-center gap-2.5">
      <button type="button" onClick={props.onLocate} class="shrink-0" aria-label="定位">
        <FileIcon asFolder size="sm" rounded="md" />
      </button>
      <div class="flex-1 min-w-0">
        <button
          type="button"
          onClick={props.onLocate}
          class="block w-full text-left text-[13px] font-medium truncate hover:text-brand"
          title={props.folder}
        >
          {folderName(props.folder)}
        </button>
        <div class="text-[11px] text-fg-muted truncate">{props.folder}</div>
      </div>
      <div class="shrink-0 flex items-center gap-0.5">
        <IconButton label="取消公开" size="sm" variant="danger" onClick={props.onUnshare}>
          <IconShare size={13} />
        </IconButton>
        <IconButton label="定位" size="sm" onClick={props.onLocate}>
          <IconChevronRight size={14} />
        </IconButton>
      </div>
    </div>
  </li>
);

const ExcludedFolderRow: Component<{ folder: string; onRestore: () => void }> = (props) => (
  <li class="px-3.5 py-2.5 hover:bg-bg-hover">
    <div class="flex items-center gap-2.5">
      <FileIcon asFolder size="sm" rounded="md" />
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-medium truncate" title={props.folder}>
          {folderName(props.folder)}
        </div>
        <div class="text-[11px] text-fg-muted truncate">{props.folder}</div>
      </div>
      <button
        type="button"
        onClick={props.onRestore}
        class="text-[11.5px] text-brand hover:underline px-2 h-7"
      >
        恢复
      </button>
    </div>
  </li>
);

const Badge: Component<{ tone: 'muted' | 'danger' | 'ok'; children: any }> = (props) => (
  <span
    class={cn(
      'inline-flex items-center gap-0.5 px-1.5 h-4 text-[10px] rounded',
      props.tone === 'muted' && 'bg-bg-hover text-fg-muted',
      props.tone === 'danger' && 'bg-danger/12 text-danger',
      props.tone === 'ok' && 'bg-ok/12 text-ok',
    )}
  >
    {props.children}
  </span>
);
