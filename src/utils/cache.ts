export async function serveWithEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  handler: () => Promise<Response | null>,
): Promise<Response | null> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers });
  }

  const response = await handler();
  if (!response || !response.ok) return response;

  ctx.waitUntil(cache.put(request, response.clone()));
  response.headers.set('X-Cache', 'MISS');
  return response;
}

const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.map',
]);

export function isStaticAsset(pathname: string): boolean {
  const dot = pathname.lastIndexOf('.');
  if (dot < 0) return false;
  return STATIC_EXTENSIONS.has(pathname.slice(dot).toLowerCase());
}
