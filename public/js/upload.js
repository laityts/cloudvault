import { saveUpload, getAllUploads, deleteUpload } from './db.js';

const CHUNK_SIZE = 5 * 1024 * 1024;
const SMALL_FILE_THRESHOLD = CHUNK_SIZE;
const MAX_CONCURRENT_CHUNKS = 3;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const PROGRESS_UPDATE_INTERVAL = 5;

class UploadManager {
  constructor() {
    this.queue = [];
    this.active = 0;
    this.maxConcurrent = 3;
    this.loadFromStorage();
    this.setupEventListeners();
  }

  dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  normalizeStatus(status) {
    const allowed = new Set(['pending', 'uploading', 'paused', 'done', 'error', 'cancelled', 'needs_file']);
    return allowed.has(status) ? status : 'pending';
  }

  normalizeParts(parts) {
    if (!Array.isArray(parts)) return [];
    const partMap = new Map();

    for (const part of parts) {
      const partNumber = Number(part?.partNumber);
      const etag = typeof part?.etag === 'string' ? part.etag.trim() : '';
      if (!Number.isInteger(partNumber) || partNumber <= 0 || !etag) continue;
      partMap.set(partNumber, etag);
    }

    return Array.from(partMap.entries())
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  normalizeFolder(folder) {
    return typeof folder === 'string' && folder.trim() ? folder.trim() : 'root';
  }

  normalizeRelativePath(relativePath, fallbackName = '') {
    const raw = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
    const parts = raw.split('/').map(part => part.trim()).filter(Boolean);
    const safeParts = parts.filter(part => part !== '.' && part !== '..');
    if (safeParts.length > 0) {
      return safeParts.join('/');
    }
    return fallbackName || 'untitled';
  }

  normalizeCandidate(entry, defaultFolder = 'root') {
    const file = entry?.file instanceof File ? entry.file : (entry instanceof File ? entry : null);
    if (!file) return null;

    return {
      file,
      folder: this.normalizeFolder(entry?.folder ?? defaultFolder),
      relativePath: this.normalizeRelativePath(entry?.relativePath || file.webkitRelativePath || file.name, file.name),
      lastModified: Number.isFinite(Number(file.lastModified)) ? Number(file.lastModified) : null,
    };
  }

  matchesUploadCandidate(item, candidate, options = {}) {
    if (!item || !candidate?.file) return false;

    const requireFolder = options.requireFolder !== false;
    const requireRelativePath = options.requireRelativePath === true;
    const strictLastModified = options.strictLastModified === true;

    if (requireFolder && candidate.folder && item.folder !== candidate.folder) {
      return false;
    }

    if (item.name !== candidate.file.name || item.size !== candidate.file.size) {
      return false;
    }

    if (requireRelativePath) {
      const itemRelativePath = this.normalizeRelativePath(item.relativePath, item.name);
      const candidateRelativePath = this.normalizeRelativePath(candidate.relativePath, candidate.file.name);
      if (itemRelativePath !== candidateRelativePath) {
        return false;
      }
    }

    if (
      strictLastModified &&
      Number.isFinite(Number(item.lastModified)) &&
      Number.isFinite(Number(candidate.lastModified)) &&
      Number(item.lastModified) !== Number(candidate.lastModified)
    ) {
      return false;
    }

    return true;
  }

  hydrateStoredItem(item) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return null;

    const size = Number.isFinite(Number(item.size)) ? Number(item.size) : 0;
    const normalized = {
      ...item,
      folder: this.normalizeFolder(item.folder),
      type: typeof item.type === 'string' && item.type ? item.type : 'application/octet-stream',
      size,
      status: this.normalizeStatus(item.status),
      progress: Number.isFinite(Number(item.progress)) ? Math.max(0, Math.min(100, Number(item.progress))) : 0,
      uploadedBytes: Number.isFinite(Number(item.uploadedBytes)) ? Math.max(0, Math.min(size, Number(item.uploadedBytes))) : 0,
      speed: 0,
      eta: 0,
      retryCount: Number.isFinite(Number(item.retryCount)) ? Math.max(0, Number(item.retryCount)) : 0,
      chunks: this.normalizeParts(item.chunks),
      uploadId: typeof item.uploadId === 'string' && item.uploadId ? item.uploadId : null,
      key: typeof item.key === 'string' && item.key ? item.key : null,
      fileId: typeof item.fileId === 'string' && item.fileId ? item.fileId : null,
      controller: null,
      xhr: null,
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
      lastUpdate: null,
      lastLoaded: Number.isFinite(Number(item.lastLoaded)) ? Number(item.lastLoaded) : 0,
      progressUpdateCounter: 0,
      speedSamples: [],
      errorMessage: typeof item.errorMessage === 'string' ? item.errorMessage : '',
      lastModified: Number.isFinite(Number(item.lastModified)) ? Number(item.lastModified) : null,
      relativePath: this.normalizeRelativePath(item.relativePath, typeof item.name === 'string' ? item.name : 'untitled'),
    };

    if (normalized.status === 'uploading') {
      normalized.status = normalized.file ? 'paused' : 'needs_file';
    }

    if (normalized.status === 'done') {
      normalized.progress = 100;
      normalized.uploadedBytes = normalized.size;
      normalized.retryCount = 0;
      normalized.errorMessage = '';
    } else if (!normalized.file && normalized.status !== 'cancelled') {
      normalized.status = 'needs_file';
    }

    return normalized;
  }

  serializeUpload(item, includeFile = true) {
    const copy = { ...item };
    delete copy.controller;
    delete copy.xhr;
    delete copy.lastUpdate;
    delete copy.lastLoaded;
    delete copy.progressUpdateCounter;
    delete copy.speedSamples;
    delete copy._saveTimeout;
    if (!includeFile) delete copy.file;
    return copy;
  }

  async loadFromStorage() {
    try {
      let stored = await getAllUploads();

      if (stored.length === 0) {
        const backup = localStorage.getItem('cv_upload_backup');
        if (backup) {
          try {
            const parsed = JSON.parse(backup);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                await saveUpload(item);
              }
              stored = parsed;
            }
            localStorage.removeItem('cv_upload_backup');
          } catch (error) {
            console.error('Failed to restore from localStorage backup', error);
          }
        }
      }

      this.queue = stored
        .map(item => this.hydrateStoredItem(item))
        .filter(item => item !== null);

      for (const item of this.queue) {
        await this.restoreUploadState(item);
      }

      this.dispatch('upload-queue-loaded');
      this.dispatch('upload-queue-changed');
      this.processQueue();
    } catch (error) {
      console.error('Failed to load uploads from storage', error);
    }
  }

  async restoreUploadState(item) {
    if (!item || item.status === 'done' || item.status === 'cancelled') {
      return;
    }

    if (item.uploadId && item.fileId) {
      await this.syncRemoteMultipartState(item);
    }

    if (!item.file && item.status !== 'done') {
      item.status = 'needs_file';
      await this.saveToStorage(item);
    }
  }

  async syncRemoteMultipartState(item) {
    if (!item?.uploadId || !item?.fileId) return;

    try {
      const url = `/api/files/upload?action=mpu-status&fileId=${encodeURIComponent(item.fileId)}&uploadId=${encodeURIComponent(item.uploadId)}`;
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
      });

      if (response.status === 404) {
        item.uploadId = null;
        item.key = null;
        item.fileId = null;
        item.chunks = [];
        item.uploadedBytes = 0;
        item.progress = 0;
        item.status = item.file ? 'pending' : 'needs_file';
        await this.saveToStorage(item);
        return;
      }

      if (!response.ok) {
        return;
      }

      const data = await response.json();
      if (data.completed || data.status === 'done') {
        item.status = 'done';
        item.progress = 100;
        item.uploadedBytes = item.size;
        item.retryCount = 0;
        item.errorMessage = '';
        item.uploadId = null;
        item.key = null;
        item.fileId = null;
        item.chunks = [];
        await this.saveToStorage(item);
        return;
      }

      item.uploadId = typeof data.uploadId === 'string' && data.uploadId ? data.uploadId : item.uploadId;
      item.key = typeof data.key === 'string' && data.key ? data.key : item.key;
      item.fileId = typeof data.fileId === 'string' && data.fileId ? data.fileId : item.fileId;
      item.chunks = this.normalizeParts(data.chunks);

      const totalParts = Number.isFinite(Number(data.totalChunks))
        ? Number(data.totalChunks)
        : Math.max(Math.ceil(item.size / CHUNK_SIZE), item.chunks.length);
      item.uploadedBytes = this.calculateUploadedBytes(item, totalParts);
      item.progress = item.size > 0 ? Math.min(100, Math.round((item.uploadedBytes / item.size) * 100)) : 0;

      if (item.status !== 'paused' && item.status !== 'error' && item.status !== 'needs_file') {
        item.status = item.file ? 'paused' : 'needs_file';
      }

      await this.saveToStorage(item);
    } catch (error) {
      console.error('Failed to sync multipart state', error);
    }
  }

  backupQueueToLocalStorage() {
    try {
      const backup = this.queue.map(item => this.serializeUpload(item, false));
      localStorage.setItem('cv_upload_backup', JSON.stringify(backup));
    } catch (error) {
      console.error('Failed to backup uploads to localStorage', error);
    }
  }

  pauseAllUploadingOnUnload() {
    const uploadingItems = this.queue.filter(item => item.status === 'uploading');
    for (const item of uploadingItems) {
      item.status = 'paused';
      item.controller?.abort();
      item.controller = null;
      item.xhr = null;
      item.speed = 0;
      item.eta = 0;
      this.saveToStorage(item);
    }

    if (uploadingItems.length > 0) {
      this.dispatch('upload-queue-changed');
    }

    this.backupQueueToLocalStorage();
  }

  async saveToStorage(item) {
    try {
      await saveUpload(this.serializeUpload(item));
    } catch (error) {
      console.error('Failed to save upload', error);
    }
  }

  getUploadHeaders(item, includeSize = false) {
    const headers = {
      'X-File-Name': encodeURIComponent(item.name),
      'X-Folder': encodeURIComponent(item.folder || 'root'),
      'Content-Type': item.type || 'application/octet-stream',
    };

    if (includeSize) {
      headers['X-File-Size'] = String(item.size);
    }

    return headers;
  }

  parseJsonText(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  getResponseMessage(payload, fallbackMessage) {
    if (typeof payload?.reason === 'string' && payload.reason.trim()) {
      return payload.reason.trim();
    }
    if (typeof payload?.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
    return fallbackMessage;
  }

  createSkippedUploadError(payload, fallbackMessage = '目标目录已存在同名文件，已跳过上传') {
    const error = new Error(this.getResponseMessage(payload, fallbackMessage));
    error.skipUpload = true;
    error.payload = payload || null;
    return error;
  }

  async readResponsePayload(response) {
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    try {
      const text = await response.text();
      return this.parseJsonText(text) || { error: text };
    } catch {
      return null;
    }
  }

  async ensureUploadAllowed(item) {
    const response = await fetch('/api/files/upload?action=check', {
      method: 'POST',
      headers: this.getUploadHeaders(item, true),
      credentials: 'same-origin',
      signal: item.controller?.signal,
    });

    const payload = await this.readResponsePayload(response);
    if (!response.ok) {
      throw new Error(this.getResponseMessage(payload, '上传预检查失败'));
    }

    return payload?.exists === true ? payload : null;
  }

  async removeUploadItem(item, { abortRemote = false } = {}) {
    if (!item || typeof item.id !== 'string') return;

    if (abortRemote && item.uploadId && item.key) {
      try {
        let url = `/api/files/upload?action=mpu-abort&uploadId=${encodeURIComponent(item.uploadId)}&key=${encodeURIComponent(item.key)}`;
        if (item.fileId) {
          url += `&fileId=${encodeURIComponent(item.fileId)}`;
        }
        await fetch(url, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
      } catch (error) {
        console.error('Failed to abort multipart upload', error);
      }
    }

    this.queue = this.queue.filter(entry => entry.id !== item.id);
    await deleteUpload(item.id);
  }

  findDuplicateTask(candidate) {
    return this.queue.find(item =>
      item.status !== 'done' &&
      item.status !== 'cancelled' &&
      this.matchesUploadCandidate(item, candidate, {
        requireFolder: true,
        requireRelativePath: true,
        strictLastModified: true,
      })
    );
  }

  findRelinkTask(candidate, matchedTaskIds) {
    const findTask = (requireRelativePath) => this.queue.find(item =>
      item.status === 'needs_file' &&
      !matchedTaskIds.has(item.id) &&
      this.matchesUploadCandidate(item, candidate, {
        requireFolder: false,
        requireRelativePath,
        strictLastModified: true,
      })
    );

    const strictMatch = findTask(true);
    if (strictMatch) {
      return {
        task: strictMatch,
        preferredRelativePath: candidate.relativePath,
      };
    }

    const fallbackMatch = findTask(false);
    if (fallbackMatch) {
      return {
        task: fallbackMatch,
        preferredRelativePath: null,
      };
    }

    return null;
  }

  validateFile(file) {
    if (!(file instanceof File)) {
      return { valid: false, message: '文件对象无效' };
    }

    const maxSize = 10 * 1024 * 1024 * 1024;
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > maxSize) {
      return { valid: false, message: '文件大小超出限制' };
    }

    const dotIndex = file.name.lastIndexOf('.');
    const ext = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : '';
    const forbiddenExt = ['.exe', '.sh', '.bat', '.cmd', '.vbs', '.ps1'];
    if (ext && forbiddenExt.includes(ext)) {
      return { valid: false, message: '该文件类型不允许上传' };
    }

    if (!file.name || file.name.includes('/') || file.name.includes('\\')) {
      return { valid: false, message: '文件名不合法' };
    }

    return { valid: true, message: '' };
  }

  async addUploadEntries(entries, defaultFolder = 'root') {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    const summary = { added: 0, restored: 0, skipped: 0, invalid: 0 };

    for (const entry of normalizedEntries) {
      const candidate = this.normalizeCandidate(entry, defaultFolder);
      if (!candidate) {
        summary.invalid++;
        continue;
      }

      const validation = this.validateFile(candidate.file);
      if (!validation.valid) {
        summary.invalid++;
        this.dispatch('upload-error', { name: candidate.file?.name || '未知文件', error: validation.message });
        continue;
      }

      const existing = this.findDuplicateTask(candidate);
      if (existing) {
        if (!existing.file || existing.status === 'needs_file') {
          const attachResult = await this.attachFileToUpload(existing.id, candidate.file, {
            silentSuccess: true,
            preferredRelativePath: candidate.relativePath,
            strictLastModified: true,
          });
          if (attachResult?.ok) {
            summary.restored++;
          } else {
            summary.invalid++;
            this.dispatch('upload-error', { name: candidate.file.name, error: attachResult?.message || '恢复上传任务失败' });
          }
        } else {
          summary.skipped++;
          this.dispatch('upload-skipped', { name: candidate.file.name, reason: '已在上传队列中' });
        }
        continue;
      }

      const item = {
        id: crypto.randomUUID(),
        file: candidate.file,
        folder: candidate.folder,
        name: candidate.file.name,
        size: candidate.file.size,
        type: candidate.file.type || 'application/octet-stream',
        status: 'pending',
        progress: 0,
        uploadedBytes: 0,
        speed: 0,
        eta: 0,
        retryCount: 0,
        chunks: [],
        uploadId: null,
        key: null,
        fileId: null,
        controller: null,
        xhr: null,
        createdAt: Date.now(),
        lastUpdate: null,
        lastLoaded: 0,
        progressUpdateCounter: 0,
        speedSamples: [],
        errorMessage: '',
        lastModified: candidate.lastModified,
        relativePath: candidate.relativePath,
      };
      this.queue.push(item);
      await this.saveToStorage(item);
      summary.added++;
    }

    if (summary.added > 0 || summary.restored > 0) {
      this.dispatch('upload-queue-changed');
      this.processQueue();
    }

    return summary;
  }

  addFiles(files, folder) {
    const entries = Array.from(files || []).map(file => ({
      file,
      folder: this.normalizeFolder(folder),
      relativePath: file.webkitRelativePath || file.name,
    }));
    return this.addUploadEntries(entries, folder);
  }

  async relinkMissingUploads(entries) {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    const summary = { attached: 0, unmatched: 0, failed: 0 };
    const matchedTaskIds = new Set();

    for (const entry of normalizedEntries) {
      const candidate = this.normalizeCandidate(entry, 'root');
      if (!candidate) {
        summary.failed++;
        continue;
      }

      const matchedTask = this.findRelinkTask(candidate, matchedTaskIds);
      if (!matchedTask?.task) {
        summary.unmatched++;
        continue;
      }

      const attachResult = await this.attachFileToUpload(matchedTask.task.id, candidate.file, {
        silentSuccess: true,
        preferredRelativePath: matchedTask.preferredRelativePath || undefined,
        strictLastModified: true,
      });

      if (attachResult?.ok) {
        matchedTaskIds.add(matchedTask.task.id);
        summary.attached++;
      } else {
        summary.failed++;
      }
    }

    return summary;
  }

  processQueue() {
    while (this.active < this.maxConcurrent) {
      const item = this.queue.find(queueItem =>
        queueItem.status === 'pending' &&
        queueItem.file
      );
      if (!item) break;

      item.status = 'uploading';
      item.errorMessage = '';
      this.active++;
      this.dispatch('upload-queue-changed');

      this.uploadFile(item)
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.processQueue();
        });
    }
  }

  calculatePartBytes(item, partNumber, totalParts) {
    if (!item || !Number.isFinite(Number(partNumber)) || partNumber <= 0 || !Number.isFinite(Number(totalParts)) || totalParts <= 0) {
      return 0;
    }

    const start = (partNumber - 1) * CHUNK_SIZE;
    if (start >= item.size) return 0;

    if (partNumber === totalParts) {
      return Math.max(0, item.size - start);
    }

    return Math.min(CHUNK_SIZE, item.size - start);
  }

  calculateUploadedBytes(item, totalParts) {
    const normalizedParts = this.normalizeParts(item?.chunks);
    return Math.min(
      normalizedParts.reduce((sum, part) => sum + this.calculatePartBytes(item, part.partNumber, totalParts), 0),
      item?.size || 0
    );
  }

  async uploadFile(item) {
    if (!item.file) {
      item.status = 'needs_file';
      await this.saveToStorage(item);
      this.dispatch('upload-queue-changed');
      return;
    }

    const controller = new AbortController();
    item.controller = controller;
    item.speed = 0;
    item.eta = 0;
    item.speedSamples = [];
    item.lastUpdate = null;
    item.lastLoaded = item.uploadedBytes || 0;

    try {
      const conflict = await this.ensureUploadAllowed(item);
      if (conflict) {
        throw this.createSkippedUploadError(conflict);
      }

      if (item.size < SMALL_FILE_THRESHOLD) {
        item.uploadedBytes = 0;
        item.progress = 0;
        await this.directUpload(item);
      } else {
        await this.multipartUpload(item);
      }

      item.status = 'done';
      item.progress = 100;
      item.uploadedBytes = item.size;
      item.speed = 0;
      item.eta = 0;
      item.retryCount = 0;
      item.errorMessage = '';
      item.uploadId = null;
      item.key = null;
      item.fileId = null;
      item.chunks = [];
      item.controller = null;
      item.xhr = null;
      await this.saveToStorage(item);
      this.dispatch('upload-complete', { name: item.name });
      this.dispatch('upload-queue-changed');
    } catch (error) {
      if (error?.name === 'AbortError') {
        item.status = 'paused';
        item.controller = null;
        item.xhr = null;
        item.speed = 0;
        item.eta = 0;
        await this.saveToStorage(item);
        this.dispatch('upload-paused', { name: item.name });
        this.dispatch('upload-queue-changed');
        return;
      }

      if (error?.skipUpload) {
        item.controller = null;
        item.xhr = null;
        item.speed = 0;
        item.eta = 0;
        await this.removeUploadItem(item, { abortRemote: Boolean(item.uploadId && item.key) });
        this.dispatch('upload-skipped', {
          name: item.name,
          reason: error.message || '目标目录已存在同名文件，已跳过上传',
        });
        this.dispatch('upload-queue-changed');
        return;
      }

      item.retryCount = (item.retryCount || 0) + 1;
      item.errorMessage = error?.message || '上传失败';
      item.controller = null;
      item.xhr = null;
      item.speed = 0;
      item.eta = 0;

      if (item.retryCount <= MAX_RETRIES && item.file) {
        item.status = 'pending';
        await this.saveToStorage(item);
        this.dispatch('upload-retry', {
          name: item.name,
          retry: item.retryCount,
          error: item.errorMessage,
        });
        this.dispatch('upload-queue-changed');
        window.setTimeout(() => this.processQueue(), RETRY_DELAY);
      } else {
        item.status = item.file ? 'error' : 'needs_file';
        await this.saveToStorage(item);
        this.dispatch('upload-error', {
          name: item.name,
          error: item.errorMessage,
        });
        this.dispatch('upload-queue-changed');
      }
    }
  }

  directUpload(item) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      const signal = item.controller.signal;

      xhr.upload.onprogress = event => {
        if (!event.lengthComputable) return;
        const loaded = event.loaded;
        item.uploadedBytes = loaded;
        item.progress = item.size > 0 ? Math.round((loaded / item.size) * 100) : 0;
        this.updateSpeedAndETA(item, loaded);
        this._debounceSave(item);
        this.dispatch('upload-progress');
      };

      xhr.onload = () => {
        item.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve({});
          }
        } else {
          const payload = this.parseJsonText(xhr.responseText);
          if (xhr.status === 409 && (payload?.skipped === true || payload?.exists === true)) {
            reject(this.createSkippedUploadError(payload));
            return;
          }
          reject(new Error(this.getResponseMessage(payload, xhr.responseText || '上传失败')));
        }
      };

      xhr.onerror = () => {
        item.xhr = null;
        reject(new Error('网络异常'));
      };

      signal.addEventListener('abort', () => {
        xhr.abort();
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });

      xhr.open('POST', '/api/files/upload');
      const headers = this.getUploadHeaders(item);
      for (const [header, value] of Object.entries(headers)) {
        xhr.setRequestHeader(header, value);
      }
      xhr.withCredentials = true;
      xhr.send(item.file);
    });
  }

  async createMultipartSession(item) {
    const response = await fetch('/api/files/upload?action=mpu-create', {
      method: 'POST',
      headers: this.getUploadHeaders(item, true),
      credentials: 'same-origin',
      signal: item.controller.signal,
    });

    const data = await this.readResponsePayload(response);
    if (!response.ok) {
      if (response.status === 409 && (data?.skipped === true || data?.exists === true)) {
        throw this.createSkippedUploadError(data);
      }
      throw new Error(this.getResponseMessage(data, '初始化分片上传失败'));
    }

    if (!data?.uploadId || !data?.key || !data?.fileId) {
      throw new Error('分片上传会话响应无效');
    }

    item.uploadId = data.uploadId;
    item.key = data.key;
    item.fileId = data.fileId;
    item.chunks = [];
    item.uploadedBytes = 0;
    item.progress = 0;
    await this.saveToStorage(item);
  }

  async uploadPartWithRetry(item, partNumber) {
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        return await this.uploadPart(item, partNumber);
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }

        attempt++;
        if (attempt > MAX_RETRIES) {
          throw new Error(`分片 ${partNumber} 上传失败`);
        }

        await this.delay(RETRY_DELAY, item.controller.signal);
      }
    }

    throw new Error(`分片 ${partNumber} 上传失败`);
  }

  async uploadPart(item, partNumber) {
    const start = (partNumber - 1) * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, item.size);
    const chunk = item.file.slice(start, end);
    const url = `/api/files/upload?action=mpu-upload&uploadId=${encodeURIComponent(item.uploadId)}&partNumber=${partNumber}&key=${encodeURIComponent(item.key)}`;

    const response = await fetch(url, {
      method: 'PUT',
      body: chunk,
      credentials: 'same-origin',
      signal: item.controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `分片 ${partNumber} 上传失败`);
    }

    const partData = await response.json();
    return { partNumber, etag: partData.etag };
  }

  async multipartUpload(item) {
    if (!item.file) {
      throw new Error('缺少本地文件，无法继续上传');
    }

    if (item.uploadId && item.fileId) {
      await this.syncRemoteMultipartState(item);
      if (item.status === 'done') {
        return;
      }
    }

    if (!item.uploadId || !item.key || !item.fileId) {
      await this.createMultipartSession(item);
    }

    const totalParts = Math.max(1, Math.ceil(item.size / CHUNK_SIZE));
    item.chunks = this.normalizeParts(item.chunks);
    item.uploadedBytes = this.calculateUploadedBytes(item, totalParts);
    item.progress = item.size > 0 ? Math.round((item.uploadedBytes / item.size) * 100) : 0;

    const uploadedParts = new Set(item.chunks.map(part => part.partNumber));
    const pendingParts = [];
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      if (!uploadedParts.has(partNumber)) {
        pendingParts.push(partNumber);
      }
    }

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_CHUNKS, pendingParts.length || 1) },
      async () => {
        while (pendingParts.length > 0) {
          const partNumber = pendingParts.shift();
          if (!partNumber) return;

          const partInfo = await this.uploadPartWithRetry(item, partNumber);
          item.chunks = this.normalizeParts([...item.chunks, partInfo]);
          item.progressUpdateCounter++;
          item.uploadedBytes = this.calculateUploadedBytes(item, totalParts);
          item.progress = item.size > 0 ? Math.min(100, Math.round((item.uploadedBytes / item.size) * 100)) : 100;
          this.updateSpeedAndETA(item, item.uploadedBytes);
          this._debounceSave(item);
          this.dispatch('upload-progress');

          if (item.progressUpdateCounter >= PROGRESS_UPDATE_INTERVAL || item.chunks.length === totalParts) {
            item.progressUpdateCounter = 0;
            void this.updateServerProgress(item);
          }
        }
      }
    );

    await Promise.all(workers);
    await this.updateServerProgress(item);

    const response = await fetch('/api/files/upload?action=mpu-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: item.uploadId,
        key: item.key,
        parts: this.normalizeParts(item.chunks),
        fileId: item.fileId,
      }),
      credentials: 'same-origin',
      signal: item.controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || '合并分片失败');
    }
  }

  async updateServerProgress(item) {
    if (!item.fileId || !item.uploadId) return;
    try {
      await fetch('/api/files/upload?action=mpu-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: item.fileId,
          uploadId: item.uploadId,
          completedChunks: item.chunks.length,
          chunks: this.normalizeParts(item.chunks),
        }),
        credentials: 'same-origin',
      });
    } catch (error) {
      console.error('Failed to update server progress', error);
    }
  }

  delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        signal?.removeEventListener('abort', abortHandler);
        resolve();
      }, ms);

      const abortHandler = () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };

      signal?.addEventListener('abort', abortHandler, { once: true });
    });
  }

  _debounceSave(item) {
    if (item._saveTimeout) {
      window.clearTimeout(item._saveTimeout);
    }
    item._saveTimeout = window.setTimeout(() => {
      this.saveToStorage(item);
      item._saveTimeout = null;
    }, 800);
  }

  updateSpeedAndETA(item, loaded) {
    const now = Date.now();
    if (!item.lastUpdate) {
      item.lastUpdate = now;
      item.lastLoaded = loaded;
      return;
    }

    const timeDiff = (now - item.lastUpdate) / 1000;
    if (timeDiff < 0.5) return;

    const loadedDiff = Math.max(0, loaded - item.lastLoaded);
    const speed = loadedDiff / timeDiff;
    item.speedSamples.push(speed);
    if (item.speedSamples.length > 8) {
      item.speedSamples.shift();
    }

    const avgSpeed = item.speedSamples.length
      ? item.speedSamples.reduce((sum, value) => sum + value, 0) / item.speedSamples.length
      : 0;

    item.speed = avgSpeed;
    item.eta = avgSpeed > 0 ? Math.max(0, (item.size - loaded) / avgSpeed) : Infinity;
    item.lastUpdate = now;
    item.lastLoaded = loaded;
  }

  pauseUpload(id) {
    const item = this.queue.find(entry => entry.id === id);
    if (!item) return;

    if (item.status === 'uploading') {
      item.controller?.abort();
    } else if (item.status === 'pending') {
      item.status = 'paused';
      item.speed = 0;
      item.eta = 0;
      this.saveToStorage(item);
      this.dispatch('upload-queue-changed');
    }
  }

  resumeUpload(id) {
    const item = this.queue.find(entry => entry.id === id);
    if (!item) return;

    if (!item.file) {
      item.status = 'needs_file';
      this.saveToStorage(item);
      this.dispatch('upload-needs-file', { id: item.id, name: item.name });
      this.dispatch('upload-queue-changed');
      return;
    }

    if (item.status !== 'paused' && item.status !== 'error' && item.status !== 'needs_file') {
      return;
    }

    item.status = 'pending';
    item.retryCount = 0;
    item.errorMessage = '';
    item.speed = 0;
    item.eta = 0;
    this.saveToStorage(item);
    this.dispatch('upload-queue-changed');
    this.processQueue();
  }

  async attachFileToUpload(id, file, options = {}) {
    const item = this.queue.find(entry => entry.id === id);
    if (!item) {
      return { ok: false, message: '上传任务不存在' };
    }

    const candidate = this.normalizeCandidate({
      file,
      folder: item.folder,
      relativePath: options.preferredRelativePath || item.relativePath || file.webkitRelativePath || file.name,
    }, item.folder);
    if (!candidate) {
      return { ok: false, message: '文件对象无效' };
    }

    const validation = this.validateFile(file);
    if (!validation.valid) {
      return { ok: false, message: validation.message };
    }

    if (!this.matchesUploadCandidate(item, candidate, {
      requireFolder: false,
      requireRelativePath: options.preferredRelativePath ? true : false,
      strictLastModified: options.strictLastModified === true,
    })) {
      return { ok: false, message: '请选择同名且大小一致的原始文件' };
    }

    item.file = file;
    item.type = file.type || item.type;
    item.lastModified = Number.isFinite(Number(file.lastModified)) ? Number(file.lastModified) : item.lastModified;
    item.relativePath = item.relativePath || candidate.relativePath;

    if (item.uploadId && item.fileId) {
      await this.syncRemoteMultipartState(item);
      if (item.status === 'done') {
        if (!options.silentSuccess) {
          this.dispatch('upload-file-attached', { id: item.id, name: item.name, message: '服务器端已完成上传' });
        }
        this.dispatch('upload-queue-changed');
        return { ok: true, message: '服务器端已完成上传' };
      }
    } else {
      item.chunks = [];
      item.uploadedBytes = 0;
      item.progress = 0;
    }

    item.status = 'pending';
    item.retryCount = 0;
    item.errorMessage = '';
    await this.saveToStorage(item);
    if (!options.silentSuccess) {
      this.dispatch('upload-file-attached', { id: item.id, name: item.name, message: '已恢复本地文件，继续上传' });
    }
    this.dispatch('upload-queue-changed');
    this.processQueue();
    return { ok: true, message: '已恢复本地文件，继续上传' };
  }

  async cancelUpload(id) {
    const item = this.queue.find(entry => entry.id === id);
    if (!item) return;

    if (item.status === 'uploading') {
      item.controller?.abort();
    }

    await this.removeUploadItem(item, { abortRemote: Boolean(item.uploadId && item.key) });
    this.dispatch('upload-queue-changed');
  }

  pauseAllUploads() {
    for (const item of this.queue.filter(entry => entry.status === 'pending' || entry.status === 'uploading')) {
      this.pauseUpload(item.id);
    }
  }

  resumeAllUploads() {
    for (const item of this.queue.filter(entry => entry.status === 'paused' || entry.status === 'error')) {
      this.resumeUpload(item.id);
    }
  }

  cancelAllUploads() {
    for (const item of this.queue.filter(entry => entry.status !== 'done' && entry.status !== 'cancelled')) {
      this.cancelUpload(item.id);
    }
  }

  clearCompleted() {
    this.queue = this.queue.filter(item =>
      item.status === 'pending' ||
      item.status === 'uploading' ||
      item.status === 'paused' ||
      item.status === 'needs_file'
    );

    getAllUploads().then(items => {
      for (const item of items) {
        if (item.status === 'done' || item.status === 'error' || item.status === 'cancelled') {
          deleteUpload(item.id);
        }
      }
    });

    this.dispatch('upload-queue-changed');
  }

  retryFailed(id) {
    const item = this.queue.find(entry => entry.id === id);
    if (!item || item.status !== 'error') return;

    if (!item.file) {
      item.status = 'needs_file';
      this.saveToStorage(item);
      this.dispatch('upload-needs-file', { id: item.id, name: item.name });
      this.dispatch('upload-queue-changed');
      return;
    }

    item.status = 'pending';
    item.retryCount = 0;
    item.errorMessage = '';
    this.saveToStorage(item);
    this.dispatch('upload-queue-changed');
    this.processQueue();
  }

  getUploadById(id) {
    return this.queue.find(item => item.id === id) || null;
  }

  getAllItems() {
    return this.queue;
  }

  setupEventListeners() {}
}

window.UploadManager = new UploadManager();
