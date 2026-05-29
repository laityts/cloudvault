/**
 * 流式计算 ReadableStream 的 SHA-1 和 SHA-256 哈希值。
 * 使用 stream.tee() 复制流，并行计算两个哈希。
 */
export async function computeHashes(
  stream: ReadableStream<Uint8Array>,
): Promise<{ sha1: string; sha256: string }> {
  const [stream1, stream2] = stream.tee();
  const [sha1, sha256] = await Promise.all([
    computeSingleHash(stream1, 'SHA-1'),
    computeSingleHash(stream2, 'SHA-256'),
  ]);
  return { sha1, sha256 };
}

async function computeSingleHash(
  stream: ReadableStream<Uint8Array>,
  algorithm: 'SHA-1' | 'SHA-256',
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  const hashBuffer = await crypto.subtle.digest(algorithm, buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
