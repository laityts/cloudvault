# KV → D1 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CloudVault Worker 9 类 KV 数据全部迁移至 Cloudflare D1，采用一次性硬切、不迁存量、范式化 7 张表（share:<token> 反查合并入 files.share_token UNIQUE 索引）、新增 `src/db/` 抽象层。

**Architecture:** 业务层（`api/`、`handlers/`、`auth.ts`）只调用 `src/db/<entity>.ts` 中的纯函数；`src/db/` 层封装所有 D1 prepared statement 与行/对象映射，不写业务逻辑。Session 用懒删除 + 1% 概率机会性批量清理。Stats 全部走聚合 SQL，删除累加计数器。

**Tech Stack:** Cloudflare Workers + D1 + R2 + Wrangler v4，TypeScript 5.7，无 ORM，无测试框架（项目约定本地不跑测试，依赖类型检查 + 部署后真机验证）。

**Notes on testing approach:** 项目 CLAUDE.md 第 10 条明确"本地不跑测试"。本计划用以下手段替代严格 TDD：
1. 每个任务结束跑 `npx wrangler types && npx tsc --noEmit` 做类型检查（不部署、不联网）
2. 全部任务完成后部署到生产，按设计文档第 10 节的"验证清单"做真机验证
3. 小步提交，每个任务一个原子 commit，便于按需 revert

**Reference spec:** `docs/superpowers/specs/2026-05-27-kv-to-d1-migration-design.md`

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `src/db/schema.sql` | 新建 | D1 表结构 DDL |
| `src/db/client.ts` | 新建 | D1 帮助函数（batch 封装） |
| `src/db/files.ts` | 新建 | 文件元数据 CRUD + 列表 + 行映射 |
| `src/db/folders.ts` | 新建 | 文件夹 CRUD + 前缀查询 |
| `src/db/shares.ts` | 新建 | 文件夹分享标记 / 排除 / 分享链接 |
| `src/db/sessions.ts` | 新建 | 会话 CRUD + 机会性清理 |
| `src/db/settings.ts` | 新建 | 站点设置单行 |
| `src/db/stats.ts` | 新建 | 聚合统计 |
| `src/utils/types.ts` | 改 | `Env.VAULT_KV` → `VAULT_DB`，删 `KV_PREFIX` |
| `src/auth.ts` | 改 | 改调 `db/sessions`；增加机会性清理 |
| `src/api/settings.ts` | 改 | 改调 `db/settings` |
| `src/api/stats.ts` | 改 | 改调 `db/stats` 聚合 |
| `src/api/share.ts` | 改 | 改调 `db/files` / `db/shares` |
| `src/api/files.ts` | 改 | 改调 `db/files` / `db/folders` / `db/stats`（删除累加） |
| `src/handlers/webdav.ts` | 改 | 改调 `db/files` / `db/folders`（删除累加） |
| `src/handlers/download.ts` | 改 | 改调 `db/files` / `db/shares` |
| `src/index.ts` | 改 | （如需）传 ctx 给 auth 中间件 |
| `wrangler.jsonc` | 改 | 删 `kv_namespaces`，加 `d1_databases` |
| `wrangler.example.jsonc` | 改 | 同步示例 |

---

## Task 1: 创建 D1 数据库与 schema 文件

**Files:**
- Create: `src/db/schema.sql`

- [ ] **Step 1: 在 Cloudflare 创建 D1 数据库**

Run:

```bash
npx wrangler d1 create cloudvault
```

Expected: 输出 `database_id`（形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）。记下此 ID，下个任务用。如果命令报权限错，确认已 `wrangler login`。

- [ ] **Step 2: 创建 `src/db/schema.sql`**

```sql
-- ── 文件元数据（替代 file:<id>，并合并 share:<token> 反查） ──
CREATE TABLE files (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  type            TEXT NOT NULL,
  folder          TEXT NOT NULL DEFAULT '',
  uploaded_at     TEXT NOT NULL,
  share_token     TEXT,
  share_password  TEXT,
  share_expires_at TEXT,
  downloads       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_files_folder       ON files(folder);
CREATE INDEX idx_files_uploaded_at  ON files(uploaded_at DESC);
CREATE INDEX idx_files_downloads    ON files(downloads DESC);
CREATE UNIQUE INDEX idx_files_share_token
  ON files(share_token) WHERE share_token IS NOT NULL;

-- ── 虚拟文件夹（替代 folder:<path>） ──
CREATE TABLE folders (
  path        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ── 文件夹分享标记（替代 foldershare:<folder>） ──
CREATE TABLE folder_shares (
  folder      TEXT PRIMARY KEY,
  shared_at   TEXT NOT NULL
);

-- ── 文件夹分享排除（替代 foldershare-exclude:<folder>） ──
CREATE TABLE folder_share_excludes (
  folder      TEXT PRIMARY KEY,
  excluded_at TEXT NOT NULL
);

-- ── 文件夹分享链接（替代 foldersharelink:<token> + meta:<folder>） ──
CREATE TABLE folder_share_links (
  token           TEXT PRIMARY KEY,
  folder          TEXT NOT NULL UNIQUE,
  password_hash   TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_folder_share_links_folder ON folder_share_links(folder);

-- ── 会话（替代 session:<id>） ──
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ── 站点设置（替代 settings:<key>） ──
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);
```

- [ ] **Step 3: 应用 schema 到远端 D1**

Run:

```bash
npx wrangler d1 execute cloudvault --remote --file=src/db/schema.sql
```

Expected: 全部 CREATE 语句成功，无错误输出。

- [ ] **Step 4: 验证表已创建**

Run:

```bash
npx wrangler d1 execute cloudvault --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected: 输出包含 7 张表：files, folder_share_excludes, folder_share_links, folder_shares, folders, sessions, settings（外加 _cf_* / sqlite_* 系统表可忽略）。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat(db): 新增 D1 schema 与 8 张业务表"
```

---

## Task 2: 修改 wrangler.jsonc 绑定与 Env 类型

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `wrangler.example.jsonc`
- Modify: `src/utils/types.ts`

- [ ] **Step 1: 修改 `wrangler.jsonc`**

把 Task 1 拿到的 database_id 填入。完整文件：

```jsonc
{
  "name": "cloudvault",
  "account_id": "1e1608c0c2881e609398b115463574d1",
  "main": "src/index.ts",
  "compatibility_date": "2026-02-18",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "none",
    "run_worker_first": true
  },
  "r2_buckets": [
    {
      "binding": "VAULT_BUCKET",
      "bucket_name": "cloudvault-files"
    }
  ],
  "d1_databases": [
    {
      "binding": "VAULT_DB",
      "database_name": "cloudvault",
      "database_id": "<填入 Task 1 拿到的 database_id>"
    }
  ],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },
  "vars": {
    "ENVIRONMENT": "production"
  }
}
```

- [ ] **Step 2: 同步 `wrangler.example.jsonc`**

Read 当前内容，把示例中的 `kv_namespaces` 段替换为：

```jsonc
"d1_databases": [
  {
    "binding": "VAULT_DB",
    "database_name": "cloudvault",
    "database_id": "<your-d1-database-id>"
  }
]
```

- [ ] **Step 3: 修改 `src/utils/types.ts` 的 `Env` 接口**

把：

```ts
export interface Env {
  VAULT_BUCKET: R2Bucket;
  VAULT_KV: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ENVIRONMENT: string;
}
```

替换为：

```ts
export interface Env {
  VAULT_BUCKET: R2Bucket;
  VAULT_DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ENVIRONMENT: string;
}
```

- [ ] **Step 4: 删除 `src/utils/types.ts` 末尾的 KV_PREFIX 导出**

把整段：

```ts
// ─── KV Key Patterns ─────────────────────────────────────────────────
export const KV_PREFIX = {
  FILE: 'file:',
  SHARE: 'share:',
  FOLDER_SHARE: 'foldershare:',
  FOLDER_SHARE_EXCLUDE: 'foldershare-exclude:',
  FOLDER_SHARE_LINK: 'foldersharelink:',
  SESSION: 'session:',
  STATS: 'stats:',
  SETTINGS: 'settings:',
} as const;
```

整段删除。

- [ ] **Step 5: 重新生成 wrangler 类型**

Run:

```bash
npx wrangler types
```

Expected: 生成或更新 `worker-configuration.d.ts`，新类型中包含 `VAULT_DB: D1Database` 而不是 `VAULT_KV`。

- [ ] **Step 6: 跑一次类型检查（必然失败，符合预期）**

Run:

```bash
npx tsc --noEmit
```

Expected: 大量 `Property 'VAULT_KV' does not exist on type 'Env'` 与 `Cannot find name 'KV_PREFIX'`。这是预期的，由后续任务逐一修复。

- [ ] **Step 7: Commit**

```bash
git add wrangler.jsonc wrangler.example.jsonc src/utils/types.ts worker-configuration.d.ts
git commit -m "feat(env): 把 KVNamespace 绑定替换为 D1Database，删 KV_PREFIX"
```

---

## Task 3: 实现 `src/db/client.ts` 帮助层

**Files:**
- Create: `src/db/client.ts`

- [ ] **Step 1: 创建 `src/db/client.ts`**

```ts
import type { Env } from '../utils/types';

export const db = (env: Env): D1Database => env.VAULT_DB;

export async function batch(
  env: Env,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  return env.VAULT_DB.batch(statements);
}
```

- [ ] **Step 2: 类型检查（应通过此文件）**

Run:

```bash
npx tsc --noEmit src/db/client.ts
```

Expected: 该文件无新错误（其它文件的旧错误仍存在，忽略）。

- [ ] **Step 3: Commit**

```bash
git add src/db/client.ts
git commit -m "feat(db): 新增 D1 client 帮助层"
```

---

## Task 4: 实现 `src/db/files.ts`

**Files:**
- Create: `src/db/files.ts`

- [ ] **Step 1: 创建 `src/db/files.ts`，含行映射与全部 files 相关查询**

```ts
import type { Env, FileMeta } from '../utils/types';

interface FileRow {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  folder: string;
  uploaded_at: string;
  share_token: string | null;
  share_password: string | null;
  share_expires_at: string | null;
  downloads: number;
}

function rowToMeta(row: FileRow): FileMeta {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    size: row.size,
    type: row.type,
    folder: row.folder,
    uploadedAt: row.uploaded_at,
    shareToken: row.share_token,
    sharePassword: row.share_password,
    shareExpiresAt: row.share_expires_at,
    downloads: row.downloads,
  };
}

export async function getFile(env: Env, id: string): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE id = ?')
    .bind(id)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

export async function getFileByShareToken(
  env: Env,
  token: string,
): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE share_token = ?')
    .bind(token)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

export async function findFileByFolderAndName(
  env: Env,
  folder: string,
  name: string,
): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE folder = ? AND name = ?')
    .bind(folder, name)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

export async function putFile(env: Env, meta: FileMeta): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO files (id, key, name, size, type, folder, uploaded_at,
                          share_token, share_password, share_expires_at, downloads)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         key = excluded.key,
         name = excluded.name,
         size = excluded.size,
         type = excluded.type,
         folder = excluded.folder,
         uploaded_at = excluded.uploaded_at,
         share_token = excluded.share_token,
         share_password = excluded.share_password,
         share_expires_at = excluded.share_expires_at,
         downloads = excluded.downloads`,
    )
    .bind(
      meta.id, meta.key, meta.name, meta.size, meta.type, meta.folder,
      meta.uploadedAt, meta.shareToken, meta.sharePassword,
      meta.shareExpiresAt, meta.downloads,
    )
    .run();
}

export async function deleteFile(env: Env, id: string): Promise<void> {
  await env.VAULT_DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
}

export async function listFilesInFolder(
  env: Env,
  folder: string,
): Promise<FileMeta[]> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE folder = ? ORDER BY uploaded_at DESC')
    .bind(folder)
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function listFilesByFolderPrefix(
  env: Env,
  folderPrefix: string,
): Promise<FileMeta[]> {
  // 匹配 folder = prefix 或 folder LIKE 'prefix/%'
  const { results } = await env.VAULT_DB
    .prepare(
      `SELECT * FROM files
       WHERE folder = ? OR folder LIKE ?
       ORDER BY uploaded_at DESC`,
    )
    .bind(folderPrefix, folderPrefix + '/%')
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function searchFiles(
  env: Env,
  searchTerm: string,
): Promise<FileMeta[]> {
  const pattern = '%' + searchTerm.toLowerCase() + '%';
  const { results } = await env.VAULT_DB
    .prepare(
      `SELECT * FROM files
       WHERE LOWER(name) LIKE ?
       ORDER BY uploaded_at DESC`,
    )
    .bind(pattern)
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function listAllFiles(env: Env): Promise<FileMeta[]> {
  // 仅在确实需要全表（stats 聚合的备选、迁移期暂用）；调用方应优先使用更精确的查询
  const { results } = await env.VAULT_DB
    .prepare('SELECT * FROM files ORDER BY uploaded_at DESC')
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function incrementDownloads(env: Env, id: string): Promise<void> {
  await env.VAULT_DB
    .prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?')
    .bind(id)
    .run();
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit
```

Expected: `src/db/files.ts` 本身无错误（其它旧文件仍报 KV 相关错误，忽略）。

- [ ] **Step 3: Commit**

```bash
git add src/db/files.ts
git commit -m "feat(db): 新增 files 表 CRUD 与查询函数"
```

---

## Task 5: 实现 `src/db/folders.ts`

**Files:**
- Create: `src/db/folders.ts`

- [ ] **Step 1: 创建 `src/db/folders.ts`**

```ts
import type { Env } from '../utils/types';

export interface FolderRecord {
  path: string;
  name: string;
  createdAt: string;
}

interface FolderRow {
  path: string;
  name: string;
  created_at: string;
}

function rowToRecord(row: FolderRow): FolderRecord {
  return { path: row.path, name: row.name, createdAt: row.created_at };
}

export async function getFolder(
  env: Env,
  path: string,
): Promise<FolderRecord | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM folders WHERE path = ?')
    .bind(path)
    .first<FolderRow>();
  return row ? rowToRecord(row) : null;
}

export async function putFolder(
  env: Env,
  path: string,
  name?: string,
): Promise<void> {
  const folderName = name ?? path;
  const createdAt = new Date().toISOString();
  await env.VAULT_DB
    .prepare(
      `INSERT INTO folders (path, name, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         name = excluded.name`,
    )
    .bind(path, folderName, createdAt)
    .run();
}

export async function deleteFolder(env: Env, path: string): Promise<void> {
  await env.VAULT_DB.prepare('DELETE FROM folders WHERE path = ?').bind(path).run();
}

export async function deleteFoldersByPrefix(
  env: Env,
  pathPrefix: string,
): Promise<number> {
  const result = await env.VAULT_DB
    .prepare('DELETE FROM folders WHERE path = ? OR path LIKE ?')
    .bind(pathPrefix, pathPrefix + '/%')
    .run();
  return result.meta.changes;
}

export async function listFoldersByPrefix(
  env: Env,
  pathPrefix: string,
): Promise<FolderRecord[]> {
  const { results } = await env.VAULT_DB
    .prepare(
      'SELECT * FROM folders WHERE path = ? OR path LIKE ? ORDER BY path',
    )
    .bind(pathPrefix, pathPrefix + '/%')
    .all<FolderRow>();
  return (results || []).map(rowToRecord);
}

export async function listAllFolders(env: Env): Promise<FolderRecord[]> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT * FROM folders ORDER BY path')
    .all<FolderRow>();
  return (results || []).map(rowToRecord);
}

export async function renameFolderRecord(
  env: Env,
  oldPath: string,
  newPath: string,
  newName?: string,
): Promise<void> {
  const finalName = newName ?? newPath;
  await env.VAULT_DB
    .prepare('UPDATE folders SET path = ?, name = ? WHERE path = ?')
    .bind(newPath, finalName, oldPath)
    .run();
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/db/folders.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/db/folders.ts
git commit -m "feat(db): 新增 folders 表 CRUD 与前缀查询"
```

---

## Task 6: 实现 `src/db/shares.ts`

**Files:**
- Create: `src/db/shares.ts`

- [ ] **Step 1: 创建 `src/db/shares.ts`**

```ts
import type { Env } from '../utils/types';

// ── folder_shares（文件夹分享标记） ──

export async function isFolderShareMarked(
  env: Env,
  folder: string,
): Promise<boolean> {
  const row = await env.VAULT_DB
    .prepare('SELECT 1 FROM folder_shares WHERE folder = ?')
    .bind(folder)
    .first<{ '1': number }>();
  return row !== null;
}

export async function addFolderShare(env: Env, folder: string): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO folder_shares (folder, shared_at) VALUES (?, ?)
       ON CONFLICT(folder) DO NOTHING`,
    )
    .bind(folder, new Date().toISOString())
    .run();
}

export async function removeFolderShare(env: Env, folder: string): Promise<void> {
  await env.VAULT_DB
    .prepare('DELETE FROM folder_shares WHERE folder = ?')
    .bind(folder)
    .run();
}

export async function listSharedFolders(env: Env): Promise<Set<string>> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT folder FROM folder_shares')
    .all<{ folder: string }>();
  return new Set((results || []).map((r) => r.folder));
}

// ── folder_share_excludes ──

export async function isFolderExcluded(
  env: Env,
  folder: string,
): Promise<boolean> {
  const row = await env.VAULT_DB
    .prepare('SELECT 1 FROM folder_share_excludes WHERE folder = ?')
    .bind(folder)
    .first<{ '1': number }>();
  return row !== null;
}

export async function addFolderExclude(env: Env, folder: string): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO folder_share_excludes (folder, excluded_at) VALUES (?, ?)
       ON CONFLICT(folder) DO NOTHING`,
    )
    .bind(folder, new Date().toISOString())
    .run();
}

export async function removeFolderExclude(env: Env, folder: string): Promise<void> {
  await env.VAULT_DB
    .prepare('DELETE FROM folder_share_excludes WHERE folder = ?')
    .bind(folder)
    .run();
}

export async function listExcludedFolders(env: Env): Promise<Set<string>> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT folder FROM folder_share_excludes')
    .all<{ folder: string }>();
  return new Set((results || []).map((r) => r.folder));
}

// ── folder_share_links ──

export interface FolderShareLink {
  token: string;
  folder: string;
  passwordHash: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface FolderShareLinkRow {
  token: string;
  folder: string;
  password_hash: string | null;
  expires_at: string | null;
  created_at: string;
}

function linkRowToObj(row: FolderShareLinkRow): FolderShareLink {
  return {
    token: row.token,
    folder: row.folder,
    passwordHash: row.password_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function getFolderShareLinkByToken(
  env: Env,
  token: string,
): Promise<FolderShareLink | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM folder_share_links WHERE token = ?')
    .bind(token)
    .first<FolderShareLinkRow>();
  return row ? linkRowToObj(row) : null;
}

export async function getFolderShareLinkByFolder(
  env: Env,
  folder: string,
): Promise<FolderShareLink | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM folder_share_links WHERE folder = ?')
    .bind(folder)
    .first<FolderShareLinkRow>();
  return row ? linkRowToObj(row) : null;
}

export async function upsertFolderShareLink(
  env: Env,
  link: FolderShareLink,
): Promise<void> {
  // 由于 folder 上有 UNIQUE，先删除旧记录再插入新 token
  await env.VAULT_DB.batch([
    env.VAULT_DB.prepare('DELETE FROM folder_share_links WHERE folder = ?').bind(link.folder),
    env.VAULT_DB
      .prepare(
        `INSERT INTO folder_share_links (token, folder, password_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(link.token, link.folder, link.passwordHash, link.expiresAt, link.createdAt),
  ]);
}

export async function deleteFolderShareLinkByFolder(
  env: Env,
  folder: string,
): Promise<void> {
  await env.VAULT_DB
    .prepare('DELETE FROM folder_share_links WHERE folder = ?')
    .bind(folder)
    .run();
}

export async function deleteFolderShareLinksByFolderPrefix(
  env: Env,
  folderPrefix: string,
): Promise<void> {
  await env.VAULT_DB
    .prepare(
      'DELETE FROM folder_share_links WHERE folder = ? OR folder LIKE ?',
    )
    .bind(folderPrefix, folderPrefix + '/%')
    .run();
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/db/shares.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/db/shares.ts
git commit -m "feat(db): 新增 folder_shares/excludes/links CRUD 函数"
```

---

## Task 7: 实现 `src/db/sessions.ts`（含懒删 + 机会性清理）

**Files:**
- Create: `src/db/sessions.ts`

- [ ] **Step 1: 创建 `src/db/sessions.ts`**

```ts
import type { Env, Session } from '../utils/types';

interface SessionRow {
  id: string;
  created_at: string;
  expires_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function getSession(
  env: Env,
  id: string,
): Promise<Session | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(id)
    .first<SessionRow>();
  return row ? rowToSession(row) : null;
}

export async function putSession(env: Env, session: Session): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
    )
    .bind(session.id, session.createdAt, session.expiresAt)
    .run();
}

export async function deleteSession(env: Env, id: string): Promise<void> {
  await env.VAULT_DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

// 机会性清理：删除所有已过期会话；调用方应在 ctx.waitUntil 中触发以不阻塞响应
export async function purgeExpiredSessions(env: Env): Promise<void> {
  await env.VAULT_DB
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .bind(new Date().toISOString())
    .run();
}

export function shouldOpportunisticPurge(): boolean {
  return Math.random() < 0.01;
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/db/sessions.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/db/sessions.ts
git commit -m "feat(db): 新增 sessions CRUD 与机会性清理"
```

---

## Task 8: 实现 `src/db/settings.ts`

**Files:**
- Create: `src/db/settings.ts`

- [ ] **Step 1: 创建 `src/db/settings.ts`**

```ts
import type { Env, SiteSettings } from '../utils/types';
import { DEFAULT_SETTINGS } from '../utils/types';

const SITE_KEY = 'site';

export async function getSiteSettings(env: Env): Promise<SiteSettings> {
  const row = await env.VAULT_DB
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(SITE_KEY)
    .first<{ value: string }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function putSiteSettings(
  env: Env,
  settings: SiteSettings,
): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(SITE_KEY, JSON.stringify(settings))
    .run();
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/db/settings.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/db/settings.ts
git commit -m "feat(db): 新增 settings 单行表读写"
```

---

## Task 9: 实现 `src/db/stats.ts`（聚合查询）

**Files:**
- Create: `src/db/stats.ts`

- [ ] **Step 1: 创建 `src/db/stats.ts`**

```ts
import type { Env, FileMeta, StatsResponse } from '../utils/types';

interface FileRow {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  folder: string;
  uploaded_at: string;
  share_token: string | null;
  share_password: string | null;
  share_expires_at: string | null;
  downloads: number;
}

function rowToMeta(row: FileRow): FileMeta {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    size: row.size,
    type: row.type,
    folder: row.folder,
    uploadedAt: row.uploaded_at,
    shareToken: row.share_token,
    sharePassword: row.share_password,
    shareExpiresAt: row.share_expires_at,
    downloads: row.downloads,
  };
}

export async function computeStats(env: Env): Promise<StatsResponse> {
  const [totalsResult, recentResult, topResult] = await env.VAULT_DB.batch([
    env.VAULT_DB.prepare(
      `SELECT COUNT(*) AS totalFiles,
              COALESCE(SUM(size), 0) AS totalSize,
              COALESCE(SUM(downloads), 0) AS totalDownloads
       FROM files`,
    ),
    env.VAULT_DB.prepare(
      'SELECT * FROM files ORDER BY uploaded_at DESC LIMIT 5',
    ),
    env.VAULT_DB.prepare(
      'SELECT * FROM files WHERE downloads > 0 ORDER BY downloads DESC LIMIT 5',
    ),
  ]);

  const totals = (totalsResult.results?.[0] ?? {
    totalFiles: 0,
    totalSize: 0,
    totalDownloads: 0,
  }) as { totalFiles: number; totalSize: number; totalDownloads: number };

  const recentRows = (recentResult.results || []) as unknown as FileRow[];
  const topRows = (topResult.results || []) as unknown as FileRow[];

  return {
    totalFiles: totals.totalFiles,
    totalSize: totals.totalSize,
    totalDownloads: totals.totalDownloads,
    recentUploads: recentRows.map(rowToMeta),
    topDownloaded: topRows.map(rowToMeta),
  };
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/db/stats.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/db/stats.ts
git commit -m "feat(db): 新增 stats 聚合查询，取代累加计数"
```

---

## Task 10: 改造 `src/auth.ts`

**Files:**
- Modify: `src/auth.ts`

- [ ] **Step 1: 完整重写 `src/auth.ts`**

```ts
import type { Env, Session } from './utils/types';
import { json, error, redirect } from './utils/response';
import {
  getSession,
  putSession,
  deleteSession,
  purgeExpiredSessions,
  shouldOpportunisticPurge,
} from './db/sessions';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(input: string, storedHash: string): Promise<boolean> {
  const inputHash = await hashPassword(input);
  const encoder = new TextEncoder();
  const a = encoder.encode(inputHash);
  const b = encoder.encode(storedHash);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function createSession(env: Env): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  const session: Session = {
    id: sessionId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await putSession(env, session);

  const cookie = `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`;
  return { sessionId, cookie };
}

export async function validateSession(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<boolean> {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return false;

  const sessionId = match[1];
  const session = await getSession(env, sessionId);
  if (!session) return false;

  if (new Date(session.expiresAt) < new Date()) {
    await deleteSession(env, sessionId);
    return false;
  }

  // 机会性清理过期会话，不阻塞响应
  if (ctx && shouldOpportunisticPurge()) {
    ctx.waitUntil(purgeExpiredSessions(env));
  }

  return true;
}

function getSessionId(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return error('Method not allowed', 405);

  const contentType = request.headers.get('Content-Type') || '';
  let password: string;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData();
    password = formData.get('password') as string || '';
  } else if (contentType.includes('application/json')) {
    const body = await request.json<{ password: string }>();
    password = body.password || '';
  } else {
    return error('Unsupported content type', 415);
  }

  if (!password) return error('Password required', 400);

  const storedHash = await hashPassword(env.ADMIN_PASSWORD);
  const valid = await verifyPassword(password, storedHash);

  if (!valid) return error('Invalid password', 401);

  const { cookie } = await createSession(env);

  return new Response(JSON.stringify({ message: 'ok' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
      'Location': '/admin',
    },
  });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const sessionId = getSessionId(request);
  if (sessionId) {
    await deleteSession(env, sessionId);
  }
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

const PUBLIC_PREFIXES = ['/s/', '/auth/', '/login'];

export async function authMiddleware(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  for (const prefix of PUBLIC_PREFIXES) {
    if (url.pathname.startsWith(prefix)) return null;
  }
  if (url.pathname === '/login') return null;

  const valid = await validateSession(request, env, ctx);
  if (!valid) return redirect('/login');
  return null;
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/auth.ts
```

Expected: `src/auth.ts` 自身无错误。

- [ ] **Step 3: Commit**

```bash
git add src/auth.ts
git commit -m "refactor(auth): 把 session 改用 D1，新增机会性清理"
```

---

## Task 11: 改造 `src/api/settings.ts`

**Files:**
- Modify: `src/api/settings.ts`

- [ ] **Step 1: 完整重写 `src/api/settings.ts`**

```ts
import type { Env, SiteSettings } from '../utils/types';
import { json } from '../utils/response';
import { getSiteSettings, putSiteSettings } from '../db/settings';

export async function getSettings(env: Env): Promise<SiteSettings> {
  return getSiteSettings(env);
}

export async function handleGetSettings(_request: Request, env: Env): Promise<Response> {
  return json(await getSettings(env));
}

export async function handlePutSettings(request: Request, env: Env): Promise<Response> {
  const body = await request.json<Partial<SiteSettings>>();
  const current = await getSettings(env);

  if (typeof body.guestPageEnabled === 'boolean') {
    current.guestPageEnabled = body.guestPageEnabled;
  }
  if (typeof body.showLoginButton === 'boolean') {
    current.showLoginButton = body.showLoginButton;
  }
  if (typeof body.siteName === 'string') {
    current.siteName = body.siteName.trim().slice(0, 50) || 'CloudVault';
  }
  if (typeof body.siteIconUrl === 'string') {
    current.siteIconUrl = body.siteIconUrl.trim().slice(0, 500);
  }

  await putSiteSettings(env, current);
  return json(current);
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/api/settings.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/api/settings.ts
git commit -m "refactor(settings): 改读写 D1 settings 表"
```

---

## Task 12: 改造 `src/api/stats.ts`

**Files:**
- Modify: `src/api/stats.ts`

- [ ] **Step 1: 完整重写 `src/api/stats.ts`**

```ts
import type { Env } from '../utils/types';
import { json } from '../utils/response';
import { computeStats } from '../db/stats';

export async function getStats(_request: Request, env: Env): Promise<Response> {
  return json(await computeStats(env));
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/api/stats.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/api/stats.ts
git commit -m "refactor(stats): 改用 D1 聚合查询替代累加计数"
```

---

## Task 13: 改造 `src/api/share.ts`

**Files:**
- Modify: `src/api/share.ts`

- [ ] **Step 1: 完整重写 `src/api/share.ts`**

把整个文件替换为：

```ts
import type { Env, FileMeta } from '../utils/types';
import { json, error } from '../utils/response';
import { getSettings } from './settings';
import {
  getFile,
  putFile,
  listAllFiles,
  listFilesInFolder,
  listFilesByFolderPrefix,
} from '../db/files';
import { listFoldersByPrefix } from '../db/folders';
import {
  isFolderShareMarked,
  addFolderShare,
  removeFolderShare,
  listSharedFolders as dbListSharedFolders,
  isFolderExcluded,
  addFolderExclude,
  removeFolderExclude,
  listExcludedFolders as dbListExcludedFolders,
  getFolderShareLinkByToken,
  getFolderShareLinkByFolder,
  upsertFolderShareLink,
  deleteFolderShareLinkByFolder,
} from '../db/shares';

function extractFileId(url: URL): string | null {
  const parts = url.pathname.split('/');
  const idx = parts.indexOf('share');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : null;
}

async function hashSharePassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + ':cloudvault-share-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySharePassword(input: string, storedHash: string): Promise<boolean> {
  const inputHash = await hashSharePassword(input);
  const encoder = new TextEncoder();
  const a = encoder.encode(inputHash);
  const b = encoder.encode(storedHash);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

// ─── Folder Sharing Helpers ───────────────────────────────────────────

export async function getSharedFolders(env: Env): Promise<Set<string>> {
  return dbListSharedFolders(env);
}

export async function getExcludedFolders(env: Env): Promise<Set<string>> {
  return dbListExcludedFolders(env);
}

export function isFolderShared(folderPath: string, sharedFolders: Set<string>, excludedFolders?: Set<string>): boolean {
  if (!folderPath || folderPath === 'root') return false;
  if (excludedFolders?.has(folderPath)) return false;
  let current = folderPath;
  while (current) {
    if (sharedFolders.has(current)) return true;
    const lastSlash = current.lastIndexOf('/');
    if (lastSlash < 0) break;
    current = current.substring(0, lastSlash);
  }
  return false;
}

// ─── File Share CRUD ──────────────────────────────────────────────────

export async function createShare(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    fileId: string;
    password?: string;
    expiresInDays?: number;
  }>();

  if (!body.fileId) return error('fileId required', 400);

  const meta = await getFile(env, body.fileId);
  if (!meta) return error('File not found', 404);

  const token = crypto.randomUUID();
  let passwordHash: string | null = null;
  if (body.password) {
    passwordHash = await hashSharePassword(body.password);
  }

  let expiresAt: string | null = null;
  if (body.expiresInDays && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  meta.shareToken = token;
  meta.sharePassword = passwordHash;
  meta.shareExpiresAt = expiresAt;

  await putFile(env, meta);

  return json({
    token,
    url: '/s/' + token,
    expiresAt,
    hasPassword: !!passwordHash,
  });
}

export async function revokeShare(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fileId = extractFileId(url);
  if (!fileId) return error('File ID required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);

  meta.shareToken = null;
  meta.sharePassword = null;
  meta.shareExpiresAt = null;

  await putFile(env, meta);

  return json({ message: 'Share revoked' });
}

export async function getShareInfo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fileId = extractFileId(url);
  if (!fileId) return error('File ID required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);

  return json({
    fileId: meta.id,
    token: meta.shareToken,
    hasPassword: !!meta.sharePassword,
    expiresAt: meta.shareExpiresAt,
    downloads: meta.downloads,
  });
}

// ─── Folder Share Toggle ──────────────────────────────────────────────

export async function shareFolderToggle(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ folder: string }>();
  if (!body.folder?.trim()) return error('Folder name required', 400);

  const folder = body.folder.trim();
  const existing = await isFolderShareMarked(env, folder);

  if (existing) {
    await removeFolderShare(env, folder);
    return json({ shared: false, folder });
  }

  await addFolderShare(env, folder);
  return json({ shared: true, folder });
}

export async function listSharedFolders(_request: Request, env: Env): Promise<Response> {
  const folders = await getSharedFolders(env);
  return json({ folders: Array.from(folders).sort() });
}

export async function toggleFolderExclude(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ folder: string }>();
  if (!body.folder?.trim()) return error('Folder name required', 400);

  const folder = body.folder.trim();
  const existing = await isFolderExcluded(env, folder);

  if (existing) {
    await removeFolderExclude(env, folder);
    return json({ excluded: false, folder });
  }

  await addFolderExclude(env, folder);
  return json({ excluded: true, folder });
}

// ─── Folder Share Link CRUD ────────────────────────────────────────────

export async function createFolderShareLink(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    folder: string;
    password?: string;
    expiresInDays?: number;
  }>();

  if (!body.folder?.trim()) return error('Folder name required', 400);
  const folder = body.folder.trim();

  const token = crypto.randomUUID();
  let passwordHash: string | null = null;
  if (body.password) {
    passwordHash = await hashSharePassword(body.password);
  }

  let expiresAt: string | null = null;
  if (body.expiresInDays && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  await upsertFolderShareLink(env, {
    token,
    folder,
    passwordHash,
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  return json({
    token,
    url: '/s/' + token,
    expiresAt,
    hasPassword: !!passwordHash,
  });
}

export async function revokeFolderShareLink(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folder = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
  if (!folder) return error('Folder path required', 400);

  const existing = await getFolderShareLinkByFolder(env, folder);
  if (!existing) return error('No share link found for this folder', 404);

  await deleteFolderShareLinkByFolder(env, folder);
  return json({ message: 'Folder share link revoked' });
}

export async function getFolderShareLinkInfo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folder = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
  if (!folder) return error('Folder path required', 400);

  const link = await getFolderShareLinkByFolder(env, folder);
  if (!link) return json({ token: null });

  return json({
    folder,
    token: link.token,
    hasPassword: !!link.passwordHash,
    expiresAt: link.expiresAt,
  });
}

export async function resolveFolderShareToken(token: string, env: Env): Promise<{ folder: string; passwordHash: string | null; expiresAt: string | null } | null> {
  const link = await getFolderShareLinkByToken(env, token);
  if (!link) return null;
  return { folder: link.folder, passwordHash: link.passwordHash, expiresAt: link.expiresAt };
}

export async function browseFolderShareLink(folder: string, subpath: string, env: Env): Promise<{ files: Array<{ id: string; name: string; size: number; type: string; folder: string; uploadedAt: string }>; subfolders: string[] }> {
  const browsePath = subpath ? folder + '/' + subpath : folder;
  const prefix = browsePath + '/';

  const folderFiles = (await listFilesInFolder(env, browsePath)).map(f => ({
    id: f.id, name: f.name, size: f.size, type: f.type,
    folder: f.folder, uploadedAt: f.uploadedAt,
  }));

  // 子文件夹来源：(1) files 表中 folder LIKE 'browsePath/%' 的直接子级；(2) folders 表中同前缀的记录
  const subfolderSet = new Set<string>();

  const deeperFiles = await listFilesByFolderPrefix(env, browsePath);
  for (const f of deeperFiles) {
    if (f.folder.startsWith(prefix)) {
      const rest = f.folder.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
      if (childName) subfolderSet.add(prefix + childName);
    }
  }

  const folderRecords = await listFoldersByPrefix(env, browsePath);
  for (const fr of folderRecords) {
    if (fr.path.startsWith(prefix)) {
      const rest = fr.path.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
      if (childName) subfolderSet.add(prefix + childName);
    }
  }

  return { files: folderFiles, subfolders: Array.from(subfolderSet).sort() };
}

// ─── Public Shared Listing (with folder inheritance) ──────────────────

export async function listPublicShared(_request: Request, env: Env): Promise<Response> {
  const settings = await getSettings(env);
  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const allFiles = await listAllFiles(env);

  const visibleFolders = Array.from(sharedFolders).filter(sf => !excludedFolders.has(sf));

  const files: Array<{
    id: string; name: string; size: number; type: string;
    token: string | null; folder: string; uploadedAt: string;
  }> = [];

  for (const meta of allFiles) {
    const hasValidShareLink = !!meta.shareToken && !meta.sharePassword &&
      (!meta.shareExpiresAt || new Date(meta.shareExpiresAt) >= new Date());
    const inSharedFolder = isFolderShared(meta.folder, sharedFolders, excludedFolders);

    if (hasValidShareLink && !inSharedFolder) {
      files.push({
        id: meta.id, name: meta.name, size: meta.size, type: meta.type,
        token: meta.shareToken, folder: meta.folder, uploadedAt: meta.uploadedAt,
      });
    }
  }

  files.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return json({
    files,
    sharedFolders: visibleFolders.sort(),
    settings: { showLoginButton: settings.showLoginButton, siteName: settings.siteName, siteIconUrl: settings.siteIconUrl },
  });
}

// ─── Public Folder Browse ─────────────────────────────────────────────

export async function browsePublicFolder(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);

  if (!path) {
    const visibleFolders = Array.from(sharedFolders).filter(sf => !excludedFolders.has(sf));
    return json({ files: [], subfolders: visibleFolders.sort(), currentFolder: '' });
  }

  const isSharedOrChild = isFolderShared(path, sharedFolders, excludedFolders);
  const isAncestorOfShared = !isSharedOrChild && Array.from(sharedFolders).some(
    sf => sf.startsWith(path + '/') && !excludedFolders.has(sf)
  );

  if (!isSharedOrChild && !isAncestorOfShared) {
    return error('Folder not shared', 403);
  }

  const prefix = path + '/';

  let folderFiles: Array<{
    id: string; name: string; size: number; type: string;
    token: string | null; folder: string; uploadedAt: string;
  }> = [];

  if (isSharedOrChild) {
    folderFiles = (await listFilesInFolder(env, path)).map(f => ({
      id: f.id, name: f.name, size: f.size, type: f.type,
      token: f.shareToken || null, folder: f.folder, uploadedAt: f.uploadedAt,
    }));
  }

  const subfolderSet = new Set<string>();

  if (isAncestorOfShared) {
    for (const sf of sharedFolders) {
      if (sf.startsWith(prefix)) {
        const rest = sf.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
        if (childName) subfolderSet.add(prefix + childName);
      }
    }
  } else {
    const deeperFiles = await listFilesByFolderPrefix(env, path);
    for (const f of deeperFiles) {
      if (f.folder.startsWith(prefix)) {
        const rest = f.folder.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
        if (childName) subfolderSet.add(prefix + childName);
      }
    }
    const folderRecords = await listFoldersByPrefix(env, path);
    for (const fr of folderRecords) {
      if (fr.path.startsWith(prefix)) {
        const rest = fr.path.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
        if (childName) subfolderSet.add(prefix + childName);
      }
    }
  }

  for (const ex of excludedFolders) {
    subfolderSet.delete(ex);
    for (const sf of [...subfolderSet]) {
      if (sf.startsWith(ex + '/')) subfolderSet.delete(sf);
    }
  }

  return json({ files: folderFiles, subfolders: Array.from(subfolderSet).sort(), currentFolder: path });
}

// ─── Public File Download (folder-shared files) ──────────────────────

export async function publicDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const fileId = parts[parts.length - 1];
  if (!fileId) return error('File ID required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);

  const hasPublicLink = !!meta.shareToken && !meta.sharePassword &&
    (!meta.shareExpiresAt || new Date(meta.shareExpiresAt) >= new Date());
  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const inSharedFolder = isFolderShared(meta.folder, sharedFolders, excludedFolders);

  if (!hasPublicLink && !inSharedFolder) {
    return error('File not publicly accessible', 403);
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  meta.downloads++;
  await putFile(env, meta);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.name) + '"');
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/api/share.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/api/share.ts
git commit -m "refactor(share): 把所有 KV 调用替换为 db 层函数"
```

---

## Task 14: 改造 `src/api/files.ts`

**Files:**
- Modify: `src/api/files.ts`

- [ ] **Step 1: 完整重写 `src/api/files.ts`**

> 说明：删除原 `getAllFiles`、`updateStatsCounters` 两个本地函数；所有 KV 写入改用 db 层；`list` 使用 `listFilesInFolder` / `searchFiles` / `listFilesByFolderPrefix`；`deleteFolder` 与 `renameFolder` 改成 SQL 友好版（在 db 层用一次 SELECT + 多次 UPDATE 替代原 1+N 全表）。zipDownload 与 crc32 函数原样保留。

替换全文为：

```ts
import type { Env, FileMeta } from '../utils/types';
import { json, error, getMimeType } from '../utils/response';
import { getSharedFolders, getExcludedFolders, isFolderShared } from './share';
import {
  getFile,
  putFile,
  deleteFile,
  listFilesInFolder,
  listFilesByFolderPrefix,
  searchFiles,
} from '../db/files';
import {
  getFolder,
  putFolder,
  deleteFolder as dbDeleteFolder,
  deleteFoldersByPrefix,
  listAllFolders,
  listFoldersByPrefix,
  renameFolderRecord,
} from '../db/folders';
import {
  removeFolderShare,
  removeFolderExclude,
  deleteFolderShareLinkByFolder,
  deleteFolderShareLinksByFolderPrefix,
  addFolderShare,
  isFolderShareMarked,
  isFolderExcluded,
  addFolderExclude,
} from '../db/shares';

function extractId(url: URL): string | null {
  const parts = url.pathname.split('/');
  const idx = parts.indexOf('files');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : null;
}

export async function upload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'mpu-create') return handleMultipartCreate(request, env);
  if (action === 'mpu-upload') return handleMultipartUpload(request, env, url);
  if (action === 'mpu-complete') return handleMultipartComplete(request, env);

  return handleDirectUpload(request, env);
}

async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);

  const id = crypto.randomUUID();
  const key = folder === 'root' ? fileName : folder + '/' + fileName;

  if (!key || key.includes('..')) return error('Invalid file path', 400);

  const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
    customMetadata: { fileId: id },
  });

  if (!r2Object) return error('Upload failed', 500);

  const meta: FileMeta = {
    id,
    key,
    name: fileName,
    size: r2Object.size,
    type: contentType,
    folder,
    uploadedAt: new Date().toISOString(),
    shareToken: null,
    sharePassword: null,
    shareExpiresAt: null,
    downloads: 0,
  };

  await putFile(env, meta);

  return json(meta, 201);
}

async function handleMultipartCreate(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const key = folder === 'root' ? fileName : folder + '/' + fileName;

  const multipart = await env.VAULT_BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
  });

  return json({ uploadId: multipart.uploadId, key });
}

async function handleMultipartUpload(request: Request, env: Env, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = parseInt(url.searchParams.get('partNumber') || '0', 10);
  const key = url.searchParams.get('key');

  if (!uploadId || !partNumber || !key) return error('Missing uploadId, partNumber, or key', 400);

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await multipart.uploadPart(partNumber, request.body as ReadableStream);

  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function handleMultipartComplete(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    uploadId: string;
    key: string;
    parts: { partNumber: number; etag: string }[];
  }>();

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
  const r2Object = await multipart.complete(body.parts);

  const fileName = body.key.split('/').pop() || body.key;
  const folder = body.key.includes('/') ? body.key.substring(0, body.key.lastIndexOf('/')) : 'root';
  const id = crypto.randomUUID();

  const meta: FileMeta = {
    id,
    key: body.key,
    name: fileName,
    size: r2Object.size,
    type: r2Object.httpMetadata?.contentType || getMimeType(fileName),
    folder,
    uploadedAt: new Date().toISOString(),
    shareToken: null,
    sharePassword: null,
    shareExpiresAt: null,
    downloads: 0,
  };

  await putFile(env, meta);

  return json(meta, 201);
}

export async function list(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folderFilter = url.searchParams.get('folder');
  const searchFilter = url.searchParams.get('search')?.toLowerCase();

  let files: FileMeta[];
  if (searchFilter) {
    files = await searchFiles(env, searchFilter);
  } else if (folderFilter) {
    files = await listFilesInFolder(env, folderFilter);
  } else {
    files = await listFilesInFolder(env, 'root');
  }

  return json({ files, cursor: null, totalFiles: files.length });
}

export async function get(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractId(url);
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  return json(meta);
}

export async function download(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'private, max-age=14400');
  headers.set('Content-Disposition', 'attachment; filename="' + meta.name + '"');

  return new Response(object.body, { headers });
}

export async function deleteFiles(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  let ids: string[];

  if (request.method === 'DELETE') {
    const id = extractId(url);
    if (!id) return error('File ID required', 400);
    ids = [id];
  } else {
    const body = await request.json<{ ids: string[] }>();
    ids = body.ids;
  }

  if (!ids || ids.length === 0) return error('No file IDs provided', 400);

  for (const id of ids) {
    const meta = await getFile(env, id);
    if (!meta) continue;
    await env.VAULT_BUCKET.delete(meta.key);
    await deleteFile(env, id);
  }

  return json({ deleted: ids.length });
}

export async function rename(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractId(url);
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const body = await request.json<{ name: string }>();
  if (!body.name?.trim()) return error('Name required', 400);

  meta.name = body.name.trim();
  await putFile(env, meta);

  return json(meta);
}

export async function createFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ name: string; parent: string }>();
  if (!body.name?.trim()) return error('Folder name required', 400);

  const folderName = body.parent === 'root' ? body.name.trim() : body.parent + '/' + body.name.trim();
  await putFolder(env, folderName, folderName);

  return json({ folder: folderName }, 201);
}

export async function deleteFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ folder: string }>();
  if (!body.folder?.trim()) return error('Folder name required', 400);
  const folder = body.folder.trim();

  // 删除目录树记录 + 分享标记 + 排除标记 + 文件夹分享链接
  const deletedSubfolders = await deleteFoldersByPrefix(env, folder);
  await removeFolderShare(env, folder);
  await removeFolderExclude(env, folder);
  await deleteFolderShareLinkByFolder(env, folder);
  await deleteFolderShareLinksByFolderPrefix(env, folder);
  // 子目录的标记也清理
  const subFolders = await listFoldersByPrefix(env, folder);
  for (const sub of subFolders) {
    await removeFolderShare(env, sub.path);
    await removeFolderExclude(env, sub.path);
  }

  // 删除所有该目录及子目录下的文件
  const allFolderFiles = await listFilesByFolderPrefix(env, folder);
  let deletedFiles = 0;
  for (const file of allFolderFiles) {
    await env.VAULT_BUCKET.delete(file.key);
    await deleteFile(env, file.id);
    deletedFiles++;
  }

  return json({ deleted: folder, deletedFiles, deletedSubfolders });
}

export async function renameFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ oldName: string; newName: string }>();
  if (!body.oldName?.trim() || !body.newName?.trim()) return error('Both old and new names required', 400);
  const oldName = body.oldName.trim();
  const newName = body.newName.trim();
  if (oldName === newName) return json({ folder: newName });

  // 1. 重命名 folders 表
  const selfRecord = await getFolder(env, oldName);
  if (selfRecord) {
    await renameFolderRecord(env, oldName, newName, newName);
  } else {
    await putFolder(env, newName, newName);
  }
  const subFolders = await listFoldersByPrefix(env, oldName);
  for (const sub of subFolders) {
    if (sub.path === oldName) continue;
    const newSubPath = newName + sub.path.slice(oldName.length);
    await renameFolderRecord(env, sub.path, newSubPath, newSubPath);
  }

  // 2. 迁移文件夹分享标记
  if (await isFolderShareMarked(env, oldName)) {
    await removeFolderShare(env, oldName);
    await addFolderShare(env, newName);
  }
  if (await isFolderExcluded(env, oldName)) {
    await removeFolderExclude(env, oldName);
    await addFolderExclude(env, newName);
  }

  // 3. 移动 R2 文件 + 更新 files 表
  const affectedFiles = await listFilesByFolderPrefix(env, oldName);
  for (const file of affectedFiles) {
    const newFolder = newName + file.folder.slice(oldName.length);
    const newKey = newFolder === 'root' ? file.name : newFolder + '/' + file.name;
    const obj = await env.VAULT_BUCKET.get(file.key);
    if (obj) {
      await env.VAULT_BUCKET.put(newKey, obj.body, {
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
      });
      await env.VAULT_BUCKET.delete(file.key);
    }
    file.key = newKey;
    file.folder = newFolder;
    await putFile(env, file);
  }

  return json({ folder: newName });
}

export async function listFolders(_request: Request, env: Env): Promise<Response> {
  const folderRecords = await listAllFolders(env);
  const folderSet = new Set<string>();
  for (const fr of folderRecords) folderSet.add(fr.path);

  // 从文件中补齐（处理仅通过 R2 路径出现的隐式文件夹）
  // 注意：这里仍需读取全表文件以推导出隐式 folder。规模可控，可后续优化。
  const sql = `SELECT DISTINCT folder FROM files WHERE folder != 'root' AND folder != ''`;
  const { results } = await env.VAULT_DB.prepare(sql).all<{ folder: string }>();
  for (const r of results || []) folderSet.add(r.folder);

  // 补全中间父级
  for (const folder of [...folderSet]) {
    const parts = folder.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      folderSet.add(path);
    }
  }

  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const folderList = Array.from(folderSet).sort().map(name => ({
    name,
    shared: isFolderShared(name, sharedFolders, excludedFolders),
    directlyShared: sharedFolders.has(name),
    excluded: excludedFolders.has(name),
  }));

  return json({ folders: folderList });
}

export async function moveFiles(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ ids: string[]; targetFolder: string }>();
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.targetFolder === undefined) return error('Target folder required', 400);

  const targetFolder = body.targetFolder;
  let moved = 0;

  for (const id of body.ids) {
    const meta = await getFile(env, id);
    if (!meta) continue;
    if (meta.folder === targetFolder) continue;

    const newKey = targetFolder === 'root' ? meta.name : targetFolder + '/' + meta.name;

    const oldObject = await env.VAULT_BUCKET.get(meta.key);
    if (!oldObject) continue;

    await env.VAULT_BUCKET.put(newKey, oldObject.body, {
      httpMetadata: oldObject.httpMetadata,
      customMetadata: oldObject.customMetadata,
    });
    await env.VAULT_BUCKET.delete(meta.key);

    meta.key = newKey;
    meta.folder = targetFolder;
    await putFile(env, meta);
    moved++;
  }

  return json({ moved });
}

export async function thumbnail(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  if (!meta.type.startsWith('image/')) return error('Not an image', 400);

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');

  return new Response(object.body, { headers });
}

export async function preview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const rangeHeader = request.headers.get('Range');

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', meta.type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(meta.name) + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set('Accept-Ranges', 'bytes');

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const totalSize = object.size;
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      if (start >= totalSize || end >= totalSize || start > end) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': 'bytes */' + totalSize },
        });
      }
      headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + totalSize);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(object.body, { status: 206, headers });
    }
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

export async function zipDownload(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ ids: string[] }>();
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.ids.length > 100) return error('Max 100 files per zip', 400);

  const fileMetas: FileMeta[] = [];
  for (const id of body.ids) {
    const m = await getFile(env, id);
    if (m) fileMetas.push(m);
  }

  if (fileMetas.length === 0) return error('No valid files found', 404);

  if (fileMetas.length === 1) {
    const meta = fileMetas[0];
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) return error('File not found in storage', 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.name) + '"');
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const meta of fileMetas) {
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) continue;

    const fileData = new Uint8Array(await object.arrayBuffer());
    const fileName = encoder.encode(meta.name);
    const crc = crc32(fileData);

    const localHeader = new Uint8Array(30 + fileName.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, fileData.length, true);
    lv.setUint32(22, fileData.length, true);
    lv.setUint16(26, fileName.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(fileName, 30);

    const cdEntry = new Uint8Array(46 + fileName.length);
    const cv = new DataView(cdEntry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, fileData.length, true);
    cv.setUint32(24, fileData.length, true);
    cv.setUint16(28, fileName.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cdEntry.set(fileName, 46);

    parts.push(localHeader);
    parts.push(fileData);
    centralDir.push(cdEntry);
    offset += localHeader.length + fileData.length;
  }

  let cdSize = 0;
  for (const cd of centralDir) cdSize += cd.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centralDir.length, true);
  ev.setUint16(10, centralDir.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + cdSize + 22;
  const zipBuffer = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of parts) { zipBuffer.set(part, pos); pos += part.length; }
  for (const cd of centralDir) { zipBuffer.set(cd, pos); pos += cd.length; }
  zipBuffer.set(eocd, pos);

  const zipName = 'cloudvault-' + new Date().toISOString().slice(0, 10) + '.zip';
  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + zipName + '"',
      'Content-Length': String(totalSize),
    },
  });
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/api/files.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/api/files.ts
git commit -m "refactor(files): 把所有 KV 调用替换为 db 层函数"
```

---

## Task 15: 改造 `src/handlers/download.ts`

**Files:**
- Modify: `src/handlers/download.ts`

- [ ] **Step 1: 完整重写 `src/handlers/download.ts`**

```ts
import type { Env, FileMeta } from '../utils/types';
import { error, getPreviewType, fetchAssetHtml, injectBranding } from '../utils/response';
import { verifySharePassword, resolveFolderShareToken, browseFolderShareLink, getSharedFolders, getExcludedFolders, isFolderShared } from '../api/share';
import { getSettings } from '../api/settings';
import { getMimeType } from '../utils/response';
import {
  getFile,
  getFileByShareToken,
  putFile,
  findFileByFolderAndName,
} from '../db/files';

function extractToken(url: URL): string | null {
  const parts = url.pathname.split('/');
  const sIdx = parts.indexOf('s');
  return sIdx >= 0 && parts[sIdx + 1] ? parts[sIdx + 1] : null;
}

async function resolveShare(token: string, env: Env): Promise<{ meta: FileMeta; expired: boolean } | null> {
  const meta = await getFileByShareToken(env, token);
  if (!meta) return null;

  const expired = !!meta.shareExpiresAt && new Date(meta.shareExpiresAt) < new Date();
  return { meta, expired };
}

function hasValidShareCookie(request: Request, token: string): boolean {
  const cookies = request.headers.get('Cookie') || '';
  return cookies.includes('share_' + token + '=verified');
}

export async function handleSharePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const result = await resolveShare(token, env);
  if (result) {
    if (result.expired) {
      return serveShareHtml(env, request, { error: 'This share link has expired.' });
    }
    if (result.meta.sharePassword && !hasValidShareCookie(request, token)) {
      return serveShareHtml(env, request, { needsPassword: true });
    }
    return serveShareHtml(env, request, {
      name: result.meta.name,
      size: result.meta.size,
      type: result.meta.type,
      uploadedAt: result.meta.uploadedAt,
      downloads: result.meta.downloads,
      previewType: getPreviewType(result.meta.name, result.meta.type),
    });
  }

  const folderLink = await resolveFolderShareToken(token, env);
  if (!folderLink) {
    return serveShareHtml(env, request, { error: 'This share link is invalid or has been revoked.' });
  }

  if (folderLink.expiresAt && new Date(folderLink.expiresAt) < new Date()) {
    return serveShareHtml(env, request, { error: 'This share link has expired.' });
  }

  if (folderLink.passwordHash && !hasValidShareCookie(request, token)) {
    return serveShareHtml(env, request, { needsPassword: true, isFolder: true });
  }

  const subpath = url.searchParams.get('path') || '';
  const browseResult = await browseFolderShareLink(folderLink.folder, subpath, env);
  const folderName = folderLink.folder.split('/').pop() || folderLink.folder;

  return serveShareHtml(env, request, {
    isFolder: true,
    folderName,
    folder: folderLink.folder,
    subpath,
    files: browseResult.files,
    subfolders: browseResult.subfolders,
  });
}

export async function handleFolderShareDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const folderLink = await resolveFolderShareToken(token, env);
  if (!folderLink) return error('Share link invalid', 404);
  if (folderLink.expiresAt && new Date(folderLink.expiresAt) < new Date()) return error('Share link expired', 404);
  if (folderLink.passwordHash && !hasValidShareCookie(request, token)) return error('Password required', 403);

  const fileId = url.searchParams.get('fileId');
  if (!fileId) return error('fileId required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);
  if (!meta.folder.startsWith(folderLink.folder) && meta.folder !== folderLink.folder) {
    return error('File not in shared folder', 403);
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  meta.downloads++;
  await putFile(env, meta);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.name) + '"');
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
}

export async function handleFolderSharePreview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const folderLink = await resolveFolderShareToken(token, env);
  if (!folderLink) return error('Share link invalid', 404);
  if (folderLink.expiresAt && new Date(folderLink.expiresAt) < new Date()) return error('Share link expired', 404);
  if (folderLink.passwordHash && !hasValidShareCookie(request, token)) return error('Password required', 403);

  const fileId = url.searchParams.get('fileId');
  if (!fileId) return error('fileId required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);
  if (!meta.folder.startsWith(folderLink.folder) && meta.folder !== folderLink.folder) {
    return error('File not in shared folder', 403);
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', meta.type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');

  return new Response(object.body, { headers });
}

async function serveShareHtml(env: Env, request: Request, fileData: Record<string, unknown>): Promise<Response> {
  const settings = await getSettings(env);
  let html = await fetchAssetHtml(env.ASSETS, request.url, '/share.html');

  html = injectBranding(html, { siteName: settings.siteName, siteIconUrl: settings.siteIconUrl });
  html = html.replace(
    '<script id="file-data" type="application/json">{}</script>',
    '<script id="file-data" type="application/json">' + JSON.stringify(fileData) + '</script>'
  );

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function handleShareDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const result = await resolveShare(token, env);
  if (!result || result.expired) return error('Share link invalid or expired', 404);

  if (result.meta.sharePassword && !hasValidShareCookie(request, token)) {
    return error('Password required', 403);
  }

  const object = await env.VAULT_BUCKET.get(result.meta.key);
  if (!object) return error('File not found in storage', 404);

  result.meta.downloads++;
  await putFile(env, result.meta);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Content-Disposition', 'attachment; filename="' + result.meta.name + '"');
  headers.set('Content-Length', String(object.size));

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    return handleRangeRequest(request, env, result.meta, object, headers);
  }

  return new Response(object.body, { headers });
}

export async function handlePreview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const result = await resolveShare(token, env);
  if (!result || result.expired) return error('Share link invalid or expired', 404);

  if (result.meta.sharePassword && !hasValidShareCookie(request, token)) {
    return error('Password required', 403);
  }

  const rangeHeader = request.headers.get('Range');

  if (rangeHeader) {
    const object = await env.VAULT_BUCKET.get(result.meta.key);
    if (!object) return error('File not found', 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Content-Type', result.meta.type || 'application/octet-stream');
    headers.set('Accept-Ranges', 'bytes');

    return handleRangeRequest(request, env, result.meta, object, headers);
  }

  const object = await env.VAULT_BUCKET.get(result.meta.key);
  if (!object) return error('File not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', result.meta.type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Accept-Ranges', 'bytes');

  return new Response(object.body, { headers });
}

function handleRangeRequest(
  request: Request,
  _env: Env,
  _meta: FileMeta,
  object: R2ObjectBody,
  headers: Headers,
): Response {
  const rangeHeader = request.headers.get('Range') || '';
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);

  if (!match) {
    return new Response(object.body, { headers });
  }

  const totalSize = object.size;
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

  if (start >= totalSize || end >= totalSize || start > end) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + totalSize },
    });
  }

  headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + totalSize);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');

  return new Response(object.body, { status: 206, headers });
}

export async function handleSharePassword(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  let storedPassword: string | null = null;

  const result = await resolveShare(token, env);
  if (result) {
    storedPassword = result.meta.sharePassword;
  } else {
    const folderLink = await resolveFolderShareToken(token, env);
    if (folderLink) {
      storedPassword = folderLink.passwordHash;
    }
  }

  if (!storedPassword) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/s/' + token },
    });
  }

  const contentType = request.headers.get('Content-Type') || '';
  let password: string;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData();
    password = formData.get('password') as string || '';
  } else if (contentType.includes('application/json')) {
    const body = await request.json<{ password: string }>();
    password = body.password || '';
  } else {
    return error('Unsupported content type', 415);
  }

  const valid = await verifySharePassword(password, storedPassword);
  if (!valid) return error('Invalid password', 401);

  const cookieMaxAge = 24 * 60 * 60;
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/s/' + token,
      'Set-Cookie': 'share_' + token + '=verified; Path=/s/' + token + '; HttpOnly; Secure; SameSite=Lax; Max-Age=' + cookieMaxAge,
    },
  });
}

export async function handleCleanDownload(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }

  if (!decodedPath || !decodedPath.includes('/')) return null;

  const lastSlash = decodedPath.lastIndexOf('/');
  const folder = decodedPath.substring(0, lastSlash);
  const fileName = decodedPath.substring(lastSlash + 1);
  if (!folder || !fileName) return null;

  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  if (!isFolderShared(folder, sharedFolders, excludedFolders)) return null;

  const meta = await findFileByFolderAndName(env, folder, fileName);
  if (!meta) return null;

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return null;

  meta.downloads++;
  await putFile(env, meta);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Content-Length', String(object.size));
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', getMimeType(meta.name));
  }
  headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.name) + '"');

  return new Response(object.body, { headers });
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/handlers/download.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/handlers/download.ts
git commit -m "refactor(download): 把所有 KV 调用替换为 db 层函数"
```

---

## Task 16: 改造 `src/handlers/webdav.ts`

**Files:**
- Modify: `src/handlers/webdav.ts`

- [ ] **Step 1: 完整重写 `src/handlers/webdav.ts`**

```ts
import type { Env, FileMeta } from '../utils/types';
import { getMimeType } from '../utils/response';
import {
  multistatusResponse,
  propstatEntry,
  fileToProps,
  fileToHref,
  folderToProps,
  folderToHref,
} from '../utils/webdav-xml';
import {
  getFile,
  putFile,
  deleteFile,
  findFileByFolderAndName,
  listFilesInFolder,
  listFilesByFolderPrefix,
  listAllFiles,
} from '../db/files';
import {
  getFolder,
  putFolder,
  deleteFolder,
  deleteFoldersByPrefix,
  listAllFolders,
  listFoldersByPrefix,
} from '../db/folders';

const DAV_PREFIX = '/dav/';
const DAV_METHODS = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY';

function parseDavPath(request: Request): string {
  const url = new URL(request.url);
  const raw = decodeURIComponent(url.pathname.slice(DAV_PREFIX.length));
  return raw.replace(/\/+$/, '');
}

function toFolder(davPath: string): string {
  const idx = davPath.lastIndexOf('/');
  return idx < 0 ? 'root' : davPath.substring(0, idx);
}

function toFileName(davPath: string): string {
  return davPath.split('/').pop() || davPath;
}

function toR2Key(folder: string, name: string): string {
  return folder === 'root' ? name : folder + '/' + name;
}

async function getAllFoldersMap(env: Env): Promise<Map<string, string>> {
  const records = await listAllFolders(env);
  const map = new Map<string, string>();
  for (const r of records) map.set(r.path, r.createdAt);
  return map;
}

async function findFileByDavPath(env: Env, davPath: string): Promise<FileMeta | null> {
  const folder = toFolder(davPath);
  const name = toFileName(davPath);
  return findFileByFolderAndName(env, folder, name);
}

export async function handleWebDav(request: Request, env: Env): Promise<Response> {
  const method = request.method;

  switch (method) {
    case 'OPTIONS': return handleOptions();
    case 'PROPFIND': return handlePropfind(request, env);
    case 'GET': return handleGet(request, env);
    case 'HEAD': return handleHead(request, env);
    case 'PUT': return handlePut(request, env);
    case 'DELETE': return handleDelete(request, env);
    case 'MKCOL': return handleMkcol(request, env);
    case 'MOVE': return handleMove(request, env);
    case 'COPY': return handleCopy(request, env);
    default:
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: DAV_METHODS },
      });
  }
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: DAV_METHODS,
      DAV: '1',
      'MS-Author-Via': 'DAV',
    },
  });
}

async function handlePropfind(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  const depth = request.headers.get('Depth') ?? '1';

  if (davPath === '') {
    return propfindRoot(env, depth);
  }

  const file = await findFileByDavPath(env, davPath);
  if (file) {
    return multistatusResponse([
      propstatEntry(fileToHref(file), fileToProps(file), false),
    ]);
  }

  const folders = await getAllFoldersMap(env);
  // 仅用于判断目录是否存在 / 收集子文件夹时需要一些文件数据
  const directFiles = await listFilesInFolder(env, davPath);
  const deeperFiles = await listFilesByFolderPrefix(env, davPath);

  if (!isDirPath(davPath, folders, deeperFiles)) {
    return new Response('Not Found', { status: 404 });
  }

  const items: string[] = [
    propstatEntry(folderToHref(davPath), folderToProps(davPath, folders.get(davPath)), true),
  ];

  if (depth !== '0') {
    for (const f of directFiles) {
      items.push(propstatEntry(fileToHref(f), fileToProps(f), false));
    }

    const childNames = collectChildFolders(davPath, folders, deeperFiles);
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
    const folders = await getAllFoldersMap(env);
    const rootFiles = await listFilesInFolder(env, 'root');

    for (const f of rootFiles) {
      items.push(propstatEntry(fileToHref(f), fileToProps(f), false));
    }

    const topFolders = new Set<string>();
    for (const [name] of folders) {
      const top = name.split('/')[0];
      topFolders.add(top);
    }
    // 文件路径里的 top 也要算
    const allFilesForRoot = await listAllFiles(env);
    for (const f of allFilesForRoot) {
      if (f.folder !== 'root') {
        topFolders.add(f.folder.split('/')[0]);
      }
    }
    for (const tf of topFolders) {
      items.push(propstatEntry(folderToHref(tf), folderToProps(tf, folders.get(tf)), true));
    }
  }

  return multistatusResponse(items);
}

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

function isDirPath(davPath: string, folders: Map<string, string>, scopedFiles: FileMeta[]): boolean {
  if (!davPath) return true;
  return folders.has(davPath) || scopedFiles.some(f => f.folder === davPath || f.folder.startsWith(davPath + '/'));
}

function collectChildFolders(davPath: string, folders: Map<string, string>, scopedFiles: FileMeta[]): string[] {
  const childSet = new Set<string>();
  const prefix = davPath ? davPath + '/' : '';

  if (!davPath) {
    for (const [name] of folders) { childSet.add(name.split('/')[0]); }
    for (const f of scopedFiles) { if (f.folder !== 'root') childSet.add(f.folder.split('/')[0]); }
  } else {
    for (const [name] of folders) {
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')) {
        childSet.add(name.slice(prefix.length));
      }
    }
    for (const f of scopedFiles) {
      if (f.folder.startsWith(prefix) && !f.folder.slice(prefix.length).includes('/')) {
        childSet.add(f.folder.slice(prefix.length));
      }
    }
  }

  return [...childSet].sort();
}

async function serveDirectoryListing(
  _env: Env,
  davPath: string,
  folders: Map<string, string>,
  directFiles: FileMeta[],
  scopedFiles: FileMeta[],
): Promise<Response> {
  const displayPath = davPath || '/';
  const childFolders = collectChildFolders(davPath, folders, scopedFiles);

  const sortedFiles = [...directFiles].sort((a, b) => a.name.localeCompare(b.name));

  let rows = '';
  if (davPath) {
    const parentPath = davPath.includes('/') ? davPath.substring(0, davPath.lastIndexOf('/')) : '';
    rows += `<tr><td>📁</td><td><a href="${encodeDavHref(parentPath, true)}">..</a></td><td>—</td><td>—</td></tr>\n`;
  }
  for (const cf of childFolders) {
    const fullPath = davPath ? davPath + '/' + cf : cf;
    rows += `<tr><td>📁</td><td><a href="${encodeDavHref(fullPath, true)}">${escapeHtml(cf)}/</a></td><td>—</td><td>—</td></tr>\n`;
  }
  for (const f of sortedFiles) {
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

async function handleGet(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  const folders = await getAllFoldersMap(env);
  // 用作目录判断的 scope 数据：根目录看全表；子目录看前缀
  const scopedFiles = davPath ? await listFilesByFolderPrefix(env, davPath) : await listAllFiles(env);
  const isDir = isDirPath(davPath, folders, scopedFiles);

  if (isDir) {
    const isBrowser = (request.headers.get('Accept') || '').includes('text/html');
    if (!isBrowser) return new Response('', { status: 200, headers: { 'Content-Type': 'httpd/unix-directory' } });
    const directFiles = davPath ? await listFilesInFolder(env, davPath) : await listFilesInFolder(env, 'root');
    return serveDirectoryListing(env, davPath, folders, directFiles, scopedFiles);
  }

  const folder = toFolder(davPath);
  const name = toFileName(davPath);
  const file = await findFileByFolderAndName(env, folder, name);

  const r2Key = file ? file.key : toR2Key(folder, name);
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

async function handleHead(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);

  if (davPath) {
    const folder = toFolder(davPath);
    const name = toFileName(davPath);
    const file = await findFileByFolderAndName(env, folder, name);
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

    const r2Key = toR2Key(folder, name);
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

  const folders = await getAllFoldersMap(env);
  const scopedFiles = davPath ? await listFilesByFolderPrefix(env, davPath) : await listAllFiles(env);

  if (isDirPath(davPath, folders, scopedFiles)) {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'httpd/unix-directory' },
    });
  }

  return new Response('Not Found', { status: 404 });
}

async function handlePut(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot PUT to root', { status: 405 });
  if (davPath.includes('..')) return new Response('Invalid path', { status: 400 });

  const folder = toFolder(davPath);
  const fileName = toFileName(davPath);
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const key = toR2Key(folder, fileName);

  const existingFile = await findFileByDavPath(env, davPath);

  if (existingFile) {
    await env.VAULT_BUCKET.delete(existingFile.key);
    const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
      httpMetadata: {
        contentType,
        contentDisposition: 'attachment; filename="' + fileName + '"',
      },
      customMetadata: { fileId: existingFile.id },
    });
    if (!r2Object) return new Response('Upload failed', { status: 500 });

    existingFile.key = key;
    existingFile.size = r2Object.size;
    existingFile.type = contentType;
    existingFile.uploadedAt = new Date().toISOString();
    await putFile(env, existingFile);

    return new Response(null, { status: 204 });
  }

  if (folder !== 'root') {
    await ensureFolderChain(env, folder);
  }

  const id = crypto.randomUUID();
  const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
    customMetadata: { fileId: id },
  });
  if (!r2Object) return new Response('Upload failed', { status: 500 });

  const meta: FileMeta = {
    id,
    key,
    name: fileName,
    size: r2Object.size,
    type: contentType,
    folder,
    uploadedAt: new Date().toISOString(),
    shareToken: null,
    sharePassword: null,
    shareExpiresAt: null,
    downloads: 0,
  };

  await putFile(env, meta);

  return new Response(null, { status: 201 });
}

async function ensureFolderChain(env: Env, folderPath: string): Promise<void> {
  const parts = folderPath.split('/');
  let path = '';
  for (const part of parts) {
    path = path ? path + '/' + part : part;
    const existing = await getFolder(env, path);
    if (!existing) {
      await putFolder(env, path, path);
    }
  }
}

async function handleDelete(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot DELETE root', { status: 403 });

  const file = await findFileByDavPath(env, davPath);
  if (file) {
    await env.VAULT_BUCKET.delete(file.key);
    await deleteFile(env, file.id);
    return new Response(null, { status: 204 });
  }

  const folders = await getAllFoldersMap(env);
  const scopedFiles = await listFilesByFolderPrefix(env, davPath);
  const isFolder = folders.has(davPath) || scopedFiles.length > 0;

  if (!isFolder) return new Response('Not Found', { status: 404 });

  await deleteFolder(env, davPath);
  await deleteFoldersByPrefix(env, davPath);

  for (const f of scopedFiles) {
    await env.VAULT_BUCKET.delete(f.key);
    await deleteFile(env, f.id);
  }

  return new Response(null, { status: 204 });
}

async function handleMkcol(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot MKCOL root', { status: 405 });

  const body = await request.text();
  if (body) return new Response('Unsupported Media Type', { status: 415 });

  const existingFile = await findFileByDavPath(env, davPath);
  if (existingFile) return new Response('Conflict', { status: 409 });

  const existing = await getFolder(env, davPath);
  if (existing) return new Response('Method Not Allowed', { status: 405 });

  const parentPath = davPath.includes('/') ? davPath.substring(0, davPath.lastIndexOf('/')) : '';
  if (parentPath) {
    const parent = await getFolder(env, parentPath);
    if (!parent) {
      const parentFiles = await listFilesByFolderPrefix(env, parentPath);
      if (parentFiles.length === 0) return new Response('Conflict', { status: 409 });
    }
  }

  await putFolder(env, davPath, davPath);

  return new Response('Created', { status: 201 });
}

async function handleMove(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot MOVE root', { status: 403 });

  const destination = parseDestination(request);
  if (!destination) return new Response('Bad Request', { status: 400 });

  const overwrite = request.headers.get('Overwrite') !== 'F';

  const file = await findFileByDavPath(env, davPath);
  if (file) {
    const destFile = await findFileByDavPath(env, destination);
    if (destFile && !overwrite) return new Response('Precondition Failed', { status: 412 });

    if (destFile) {
      await env.VAULT_BUCKET.delete(destFile.key);
      await deleteFile(env, destFile.id);
    }

    const newFolder = toFolder(destination);
    const newName = toFileName(destination);
    const newKey = toR2Key(newFolder, newName);

    if (newFolder !== 'root') await ensureFolderChain(env, newFolder);

    const object = await env.VAULT_BUCKET.get(file.key);
    if (!object) return new Response('Not Found', { status: 404 });

    await env.VAULT_BUCKET.put(newKey, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });
    await env.VAULT_BUCKET.delete(file.key);

    file.key = newKey;
    file.folder = newFolder;
    file.name = newName;
    await putFile(env, file);

    return new Response(null, { status: destFile ? 204 : 201 });
  }

  return new Response('Not Found', { status: 404 });
}

async function handleCopy(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot COPY root', { status: 403 });

  const destination = parseDestination(request);
  if (!destination) return new Response('Bad Request', { status: 400 });

  const overwrite = request.headers.get('Overwrite') !== 'F';

  const file = await findFileByDavPath(env, davPath);
  if (!file) return new Response('Not Found', { status: 404 });

  const destFile = await findFileByDavPath(env, destination);
  if (destFile && !overwrite) return new Response('Precondition Failed', { status: 412 });

  if (destFile) {
    await env.VAULT_BUCKET.delete(destFile.key);
    await deleteFile(env, destFile.id);
  }

  const newFolder = toFolder(destination);
  const newName = toFileName(destination);
  const newKey = toR2Key(newFolder, newName);
  const newId = crypto.randomUUID();

  if (newFolder !== 'root') await ensureFolderChain(env, newFolder);

  const object = await env.VAULT_BUCKET.get(file.key);
  if (!object) return new Response('Not Found', { status: 404 });

  await env.VAULT_BUCKET.put(newKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: { fileId: newId },
  });

  const meta: FileMeta = {
    id: newId,
    key: newKey,
    name: newName,
    size: file.size,
    type: file.type,
    folder: newFolder,
    uploadedAt: new Date().toISOString(),
    shareToken: null,
    sharePassword: null,
    shareExpiresAt: null,
    downloads: 0,
  };

  await putFile(env, meta);

  return new Response(null, { status: destFile ? 204 : 201 });
}

function parseDestination(request: Request): string | null {
  const dest = request.headers.get('Destination');
  if (!dest) return null;

  try {
    const url = new URL(dest);
    const decoded = decodeURIComponent(url.pathname);
    if (!decoded.startsWith(DAV_PREFIX)) return null;
    return decoded.slice(DAV_PREFIX.length).replace(/\/+$/, '');
  } catch {
    const decoded = decodeURIComponent(dest);
    if (!decoded.startsWith(DAV_PREFIX)) return null;
    return decoded.slice(DAV_PREFIX.length).replace(/\/+$/, '');
  }
}
```

- [ ] **Step 2: 类型检查**

Run:

```bash
npx tsc --noEmit src/handlers/webdav.ts
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/handlers/webdav.ts
git commit -m "refactor(webdav): 把所有 KV 调用替换为 db 层函数"
```

---

## Task 17: 改造 `src/index.ts` 把 ctx 传给 auth

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 修改 `validateSession` / `authMiddleware` 的调用点，传入 ctx**

只改变两处：

- 第 123 行 `const isAuth = await validateSession(request, env);` → `const isAuth = await validateSession(request, env, ctx);`
- 第 97-98 行的 admin 路由处 `const authResponse = await authMiddleware(request, env);` → `const authResponse = await authMiddleware(request, env, ctx);`
- 第 108-109 行的 `/api/` 路由处 `const authResponse = await authMiddleware(request, env);` → `const authResponse = await authMiddleware(request, env, ctx);`

> 还有 `handleRootPage(request, env)` 内部 `validateSession(request, env)` 的调用，给 `handleRootPage` 加一个可选 `ctx?: ExecutionContext` 参数并向上层传透。

具体 edits：

把 `src/index.ts` 第 92-93 行：

```ts
      if (path === '/' && method === 'GET') {
        return await handleRootPage(request, env);
      }
```

替换为：

```ts
      if (path === '/' && method === 'GET') {
        return await handleRootPage(request, env, ctx);
      }
```

把 `src/index.ts` 第 96-98 行：

```ts
      if (path === '/admin' && method === 'GET') {
        const authResponse = await authMiddleware(request, env);
        if (authResponse) return authResponse;
```

替换为：

```ts
      if (path === '/admin' && method === 'GET') {
        const authResponse = await authMiddleware(request, env, ctx);
        if (authResponse) return authResponse;
```

把 `src/index.ts` 第 107-109 行：

```ts
      if (path.startsWith('/api/')) {
        const authResponse = await authMiddleware(request, env);
        if (authResponse) return authResponse;
```

替换为：

```ts
      if (path.startsWith('/api/')) {
        const authResponse = await authMiddleware(request, env, ctx);
        if (authResponse) return authResponse;
```

把第 123 行：

```ts
      const isAuth = await validateSession(request, env);
```

替换为：

```ts
      const isAuth = await validateSession(request, env, ctx);
```

修改 `handleRootPage` 函数签名（第 136 行）：

```ts
async function handleRootPage(request: Request, env: Env): Promise<Response> {
```

→

```ts
async function handleRootPage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
```

以及函数体内第 141 行：

```ts
    const isAuth = await validateSession(request, env);
```

→

```ts
    const isAuth = await validateSession(request, env, ctx);
```

- [ ] **Step 2: 全项目类型检查**

Run:

```bash
npx tsc --noEmit
```

Expected: 无错误。如有错误，按提示修复（理应都来自前面任务漏改的小细节）。

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor(index): 把 ctx 传给 auth 中间件以支持机会性 session 清理"
```

---

## Task 18: 全项目类型校验与最终自检

**Files:** 无修改

- [ ] **Step 1: 全量类型检查**

Run:

```bash
npx tsc --noEmit
```

Expected: 无任何错误。

- [ ] **Step 2: 静态扫描，确保所有 KV 引用已清理**

Run:

```bash
grep -rn "VAULT_KV\|KV_PREFIX\|KVNamespace" src/ || echo "OK: no KV references remain"
```

Expected: 输出 `OK: no KV references remain`。

- [ ] **Step 3: 校验 wrangler 配置**

Run:

```bash
npx wrangler deploy --dry-run --outdir=/tmp/cloudvault-dryrun
```

Expected: dry-run 成功，无配置错误，无类型错误。最终一行应为构建产物大小信息。

- [ ] **Step 4（无需 commit）**

无文件变更，跳过 commit。

---

## Task 19: 部署到生产并真机验证

**Files:** 无修改

- [ ] **Step 1: 推送触发 CI 部署**

Run:

```bash
git push origin main
```

Expected: 触发 GitHub Actions 工作流，自动部署到 Cloudflare。

- [ ] **Step 2: 验证部署成功**

Run:

```bash
gh run list --limit 1
```

Expected: 最近一次 workflow 状态为 `success`。如失败，跑 `gh run view --log-failed` 看日志。

- [ ] **Step 3: 真机验证（按设计 spec 第 10 节清单）**

依次手动操作生产站点（清单见 `docs/superpowers/specs/2026-05-27-kv-to-d1-migration-design.md` 第 10 节）：

1. 访问首页 → 看到访客页或重定向到登录页（依设置）
2. 登录 → 进入 `/admin` 仪表盘加载成功
3. 上传一个文件 → 出现在列表
4. 新建文件夹 → 出现在文件夹树
5. 删除该文件 / 该文件夹 → 列表更新
6. 创建文件分享链接（无密码）→ 在另一浏览器访问 `/s/<token>` 成功下载
7. 创建文件分享链接（带密码）→ 验证密码后下载
8. 撤销分享链接 → `/s/<token>` 返回 invalid
9. 创建文件夹分享链接 → 外部浏览能看到文件、能下载
10. 挂载 WebDAV，列目录 / PUT 文件 / DELETE 文件
11. 打开 `/admin` 的统计页 → 数字正确（与已上传文件一致）
12. 设置页修改站点名 → 保存后刷新仍生效
13. 登出 → 跳转登录页，原 cookie 不再有效

如任一项失败，定位问题、修复、重新部署。

- [ ] **Step 4: 检查 D1 实际数据**

Run:

```bash
npx wrangler d1 execute cloudvault --remote --command="SELECT COUNT(*) AS files FROM files; SELECT COUNT(*) AS sessions FROM sessions; SELECT COUNT(*) AS settings FROM settings;"
```

Expected: 数字与你实际操作一致（至少有 1 个 session 和 1 行 settings）。

- [ ] **Step 5（可选）：移除 KV namespace 绑定**

在确认运行稳定一段时间（例如 24 小时）后：

修改 `wrangler.jsonc`，确保 `kv_namespaces` 段已删除（Task 2 已做）。然后在 Cloudflare 仪表盘手动删除 KV namespace `d4b3fc0694da47abbaba8cfc2093cad7`。

> 此步骤不需要 commit，因为 Task 2 已完成。但如发现 wrangler.jsonc 中还残留 KV 段，立即修正并提交一个 `chore: 清理废弃 KV namespace 绑定` commit。

---

## Self-Review

**1. Spec coverage 检查**

| Spec 章节 | 实现 Task |
|----------|-----------|
| §3 绑定与配置变更 | Task 2 |
| §4 目录结构 | Task 3-9 创建，Task 10-16 改造 |
| §5 D1 表结构（含 8 项关键设计点）| Task 1 |
| §6 DB 抽象层（client + 模块） | Task 3-9 |
| §7 调用方改造清单 | Task 10-17 |
| §8 部署与回滚 | Task 19 + 设计文档已记录回滚预案 |
| §9 风险与缓解 | 设计文档；本计划用 `ctx.waitUntil` + 单查询批处理 + 索引落实 |
| §10 验证清单 | Task 19 Step 3 |

**2. Placeholder scan**

无 TODO / TBD / "implement later" / 模糊"add error handling"等表述。Task 19 Step 5 末尾有可选步骤但已说明条件与判定。

**3. Type consistency**

- `FileMeta` 接口字段（`uploadedAt`, `shareToken` etc.）在 Task 4/5/6/7/8/9/13/14/15/16 中始终用 camelCase；db 层 row 始终是 snake_case，通过 `rowToMeta` / `linkRowToObj` 统一映射 ✅
- `Env.VAULT_DB`：在所有 db/* 模块、auth.ts、所有改造模块中一致 ✅
- `getFile`/`putFile`/`deleteFile` 等签名在 Task 4 定义，被 Task 13/14/15/16 一致引用 ✅
- `listFilesByFolderPrefix` 命名在 Task 4 定义，Task 13/14/15/16 调用一致 ✅
- `purgeExpiredSessions` + `shouldOpportunisticPurge` 在 Task 7 定义，Task 10 引用一致 ✅
- `upsertFolderShareLink` 接受 `FolderShareLink` 对象（含 createdAt）：Task 6 定义、Task 13 调用一致 ✅
- 旧 `KV_PREFIX.SHARE`（`share:<token>`）的功能合并到 `files.share_token` 列：Task 1（UNIQUE INDEX）+ Task 4（`getFileByShareToken`）+ Task 13/15（不再单独写）一致 ✅

**4. Ambiguity 检查**

- Task 19 Step 2 部署使用 GitHub Actions：项目已有 `.github/workflows/`（git log 中 `47a4340 ci:` 提交），`git push origin main` 自动部署
- 所有"完整重写文件"任务都给出了全文，避免按行号 patch 出错
- 类型检查目标统一为 `npx tsc --noEmit`，不依赖测试框架

**所有 spec 要求均有 task 对应，所有 task 步骤可独立执行。**
