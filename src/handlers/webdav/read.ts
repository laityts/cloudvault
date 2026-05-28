import type { Env, FileMeta } from '../../utils/types';
import { getMimeType } from '../../utils/response';
import {
  multistatusResponse,
  propstatEntry,
  fileToProps,
  fileToHref,
  folderToProps,
  folderToHref,
} from '../../utils/webdav-xml';
import {
  findFileByFolderAndName,
  listFilesInFolder,
  listAllFiles,
} from '../../db/files';
import {
  parseDavPath,
  toFolder,
  toFileName,
  getFoldersMap,
  findFileByDavPath,
  isDirPath,
  collectChildFolders,
} from './shared';
import { buildR2Key } from '../../utils/keys';

export async function handlePropfind(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  const depth = request.headers.get('Depth') ?? '1';

  if (davPath === '') return propfindRoot(env, depth);

  const file = await findFileByDavPath(env, davPath);
  if (file) {
    return multistatusResponse([
      propstatEntry(fileToHref(file), fileToProps(file), false),
    ]);
  }

  const folders = await getFoldersMap(env);
  const allFiles = await listAllFiles(env);

  if (!isDirPath(davPath, folders, allFiles)) {
    return new Response('Not Found', { status: 404 });
  }

  const items: string[] = [
    propstatEntry(folderToHref(davPath), folderToProps(davPath, folders.get(davPath)), true),
  ];

  if (depth !== '0') {
    const directFiles = await listFilesInFolder(env, davPath);
    for (const f of directFiles) {
      items.push(propstatEntry(fileToHref(f), fileToProps(f), false));
    }

    const childNames = collectChildFolders(davPath, folders, allFiles);
    for (const cn of childNames) {
      const fullPath = davPath + '/' + cn;
      items.push(propstatEntry(folderToHref(fullPath), folderToProps(fullPath, folders.get(fullPath)), true));
    }
  }

  return multistatusResponse(items);
}

async function propfindRoot(env: Env, depth: string): Promise<Response> {
  const items: string[] = [
    propstatEntry(folderToHref(''), folderToProps('', new Date().toISOString()), true),
  ];

  if (depth !== '0') {
    const folders = await getFoldersMap(env);
    const allFiles = await listAllFiles(env);

    const rootFiles = allFiles.filter(f => f.folder === 'root');
    for (const f of rootFiles) {
      items.push(propstatEntry(fileToHref(f), fileToProps(f), false));
    }

    const topFolders = new Set<string>();
    for (const [name] of folders) topFolders.add(name.split('/')[0]!);
    for (const f of allFiles) {
      if (f.folder !== 'root') topFolders.add(f.folder.split('/')[0]!);
    }
    for (const tf of topFolders) {
      items.push(propstatEntry(folderToHref(tf), folderToProps(tf, folders.get(tf)), true));
    }
  }

  return multistatusResponse(items);
}

export async function handleGet(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  const folders = await getFoldersMap(env);
  const allFiles = await listAllFiles(env);
  const isDir = isDirPath(davPath, folders, allFiles);

  if (isDir) {
    const isBrowser = (request.headers.get('Accept') || '').includes('text/html');
    if (!isBrowser) {
      return new Response('', { status: 200, headers: { 'Content-Type': 'httpd/unix-directory' } });
    }
    return serveDirectoryListing(env, davPath, folders, allFiles);
  }

  const folder = toFolder(davPath);
  const name = toFileName(davPath);
  const file = await findFileByFolderAndName(env, folder, name);

  const r2Key = file ? file.key : buildR2Key(folder, name);
  const object = await env.VAULT_BUCKET.get(r2Key, {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (!object) return new Response('Not Found', { status: 404 });

  if (!('body' in object)) {
    return new Response('Preconditions failed', { status: 412 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Length', String(object.size));
  if (file) {
    headers.set('etag', '"' + file.id + '"');
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', file.type || getMimeType(file.name));
    }
  } else if (!headers.has('Content-Type')) {
    headers.set('Content-Type', getMimeType(name));
  }

  return new Response(object.body, { headers });
}

export async function handleHead(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);

  if (davPath) {
    const file = await findFileByDavPath(env, davPath);
    if (file) {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': file.type || getMimeType(file.name),
          'Content-Length': String(file.size),
          ETag: '"' + file.id + '"',
          'Last-Modified': new Date(file.uploadedAt).toUTCString(),
        },
      });
    }

    const folder = toFolder(davPath);
    const name = toFileName(davPath);
    const r2Key = buildR2Key(folder, name);
    const r2Head = await env.VAULT_BUCKET.head(r2Key);
    if (r2Head) {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': r2Head.httpMetadata?.contentType || getMimeType(name),
          'Content-Length': String(r2Head.size),
          'Last-Modified': r2Head.uploaded.toUTCString(),
        },
      });
    }
  }

  const folders = await getFoldersMap(env);
  const allFiles = await listAllFiles(env);
  if (isDirPath(davPath, folders, allFiles)) {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'httpd/unix-directory' },
    });
  }

  return new Response('Not Found', { status: 404 });
}

// ─── Directory listing (HTML for browser GET) ─────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function encodeDavHref(davPath: string, trailingSlash = false): string {
  if (!davPath) return '/dav/';
  const encoded = davPath.split('/').map(s => encodeURIComponent(s)).join('/');
  return '/dav/' + encoded + (trailingSlash ? '/' : '');
}

async function serveDirectoryListing(
  env: Env,
  davPath: string,
  folders: Map<string, string>,
  allFiles: FileMeta[],
): Promise<Response> {
  const displayPath = davPath || '/';
  const childFolders = collectChildFolders(davPath, folders, allFiles);

  const directFiles = davPath
    ? await listFilesInFolder(env, davPath)
    : await listFilesInFolder(env, 'root');
  directFiles.sort((a, b) => a.name.localeCompare(b.name));

  let rows = '';
  if (davPath) {
    const parentPath = davPath.includes('/') ? davPath.substring(0, davPath.lastIndexOf('/')) : '';
    rows += `<tr><td>📁</td><td><a href="${encodeDavHref(parentPath, true)}">..</a></td><td>—</td><td>—</td></tr>\n`;
  }
  for (const cf of childFolders) {
    const fullPath = davPath ? davPath + '/' + cf : cf;
    rows += `<tr><td>📁</td><td><a href="${encodeDavHref(fullPath, true)}">${escapeHtml(cf)}/</a></td><td>—</td><td>—</td></tr>\n`;
  }
  for (const f of directFiles) {
    const fullPath = davPath ? davPath + '/' + f.name : f.name;
    const date = f.uploadedAt ? new Date(f.uploadedAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
    rows += `<tr><td>📄</td><td><a href="${encodeDavHref(fullPath)}">${escapeHtml(f.name)}</a></td><td>${formatSize(f.size)}</td><td>${date}</td></tr>\n`;
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WebDAV — ${escapeHtml(displayPath)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#e0e0e0;background:#1a1a2e}
a{color:#82aaff;text-decoration:none}a:hover{text-decoration:underline}
table{border-collapse:collapse;width:100%;max-width:800px}th,td{text-align:left;padding:6px 12px;border-bottom:1px solid #333}
th{color:#888;font-size:13px}h1{font-size:18px;font-weight:500}</style></head>
<body><h1>Index of ${escapeHtml(displayPath)}</h1>
<table><thead><tr><th></th><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
<tbody>${rows}</tbody></table>
<p style="color:#555;font-size:12px;margin-top:2rem">CloudVault WebDAV</p></body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
