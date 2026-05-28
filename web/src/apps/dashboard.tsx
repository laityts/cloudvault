import { render } from 'solid-js/web';
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js';
import '~/styles/global.css';
import { bootstrapTheme, createTheme } from '~/stores/theme';
import { applyBrandingToDocument, readBranding } from '~/stores/branding';
import {
  BrandMark,
  Breadcrumb,
  Button,
  Dropdown,
  Drawer,
  EmptyState,
  IconArchive,
  IconAudio,
  IconCode,
  IconCopy,
  IconDownload,
  IconEdit,
  IconFile,
  IconFilter,
  IconFolderPlus,
  IconGrid,
  IconHome,
  IconImage,
  IconLink,
  IconList,
  IconLogout,
  IconMenu,
  IconMove,
  IconPdf,
  IconSearch,
  IconSettings,
  IconShare,
  IconTrash,
  IconUpload,
  IconVideo,
  IconButton,
  Input,
  Lightbox,
  type LightboxImage,
  type MenuItem,
  ResponsiveMenu,
  Spinner,
  ThemeToggle,
  ToastProvider,
  createContextMenu,
  useToast,
} from '~/ui';
import { logout, zipDownload } from '~/api';
import type { FileMeta } from '~/api/types';
import { formatBytes } from '~/lib/format';
import { createDashboardStore } from '~/features/dashboard/store';
import { FolderTree } from '~/features/dashboard/FolderTree';
import { FileGrid, FileTable } from '~/features/dashboard/FileViews';
import { FilePreviewDialog } from '~/features/dashboard/FilePreviewDialog';
import {
  ConfirmDialog,
  FolderShareLinkDialog,
  MoveDialog,
  NewFolderDialog,
  RenameDialog,
  SettingsDialog,
  ShareFileDialog,
} from '~/features/dashboard/Modals';
import { UploadManager, readDroppedEntries } from '~/features/upload/uploadManager';
import { UploadPanel } from '~/features/upload/UploadPanel';
import type { UploadItem } from '~/features/upload/uploadManager';
import { createIsDesktop } from '~/lib/media';
import { cn } from '~/lib/cn';

bootstrapTheme();

const TYPE_FILTERS: Array<{ v: ReturnType<typeof createDashboardStore>['typeFilter'] extends () => infer T ? T : never; label: string; icon: any }> = [
  { v: 'all' as any, label: '全部类型', icon: IconFile },
  { v: 'images' as any, label: '图片', icon: IconImage },
  { v: 'videos' as any, label: '视频', icon: IconVideo },
  { v: 'audio' as any, label: '音频', icon: IconAudio },
  { v: 'documents' as any, label: '文档', icon: IconPdf },
  { v: 'archives' as any, label: '压缩包', icon: IconArchive },
  { v: 'code' as any, label: '代码', icon: IconCode },
  { v: 'other' as any, label: '其他', icon: IconFile },
];

function DashboardApp() {
  const initialBranding = readBranding();
  const [branding, setBranding] = createSignal(initialBranding);
  applyBrandingToDocument(initialBranding);

  const { theme, toggle } = createTheme();
  const isDesktop = createIsDesktop();
  const toast = useToast();

  const store = createDashboardStore();

  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [showDropZone, setShowDropZone] = createSignal(false);
  const [previewFile, setPreviewFile] = createSignal<FileMeta | null>(null);

  // Lightbox state
  const [lightbox, setLightbox] = createSignal<{ open: boolean; index: number }>({ open: false, index: 0 });
  const lightboxImages = createMemo<LightboxImage[]>(() =>
    store.filteredFiles()
      .filter((f) => f.type?.startsWith('image/'))
      .map((f) => ({
        id: f.id,
        name: f.name,
        src: `/api/files/${f.id}/preview`,
        downloadUrl: f.shareToken ? `/s/${f.shareToken}/download` : `/api/files/${f.id}/download`,
      })),
  );

  // Modals
  const [newFolderOpen, setNewFolderOpen] = createSignal(false);
  const [renameTarget, setRenameTarget] = createSignal<{ kind: 'file' | 'folder'; id?: string; name: string } | null>(null);
  const [confirmState, setConfirmState] = createSignal<{ kind: 'files' | 'folder'; ids?: string[]; folder?: string } | null>(null);
  const [moveState, setMoveState] = createSignal<{ ids: string[] } | null>(null);
  const [shareFile, setShareFile] = createSignal<FileMeta | null>(null);
  const [folderShareLink, setFolderShareLink] = createSignal<string | null>(null);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // Context menus
  const fileMenu = createContextMenu<FileMeta>({ w: 220, h: 280 });
  const folderMenu = createContextMenu<{ name: string; directlyShared: boolean; excluded: boolean; shared: boolean }>({ w: 240, h: 320 });

  // Uploads
  const uploadManager = new UploadManager();
  const [uploads, setUploads] = createSignal<UploadItem[]>([]);
  const [showUploadPanel, setShowUploadPanel] = createSignal(false);

  onMount(() => {
    const unsub = uploadManager.subscribe((s) => {
      setUploads(s);
      if (s.length > 0) setShowUploadPanel(true);
    });
    onCleanup(unsub);

    const onComplete = () => {
      void store.refreshAll();
    };
    window.addEventListener('upload-complete', onComplete);
    onCleanup(() => window.removeEventListener('upload-complete', onComplete));

    // Drag-drop globally
    let counter = 0;
    const onEnter = (e: DragEvent) => {
      e.preventDefault();
      counter++;
      if (e.dataTransfer?.types?.includes('Files')) setShowDropZone(true);
    };
    const onLeave = (e: DragEvent) => {
      e.preventDefault();
      counter--;
      if (counter <= 0) {
        setShowDropZone(false);
        counter = 0;
      }
    };
    const onOver = (e: DragEvent) => e.preventDefault();
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      counter = 0;
      setShowDropZone(false);
      if (!e.dataTransfer) return;
      const entries = await readDroppedEntries(e.dataTransfer);
      const grouped: Record<string, File[]> = {};
      for (const { file, relativePath } of entries) {
        const folder = relativePath
          ? store.currentFolder() === 'root'
            ? relativePath.split('/')[0]
            : `${store.currentFolder()}/${relativePath.split('/')[0]}`
          : store.currentFolder();
        (grouped[folder] = grouped[folder] || []).push(file);
      }
      for (const [folder, files] of Object.entries(grouped)) {
        uploadManager.addFiles(files, folder);
      }
    };
    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('dragover', onOver);
    document.addEventListener('drop', onDrop);
    onCleanup(() => {
      document.removeEventListener('dragenter', onEnter);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('drop', onDrop);
    });

    // Keyboard shortcuts
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (e.key === 'Delete' && store.selected().size > 0) {
        e.preventDefault();
        setConfirmState({ kind: 'files', ids: Array.from(store.selected()) });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        store.selectAll();
      }
      if (e.key === 'Escape') {
        store.clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  const handleFileInput = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      uploadManager.addFiles(Array.from(input.files), store.currentFolder());
    }
    input.value = '';
  };

  const onPreviewFile = (f: FileMeta) => {
    if (f.type?.startsWith('image/')) {
      const idx = lightboxImages().findIndex((i) => i.id === f.id);
      setLightbox({ open: true, index: idx >= 0 ? idx : 0 });
    } else {
      setPreviewFile(f);
    }
  };

  const downloadFile = (f: FileMeta) => {
    const url = f.shareToken ? `/s/${f.shareToken}/download` : `/api/files/${f.id}/download`;
    window.open(url, '_blank');
  };

  const downloadZip = async () => {
    const ids = Array.from(store.selected());
    if (!ids.length) return;
    try {
      const blob = await zipDownload(ids);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cloudvault-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('打包下载完成');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打包失败');
    }
  };

  const fileMenuItems = (f: FileMeta): MenuItem[] => [
    { label: '分享', icon: <IconShare size={14} />, onClick: () => setShareFile(f) },
    { label: '下载', icon: <IconDownload size={14} />, onClick: () => downloadFile(f) },
    { label: '复制链接', icon: <IconCopy size={14} />, onClick: async () => {
        if (!f.shareToken) return toast.error('请先创建分享链接');
        try {
          await navigator.clipboard.writeText(`${window.location.origin}/s/${f.shareToken}`);
          toast.success('链接已复制');
        } catch {
          toast.error('复制失败');
        }
      }, disabled: !f.shareToken },
    { label: '移动到…', icon: <IconMove size={14} />, onClick: () => setMoveState({ ids: [f.id] }) },
    { label: '重命名', icon: <IconEdit size={14} />, onClick: () => setRenameTarget({ kind: 'file', id: f.id, name: f.name }) },
    { divider: true, label: '' },
    { label: '删除', icon: <IconTrash size={14} />, tone: 'danger', onClick: () => setConfirmState({ kind: 'files', ids: [f.id] }) },
  ];

  const folderMenuItems = (folder: { name: string; directlyShared: boolean; excluded: boolean; shared: boolean }): MenuItem[] => {
    const items: MenuItem[] = [];
    if (folder.excluded) {
      items.push({
        label: '加入访客分享',
        icon: <IconShare size={14} />,
        onClick: async () => {
          try {
            await store.toggleExclude(folder.name);
            toast.success('已加入分享');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : '操作失败');
          }
        },
      });
    } else if (folder.directlyShared) {
      items.push({
        label: '取消访客分享',
        icon: <IconShare size={14} />,
        onClick: async () => {
          try {
            await store.toggleShare(folder.name);
            toast.success('已取消分享');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : '操作失败');
          }
        },
      });
    } else if (folder.shared) {
      items.push({
        label: '从分享中排除',
        icon: <IconShare size={14} />,
        onClick: async () => {
          try {
            await store.toggleExclude(folder.name);
            toast.success('已排除');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : '操作失败');
          }
        },
      });
    } else {
      items.push({
        label: '加入访客分享',
        icon: <IconShare size={14} />,
        onClick: async () => {
          try {
            await store.toggleShare(folder.name);
            toast.success('已分享');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : '操作失败');
          }
        },
      });
    }
    items.push({
      label: '分享链接',
      icon: <IconLink size={14} />,
      onClick: () => setFolderShareLink(folder.name),
    });
    items.push({ divider: true, label: '' });
    items.push({
      label: '重命名文件夹',
      icon: <IconEdit size={14} />,
      onClick: () => setRenameTarget({ kind: 'folder', name: folder.name }),
    });
    items.push({
      label: '删除文件夹',
      icon: <IconTrash size={14} />,
      tone: 'danger',
      onClick: () => setConfirmState({ kind: 'folder', folder: folder.name }),
    });
    return items;
  };

  // Breadcrumb
  const breadcrumbItems = createMemo(() =>
    store.currentFolder() === 'root'
      ? []
      : store.currentFolder().split('/').map((p, i, arr) => ({
          label: p,
          onClick: () => store.setCurrentFolder(arr.slice(0, i + 1).join('/')),
        })),
  );

  const typeFilterLabel = createMemo(() => {
    const v = store.typeFilter();
    return TYPE_FILTERS.find((t) => t.v === v)?.label ?? '全部';
  });

  // Update doc title once branding is settled
  createEffect(() => {
    applyBrandingToDocument(branding());
  });

  return (
    <div class="min-h-dvh flex flex-col bg-bg-base">
      {/* HEADER */}
      <header class="sticky top-0 z-40 border-b hairline bg-bg-base/85 backdrop-blur-md safe-pt">
        <div class="flex items-center gap-2 h-13 px-3 sm:px-4">
          <Show when={!isDesktop()}>
            <IconButton label="Menu" onClick={() => setSidebarOpen(true)} size="md">
              <IconMenu size={18} />
            </IconButton>
          </Show>
          <BrandMark branding={branding()} size="sm" class="min-w-0" />
          <span class="hidden md:inline text-fg-subtle text-[12px] mx-2">·</span>
          <span class="hidden md:inline text-[12px] text-fg-muted tabular">
            {store.stats()?.totalFiles ?? 0} 个文件 · {formatBytes(store.stats()?.totalSize ?? 0)}
          </span>

          <div class="flex-1" />

          <ThemeToggle theme={theme()} onToggle={toggle} size="md" />
          <IconButton label="Settings" onClick={() => setSettingsOpen(true)} size="md">
            <IconSettings size={16} />
          </IconButton>
          <IconButton label="Logout" onClick={() => void logout()} size="md">
            <IconLogout size={16} />
          </IconButton>
        </div>
      </header>

      <div class="flex-1 flex min-h-0">
        {/* SIDEBAR — desktop */}
        <Show when={isDesktop()}>
          <aside class="w-60 shrink-0 border-r hairline overflow-y-auto bg-bg-base/40">
            <div class="px-2 py-3">
              <FolderTree
                store={store}
                onContextMenu={(e, folderPath) => {
                  const folder = store.folders()?.folders.find((f) => f.name === folderPath);
                  if (folder) folderMenu.open(e, folder);
                }}
              />
            </div>
            <div class="mt-4 px-4 pb-4 border-t hairline pt-4">
              <p class="text-[11px] text-fg-subtle uppercase tracking-wide mb-1.5">存储</p>
              <div class="h-1.5 rounded-full bg-bg-hover overflow-hidden">
                <div
                  class="h-full bg-brand"
                  style={{
                    width: `${Math.min(((store.stats()?.totalSize ?? 0) / (10 * 1024 * 1024 * 1024)) * 100, 100)}%`,
                  }}
                />
              </div>
              <p class="text-[11px] text-fg-muted mt-1.5 tabular">
                {formatBytes(store.stats()?.totalSize ?? 0)} 已用
              </p>
            </div>
          </aside>
        </Show>

        {/* MAIN */}
        <main class="flex-1 flex flex-col min-w-0">
          {/* Action bar */}
          <div class="flex items-center gap-2 px-3 sm:px-4 py-2.5 border-b hairline overflow-x-auto">
            <Breadcrumb
              class="mr-auto"
              rootIcon={<IconHome size={13} />}
              rootLabel="Home"
              onRoot={() => store.setCurrentFolder('root')}
              items={breadcrumbItems()}
            />
            <div class="hidden md:block w-44 lg:w-64">
              <Input
                type="search"
                size="sm"
                placeholder="搜索文件…"
                value={store.search()}
                onInput={(e) => {
                  const v = e.currentTarget.value;
                  setTimeout(() => store.setSearch(v), 0);
                }}
                leadingIcon={<IconSearch size={13} />}
              />
            </div>
            <Dropdown
              align="end"
              label={
                <span class="inline-flex items-center gap-1.5">
                  <IconFilter size={12} />
                  <span class="hidden sm:inline">{typeFilterLabel()}</span>
                </span>
              }
              items={TYPE_FILTERS.map((t) => ({
                label: t.label,
                icon: <t.icon size={14} />,
                onClick: () => store.setTypeFilter(t.v as any),
              }))}
            />
            <IconButton
              label={`切换到${store.view() === 'grid' ? '列表' : '网格'}`}
              size="sm"
              onClick={() => store.setView(store.view() === 'grid' ? 'list' : 'grid')}
            >
              {store.view() === 'grid' ? <IconList size={14} /> : <IconGrid size={14} />}
            </IconButton>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<IconFolderPlus size={13} />}
              onClick={() => setNewFolderOpen(true)}
            >
              <span class="hidden sm:inline">新建文件夹</span>
            </Button>
            <label class="inline-flex">
              <Button variant="primary" size="sm" leadingIcon={<IconUpload size={13} />}>
                <span class="hidden sm:inline">上传</span>
              </Button>
              <input type="file" multiple class="sr-only" onChange={handleFileInput} />
            </label>
          </div>

          {/* Mobile search */}
          <div class="md:hidden px-3 pt-3">
            <Input
              type="search"
              size="md"
              placeholder="搜索文件…"
              value={store.search()}
              onInput={(e) => store.setSearch(e.currentTarget.value)}
              leadingIcon={<IconSearch size={14} />}
            />
          </div>

          {/* Bulk action bar */}
          <Show when={store.selected().size > 0}>
            <div class="flex items-center gap-2 px-3 sm:px-4 py-2 bg-brand-soft border-b border-brand/20 text-[13px]">
              <span class="font-medium text-brand tabular">已选 {store.selected().size} 项</span>
              <span class="flex-1" />
              <Button variant="ghost" size="xs" onClick={() => store.clearSelection()}>
                取消
              </Button>
              <Button variant="ghost" size="xs" leadingIcon={<IconDownload size={12} />} onClick={downloadZip}>
                <span class="hidden sm:inline">打包下载</span>
              </Button>
              <Button
                variant="ghost"
                size="xs"
                leadingIcon={<IconMove size={12} />}
                onClick={() => setMoveState({ ids: Array.from(store.selected()) })}
              >
                <span class="hidden sm:inline">移动</span>
              </Button>
              <Button
                variant="danger"
                size="xs"
                leadingIcon={<IconTrash size={12} />}
                onClick={() =>
                  setConfirmState({ kind: 'files', ids: Array.from(store.selected()) })
                }
              >
                删除
              </Button>
            </div>
          </Show>

          {/* Content */}
          <div class="flex-1 overflow-y-auto p-3 sm:p-4 pb-24 md:pb-4">
            <Show
              when={!store.files.loading}
              fallback={
                <div class="flex items-center justify-center py-24">
                  <Spinner size={20} />
                </div>
              }
            >
              <Show
                when={store.filteredFiles().length > 0 || store.currentSubfolders().length > 0}
                fallback={
                  <EmptyState
                    icon={<IconFile size={36} />}
                    title="此处暂无文件"
                    description="拖拽文件到此处，或点击右上角「上传」"
                  />
                }
              >
                <Show
                  when={store.view() === 'grid'}
                  fallback={
                    <FileTable
                      files={store.filteredFiles()}
                      subfolders={store.currentSubfolders()}
                      store={store}
                      onPreview={onPreviewFile}
                      onMore={(e, f) => fileMenu.open(e, f)}
                      onFolderMore={(e, folder) => folderMenu.open(e, folder)}
                    />
                  }
                >
                  <FileGrid
                    files={store.filteredFiles()}
                    subfolders={store.currentSubfolders()}
                    store={store}
                    onPreview={onPreviewFile}
                    onMore={(e, f) => fileMenu.open(e, f)}
                    onFolderMore={(e, folder) => folderMenu.open(e, folder)}
                  />
                </Show>
              </Show>
            </Show>
          </div>
        </main>
      </div>

      {/* Mobile FAB upload */}
      <Show when={!isDesktop()}>
        <label class="fixed bottom-5 right-4 z-30">
          <span
            class={cn(
              'inline-flex items-center justify-center h-14 w-14 rounded-full bg-brand text-fg-onAccent shadow-float',
              'active:scale-95 transition-transform',
            )}
          >
            <IconUpload size={20} />
          </span>
          <input type="file" multiple class="sr-only" onChange={handleFileInput} />
        </label>
      </Show>

      {/* Dropzone overlay */}
      <Show when={showDropZone()}>
        <div class="fixed inset-0 z-[9000] pointer-events-none flex items-center justify-center bg-bg-base/85 backdrop-blur-sm">
          <div class="rounded-2xl border-2 border-dashed border-brand bg-brand-soft px-12 py-10 text-center">
            <IconUpload size={36} class="mx-auto text-brand mb-3" />
            <p class="text-base font-semibold text-brand">松开以上传到</p>
            <p class="mt-1 text-[13px] text-fg-muted">
              {store.currentFolder() === 'root' ? 'Home' : store.currentFolder()}
            </p>
          </div>
        </div>
      </Show>

      {/* Sidebar drawer (mobile) */}
      <Drawer open={sidebarOpen()} onClose={() => setSidebarOpen(false)} side="left" width="min(76vw, 240px)">
        <div class="px-2 py-3 overflow-y-auto safe-pb">
          <FolderTree
            store={store}
            onContextMenu={(e, folderPath) => {
              const folder = store.folders()?.folders.find((f) => f.name === folderPath);
              if (folder) folderMenu.open(e, folder);
            }}
          />
        </div>
      </Drawer>

      {/* Context menus */}
      <ResponsiveMenu
        open={fileMenu.state().open}
        x={fileMenu.state().x}
        y={fileMenu.state().y}
        items={fileMenu.state().target ? fileMenuItems(fileMenu.state().target!) : []}
        onClose={fileMenu.close}
        title={fileMenu.state().target?.name}
      />
      <ResponsiveMenu
        open={folderMenu.state().open}
        x={folderMenu.state().x}
        y={folderMenu.state().y}
        items={folderMenu.state().target ? folderMenuItems(folderMenu.state().target!) : []}
        onClose={folderMenu.close}
        title={folderMenu.state().target?.name}
      />

      {/* Modals */}
      <NewFolderDialog
        open={newFolderOpen()}
        onClose={() => setNewFolderOpen(false)}
        onCreate={async (n) => {
          try {
            await store.createFolder(n);
            toast.success('文件夹已创建');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : '创建失败');
            throw e;
          }
        }}
      />
      <RenameDialog
        open={!!renameTarget()}
        onClose={() => setRenameTarget(null)}
        current={renameTarget()?.name ?? ''}
        title={renameTarget()?.kind === 'folder' ? '重命名文件夹' : '重命名文件'}
        onConfirm={async (name) => {
          const t = renameTarget();
          if (!t) return;
          try {
            if (t.kind === 'file') {
              await store.renameFile(t.id!, name);
            } else {
              const parent = t.name.includes('/') ? t.name.slice(0, t.name.lastIndexOf('/')) : '';
              const fullNew = parent ? `${parent}/${name}` : name;
              await store.renameFolder(t.name, fullNew);
            }
            toast.success('已重命名');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : '重命名失败');
            throw e;
          }
        }}
      />
      <ConfirmDialog
        open={!!confirmState()}
        onClose={() => setConfirmState(null)}
        title={confirmState()?.kind === 'folder' ? '删除文件夹' : '删除文件'}
        description={
          confirmState()?.kind === 'folder'
            ? `将删除文件夹 “${confirmState()?.folder}” 及其全部子文件。此操作不可撤销。`
            : `确认删除已选中的 ${confirmState()?.ids?.length ?? 0} 个文件？此操作不可撤销。`
        }
        variant="danger"
        confirmLabel="删除"
        onConfirm={async () => {
          const c = confirmState();
          if (!c) return;
          try {
            if (c.kind === 'folder' && c.folder) {
              const r = await store.deleteFolder(c.folder);
              const parts = [];
              if (r.deletedFiles > 0) parts.push(`${r.deletedFiles} 个文件`);
              if (r.deletedSubfolders > 0) parts.push(`${r.deletedSubfolders} 个子文件夹`);
              toast.success(parts.length ? `文件夹已删除 — 移除 ${parts.join(' · ')}` : '文件夹已删除');
            } else if (c.kind === 'files' && c.ids?.length) {
              await store.deleteFiles(c.ids);
              toast.success(`已删除 ${c.ids.length} 个文件`);
            }
          } catch (e) {
            toast.error(e instanceof Error ? e.message : '删除失败');
            throw e;
          }
        }}
      />
      <MoveDialog
        open={!!moveState()}
        onClose={() => setMoveState(null)}
        fileIds={moveState()?.ids ?? []}
        folders={(store.folders()?.folders ?? []).map((f) => ({ name: f.name }))}
        onMove={async (ids, target) => {
          try {
            const moved = await store.moveFiles(ids, target);
            toast.success(`已移动 ${moved} 个文件`);
            return moved;
          } catch (e) {
            toast.error(e instanceof Error ? e.message : '移动失败');
            throw e;
          }
        }}
      />
      <ShareFileDialog
        file={shareFile()}
        onClose={() => setShareFile(null)}
        onChange={() => store.refreshFiles()}
      />
      <FolderShareLinkDialog folder={folderShareLink()} onClose={() => setFolderShareLink(null)} />
      <SettingsDialog
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => {
          setBranding({ siteName: s.siteName, siteIconUrl: s.siteIconUrl });
        }}
      />

      {/* Preview / Lightbox */}
      <FilePreviewDialog file={previewFile()} onClose={() => setPreviewFile(null)} />
      <Lightbox
        open={lightbox().open}
        images={lightboxImages()}
        index={lightbox().index}
        onIndexChange={(i) => setLightbox({ open: true, index: i })}
        onClose={() => setLightbox({ open: false, index: 0 })}
      />

      {/* Upload panel */}
      <Show when={uploads().length > 0 && showUploadPanel()}>
        <UploadPanel
          items={uploads()}
          onClear={() => uploadManager.clearCompleted()}
          onClose={() => setShowUploadPanel(false)}
        />
      </Show>
    </div>
  );
}

render(
  () => (
    <ToastProvider>
      <DashboardApp />
    </ToastProvider>
  ),
  document.getElementById('app')!,
);
