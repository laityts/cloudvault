import { multipartCreate, multipartComplete, multipartUploadPart } from '~/api';
import type { UploadPart } from '~/api/types';

export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error';

export interface UploadItem {
  id: string;
  file: File;
  folder: string;
  progress: number;
  status: UploadStatus;
  error?: string;
}

type Listener = (state: UploadItem[]) => void;

const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_CONCURRENT = 3;
const DIRECT_LIMIT = 10 * 1024 * 1024;

let _idCounter = 0;

export class UploadManager {
  private queue: UploadItem[] = [];
  private active = 0;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): UploadItem[] {
    return this.queue.map((q) => ({ ...q }));
  }

  private emit() {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  addFiles(files: Iterable<File>, folder: string): UploadItem[] {
    const added: UploadItem[] = [];
    for (const file of files) {
      const item: UploadItem = {
        id: `u${++_idCounter}-${file.name}`,
        file,
        folder: folder || 'root',
        progress: 0,
        status: 'pending',
      };
      this.queue.push(item);
      added.push(item);
    }
    this.emit();
    this.processQueue();
    return added;
  }

  clearCompleted(): void {
    this.queue = this.queue.filter((q) => q.status === 'uploading' || q.status === 'pending');
    this.emit();
  }

  clearAll(): void {
    this.queue = this.queue.filter((q) => q.status === 'uploading');
    this.emit();
  }

  private processQueue(): void {
    while (this.active < MAX_CONCURRENT) {
      const next = this.queue.find((q) => q.status === 'pending');
      if (!next) break;
      next.status = 'uploading';
      this.active++;
      this.emit();
      this.upload(next).finally(() => {
        this.active--;
        this.processQueue();
      });
    }
  }

  private async upload(item: UploadItem): Promise<void> {
    try {
      if (item.file.size < DIRECT_LIMIT) {
        await this.directUpload(item);
      } else {
        await this.multipartUpload(item);
      }
      item.status = 'done';
      item.progress = 100;
      this.emit();
      window.dispatchEvent(new CustomEvent('upload-complete', { detail: { name: item.file.name } }));
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
      this.emit();
      window.dispatchEvent(new CustomEvent('upload-error', { detail: { name: item.file.name, error: item.error } }));
    }
  }

  private directUpload(item: UploadItem): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name));
      xhr.setRequestHeader('X-Folder', encodeURIComponent(item.folder || 'root'));
      xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
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
      xhr.send(item.file);
    });
  }

  private async multipartUpload(item: UploadItem): Promise<void> {
    const { uploadId, key } = await multipartCreate({
      'X-File-Name': encodeURIComponent(item.file.name),
      'X-Folder': encodeURIComponent(item.folder || 'root'),
      'Content-Type': item.file.type || 'application/octet-stream',
    });

    const totalParts = Math.ceil(item.file.size / CHUNK_SIZE);
    const parts: UploadPart[] = [];

    for (let i = 0; i < totalParts; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, item.file.size);
      const chunk = item.file.slice(start, end);
      const part = await multipartUploadPart({
        uploadId,
        key,
        partNumber: i + 1,
        chunk,
      });
      parts.push(part);
      item.progress = Math.round(((i + 1) / totalParts) * 100);
      this.emit();
    }

    await multipartComplete({ uploadId, key, parts });
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
