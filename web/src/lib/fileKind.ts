export type FileCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'archive'
  | 'code'
  | 'pdf'
  | 'app'
  | 'font'
  | 'other';

const CODE_RE =
  /\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rb|go|rs|java|c|cc|cpp|h|hpp|cs|swift|kt|sh|bash|zsh|fish|yaml|yml|toml|ini|cfg|conf|sql|graphql|gql|md|mdx|html|htm|css|scss|less|sass|json|xml|svg|lua|dart|r|m|mm|scala|clj|ex|exs|hs|erl|ps1|bat|cmd|nim|zig)$/i;

const ARCHIVE_RE = /\.(zip|tar|gz|tgz|bz2|xz|rar|7z|lz|lzma|zst)$/i;
const DOC_RE = /\.(doc|docx|odt|rtf|pages|ppt|pptx|key|xls|xlsx|csv|numbers)$/i;
const APP_RE = /\.(exe|msi|dmg|pkg|deb|rpm|appimage|apk|aab|ipa|iso|img)$/i;
const FONT_RE = /\.(ttf|otf|woff|woff2|eot)$/i;

export function fileCategory(mime: string | undefined | null, name: string | undefined | null): FileCategory {
  const m = (mime || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (m === 'application/pdf' || /\.pdf$/i.test(n)) return 'pdf';
  if (m.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif|svg)$/i.test(n)) return 'image';
  if (m.startsWith('video/') || /\.(mp4|mkv|webm|mov|avi|wmv|flv|m4v)$/i.test(n)) return 'video';
  if (m.startsWith('audio/') || /\.(mp3|wav|flac|aac|ogg|m4a|opus|wma)$/i.test(n)) return 'audio';
  if (ARCHIVE_RE.test(n) || /(zip|tar|rar|gzip|x-7z)/i.test(m)) return 'archive';
  if (APP_RE.test(n)) return 'app';
  if (FONT_RE.test(n)) return 'font';
  if (DOC_RE.test(n) || /(document|spreadsheet|presentation)/i.test(m)) return 'document';
  if (CODE_RE.test(n) || m.startsWith('text/') || /(javascript|json|xml|yaml)/i.test(m)) return 'code';
  return 'other';
}

/** Coarse-grained categories used by dashboard filter pills.
 * Maps the fine-grained category into the legacy filter taxonomy. */
export type FilterCategory =
  | 'all'
  | 'images'
  | 'videos'
  | 'audio'
  | 'documents'
  | 'archives'
  | 'code'
  | 'other';

export function filterCategory(mime: string | undefined | null, name: string | undefined | null): FilterCategory {
  const c = fileCategory(mime, name);
  switch (c) {
    case 'image':
      return 'images';
    case 'video':
      return 'videos';
    case 'audio':
      return 'audio';
    case 'pdf':
    case 'document':
      return 'documents';
    case 'archive':
      return 'archives';
    case 'code':
      return 'code';
    default:
      return 'other';
  }
}

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'code' | 'markdown' | 'unsupported';

export function previewKind(mime: string | undefined | null, name: string | undefined | null): PreviewKind {
  const m = (mime || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (m.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif|svg)$/i.test(n)) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (/\.md$/i.test(n)) return 'markdown';
  if (m.startsWith('text/') || CODE_RE.test(n) || /(javascript|json|xml|yaml)/i.test(m)) return 'code';
  return 'unsupported';
}
