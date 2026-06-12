export interface StreamR2Options {
  /** Extra headers to set on the response (e.g. Content-Disposition, Content-Type override). */
  headers?: Record<string, string>;
  /** Cache-Control header value. Omit to leave unset. */
  cacheControl?: string;
  /** When true, sets Accept-Ranges: bytes and honors incoming Range header (206 partial responses). */
  acceptRanges?: boolean;
}

/**
 * 从 R2 取对象并组装流式响应：
 * - writeHttpMetadata + etag（始终）
 * - 可选 Cache-Control、Accept-Ranges、自定义头
 * - acceptRanges 且请求带 Range 时，把 Range 交给 R2 在 get 时切片，
 *   依据 object.range 返回 206 + 正确的 Content-Range / Content-Length
 *
 * 对象不存在时返回 null，由调用方决定 404 文案。
 */
export async function streamR2Object(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: StreamR2Options = {},
): Promise<Response | null> {
  const rangeHeader = options.acceptRanges ? request.headers.get('Range') : null;

  const object = await bucket.get(key, rangeHeader ? { range: request.headers } : undefined);
  if (!object || !('body' in object)) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);

  if (options.cacheControl !== undefined) {
    headers.set('Cache-Control', options.cacheControl);
  }
  if (options.acceptRanges) {
    headers.set('Accept-Ranges', 'bytes');
  }
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers.set(k, v);
    }
  }

  // R2 在 Range 可满足时返回切片后的 body，并在 object.range 反映实际范围。
  const range = object.range;
  if (rangeHeader && range) {
    let offset: number;
    let length: number;
    if ('suffix' in range) {
      length = range.suffix;
      offset = object.size - length;
    } else {
      offset = range.offset ?? 0;
      length = range.length ?? object.size - offset;
    }
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}
