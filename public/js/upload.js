// upload.js - 增强版上传管理器
import { saveUpload, getAllUploads, deleteUpload } from './db.js';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CONCURRENT_CHUNKS = 3;      // 分块并发数
const MAX_RETRIES = 3;                 // 最大重试次数
const RETRY_DELAY = 1000;              // 重试延迟（ms）
const PROGRESS_UPDATE_INTERVAL = 5;    // 每上传5个分块更新一次服务器进度

class UploadManager {
  constructor() {
    this.queue = [];           // 上传队列（内存中的实时状态）
    this.active = 0;           // 当前活跃的上传任务数
    this.maxConcurrent = 3;    // 最大并发任务数（不同文件）
    this.speedSamples = [];    // 用于计算速度的样本
    this.loadFromStorage();    // 从 IndexedDB 恢复队列
    this.setupEventListeners();
  }

  // 从存储恢复队列
  async loadFromStorage() {
    try {
      const stored = await getAllUploads();
      // 过滤掉已完成或已取消的任务，只恢复未完成的任务
      this.queue = stored.filter(item => 
        item.status !== 'done' && item.status !== 'cancelled'
      ).map(item => ({
        ...item,
        // 确保每个任务有必要的控制属性
        controller: null,          // AbortController，用于取消
        xhr: null,                 // XMLHttpRequest (用于直接上传)
        speed: 0,
        eta: 0,
        lastUpdate: null,
        lastLoaded: 0,
        progressUpdateCounter: 0,
      }));
      // 触发UI更新
      window.dispatchEvent(new CustomEvent('upload-queue-loaded'));
      this.processQueue();
    } catch (e) {
      console.error('Failed to load uploads from storage', e);
    }
  }

  // 保存单个任务到存储
  async saveToStorage(item) {
    try {
      // 深拷贝一份，排除不可序列化的字段
      const copy = { ...item };
      delete copy.controller;
      delete copy.xhr;
      delete copy.lastUpdate;
      delete copy.lastLoaded;
      delete copy.progressUpdateCounter;
      await saveUpload(copy);
    } catch (e) {
      console.error('Failed to save upload', e);
    }
  }

  // 添加文件到队列
  addFiles(files, folder) {
    for (const file of files) {
      // 上传前校验
      if (!this.validateFile(file)) {
        window.dispatchEvent(new CustomEvent('upload-error', { 
          detail: { name: file.name, error: 'File type or size not allowed' }
        }));
        continue;
      }

      const id = crypto.randomUUID();
      const item = {
        id,
        file,
        folder,
        name: file.name,
        size: file.size,
        type: file.type,
        status: 'pending',      // pending, uploading, paused, done, error, cancelled
        progress: 0,
        uploadedBytes: 0,
        speed: 0,
        eta: 0,
        retryCount: 0,
        chunks: [],             // 对于分块上传，存储 { partNumber, etag } 已完成的分块
        uploadId: null,         // multipart upload ID
        key: null,              // R2 object key
        fileId: null,           // 服务器端文件ID
        controller: null,
        xhr: null,
        createdAt: Date.now(),
        lastUpdate: null,
        lastLoaded: 0,
        progressUpdateCounter: 0,
      };
      this.queue.push(item);
      this.saveToStorage(item);
    }
    window.dispatchEvent(new CustomEvent('upload-queue-changed'));
    this.processQueue();
  }

  // 文件验证
  validateFile(file) {
    // 示例：最大文件 10GB，禁止特定扩展名
    const maxSize = 10 * 1024 * 1024 * 1024; // 10GB
    if (file.size > maxSize) return false;
    const forbiddenExt = ['.exe', '.sh', '.bat', '.cmd', '.vbs', '.ps1'];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (forbiddenExt.includes(ext)) return false;
    return true;
  }

  // 处理队列
  processQueue() {
    while (this.active < this.maxConcurrent) {
      const item = this.queue.find(q => 
        q.status === 'pending' && !q.paused
      );
      if (!item) break;
      item.status = 'uploading';
      this.active++;
      this.uploadFile(item).finally(() => {
        this.active--;
        this.processQueue();
      });
    }
  }

  // 上传主逻辑
  async uploadFile(item) {
    // 创建 AbortController 用于取消
    const controller = new AbortController();
    item.controller = controller;

    try {
      if (item.size < CHUNK_SIZE * 2) {
        // 小文件直接上传
        await this.directUpload(item);
      } else {
        // 大文件分块上传
        await this.multipartUpload(item);
      }
      // 上传成功
      item.status = 'done';
      item.progress = 100;
      await this.saveToStorage(item);
      window.dispatchEvent(new CustomEvent('upload-complete', { detail: { name: item.name } }));
    } catch (err) {
      if (err.name === 'AbortError') {
        // 用户取消或暂停
        item.status = 'paused';
        item.controller = null;
        await this.saveToStorage(item);
        window.dispatchEvent(new CustomEvent('upload-paused', { detail: { name: item.name } }));
        return;
      }

      // 处理错误重试
      item.retryCount = (item.retryCount || 0) + 1;
      if (item.retryCount <= MAX_RETRIES) {
        item.status = 'pending'; // 重新加入队列
        item.controller = null;
        await this.saveToStorage(item);
        window.dispatchEvent(new CustomEvent('upload-retry', { detail: { name: item.name, retry: item.retryCount } }));
        // 延迟重试
        setTimeout(() => this.processQueue(), RETRY_DELAY);
      } else {
        item.status = 'error';
        item.controller = null;
        await this.saveToStorage(item);
        window.dispatchEvent(new CustomEvent('upload-error', { detail: { name: item.name, error: err.message } }));
      }
    }
  }

  // 直接上传（小文件）
  directUpload(item) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      const controller = item.controller;
      const signal = controller.signal;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const loaded = e.loaded;
          item.uploadedBytes = loaded;
          item.progress = Math.round((loaded / item.size) * 100);
          this.updateSpeedAndETA(item, loaded);
          window.dispatchEvent(new CustomEvent('upload-progress'));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(xhr.responseText || 'Upload failed'));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));

      // 处理取消
      signal.addEventListener('abort', () => {
        xhr.abort();
        reject(new DOMException('Aborted', 'AbortError'));
      });

      xhr.open('POST', '/api/files/upload');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.name));
      xhr.setRequestHeader('X-Folder', encodeURIComponent(item.folder || 'root'));
      xhr.setRequestHeader('Content-Type', item.type || 'application/octet-stream');
      xhr.withCredentials = true;
      xhr.send(item.file);
    });
  }

  // 分块上传
  async multipartUpload(item) {
    // 1. 如果没有 uploadId，则创建 multipart upload
    if (!item.uploadId) {
      const createRes = await fetch('/api/files/upload?action=mpu-create', {
        method: 'POST',
        headers: {
          'X-File-Name': encodeURIComponent(item.name),
          'X-Folder': encodeURIComponent(item.folder || 'root'),
          'Content-Type': item.type || 'application/octet-stream',
          'X-File-Size': item.size.toString(),
        },
        credentials: 'same-origin',
        signal: item.controller.signal,
      });
      if (!createRes.ok) throw new Error('Failed to create multipart upload');
      const { uploadId, key, fileId } = await createRes.json();
      item.uploadId = uploadId;
      item.key = key;
      item.fileId = fileId;
      await this.saveToStorage(item);
    }

    const totalParts = Math.ceil(item.size / CHUNK_SIZE);
    // 确定已上传的分块（从 item.chunks 恢复）
    const uploadedParts = new Set(item.chunks.map(c => c.partNumber));
    const pendingParts = [];
    for (let i = 1; i <= totalParts; i++) {
      if (!uploadedParts.has(i)) {
        pendingParts.push(i);
      }
    }

    // 并发上传分块
    const uploadPart = async (partNumber) => {
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
      if (!response.ok) throw new Error(`Failed to upload part ${partNumber}`);
      const partData = await response.json();
      return { partNumber, etag: partData.etag };
    };

    // 使用 Promise.all 限制并发数
    const results = [];
    const queue = [...pendingParts];
    let activeChunks = 0;

    return new Promise((resolve, reject) => {
      const next = async () => {
        while (queue.length && activeChunks < MAX_CONCURRENT_CHUNKS) {
          const part = queue.shift();
          activeChunks++;
          uploadPart(part)
            .then(partInfo => {
              results.push(partInfo);
              item.chunks.push(partInfo);
              item.progressUpdateCounter++;
              
              // 每上传 PROGRESS_UPDATE_INTERVAL 个分块或完成时更新服务器进度
              if (item.progressUpdateCounter >= PROGRESS_UPDATE_INTERVAL || 
                  results.length === totalParts) {
                this.updateServerProgress(item);
                item.progressUpdateCounter = 0;
              }
              
              // 更新进度
              item.uploadedBytes += CHUNK_SIZE;
              item.progress = Math.round((item.chunks.length / totalParts) * 100);
              this.updateSpeedAndETA(item, item.uploadedBytes);
              window.dispatchEvent(new CustomEvent('upload-progress'));
              activeChunks--;
              next();
            })
            .catch(err => {
              if (err.name === 'AbortError') {
                reject(err);
              } else {
                // 重试该分块
                queue.unshift(part);
                setTimeout(() => next(), RETRY_DELAY);
              }
            });
        }
        // 如果所有分块上传完成
        if (results.length === totalParts) {
          resolve();
        }
      };
      next();
    }).then(async () => {
      // 所有分块上传完成，完成 multipart upload
      const completeRes = await fetch('/api/files/upload?action=mpu-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId: item.uploadId,
          key: item.key,
          parts: item.chunks,
          fileId: item.fileId,
        }),
        credentials: 'same-origin',
        signal: item.controller.signal,
      });
      if (!completeRes.ok) throw new Error('Failed to complete multipart upload');
      // 上传完成，清理存储中的临时数据
      item.uploadId = null;
      item.key = null;
      item.fileId = null;
      item.chunks = [];
      await this.saveToStorage(item);
    });
  }

  // 更新服务器进度
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
          chunks: item.chunks,
        }),
        credentials: 'same-origin',
      });
    } catch (e) {
      console.error('Failed to update server progress', e);
    }
  }

  // 更新速度和剩余时间
  updateSpeedAndETA(item, loaded) {
    const now = Date.now();
    if (!item.lastUpdate) {
      item.lastUpdate = now;
      item.lastLoaded = loaded;
      return;
    }
    const timeDiff = (now - item.lastUpdate) / 1000; // 秒
    if (timeDiff < 0.5) return; // 避免过于频繁更新

    const loadedDiff = loaded - item.lastLoaded;
    const speed = loadedDiff / timeDiff; // bytes/s
    // 平滑速度
    this.speedSamples.push(speed);
    if (this.speedSamples.length > 10) this.speedSamples.shift();
    const avgSpeed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;

    item.speed = avgSpeed;
    if (avgSpeed > 0) {
      const remaining = item.size - loaded;
      item.eta = remaining / avgSpeed; // 秒
    } else {
      item.eta = Infinity;
    }

    item.lastUpdate = now;
    item.lastLoaded = loaded;
  }

  // 暂停上传
  pauseUpload(id) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return;
    if (item.status === 'uploading') {
      item.controller?.abort(); // 触发 AbortError
    } else if (item.status === 'pending') {
      item.status = 'paused';
      this.saveToStorage(item);
    }
    window.dispatchEvent(new CustomEvent('upload-queue-changed'));
  }

  // 恢复上传
  resumeUpload(id) {
    const item = this.queue.find(i => i.id === id);
    if (!item || item.status !== 'paused') return;
    item.status = 'pending';
    item.retryCount = 0; // 重置重试计数
    this.saveToStorage(item);
    window.dispatchEvent(new CustomEvent('upload-queue-changed'));
    this.processQueue();
  }

  // 取消上传
  async cancelUpload(id) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return;
    if (item.status === 'uploading') {
      item.controller?.abort();
    }
    // 如果是 multipart upload，需要通知后端中止
    if (item.uploadId && item.key) {
      try {
        let url = `/api/files/upload?action=mpu-abort&uploadId=${encodeURIComponent(item.uploadId)}&key=${encodeURIComponent(item.key)}`;
        if (item.fileId) {
          url += `&fileId=${encodeURIComponent(item.fileId)}`;
        }
        await fetch(url, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
      } catch (e) {
        console.error('Failed to abort multipart upload', e);
      }
    }
    // 从队列中移除
    this.queue = this.queue.filter(i => i.id !== id);
    await deleteUpload(id);
    window.dispatchEvent(new CustomEvent('upload-queue-changed'));
  }

  // 清除已完成/错误的任务
  clearCompleted() {
    this.queue = this.queue.filter(i => i.status === 'pending' || i.status === 'uploading' || i.status === 'paused');
    // 从存储中删除已完成/错误的任务
    getAllUploads().then(all => {
      all.forEach(u => {
        if (u.status === 'done' || u.status === 'error' || u.status === 'cancelled') {
          deleteUpload(u.id);
        }
      });
    });
    window.dispatchEvent(new CustomEvent('upload-queue-changed'));
  }

  // 重试失败的任务
  retryFailed(id) {
    const item = this.queue.find(i => i.id === id);
    if (!item || item.status !== 'error') return;
    item.status = 'pending';
    item.retryCount = 0;
    this.saveToStorage(item);
    window.dispatchEvent(new CustomEvent('upload-queue-changed'));
    this.processQueue();
  }

  // 获取所有任务
  getAllItems() {
    return this.queue;
  }

  // 事件监听
  setupEventListeners() {
    // 可以监听各种事件
  }
}

// 创建单例
window.UploadManager = new UploadManager();

// 导出辅助函数供 UI 使用
window.readDroppedEntries = async function(dataTransfer) {
  const files = [];
  const items = dataTransfer.items;

  if (items && items[0] && items[0].webkitGetAsEntry) {
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    for (const entry of entries) {
      await readEntry(entry, '', files);
    }
  } else {
    for (const file of dataTransfer.files) {
      files.push({ file, relativePath: '' });
    }
  }
  return files;
};

function readEntry(entry, path, files) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        files.push({ file, relativePath: path });
        resolve();
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      reader.readEntries(async (entries) => {
        for (const e of entries) {
          await readEntry(e, path ? path + '/' + entry.name : entry.name, files);
        }
        resolve();
      });
    } else {
      resolve();
    }
  });
}