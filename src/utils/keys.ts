/**
 * Build the R2 object key from a virtual folder + filename.
 * Files at the virtual root use just the filename; nested files are "folder/name".
 */
export function buildR2Key(folder: string, name: string): string {
  return folder === 'root' ? name : `${folder}/${name}`;
}

/**
 * Extract the path segment immediately after the given marker.
 * E.g. extractPathParam(url, 'files') on /api/files/abc/preview returns 'abc'.
 * Returns null if marker not found or no segment follows.
 */
export function extractPathParam(url: URL, segment: string): string | null {
  const parts = url.pathname.split('/');
  const idx = parts.indexOf(segment);
  if (idx < 0) return null;
  const next = parts[idx + 1];
  return next ? next : null;
}

/** Whether a path traversal attempt is present. Use before writing R2 keys derived from user input. */
export function isUnsafeKey(key: string): boolean {
  return !key || key.includes('..');
}
