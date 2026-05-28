export interface StreamR2Options {
  /** Extra headers to set on the response (e.g. Content-Disposition, Content-Type override). */
  headers?: Record<string, string>;
  /** Cache-Control header value. Omit to leave unset. */
  cacheControl?: string;
  /** When true, sets Accept-Ranges: bytes and honors incoming Range header (206 partial responses). */
  acceptRanges?: boolean;
}

/**
 * Assemble a streaming R2 response with the common baseline:
 * - writeHttpMetadata + etag (always)
 * - optional Cache-Control, Accept-Ranges, custom headers
 * - Content-Length (auto)
 * - Range request handling when acceptRanges=true and request has Range header
 */
export function streamR2Object(
  object: R2ObjectBody,
  request: Request,
  options: StreamR2Options = {},
): Response {
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

  if (options.acceptRanges) {
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      return applyRange(object, rangeHeader, headers);
    }
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

function applyRange(object: R2ObjectBody, rangeHeader: string, headers: Headers): Response {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }

  const totalSize = object.size;
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

  if (start >= totalSize || end >= totalSize || start > end) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalSize}` },
    });
  }

  headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(object.body, { status: 206, headers });
}
