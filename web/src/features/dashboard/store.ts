import { batch, createMemo, createResource, createSignal, type Resource } from 'solid-js';
import {
  createFolder as apiCreateFolder,
  deleteFiles as apiDeleteFiles,
  deleteFolder as apiDeleteFolder,
  listFiles,
  listFolders,
  moveFiles as apiMoveFiles,
  renameFile as apiRenameFile,
  renameFolder as apiRenameFolder,
  toggleFolderExclude,
  toggleFolderShare,
  getStats,
} from '~/api';
import type { FileMeta, FolderInfo, StatsResponse } from '~/api/types';
import { filterCategory, type FilterCategory } from '~/lib/fileKind';
import { joinPath } from '~/lib/format';

export type ViewMode = 'grid' | 'list';
export type SortKey = 'name' | 'size' | 'type' | 'date';

const VIEW_KEY = 'cv-view';

export interface FolderNode {
  name: string;
  path: string;
  shared: boolean;
  directlyShared: boolean;
  excluded: boolean;
  children: FolderNode[];
}

export interface DashboardStore {
  files: Resource<{ files: FileMeta[] }>;
  folders: Resource<{ folders: FolderInfo[] }>;
  stats: Resource<StatsResponse>;

  currentFolder: () => string;
  setCurrentFolder: (folder: string) => void;

  search: () => string;
  setSearch: (q: string) => void;

  view: () => ViewMode;
  setView: (v: ViewMode) => void;

  sortKey: () => SortKey;
  sortDir: () => 'asc' | 'desc';
  toggleSort: (k: SortKey) => void;

  typeFilter: () => FilterCategory;
  setTypeFilter: (c: FilterCategory) => void;

  selected: () => Set<string>;
  isSelected: (id: string) => boolean;
  toggleSelect: (id: string) => void;
  selectRange: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;

  expandedFolders: () => Record<string, boolean>;
  toggleExpand: (path: string) => void;
  expandPath: (path: string) => void;

  filteredFiles: () => FileMeta[];
  folderTree: () => FolderNode[];
  /** Direct child folders of the current folder (one level deep, sorted by name). */
  currentSubfolders: () => FolderInfo[];

  // mutations
  refreshAll: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  refreshFolders: () => Promise<void>;

  createFolder: (name: string) => Promise<void>;
  deleteFolder: (folder: string) => Promise<{ deletedFiles: number; deletedSubfolders: number }>;
  renameFolder: (oldName: string, newName: string) => Promise<void>;

  deleteSelectedFiles: () => Promise<void>;
  deleteFiles: (ids: string[]) => Promise<void>;
  renameFile: (id: string, name: string) => Promise<void>;
  moveFiles: (ids: string[], targetFolder: string) => Promise<number>;

  toggleShare: (folder: string) => Promise<{ shared: boolean }>;
  toggleExclude: (folder: string) => Promise<{ excluded: boolean }>;

  patchFile: (id: string, partial: Partial<FileMeta>) => void;
}

export function createDashboardStore(): DashboardStore {
  const [currentFolder, setCurrentFolderInternal] = createSignal<string>('root');
  const [search, setSearch] = createSignal('');
  const [view, setViewSignal] = createSignal<ViewMode>(
    (typeof localStorage !== 'undefined' && (localStorage.getItem(VIEW_KEY) as ViewMode)) || 'grid',
  );
  const [sortKey, setSortKey] = createSignal<SortKey>('date');
  const [sortDir, setSortDir] = createSignal<'asc' | 'desc'>('desc');
  const [typeFilter, setTypeFilter] = createSignal<FilterCategory>('all');
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = createSignal<Record<string, boolean>>({ __root__: true });

  const setView = (v: ViewMode) => {
    setViewSignal(v);
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEW_KEY, v);
  };

  const fileQuery = createMemo(() => ({ folder: currentFolder(), search: search() }));
  const [files, { refetch: refetchFiles }] = createResource(
    fileQuery,
    async (q) => listFiles({ folder: q.folder, search: q.search }),
    { initialValue: { files: [] } as { files: FileMeta[] } },
  );

  const [folders, { refetch: refetchFolders }] = createResource(async () => listFolders(), {
    initialValue: { folders: [] } as { folders: FolderInfo[] },
  });

  const [stats, { refetch: refetchStats }] = createResource(async () => getStats(), {
    initialValue: { totalFiles: 0, totalSize: 0, totalDownloads: 0, recentUploads: [], topDownloaded: [] } as StatsResponse,
  });

  const folderTree = createMemo<FolderNode[]>(() => {
    const list = folders()?.folders ?? [];
    const root: FolderNode[] = [];
    const map = new Map<string, FolderNode>();
    for (const folder of list) {
      const parts = folder.name.split('/');
      let path = '';
      let level = root;
      for (let i = 0; i < parts.length; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        if (!map.has(path)) {
          const fd = list.find((f) => f.name === path);
          const node: FolderNode = {
            name: parts[i],
            path,
            shared: fd?.shared ?? false,
            directlyShared: fd?.directlyShared ?? false,
            excluded: fd?.excluded ?? false,
            children: [],
          };
          map.set(path, node);
          level.push(node);
        }
        level = map.get(path)!.children;
      }
    }
    return root;
  });

  const filteredFiles = createMemo(() => {
    let list = files()?.files?.slice() ?? [];
    if (typeFilter() !== 'all') {
      list = list.filter((f) => filterCategory(f.type, f.name) === typeFilter());
    }
    const k = sortKey();
    const dir = sortDir() === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let v: number;
      if (k === 'name') v = a.name.localeCompare(b.name);
      else if (k === 'size') v = a.size - b.size;
      else if (k === 'type') v = filterCategory(a.type, a.name).localeCompare(filterCategory(b.type, b.name));
      else v = a.uploadedAt.localeCompare(b.uploadedAt);
      return v * dir;
    });
    return list;
  });

  const currentSubfolders = createMemo<FolderInfo[]>(() => {
    const list = folders()?.folders ?? [];
    const cur = currentFolder();
    const q = search().trim().toLowerCase();
    const result = list.filter((f) => {
      if (!f.name) return false;
      if (cur === 'root') return !f.name.includes('/');
      const prefix = `${cur}/`;
      if (!f.name.startsWith(prefix)) return false;
      return !f.name.slice(prefix.length).includes('/');
    });
    const filtered = q
      ? result.filter((f) => (f.name.split('/').pop() ?? '').toLowerCase().includes(q))
      : result;
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  });

  const setCurrentFolder = (folder: string) => {
    if (folder === currentFolder()) return;
    batch(() => {
      setCurrentFolderInternal(folder);
      setSearch('');
      setSelected(new Set<string>());
      if (folder !== 'root') {
        const parts = folder.split('/');
        let path = '';
        const next: Record<string, boolean> = { ...expandedFolders() };
        for (const part of parts) {
          path = path ? `${path}/${part}` : part;
          next[path] = true;
        }
        setExpandedFolders(next);
      }
    });
  };

  const toggleSort = (k: SortKey) => {
    if (sortKey() === k) setSortDir(sortDir() === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'name' ? 'asc' : 'desc');
    }
  };

  const isSelected = (id: string) => selected().has(id);
  const toggleSelect = (id: string) => {
    const next = new Set(selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const selectRange = (id: string) => {
    const ids = filteredFiles().map((f) => f.id);
    const cur = selected();
    if (cur.size === 0) {
      setSelected(new Set([id]));
      return;
    }
    const last = Array.from(cur).pop()!;
    const a = ids.indexOf(last);
    const b = ids.indexOf(id);
    if (a < 0 || b < 0) {
      toggleSelect(id);
      return;
    }
    const [s, e] = a < b ? [a, b] : [b, a];
    const next = new Set(cur);
    for (let i = s; i <= e; i++) next.add(ids[i]);
    setSelected(next);
  };
  const selectAll = () => setSelected(new Set<string>(filteredFiles().map((f) => f.id)));
  const clearSelection = () => setSelected(new Set<string>());

  const toggleExpand = (path: string) => {
    const next = { ...expandedFolders() };
    if (next[path]) delete next[path];
    else next[path] = true;
    setExpandedFolders(next);
  };
  const expandPath = (path: string) => {
    const parts = path.split('/');
    let p = '';
    const next: Record<string, boolean> = { ...expandedFolders() };
    for (const part of parts) {
      p = p ? `${p}/${part}` : part;
      next[p] = true;
    }
    setExpandedFolders(next);
  };

  const refreshFiles = async () => {
    await refetchFiles();
  };
  const refreshFolders = async () => {
    await refetchFolders();
  };
  const refreshAll = async () => {
    await Promise.all([refetchFiles(), refetchFolders(), refetchStats()]);
  };

  const createFolder = async (name: string) => {
    if (!name.trim()) return;
    await apiCreateFolder(name.trim(), currentFolder());
    expandPath(joinPath(currentFolder(), name.trim()));
    await Promise.all([refetchFolders(), refetchFiles()]);
  };

  const deleteFolder = async (folder: string) => {
    const res = await apiDeleteFolder(folder);
    if (currentFolder() === folder || currentFolder().startsWith(`${folder}/`)) {
      setCurrentFolder('root');
    }
    await Promise.all([refetchFolders(), refetchFiles(), refetchStats()]);
    return res;
  };

  const renameFolder = async (oldName: string, newName: string) => {
    await apiRenameFolder(oldName, newName);
    if (currentFolder() === oldName || currentFolder().startsWith(`${oldName}/`)) {
      setCurrentFolderInternal(newName + currentFolder().slice(oldName.length));
    }
    await Promise.all([refetchFolders(), refetchFiles()]);
  };

  const deleteFiles = async (ids: string[]) => {
    if (!ids.length) return;
    await apiDeleteFiles(ids);
    clearSelection();
    await Promise.all([refetchFiles(), refetchStats()]);
  };
  const deleteSelectedFiles = async () => {
    await deleteFiles(Array.from(selected()));
  };

  const renameFile = async (id: string, name: string) => {
    await apiRenameFile(id, name.trim());
    await refetchFiles();
  };

  const moveFiles = async (ids: string[], targetFolder: string) => {
    const res = await apiMoveFiles(ids, targetFolder);
    clearSelection();
    await Promise.all([refetchFiles(), refetchFolders()]);
    return res.moved;
  };

  const toggleShare = async (folder: string) => {
    const res = await toggleFolderShare(folder);
    await refetchFolders();
    return res;
  };
  const toggleExclude = async (folder: string) => {
    const res = await toggleFolderExclude(folder);
    await refetchFolders();
    return res;
  };

  const patchFile = (id: string, partial: Partial<FileMeta>) => {
    const cur = files();
    if (!cur) return;
    const next = cur.files.map((f) => (f.id === id ? { ...f, ...partial } : f));
    // resource has no setter; refetch instead
    refetchFiles();
    void next;
  };

  return {
    files,
    folders,
    stats,
    currentFolder,
    setCurrentFolder,
    search,
    setSearch,
    view,
    setView,
    sortKey,
    sortDir,
    toggleSort,
    typeFilter,
    setTypeFilter,
    selected,
    isSelected,
    toggleSelect,
    selectRange,
    selectAll,
    clearSelection,
    expandedFolders,
    toggleExpand,
    expandPath,
    filteredFiles,
    folderTree,
    currentSubfolders,
    refreshAll,
    refreshFiles,
    refreshFolders,
    createFolder,
    deleteFolder,
    renameFolder,
    deleteSelectedFiles,
    deleteFiles,
    renameFile,
    moveFiles,
    toggleShare,
    toggleExclude,
    patchFile,
  };
}
