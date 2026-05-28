import { render } from 'solid-js/web';
import { Show, For, createMemo, createResource, createSignal } from 'solid-js';
import '~/styles/global.css';
import { bootstrapTheme, createTheme } from '~/stores/theme';
import { applyBrandingToDocument, readBranding } from '~/stores/branding';
import { browsePublicFolder, listPublicShared } from '~/api';
import type { PublicFile } from '~/api/types';
import {
  BrandMark,
  Breadcrumb,
  Button,
  EmptyState,
  FileIcon,
  IconChevronRight,
  IconChevronUp,
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconFolder,
  IconHome,
  IconSearch,
  Input,
  Spinner,
  ThemeToggle,
  ToastProvider,
  useToast,
} from '~/ui';
import { formatAbsoluteDate, formatBytes } from '~/lib/format';

bootstrapTheme();

type SortKey = 'name' | 'size' | 'date';

function GuestApp() {
  const branding = readBranding();
  applyBrandingToDocument(branding, '公开分享');
  const { theme, toggle } = createTheme();
  const toast = useToast();

  const [path, setPath] = createSignal('');
  const [search, setSearch] = createSignal('');
  const [sortKey, setSortKey] = createSignal<SortKey>('name');
  const [sortAsc, setSortAsc] = createSignal(true);
  const [showLogin, setShowLogin] = createSignal(false);

  const [data] = createResource(path, async (p) => {
    if (!p) {
      const r = await listPublicShared();
      if (r.settings?.showLoginButton) setShowLogin(true);
      if (r.settings?.siteName) {
        applyBrandingToDocument({ siteName: r.settings.siteName, siteIconUrl: r.settings.siteIconUrl }, '公开分享');
      }
      return { folders: r.sharedFolders, files: r.files };
    }
    const r = await browsePublicFolder(p);
    return { folders: r.subfolders, files: r.files };
  });

  const filteredFolders = createMemo(() => {
    const folders = data()?.folders ?? [];
    const q = search().trim().toLowerCase();
    if (!q) return folders;
    return folders.filter((f) => f.split('/').pop()?.toLowerCase().includes(q));
  });

  const filteredFiles = createMemo(() => {
    const files = (data()?.files ?? []).slice();
    const q = search().trim().toLowerCase();
    const filtered = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;
    const k = sortKey();
    const asc = sortAsc();
    return filtered.sort((a, b) => {
      let v: number;
      if (k === 'size') v = a.size - b.size;
      else if (k === 'date') v = a.uploadedAt.localeCompare(b.uploadedAt);
      else v = a.name.localeCompare(b.name);
      return asc ? v : -v;
    });
  });

  const segments = createMemo(() => (path() ? path().split('/') : []));

  const navigateTo = (p: string) => {
    setPath(p);
    setSearch('');
  };

  const downloadUrl = (f: PublicFile): string =>
    f.token ? `/s/${f.token}` : `/${encodeURI(`${f.folder}/${f.name}`)}`;

  const copyLink = async (f: PublicFile) => {
    try {
      await navigator.clipboard.writeText(window.location.origin + downloadUrl(f));
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  const toggleSort = (k: SortKey) => {
    if (sortKey() === k) setSortAsc(!sortAsc());
    else {
      setSortKey(k);
      setSortAsc(k !== 'date');
    }
  };

  return (
    <div class="min-h-dvh flex flex-col bg-bg-base">
      <header class="border-b hairline px-4 sm:px-6 py-3 safe-pt">
        <div class="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <BrandMark branding={branding} size="sm" />
          <div class="flex items-center gap-1.5">
            <ThemeToggle theme={theme()} onToggle={toggle} size="sm" />
            <Show when={showLogin()}>
              <a href="/login">
                <Button variant="outline" size="sm">
                  登录
                </Button>
              </a>
            </Show>
          </div>
        </div>
      </header>

      <main class="flex-1 px-4 sm:px-6 py-5">
        <div class="max-w-5xl mx-auto">
          <Breadcrumb
            class="mb-4"
            rootIcon={<IconHome size={13} />}
            rootLabel="首页"
            onRoot={() => navigateTo('')}
            items={segments().map((seg, idx) => ({
              label: seg,
              onClick: () => navigateTo(segments().slice(0, idx + 1).join('/')),
            }))}
          />

          <Show
            when={!data.loading}
            fallback={
              <div class="flex items-center justify-center py-24">
                <Spinner size={20} />
              </div>
            }
          >
            <Show
              when={(filteredFolders().length + filteredFiles().length + (data()?.folders?.length ?? 0) + (data()?.files?.length ?? 0)) > 0}
              fallback={
                <EmptyState
                  icon={<IconFolder size={32} />}
                  title="暂无公开内容"
                  description="所有者还未公开分享任何文件"
                />
              }
            >
              <Show when={(data()?.folders?.length ?? 0) + (data()?.files?.length ?? 0) > 0}>
                <div class="mb-4 flex items-center gap-3">
                  <div class="relative flex-1 max-w-xs">
                    <Input
                      type="search"
                      placeholder="搜索文件…"
                      leadingIcon={<IconSearch size={14} />}
                      value={search()}
                      onInput={(e) => setSearch(e.currentTarget.value)}
                    />
                  </div>
                  <span class="text-[12px] text-fg-muted hidden sm:inline tabular">
                    {filteredFiles().length} 个文件
                    <Show when={filteredFolders().length > 0}>
                      <span class="mx-2 text-fg-subtle">·</span>
                      {filteredFolders().length} 个文件夹
                    </Show>
                  </span>
                </div>

                {/* Desktop table */}
                <div class="hidden md:block surface border hairline rounded-xl overflow-hidden">
                  <div class="grid grid-cols-[minmax(0,1fr)_104px_140px_120px] items-center px-4 py-2 text-[11px] uppercase tracking-wide text-fg-subtle bg-bg-inset/40 border-b hairline">
                    <SortHeader label="名称" k="name" current={sortKey()} asc={sortAsc()} onClick={() => toggleSort('name')} />
                    <SortHeader
                      label="大小"
                      k="size"
                      current={sortKey()}
                      asc={sortAsc()}
                      onClick={() => toggleSort('size')}
                      align="end"
                    />
                    <SortHeader
                      label="加入时间"
                      k="date"
                      current={sortKey()}
                      asc={sortAsc()}
                      onClick={() => toggleSort('date')}
                      align="end"
                    />
                    <span />
                  </div>
                  <ul class="divide-y hairline divide-line">
                    <For each={filteredFolders()}>
                      {(f) => (
                        <li
                          onClick={() => navigateTo(f)}
                          class="grid grid-cols-[minmax(0,1fr)_104px_140px_120px] items-center px-4 py-3 cursor-pointer hover:bg-bg-hover transition-colors"
                        >
                          <div class="flex items-center gap-3 min-w-0">
                            <FileIcon asFolder size="sm" rounded="md" />
                            <span class="truncate text-[14px]">{f.split('/').pop()}</span>
                          </div>
                          <span class="text-right text-[12px] text-fg-muted">文件夹</span>
                          <span />
                          <span class="flex justify-end">
                            <IconChevronRight size={14} class="text-fg-subtle" />
                          </span>
                        </li>
                      )}
                    </For>
                    <For each={filteredFiles()}>
                      {(file) => (
                        <li class="grid grid-cols-[minmax(0,1fr)_104px_140px_120px] items-center px-4 py-3 hover:bg-bg-hover transition-colors group">
                          <div class="flex items-center gap-3 min-w-0">
                            <FileIcon type={file.type} name={file.name} size="sm" rounded="md" />
                            <span class="truncate text-[14px]" title={file.name}>
                              {file.name}
                            </span>
                          </div>
                          <span class="text-right text-[12px] text-fg-muted tabular">{formatBytes(file.size)}</span>
                          <span class="text-right text-[12px] text-fg-muted">{formatAbsoluteDate(file.uploadedAt)}</span>
                          <span class="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={() => copyLink(file)}
                              class="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                              aria-label="Copy link"
                            >
                              <IconCopy size={14} />
                            </button>
                            <a
                              href={downloadUrl(file)}
                              target="_blank"
                              rel="noopener"
                              class="inline-flex h-8 px-2.5 items-center justify-center gap-1.5 rounded-md text-[12px] text-brand border border-brand/40 hover:bg-brand-soft transition-colors"
                            >
                              <IconDownload size={13} />
                              下载
                            </a>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>

                {/* Mobile card list */}
                <ul class="md:hidden space-y-2">
                  <For each={filteredFolders()}>
                    {(f) => (
                      <li
                        onClick={() => navigateTo(f)}
                        class="surface border hairline rounded-lg px-3 py-3 flex items-center gap-3 active:bg-bg-hover"
                      >
                        <FileIcon asFolder size="md" rounded="md" />
                        <div class="flex-1 min-w-0">
                          <div class="text-[14px] truncate">{f.split('/').pop()}</div>
                          <div class="text-[11px] text-fg-muted">文件夹</div>
                        </div>
                        <IconChevronRight size={16} class="text-fg-subtle" />
                      </li>
                    )}
                  </For>
                  <For each={filteredFiles()}>
                    {(file) => (
                      <li class="surface border hairline rounded-lg px-3 py-3 flex items-center gap-3">
                        <FileIcon type={file.type} name={file.name} size="md" rounded="md" />
                        <div class="flex-1 min-w-0">
                          <div class="text-[14px] truncate">{file.name}</div>
                          <div class="text-[11px] text-fg-muted tabular">{formatBytes(file.size)} · {formatAbsoluteDate(file.uploadedAt)}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => copyLink(file)}
                          class="tap inline-flex items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                          aria-label="Copy link"
                        >
                          <IconCopy size={16} />
                        </button>
                        <a
                          href={downloadUrl(file)}
                          target="_blank"
                          rel="noopener"
                          class="tap inline-flex items-center justify-center rounded-md bg-brand-soft text-brand"
                          aria-label="Download"
                        >
                          <IconDownload size={16} />
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <Show when={search() && filteredFiles().length === 0 && filteredFolders().length === 0}>
                <EmptyState
                  icon={<IconSearch size={28} />}
                  title="未找到匹配项"
                  description={`没有匹配 "${search()}" 的文件`}
                />
              </Show>
            </Show>
          </Show>
        </div>
      </main>

      <footer class="px-4 py-4 text-center text-[11px] text-fg-subtle safe-pb">
        Powered by{' '}
        <a
          href="https://github.com/zqs1qiwan/cloudvault"
          target="_blank"
          rel="noopener"
          class="underline underline-offset-2 hover:text-fg-muted"
        >
          CloudVault
        </a>
      </footer>
    </div>
  );
}

function SortHeader(props: {
  label: string;
  k: SortKey;
  current: SortKey;
  asc: boolean;
  onClick: () => void;
  align?: 'start' | 'end';
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`inline-flex items-center gap-1 select-none ${props.align === 'end' ? 'justify-end' : ''} ${
        props.current === props.k ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
      }`}
    >
      <span>{props.label}</span>
      <Show when={props.current === props.k}>
        {props.asc ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
      </Show>
    </button>
  );
}

render(
  () => (
    <ToastProvider>
      <GuestApp />
    </ToastProvider>
  ),
  document.getElementById('app')!,
);
