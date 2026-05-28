export function formatBytes(bytes: number | null | undefined, precision = 1): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : precision)} ${units[i]}`;
}

export function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

export function formatAbsoluteDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Splits a folder path into navigable segments. "root" returns []. */
export function pathSegments(folder: string): string[] {
  if (!folder || folder === 'root' || folder === '') return [];
  return folder.split('/').filter(Boolean);
}

export function joinPath(parent: string, child: string): string {
  if (!parent || parent === 'root') return child;
  return `${parent}/${child}`;
}
