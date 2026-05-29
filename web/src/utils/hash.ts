/**
 * 浏览器端计算 File 的 SHA-256，返回 64 位小写 hex 字符串。
 * 通过 file.stream() 分块读，避免一次性加载到内存（大文件友好）。
 * 受限于 SubtleCrypto 不支持流式 digest，仍需把所有 chunk 拼成单个 buffer。
 * 100MB 以内浏览器内存充裕，可接受。
 */
export async function computeFileSha256(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.(loaded, file.size);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }

  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
