import { multipartCreate, multipartComplete, multipartUploadPart, multipartAbort } from '~/api';
import type { UploadPart } from '~/api/types';

export type UploadStatus = 'pending' | 'uploading' | 'paused' | 'done' | 'error' | 'canceled';

export interface UploadItem {
  id: string;
  /** 缺失意味着任务从 sessionStorage 重建后用户尚未重选文件 */
  file?: File;
  /** File 缺失时的占位文件名 */
  fileName: string;
  /** File 缺失时的占位大小 */
  fileSize: number;
  folder: string;
  progress: number;
  status: UploadStatus;
  error?: string;
  /** 是否进入了 multipart 路径（< DIRECT_LIMIT 的小文件不能续传） */
  resumable: boolean;
  /** 刷新后从 sessionStorage 重建、需要用户重新选择文件才能继续 */
  needsReselect: boolean;
  /** multipart 总分片数（resumable=true 才有意义） */
  partsTotal: number;
  /** 已成功上传的分片数（来自 InternalState.completedParts） */
  partsDone: number;
}

interface InternalState {
  /** Multipart uploadId — 暂停后保留以便续传 */
  uploadId?: string;
  /** R2 key — 暂停后保留以便续传 */
  key?: string;
  /** 已完成的 parts（partNumber 从 1 起）— 暂停后保留以便续传 */
  completedParts: UploadPart[];
  /** 当前 in-flight 请求的 abort controller */
  abort?: AbortController;
  /** 是否在暂停态 — uploadLoop 检查它来停止下一片 */
  paused: boolean;
  /** 是否已取消 — 中止后不再 transition 到 error */
  canceled: boolean;
}

type Listener = (state: UploadItem[]) => void;

const CHUNK_SIZE = 5 * 1024 * 1024;
/** 同时上传的"文件数"上限。文件之间并发。 */
const MAX_CONCURRENT = 3;
/** 单个文件内同时并发上传的 parts 数。R2 按 partNumber 排序，所以顺序无所谓。 */
const PART_CONCURRENCY = 4;
/** 小于一片（5MB）的文件走单次 PUT；其余走 multipart 享受并发 + 续传。 */
const DIRECT_LIMIT = CHUNK_SIZE;
const STORAGE_KEY = 'cv-upload-queue';

let _idCounter = 0;

interface PersistedItem {
  id: string;
  fileName: string;
  fileSize: number;
  folder: string;
  progress: number;
  resumable: boolean;
  uploadId?: string;
  key?: string;
  completedParts: UploadPart[];
}

export class UploadManager {
  private queue: UploadItem[] = [];
  private internal = new Map<string, InternalState>();
  private active = 0;
  private listeners = new Set<Listener>();
  // 默认乐观假设在线。navigator.onLine 在某些浏览器/环境下首次读取并不可靠
  // （例如桌面 Chrome 在没有任何网络变化事件时可能返回 false），所以只信任
  // 实际触发的 'offline' 事件，避免错误地阻断队列。
  private offline = false;

  constructor() {
    this.restoreFromStorage();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
  }

  destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
  }

  // ── 持久化（sessionStorage） ────────────────────────────────────────

  private restoreFromStorage(): void {
    if (typeof sessionStorage === 'undefined') return;
    let raw: string | null;
    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let persisted: PersistedItem[];
    try {
      persisted = JSON.parse(raw) as PersistedItem[];
    } catch {
      return;
    }
    if (!Array.isArray(persisted)) return;

    for (const p of persisted) {
      const partsTotal = p.resumable ? Math.ceil(p.fileSize / CHUNK_SIZE) : 1;
      const item: UploadItem = {
        id: p.id,
        file: undefined,
        fileName: p.fileName,
        fileSize: p.fileSize,
        folder: p.folder,
        progress: p.progress,
        status: 'paused',
        resumable: p.resumable,
        needsReselect: true,
        error: 'reselect',
        partsTotal,
        partsDone: (p.completedParts ?? []).length,
      };
      this.queue.push(item);
      const state: InternalState = {
        uploadId: p.uploadId,
        key: p.key,
        completedParts: p.completedParts ?? [],
        paused: true,
        canceled: false,
      };
      this.internal.set(item.id, state);
    }
  }

  private persist(): void {
    if (typeof sessionStorage === 'undefined') return;
    const persisted: PersistedItem[] = [];
    for (const item of this.queue) {
      // 不持久化已完成 / 已取消，避免下次刷新还出现历史。
      if (item.status === 'done' || item.status === 'canceled') continue;
      const state = this.internal.get(item.id);
      persisted.push({
        id: item.id,
        fileName: item.fileName,
        fileSize: item.fileSize,
        folder: item.folder,
        progress: item.progress,
        resumable: item.resumable,
        uploadId: state?.uploadId,
        key: state?.key,
        completedParts: state?.completedParts ?? [],
      });
    }
    try {
      if (persisted.length === 0) sessionStorage.removeItem(STORAGE_KEY);
      else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      /* quota or privacy mode — ignore */
    }
  }

  private onOffline = () => {
    this.offline = true;
    // 把所有进行中/待上传的暂停（仅 multipart 可以续传；direct 暂停只能取消重发）
    for (const item of this.queue) {
      if (item.status === 'uploading' || item.status === 'pending') {
        this.pauseInternal(item, /*systemPaused*/ true);
      }
    }
    this.emit();
  };

  private onOnline = () => {
    this.offline = false;
    // 恢复之前因离线被自动暂停的项 — 用 error?='offline' 标记区分用户主动暂停
    for (const item of this.queue) {
      if (item.status === 'paused' && item.error === 'offline') {
        item.error = undefined;
        item.status = 'pending';
      }
    }
    this.emit();
    this.processQueue();
  };

  isOffline(): boolean {
    return this.offline;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): UploadItem[] {
    return this.queue.map((q) => ({ ...q }));
  }

  private emit() {
    this.persist();
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  private intern(id: string): InternalState {
    let s = this.internal.get(id);
    if (!s) {
      s = { completedParts: [], paused: false, canceled: false };
      this.internal.set(id, s);
    }
    return s;
  }

  addFiles(files: Iterable<File>, folder: string): UploadItem[] {
    const added: UploadItem[] = [];
    for (const file of files) {
      const resumable = file.size >= DIRECT_LIMIT;
      const item: UploadItem = {
        id: `u${++_idCounter}-${file.name}`,
        file,
        fileName: file.name,
        fileSize: file.size,
        folder: folder || 'root',
        progress: 0,
        status: 'pending',
        resumable,
        needsReselect: false,
        partsTotal: resumable ? Math.ceil(file.size / CHUNK_SIZE) : 1,
        partsDone: 0,
      };
      this.queue.push(item);
      this.intern(item.id);
      added.push(item);
    }
    this.emit();
    this.processQueue();
    return added;
  }

  // ── 单项控制 ──────────────────────────────────────────────────────────

  /**
   * 把用户重新选择的 File 绑定到 needsReselect 项上，校验 name + size 匹配后
   * 立即转 pending 让队列恢复该任务。multipart 项会用上次保存的 uploadId 与
   * completedParts 续传，不重新上传已完成的 parts。
   *
   * @returns true 表示绑定成功并已恢复；false 表示尺寸/名字不匹配（已 toast 在 UI 层处理）
   */
  reselect(id: string, file: File): boolean {
    const item = this.queue.find((q) => q.id === id);
    if (!item) return false;
    if (!item.needsReselect) return false;
    if (file.name !== item.fileName || file.size !== item.fileSize) return false;
    if (this.offline) return false;

    item.file = file;
    item.needsReselect = false;
    item.error = undefined;
    item.status = 'pending';
    const state = this.intern(item.id);
    state.paused = false;
    state.canceled = false;
    state.abort = undefined;
    this.emit();
    this.processQueue();
    return true;
  }

  pause(id: string): void {
    const item = this.queue.find((q) => q.id === id);
    if (!item) return;
    if (item.status !== 'uploading' && item.status !== 'pending') return;
    this.pauseInternal(item, false);
    this.emit();
  }

  resume(id: string): void {
    const item = this.queue.find((q) => q.id === id);
    if (!item || item.status !== 'paused') return;
    if (this.offline) return;
    if (item.needsReselect || !item.file) return;
    item.status = 'pending';
    item.error = undefined;
    const state = this.intern(item.id);
    state.paused = false;
    this.emit();
    this.processQueue();
  }

  cancel(id: string): void {
    const item = this.queue.find((q) => q.id === id);
    if (!item) return;
    const state = this.intern(item.id);
    this.maybeAbortRemote(state);
    state.canceled = true;
    state.paused = false;
    state.abort?.abort();
    if (item.status === 'uploading') {
      // upload() 的 catch 会把它标成 canceled
      this.active = Math.max(0, this.active - 1);
    }
    item.status = 'canceled';
    this.emit();
    this.processQueue();
  }

  retry(id: string): void {
    const item = this.queue.find((q) => q.id === id);
    if (!item || (item.status !== 'error' && item.status !== 'canceled')) return;
    if (this.offline) return;
    if (item.needsReselect || !item.file) return;
    const state = this.intern(item.id);
    state.canceled = false;
    state.paused = false;
    state.abort = undefined;
    item.status = 'pending';
    item.error = undefined;
    if (!item.resumable) {
      // direct 上传无续传：从 0 开始
      item.progress = 0;
    }
    this.emit();
    this.processQueue();
  }

  // ── 批量控制 ──────────────────────────────────────────────────────────

  pauseAll(): void {
    for (const item of this.queue) {
      if (item.status === 'uploading' || item.status === 'pending') {
        this.pauseInternal(item, false);
      }
    }
    this.emit();
  }

  resumeAll(): void {
    if (this.offline) return;
    for (const item of this.queue) {
      if (item.status === 'paused' && !item.needsReselect && item.file) {
        item.status = 'pending';
        item.error = undefined;
        const state = this.intern(item.id);
        state.paused = false;
      }
    }
    this.emit();
    this.processQueue();
  }

  cancelAll(): void {
    for (const item of this.queue) {
      if (item.status === 'pending' || item.status === 'uploading' || item.status === 'paused') {
        const state = this.intern(item.id);
        this.maybeAbortRemote(state);
        state.canceled = true;
        state.paused = false;
        state.abort?.abort();
        if (item.status === 'uploading') this.active = Math.max(0, this.active - 1);
        item.status = 'canceled';
      }
    }
    this.emit();
    this.processQueue();
  }

  retryAll(): void {
    if (this.offline) return;
    for (const item of this.queue) {
      if ((item.status === 'error' || item.status === 'canceled') && !item.needsReselect && item.file) {
        const state = this.intern(item.id);
        state.canceled = false;
        state.paused = false;
        state.abort = undefined;
        item.status = 'pending';
        item.error = undefined;
        if (!item.resumable) item.progress = 0;
      }
    }
    this.emit();
    this.processQueue();
  }

  /**
   * 清除非进行中的任务。
   * - done: 直接移除
   * - paused / error / canceled: 对 multipart 调 abort 释放 R2 已上传的 parts，
   *   再移除（pending 因为还没创建 multipart，不需要 abort）
   * - uploading: 保留，避免误中断
   */
  clearCompleted(): void {
    const remove = (q: UploadItem) => q.status !== 'uploading';
    for (const q of this.queue) {
      if (!remove(q)) continue;
      const state = this.intern(q.id);
      // pending 没创建 multipart；done 不能 abort（已 complete）。
      if (q.status === 'paused' || q.status === 'error' || q.status === 'canceled') {
        this.maybeAbortRemote(state);
      }
      state.abort?.abort();
      this.internal.delete(q.id);
    }
    this.queue = this.queue.filter((q) => !remove(q));
    this.emit();
  }

  clearAll(): void {
    // 同 clearCompleted；保留以兼容旧调用方。
    this.clearCompleted();
  }

  /**
   * 在 pagehide 等卸载场景调用：把所有进行中 / 排队中的任务软暂停后写入
   * sessionStorage，刷新后由 restoreFromStorage 重建为 paused + needsReselect。
   * 不调远端 abort —— R2 multipart 保留 24 小时，用户重选文件后可手动续传。
   */
  abortPendingForUnload(): void {
    // pause 当前 in-flight 的请求，避免页面已 unload 后还有挂单
    for (const item of this.queue) {
      if (item.status === 'uploading' || item.status === 'pending') {
        const state = this.intern(item.id);
        state.paused = true;
        state.abort?.abort();
      }
    }
    this.persist();
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private pauseInternal(item: UploadItem, systemPaused: boolean): void {
    const state = this.intern(item.id);
    state.paused = true;
    state.abort?.abort();
    if (item.status === 'uploading') {
      this.active = Math.max(0, this.active - 1);
    }
    item.status = 'paused';
    if (systemPaused) item.error = 'offline';
  }

  /**
   * 如果 InternalState 持有未 complete 的 multipart uploadId，发送后端 abort
   * 释放 R2 占用。fire-and-forget，不阻塞调用方。abort 后清掉本地引用避免重复。
   */
  private maybeAbortRemote(state: InternalState): void {
    if (!state.uploadId || !state.key) return;
    void multipartAbort({ uploadId: state.uploadId, key: state.key });
    state.uploadId = undefined;
    state.key = undefined;
    state.completedParts = [];
  }

  private processQueue(): void {
    if (this.offline) return;
    while (this.active < MAX_CONCURRENT) {
      const next = this.queue.find((q) => q.status === 'pending');
      if (!next) break;
      next.status = 'uploading';
      this.active++;
      this.emit();
      this.upload(next).finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.processQueue();
      });
    }
  }

  private async upload(item: UploadItem): Promise<void> {
    const state = this.intern(item.id);
    const file = item.file;
    if (!file) {
      // Defensive: needsReselect 项理论上不会进 pending，所以这里只做兜底
      item.status = 'paused';
      item.error = 'reselect';
      this.emit();
      return;
    }
    state.abort = new AbortController();
    try {
      if (!item.resumable) {
        await this.directUpload(item, file, state);
      } else {
        await this.multipartUpload(item, file, state);
      }
      if (state.canceled || state.paused) return; // 已被中断
      item.status = 'done';
      item.progress = 100;
      this.emit();
      window.dispatchEvent(new CustomEvent('upload-complete', { detail: { name: file.name } }));
    } catch (err) {
      if (state.canceled) {
        // 状态已在 cancel() 内置为 canceled
        return;
      }
      if (state.paused) {
        // 状态已在 pauseInternal 内置为 paused
        return;
      }
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
      this.emit();
      window.dispatchEvent(new CustomEvent('upload-error', { detail: { name: file.name, error: item.error } }));
    }
  }

  private directUpload(item: UploadItem, file: File, state: InternalState): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-Folder', encodeURIComponent(item.folder || 'root'));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          item.progress = Math.round((e.loaded / e.total) * 100);
          this.emit();
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(xhr.responseText || 'Upload failed'));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onabort = () => reject(new Error('Aborted'));
      // AbortSignal → xhr.abort()
      const onAbort = () => xhr.abort();
      state.abort?.signal.addEventListener('abort', onAbort, { once: true });
      xhr.send(file);
    });
  }

  private async multipartUpload(item: UploadItem, file: File, state: InternalState): Promise<void> {
    // 复用前次创建的 uploadId（暂停恢复路径），否则新建一次
    if (!state.uploadId || !state.key) {
      const created = await multipartCreate(
        {
          'X-File-Name': encodeURIComponent(file.name),
          'X-Folder': encodeURIComponent(item.folder || 'root'),
          'Content-Type': file.type || 'application/octet-stream',
        },
        state.abort?.signal,
      );
      state.uploadId = created.uploadId;
      state.key = created.key;
      state.completedParts = [];
    }

    const totalParts = Math.ceil(file.size / CHUNK_SIZE);
    const doneSet = new Set(state.completedParts.map((p) => p.partNumber));

    // 把还没上传的 partNumber 收集成队列，PART_CONCURRENCY 个 worker 同时从队列拉。
    const queue: number[] = [];
    for (let i = 0; i < totalParts; i++) {
      const partNumber = i + 1;
      if (!doneSet.has(partNumber)) queue.push(partNumber);
    }
    let nextIdx = 0;
    let firstError: unknown = null;
    const uploadId = state.uploadId;
    const key = state.key;

    const worker = async () => {
      while (true) {
        if (state.paused || state.canceled || firstError) return;
        const i = nextIdx++;
        if (i >= queue.length) return;
        const partNumber = queue[i]!;
        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);
        try {
          const part = await multipartUploadPart({
            uploadId,
            key,
            partNumber,
            chunk,
            signal: state.abort?.signal,
          });
          state.completedParts.push(part);
          item.partsDone = state.completedParts.length;
          item.progress = Math.round((state.completedParts.length / totalParts) * 100);
          this.emit();
        } catch (e) {
          if (state.paused || state.canceled) return;
          if (!firstError) firstError = e;
          return;
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(PART_CONCURRENCY, queue.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (state.paused || state.canceled) throw new Error('Aborted');
    if (firstError) throw firstError instanceof Error ? firstError : new Error(String(firstError));

    // parts 顺序无所谓 —— Cloudflare R2 按 partNumber 排序拼接
    await multipartComplete({
      uploadId,
      key,
      parts: state.completedParts,
      signal: state.abort?.signal,
    });
    // 完成后清理临时状态，避免误续传
    state.uploadId = undefined;
    state.key = undefined;
    state.completedParts = [];
  }
}

/** Reads a DataTransfer for files + folder entries (DataTransferItemList).
 *  Returns flat list of {file, relativePath}. relativePath is "" for top-level files. */
export async function readDroppedEntries(
  dataTransfer: DataTransfer,
): Promise<Array<{ file: File; relativePath: string }>> {
  const out: Array<{ file: File; relativePath: string }> = [];
  const items = dataTransfer.items;

  if (items?.[0] && (items[0] as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry) {
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const e = (items[i] as DataTransferItem).webkitGetAsEntry();
      if (e) entries.push(e);
    }
    for (const entry of entries) {
      await readEntry(entry, '', out);
    }
  } else {
    for (const file of Array.from(dataTransfer.files)) {
      out.push({ file, relativePath: '' });
    }
  }

  return out;
}

function readEntry(
  entry: FileSystemEntry,
  path: string,
  files: Array<{ file: File; relativePath: string }>,
): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file((file) => {
        files.push({ file, relativePath: path });
        resolve();
      });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      reader.readEntries(async (entries) => {
        for (const e of entries) {
          await readEntry(e, path ? `${path}/${entry.name}` : entry.name, files);
        }
        resolve();
      });
    } else {
      resolve();
    }
  });
}
