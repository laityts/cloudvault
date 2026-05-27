# KV → D1 迁移设计

- 日期：2026-05-27
- 范围：CloudVault Worker 全量 KV 数据迁移至 Cloudflare D1
- 策略：一次性硬切，不迁移存量

## 1. 背景与动机

CloudVault 当前所有结构化数据存储在单个 KV namespace `VAULT_KV` 下，按前缀划分共 9 类 key。主要痛点：

- 大量代码路径采用 `KV.list({prefix}) + 遍历 get + 内存过滤` 的模式，O(N) 读放大严重，典型场景包括：
  - WebDAV PROPFIND 列目录（`handlers/webdav.ts`）
  - 已分享文件夹聚合（`api/share.ts`）
  - 统计聚合（`api/stats.ts`）
- KV 不支持条件查询、索引、聚合，业务侧需要手工组合
- 累计计数器 `stats:totalSize` / `stats:totalFiles` 在并发写下存在丢失更新风险

迁移到 D1 把上述查询变成单条 SQL，并消除并发计数风险。

## 2. 决策摘要

| 决策项 | 结论 |
|------|------|
| 迁移范围 | 全部 9 类 KV 数据（含 Session、Settings） |
| 迁移策略 | 一次性硬切，新代码部署即生效，无双写过渡 |
| 存量数据 | 不迁移，部署后从零重建 |
| 表结构风格 | 范式化，按业务拆分 7 张表（share:<token> 反查合并入 files.share_token UNIQUE 索引）|
| Session 过期 | 懒删除 + 1% 概率机会性批量清理（`ctx.waitUntil`） |
| Stats 累计 | 删除计数器，改用 `SELECT COUNT/SUM` 实时聚合 |
| 代码组织 | 新增 `src/db/` 抽象层，业务模块只调函数不写 SQL |
| KV namespace | 部署后保留 binding 至清理 PR；KV namespace 本身在 CF 仪表盘手动删除 |

## 3. 绑定与配置变更

```jsonc
// wrangler.jsonc 差异
- "kv_namespaces": [
-   { "binding": "VAULT_KV", "id": "d4b3fc0694da47abbaba8cfc2093cad7" }
- ],
+ "d1_databases": [
+   { "binding": "VAULT_DB", "database_name": "cloudvault", "database_id": "<待创建>" }
+ ]
```

`src/utils/types.ts` 中 `Env` 接口：

```ts
- VAULT_KV: KVNamespace;
+ VAULT_DB: D1Database;
```

`KV_PREFIX` 常量整组删除。

## 4. 目录结构

```
src/
├── db/                    # 新增
│   ├── schema.sql         # 建表 DDL（作为 wrangler d1 migration）
│   ├── client.ts          # D1 帮助函数（执行/批处理封装）
│   ├── files.ts           # 文件元数据 CRUD + list
│   ├── folders.ts         # 文件夹 CRUD
│   ├── shares.ts          # 文件夹分享标记 / 排除 / 链接
│   ├── sessions.ts        # 会话 + 机会性清理
│   ├── settings.ts        # 站点设置
│   └── stats.ts           # 聚合查询
├── api/*.ts               # 改写：去掉 KV 调用，改调 db 层
├── handlers/*.ts          # 改写：同上
├── auth.ts                # 改写：sessions 经 db/sessions
├── utils/types.ts         # 改写：Env 绑定
└── index.ts               # 改写：把 ctx 传给 auth 中间件
```

## 5. D1 表结构

写入 `src/db/schema.sql`：

```sql
-- ── 文件元数据（替代 file:<id>，并并入 share:<token> 反查） ──
CREATE TABLE files (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL,             -- R2 object key
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
  path        TEXT PRIMARY KEY,              -- 完整路径，如 "photos/2024"
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

-- ── 文件夹分享链接（替代 foldersharelink:<token> + foldersharelink:meta:<folder>） ──
CREATE TABLE folder_share_links (
  token           TEXT PRIMARY KEY,
  folder          TEXT NOT NULL UNIQUE,      -- 每个文件夹至多一个有效链接
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
  key         TEXT PRIMARY KEY,              -- 当前仅 'site'
  value       TEXT NOT NULL                  -- JSON 字符串
);
```

### 关键设计点

1. **`share:<token>` 不单独建表**：合并到 `files.share_token` + `UNIQUE INDEX WHERE NOT NULL`，点查等价、写入少一次、无双向一致性风险。
2. **`foldersharelink` 双向映射合并**：原 KV 有 `<token>` 和 `meta:<folder>` 两条反向 key，D1 用 `folder` 上的 `UNIQUE` 替代。
3. **不建 stats 表**：所有统计经聚合查询，免并发问题。
4. **时间戳沿用 ISO 8601 TEXT**：与现有代码兼容，UTC 字符串字典序与时间序一致，可直接 `WHERE expires_at < ?` 比较。
5. **不引入通用 created_at / updated_at**：YAGNI。

## 6. DB 抽象层

### `src/db/client.ts`

极薄帮助，无 ORM：

```ts
import type { Env } from '../utils/types';

export const db = (env: Env) => env.VAULT_DB;

export async function batch(env: Env, statements: D1PreparedStatement[]) {
  return env.VAULT_DB.batch(statements);
}
```

### 模块函数签名（以 `db/files.ts` 为例）

```ts
import type { FileMeta } from '../utils/types';

export async function getFile(env: Env, id: string): Promise<FileMeta | null>;
export async function getFileByShareToken(env: Env, token: string): Promise<FileMeta | null>;
export async function putFile(env: Env, meta: FileMeta): Promise<void>;
export async function deleteFile(env: Env, id: string): Promise<void>;

export async function listFiles(env: Env, opts: {
  folder?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ files: FileMeta[]; cursor: string | null; total: number }>;

export async function listFilesByFolderPrefix(
  env: Env,
  folderPrefix: string,
): Promise<FileMeta[]>;
```

### 关键约定

- 每个模块内部提供 `rowToMeta(row)` 完成 snake_case → camelCase 转换；上层不接触列名
- 分页用复合游标 `(uploaded_at DESC, id)` 替代 KV 的不透明 cursor；查询 `LIMIT N+1`，多出的那条用于生成下一页游标
- 所有原 `while (cursor) { list + 遍历 get + 过滤 }` 改为一条 `WHERE ... LIKE '<prefix>%'` 或 `WHERE ... = ?` 的 SQL
- Session 机会性清理：`getSession` 命中后若 `Math.random() < 0.01`，通过 `ctx.waitUntil` 触发后台 `DELETE FROM sessions WHERE expires_at < ?`；不阻塞响应

## 7. 调用方改造清单

| 文件 | 变更摘要 |
|------|------|
| `wrangler.jsonc` | 删 `kv_namespaces`，加 `d1_databases` |
| `wrangler.example.jsonc` | 同步示例 |
| `src/utils/types.ts` | `VAULT_KV` → `VAULT_DB`；删 `KV_PREFIX` |
| `src/auth.ts` | 3 处 KV → `db/sessions` |
| `src/api/settings.ts` | 2 处 KV → `db/settings` |
| `src/api/stats.ts` | KV list+遍历 → `db/stats` 单批聚合 |
| `src/api/share.ts` | ~25 处 KV → `db/files` / `db/shares` |
| `src/api/files.ts` | ~10–20 处 KV → `db/files` / `db/folders` |
| `src/handlers/webdav.ts` | 18 处 KV → 新 db 函数（PROPFIND 收益最大） |
| `src/handlers/download.ts` | KV 调用 → `db/files` / `db/shares` |
| `src/index.ts` | 把 `ctx` 传到 auth 中间件用于 session 清理 |

## 8. 部署与回滚

### 部署步骤

```bash
# 1. 创建 D1
wrangler d1 create cloudvault    # → 记下 database_id 填回 wrangler.jsonc

# 2. 应用 schema
wrangler d1 execute cloudvault --remote --file=src/db/schema.sql

# 3. 部署 Worker（已配置 GitHub Actions）
git push origin main
```

部署完成的瞬间硬切；原 KV namespace 保留但不再读写。

### 用户侧影响

- 所有会话失效，需重新登录
- 站点设置回退默认值（站点名、Logo 等）
- 文件夹"已分享 / 已排除"标记需手动重设
- 已生成的文件分享链接、文件夹分享链接全部失效
- R2 中的实际文件保留，但元数据丢失，旧文件在 UI / WebDAV 中不可见 — 这是"不迁移存量"策略的固有代价
- 本设计不包含"扫 R2 重建 files 表"的恢复工具；若日后需要，单独立项

### 回滚预案

| 场景 | 处理 |
|------|------|
| schema 错误 | 修 schema.sql，`wrangler d1 execute --command="DROP TABLE ..."` 重建 |
| Worker 代码错误 | `wrangler rollback` 或 git revert 后重新部署；回滚到 KV 版本后，部署期间在 D1 写入的数据丢失（可接受） |
| D1 数据库损坏 | 删库重建，重建成本 ≈ 0 |

### 清理 PR（迁移稳定后单独执行）

- 删除 `wrangler.jsonc` 中的 `kv_namespaces`
- 在 CF 仪表盘手动删除 KV namespace `d4b3fc0694da47abbaba8cfc2093cad7`

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| D1 单库写入并发上限（每秒数百） | 个人云盘量级远低于此 |
| WebDAV PROPFIND 大目录单查询返回过多 | 用 `LIMIT` 分页；当前 KV 方案 1000/批限制等价存在 |
| `LIKE 'prefix%'` 索引使用 | `folder` 已建索引，前缀查询可走 |
| Session 机会性清理偶发慢 | 用 `ctx.waitUntil`，不阻塞响应 |
| 时间字符串比较 | 全部 UTC ISO 8601，字典序与时间序一致 |

## 10. 验证清单

部署后真机走一遍（本地不跑测试）：

1. 访客页 / 登录 / 仪表盘加载
2. 上传文件、新建文件夹、删除、重命名
3. 创建文件分享链接（带 / 不带密码）、访问、撤销
4. 创建文件夹分享链接，外部访问
5. WebDAV：挂载、PROPFIND 列目录、PUT 上传、DELETE
6. 统计页数字正确
7. 设置页保存后刷新仍生效
8. 登出后会话失效

## 11. 不在本设计范围

- 历史 KV 数据迁移工具
- 扫描 R2 重建 files 表的恢复脚本
- 多数据库 / 分片
- 任何 ORM 或 query builder 引入
- D1 binding 之外的 Worker 配置变更
