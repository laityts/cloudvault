# 大文件 zip 修复 + 内容唯一性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决大文件批量打包 zip 损坏（CRC32 byte-wise 计算超 Worker CPU 时间限制）+ 防止内容重复上传（基于 SHA-256 的预检 + 上传时再检 + 清理工具）。

**Architecture:**
- 把 `crc32Update` 从 byte-wise LSB-first 替换为 slicing-by-8 表查算法（提速 5-8 倍），保持函数签名不变。
- 引入"客户端算 SHA-256 + 服务端预检 + 上传入口再检 + 写 D1 前再检"四重判重，配合新增 `GET /api/files/duplicates` 列表接口供清理工具使用，删除直接复用现有 `/api/files/delete`。
- 不加 `UNIQUE(sha256)` schema 约束（旧数据可能有重复，留作后续阶段）。

**Tech Stack:** TypeScript, Cloudflare Workers, R2, D1（SQLite），SolidJS（前端），Web SubtleCrypto（浏览器算 SHA）。

**Spec：** `docs/superpowers/specs/2026-05-29-large-zip-and-content-uniqueness-design.md`

---

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `src/api/media.ts` | zip 打包；含 `crc32Update` / `crc32Final` / `CRC32_TABLES` | 替换 `crc32Update` 实现，新增表预计算常量 |
| `src/db/migrations/003_add_sha256_index.sql` | D1 sha256 字段索引 | 新建 |
| `src/db/files.ts` | D1 文件层；新增 `findFileBySha256` / `listDuplicatesBySha256` | 在末尾新增两个导出函数 |
| `src/api/files.ts` | 上传 + CRUD；新增 `precheck` / `listDuplicates`；改 `handleDirectUpload` / `handleMultipartCreate` / `handleMultipartComplete` | 新增 + 改造 |
| `src/index.ts` | 路由表 | 新增 `POST /api/files/precheck` 与 `GET /api/files/duplicates` 两条路由 |
| `web/src/utils/hash.ts` | 浏览器算 SHA-256 | 新建 |
| `web/src/api/index.ts` | 前端 API 层；新增 `precheckFiles` / `listDuplicates`；`directUpload` 与 `multipartCreate` 调用方支持传 `X-File-Sha256` | 新增 + 改造 |
| `web/src/features/upload/uploadManager.ts` | 上传管理器；选完文件后预检 + 拒绝重复 + 上传时 header 携带 sha | 改造 |
| `web/src/features/duplicates/DuplicatesDialog.tsx`（或同等位置）| 清理重复 UI | 新建 |
| `web/src/apps/dashboard.tsx` | 接入清理重复入口 | 在工具栏 / 设置区加按钮 |

无新增的服务端实用工具文件——CRC32 表和 SHA 查询都直接放在已有的 `media.ts` / `db/files.ts` 中。

---

## Task 1：CRC32 改 slicing-by-8

**Files:**
- Modify: `src/api/media.ts`

**目标：** 把 `crc32Update` 的 byte-wise 实现替换为 slicing-by-8 表查算法。`CRC32_INIT`、`crc32Final`、调用方 `zipDownload` 全部不变。

- [ ] **Step 1：阅读现有实现**

读 `src/api/media.ts:127-141`，确认现有：

```ts
const CRC32_INIT = 0xFFFFFFFF;

function crc32Update(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return crc;
}

function crc32Final(crc: number): number {
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

- [ ] **Step 2：替换为 slicing-by-8**

把上述 `CRC32_INIT` + `crc32Update` 整体替换为下述代码（`crc32Final` 保留原样）：

```ts
const CRC32_INIT = 0xFFFFFFFF;

const CRC32_TABLES: Uint32Array[] = (() => {
  const t: Uint32Array[] = Array.from({ length: 8 }, () => new Uint32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[0]![n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[0]![n]!;
    for (let k = 1; k < 8; k++) {
      c = (t[0]![c & 0xff]! ^ (c >>> 8)) >>> 0;
      t[k]![n] = c;
    }
  }
  return t;
})();

function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc >>> 0;
  let i = 0;
  const len = data.length;
  const aligned = len - (len % 8);

  // 主循环：每次吃 8 字节
  while (i < aligned) {
    const b0 = data[i]!,     b1 = data[i + 1]!, b2 = data[i + 2]!, b3 = data[i + 3]!;
    const b4 = data[i + 4]!, b5 = data[i + 5]!, b6 = data[i + 6]!, b7 = data[i + 7]!;
    const lo = ((c ^ b0) & 0xff) | (((c >>> 8) ^ b1) & 0xff) << 8 | (((c >>> 16) ^ b2) & 0xff) << 16 | (((c >>> 24) ^ b3) & 0xff) << 24;
    c = (
      CRC32_TABLES[7]![lo & 0xff]! ^
      CRC32_TABLES[6]![(lo >>> 8) & 0xff]! ^
      CRC32_TABLES[5]![(lo >>> 16) & 0xff]! ^
      CRC32_TABLES[4]![(lo >>> 24) & 0xff]! ^
      CRC32_TABLES[3]![b4]! ^
      CRC32_TABLES[2]![b5]! ^
      CRC32_TABLES[1]![b6]! ^
      CRC32_TABLES[0]![b7]!
    ) >>> 0;
    i += 8;
  }

  // 尾巴 byte-wise
  while (i < len) {
    c = (CRC32_TABLES[0]![(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
    i++;
  }

  return c;
}

function crc32Final(crc: number): number {
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

要点：
- `c >>> 0` 反复出现是为了把 V8 内部的 int32 有符号表示**强制规范化**为 uint32（正数）——位运算结果默认是有符号 int32，`>>> 0` 转 uint32。在 hot path 上多写几次保证表查 `[c & 0xff]` 不会因为 `c` 是负数而越界。
- `lo` 的构造：把 `(c XOR data[i..i+3])` 的 4 个字节按小端序拼成 uint32。这是 slicing-by-8 LSB-first 标准做法。
- 8 张表 × 256 项 × 4 字节 = 8 KB，启动时一次性算。

- [ ] **Step 3：写正确性自验脚本**

新建临时文件 `/tmp/crc32-verify.mjs`（验证完即删，**不**入仓）：

```js
// /tmp/crc32-verify.mjs —— 验证 slicing-by-8 与已知标准值一致
// 已知：CRC32("123456789") = 0xCBF43926
// 已知：CRC32("") = 0x00000000
// 已知：CRC32("a") = 0xE8B7BE43

const CRC32_TABLES = (() => {
  const t = Array.from({ length: 8 }, () => new Uint32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[0][n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[0][n];
    for (let k = 1; k < 8; k++) {
      c = (t[0][c & 0xff] ^ (c >>> 8)) >>> 0;
      t[k][n] = c;
    }
  }
  return t;
})();

function crc32(s) {
  const data = new TextEncoder().encode(s);
  let c = 0xFFFFFFFF;
  let i = 0;
  const len = data.length;
  const aligned = len - (len % 8);
  while (i < aligned) {
    const b0 = data[i],     b1 = data[i + 1], b2 = data[i + 2], b3 = data[i + 3];
    const b4 = data[i + 4], b5 = data[i + 5], b6 = data[i + 6], b7 = data[i + 7];
    const lo = ((c ^ b0) & 0xff) | (((c >>> 8) ^ b1) & 0xff) << 8 | (((c >>> 16) ^ b2) & 0xff) << 16 | (((c >>> 24) ^ b3) & 0xff) << 24;
    c = (
      CRC32_TABLES[7][lo & 0xff] ^
      CRC32_TABLES[6][(lo >>> 8) & 0xff] ^
      CRC32_TABLES[5][(lo >>> 16) & 0xff] ^
      CRC32_TABLES[4][(lo >>> 24) & 0xff] ^
      CRC32_TABLES[3][b4] ^
      CRC32_TABLES[2][b5] ^
      CRC32_TABLES[1][b6] ^
      CRC32_TABLES[0][b7]
    ) >>> 0;
    i += 8;
  }
  while (i < len) {
    c = (CRC32_TABLES[0][(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    i++;
  }
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

const cases = [
  { input: '', expected: '00000000' },
  { input: 'a', expected: 'e8b7be43' },
  { input: '123456789', expected: 'cbf43926' },
  { input: 'The quick brown fox jumps over the lazy dog', expected: '414fa339' },
  // 大于 8 字节但非 8 倍数（测试尾巴 byte-wise 路径）
  { input: 'hello world', expected: '0d4a1185' },
  // 32 字节（测试纯 slicing-by-8 路径，无尾巴）
  { input: 'abcdefghijklmnopqrstuvwxyz012345', expected: '624d474c' },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = crc32(c.input);
  if (got === c.expected) {
    console.log(`PASS  "${c.input.slice(0, 20)}" → ${got}`);
    pass++;
  } else {
    console.log(`FAIL  "${c.input.slice(0, 20)}" → got ${got}, expected ${c.expected}`);
    fail++;
  }
}
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

Run: `node /tmp/crc32-verify.mjs`
Expected: `6 pass, 0 fail`

如果有 fail，**停下来**对照标准值 [https://crccalc.com/](https://crccalc.com/)（不要联网，离线复算）找出哪个案例错；常见 bug：
- 表预计算 `c >>> 0` 漏写 → 表项变负数 → 索引出错。
- `lo` 拼接字节序写反 → 主循环结果偏移。
- 主循环 `+= 8` 写成 `+= 4` → 数据漏读一半。

注意：上面 hello world / 32 字节案例的 expected 值如果你不确定，可以**先**用旧 byte-wise 实现算一次作为基准（在替换前临时跑一遍），再用新实现对照。

- [ ] **Step 4：清理验证脚本**

```bash
rm /tmp/crc32-verify.mjs
```

- [ ] **Step 5：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6：构建**

Run: `npm run build`
Expected: `vite build` 成功 + `wrangler deploy --dry-run` 成功。

- [ ] **Step 7：grep 验证旧实现已替换**

Run: `grep -n "crc & 1 ? 0xEDB88320" src/api/media.ts`
Expected: 无输出（旧 byte-wise 算法已不存在）。

Run: `grep -n "CRC32_TABLES" src/api/media.ts`
Expected: 至少 5 行（定义 1 行 + 主循环 4-5 行 + 尾巴 1 行）。

- [ ] **Step 8：提交**

```bash
git add src/api/media.ts
git commit -m "perf(api/media): CRC32 改 slicing-by-8 提速 5-8 倍"
```

---

## Task 2：D1 sha256 索引 migration

**Files:**
- Create: `src/db/migrations/003_add_sha256_index.sql`

**目标：** 为 `files.sha256` 字段加索引，确保 `findFileBySha256` 查询 O(log n) 而非全表扫描。

- [ ] **Step 1：阅读已有 migrations 风格**

读 `src/db/migrations/001_add_file_hashes.sql` 与 `002_optimize_search.sql`，确认头部注释格式。

- [ ] **Step 2：新建 migration**

创建 `src/db/migrations/003_add_sha256_index.sql`：

```sql
-- 为 sha256 字段添加索引，加速基于内容的去重查询
-- Apply with: wrangler d1 execute cloudvault --file=src/db/migrations/003_add_sha256_index.sql

CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
```

- [ ] **Step 3：本地构建验证**

Run: `npm run build`
Expected: 成功（migration 文件不参与 build，只是确认改动没影响构建）。

- [ ] **Step 4：提交**

```bash
git add src/db/migrations/003_add_sha256_index.sql
git commit -m "feat(db): 新增 sha256 索引 migration"
```

注意：**不**在本任务中执行 `wrangler d1 execute` 应用 migration。生产 D1 数据库的 migration 应用应当由用户手动执行（避免 plan 自动改生产 DB）。本任务只是把 migration 文件入仓。

---

## Task 3：D1 层新增 SHA-256 查询函数

**Files:**
- Modify: `src/db/files.ts`（在文件末尾追加两个函数）

**目标：** 实现 `findFileBySha256(env, sha256)` 与 `listDuplicatesBySha256(env)`，供后续 API 层调用。

- [ ] **Step 1：阅读现有 D1 层**

读 `src/db/files.ts`，确认：
- `FileRow` 接口和 `rowToMeta` 函数已存在
- 现有查询函数模式（`findFileByFolderAndName` 是 `WHERE folder = ? AND name = ?` 的范例）

- [ ] **Step 2：在文件末尾追加两个函数**

打开 `src/db/files.ts`，在最后一个 `export` 之后追加：

```ts
/** 按 SHA-256 查找文件（用于内容去重）。 */
export async function findFileBySha256(env: Env, sha256: string): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE sha256 = ? LIMIT 1')
    .bind(sha256)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

/** 列出所有 SHA-256 重复的文件，按 sha256 分组、组内按 uploaded_at 升序。 */
export async function listDuplicatesBySha256(env: Env): Promise<Array<{ sha256: string; files: FileMeta[] }>> {
  const { results } = await env.VAULT_DB
    .prepare(
      `SELECT * FROM files
       WHERE sha256 IS NOT NULL
         AND sha256 IN (
           SELECT sha256 FROM files
           WHERE sha256 IS NOT NULL
           GROUP BY sha256
           HAVING COUNT(*) > 1
         )
       ORDER BY sha256, uploaded_at`,
    )
    .all<FileRow>();

  const groups = new Map<string, FileMeta[]>();
  for (const row of results ?? []) {
    const meta = rowToMeta(row);
    if (!meta.sha256) continue;
    let arr = groups.get(meta.sha256);
    if (!arr) {
      arr = [];
      groups.set(meta.sha256, arr);
    }
    arr.push(meta);
  }
  return Array.from(groups, ([sha256, files]) => ({ sha256, files }));
}
```

- [ ] **Step 3：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 4：grep 验证**

Run: `grep -n "findFileBySha256\|listDuplicatesBySha256" src/db/files.ts`
Expected: 各 1 行（函数定义）。

- [ ] **Step 5：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 6：提交**

```bash
git add src/db/files.ts
git commit -m "feat(db): 新增 sha256 查重与重复列表查询"
```

---

## Task 4：服务端预检接口 `POST /api/files/precheck`

**Files:**
- Modify: `src/api/files.ts`（在末尾导出新 handler）
- Modify: `src/index.ts`（路由表新增一行）

**目标：** 接收 `{ sha256s: string[] }`，批量查 D1，返回 `{ results: [{ sha256, exists, existing? }] }`。

- [ ] **Step 1：阅读 src/api/files.ts 顶部 import 与 helper**

读 `src/api/files.ts:1-28`，确认现有 import：

```ts
import { error, json, parseJson } from '../utils/response';
import { getFile, putFile, deleteFile, ... } from '../db/files';
```

- [ ] **Step 2：在 import 区追加 `findFileBySha256` 引用**

打开 `src/api/files.ts`，在已有 `import { ... } from '../db/files';` 行中追加 `findFileBySha256`：

例如把：
```ts
import { getFile, putFile, deleteFile, listFilesInFolder, searchFiles, updateFileHashes } from '../db/files';
```
（实际现有行可能略不同——以现有内容为准，保留原 imports，**追加** `findFileBySha256`）

改为：
```ts
import { getFile, putFile, deleteFile, listFilesInFolder, searchFiles, updateFileHashes, findFileBySha256 } from '../db/files';
```

- [ ] **Step 3：在文件末尾添加 `precheck` handler**

```ts
const SHA256_RE = /^[0-9a-f]{64}$/;
const PRECHECK_MAX = 200;

export async function precheck(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ sha256s: string[] }>(request);
  if (!Array.isArray(body.sha256s)) return error('sha256s array required', 400);
  if (body.sha256s.length === 0) return json({ results: [] });
  if (body.sha256s.length > PRECHECK_MAX) return error(`Max ${PRECHECK_MAX} sha256s per request`, 400);

  const normalized: string[] = [];
  for (const s of body.sha256s) {
    if (typeof s !== 'string' || !SHA256_RE.test(s.toLowerCase())) {
      return error('Invalid sha256 in list', 400);
    }
    normalized.push(s.toLowerCase());
  }

  const results = await Promise.all(
    normalized.map(async (sha256) => {
      const existing = await findFileBySha256(env, sha256);
      if (!existing) return { sha256, exists: false as const };
      return {
        sha256,
        exists: true as const,
        existing: {
          id: existing.id,
          name: existing.name,
          folder: existing.folder,
          size: existing.size,
        },
      };
    }),
  );

  return json({ results });
}
```

要点：
- 200 上限避免 D1 单批查询参数列表过大。
- 用 `Promise.all` 是因为 D1 单条 PK/索引查询很快（< 10ms）；不并发的话 200 个查询就要串行 2s。如果担心连接限制可改 4 worker pool（参考 Task 3 of 上一轮 plan），但这里读多写少，应当无压力。
- 把 sha256 全部小写规范化，避免大小写差异。

- [ ] **Step 4：在路由表中新增路由**

修改 `src/index.ts`，找到「Files API」区段（约第 49-63 行），在 `'/api/files/zip'` 路由之后、`'/api/files/:id/thumbnail'` 之前插入一行：

```ts
  { method: 'POST', pattern: '/api/files/precheck', middleware: [authMiddleware], handler: files.precheck },
```

确认插入位置不会与 `'/api/files/:id'` 等含通配段的路由冲突——`precheck` 是字面段，路由器优先匹配字面段（参考现有 `'/api/files/upload'`、`'/api/files/delete'` 等同级写法）。

- [ ] **Step 5：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 7：grep 验证**

Run: `grep -n "precheck" src/api/files.ts src/index.ts`
Expected:
- `src/api/files.ts` 至少 2 行（函数定义 + import 不会出现 precheck，所以只匹配 `export async function precheck`）
- `src/index.ts` 1 行（路由注册）

- [ ] **Step 8：提交**

```bash
git add src/api/files.ts src/index.ts
git commit -m "feat(api/files): 新增 SHA-256 批量预检接口"
```

---

## Task 5：服务端上传入口 SHA-256 重复检查

**Files:**
- Modify: `src/api/files.ts`（改 `handleDirectUpload`、`handleMultipartCreate`、`handleMultipartComplete`）

**目标：** 在三个上传入口都接受 `X-File-Sha256` header，命中已存在的 sha 就 409 拒绝；对 `handleDirectUpload` 在写 D1 前再做一次兜底检查（竞态防护）。

- [ ] **Step 1：阅读现有三个 handler**

读 `src/api/files.ts:29-111`，对照 spec §4.2.3 与本任务的代码片段。

- [ ] **Step 2：定义 SHA-256 校验辅助常量**

`SHA256_RE` 已在 Task 4 加到 `files.ts`。本任务直接复用。如果 Task 4 的常量在文件末尾、`handleDirectUpload` 在文件中部，需要把 `SHA256_RE` 上移到文件靠前位置（紧跟在最后一个 import 之后）。

操作：把 `const SHA256_RE = /^[0-9a-f]{64}$/;` 这行从 Task 4 添加的位置（precheck 之上）移到 `import` 区结束之后、`async function handleDirectUpload` 之前。`PRECHECK_MAX` 仍留在 precheck 函数旁边即可。

- [ ] **Step 3：改 `handleDirectUpload`**

把 `src/api/files.ts:29-58` 的 `handleDirectUpload` 整体替换为：

```ts
async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const clientSha256 = request.headers.get('X-File-Sha256')?.toLowerCase() || null;

  if (clientSha256 !== null && !SHA256_RE.test(clientSha256)) {
    return error('Invalid X-File-Sha256', 400);
  }

  // 入口检查（在写 R2 之前早退）
  if (clientSha256) {
    const existing = await findFileBySha256(env, clientSha256);
    if (existing) {
      return json({ error: 'Duplicate content', existing }, 409);
    }
  }

  const key = buildR2Key(folder, fileName);
  if (isUnsafeKey(key)) return error('Invalid file path', 400);

  const id = crypto.randomUUID();
  const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
    customMetadata: { fileId: id },
  });
  if (!r2Object) return error('Upload failed', 500);

  // 写 D1 之前再查一次（竞态兜底：两个并发上传同一份内容）
  if (clientSha256) {
    const existing = await findFileBySha256(env, clientSha256);
    if (existing) {
      // 回滚 R2
      try { await env.VAULT_BUCKET.delete(key); } catch { /* ignore */ }
      return json({ error: 'Duplicate content', existing }, 409);
    }
  }

  const meta = createFileMeta({
    id,
    key,
    name: fileName,
    size: r2Object.size,
    type: contentType,
    folder,
  });
  if (clientSha256) {
    meta.sha256 = clientSha256;
  }
  await putFile(env, meta);

  return json(meta, 201);
}
```

要点：
- 客户端发了 sha 就两道关：入口预检 + 写 D1 前兜底。
- 命中时回滚 R2（best effort，删除失败不抛——失败的极端情况是 R2 中孤悬一个已被覆盖 key 的对象，不影响功能）。
- 客户端有 sha 就直接写到 meta.sha256（**信任客户端值**——服务端 `/info` 端点的流式补算可作后续校验，本期不做）。

- [ ] **Step 4：改 `handleMultipartCreate`**

把 `src/api/files.ts:60-74` 的 `handleMultipartCreate` 整体替换为：

```ts
async function handleMultipartCreate(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const clientSha256 = request.headers.get('X-File-Sha256')?.toLowerCase() || null;

  if (clientSha256 !== null && !SHA256_RE.test(clientSha256)) {
    return error('Invalid X-File-Sha256', 400);
  }

  if (clientSha256) {
    const existing = await findFileBySha256(env, clientSha256);
    if (existing) {
      return json({ error: 'Duplicate content', existing }, 409);
    }
  }

  const key = buildR2Key(folder, fileName);

  const multipart = await env.VAULT_BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
  });

  return json({ uploadId: multipart.uploadId, key });
}
```

mpu-create 阶段只做入口检查；二次兜底放在 `handleMultipartComplete`（下一步）。

- [ ] **Step 5：改 `handleMultipartComplete`**

把 `src/api/files.ts:89-111` 的 `handleMultipartComplete` 整体替换为：

```ts
async function handleMultipartComplete(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{
    uploadId: string;
    key: string;
    parts: { partNumber: number; etag: string }[];
    sha256?: string;
  }>(request);

  const clientSha256 = body.sha256?.toLowerCase() || null;
  if (clientSha256 !== null && !SHA256_RE.test(clientSha256)) {
    return error('Invalid sha256', 400);
  }

  // 写 D1 之前兜底（mpu-create 后到 mpu-complete 之间可能并发上传同内容）
  if (clientSha256) {
    const existing = await findFileBySha256(env, clientSha256);
    if (existing) {
      // mpu 已上传 part，需要 abort 以释放
      try {
        const mpu = env.VAULT_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
        await mpu.abort();
      } catch { /* ignore */ }
      return json({ error: 'Duplicate content', existing }, 409);
    }
  }

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
  const r2Object = await multipart.complete(body.parts);

  const fileName = body.key.split('/').pop() || body.key;
  const folder = body.key.includes('/') ? body.key.substring(0, body.key.lastIndexOf('/')) : 'root';

  const meta = createFileMeta({
    key: body.key,
    name: fileName,
    size: r2Object.size,
    type: r2Object.httpMetadata?.contentType || getMimeType(fileName),
    folder,
  });
  if (clientSha256) {
    meta.sha256 = clientSha256;
  }
  await putFile(env, meta);

  return json(meta, 201);
}
```

要点：
- `body.sha256` 通过 mpu-complete 请求体携带（不是 header），因为客户端在 mpu-create 阶段就知道 sha 了，传到 mpu-complete 一起带上即可（前端 Task 8 改造时一并加）。
- 命中时调 `mpu.abort()` 释放已上传 part；abort 失败吞掉（best effort，与现有 `handleMultipartAbort` 行为一致）。
- meta.sha256 来自客户端，跟 direct upload 路径一致。

- [ ] **Step 6：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

如果出错，常见问题：
- `meta.sha256 = clientSha256` 类型不匹配——`createFileMeta` 返回的 `meta.sha256` 类型是 `string | null`，赋值字符串 OK。
- `body.sha256?.toLowerCase()` 在 `body.sha256` 不是 string 时返回 undefined——`?.` 已处理。

- [ ] **Step 7：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 8：grep 验证**

Run: `grep -n "X-File-Sha256\|clientSha256" src/api/files.ts`
Expected: 多行命中（三个 handler 都有）。

Run: `grep -n "Duplicate content" src/api/files.ts`
Expected: 至少 3 行（三个 409 返回点）。

- [ ] **Step 9：提交**

```bash
git add src/api/files.ts
git commit -m "feat(api/files): 上传入口 SHA-256 重复检查"
```

---

## Task 6：服务端 `GET /api/files/duplicates` 列表接口

**Files:**
- Modify: `src/api/files.ts`（新增 `listDuplicates` handler）
- Modify: `src/index.ts`（路由表新增一行）

**目标：** 列出所有 SHA-256 重复的文件，按 sha 分组返回。删除复用现有 `POST /api/files/delete`（无需新接口）。

- [ ] **Step 1：在 import 区追加 `listDuplicatesBySha256`**

打开 `src/api/files.ts`，找到 `from '../db/files'` 那行 import，追加 `listDuplicatesBySha256`：

```ts
import { getFile, putFile, deleteFile, listFilesInFolder, searchFiles, updateFileHashes, findFileBySha256, listDuplicatesBySha256 } from '../db/files';
```

- [ ] **Step 2：在文件末尾追加 handler**

```ts
export async function listDuplicates(_request: Request, env: Env): Promise<Response> {
  const groups = await listDuplicatesBySha256(env);
  return json({ groups });
}
```

- [ ] **Step 3：路由注册**

修改 `src/index.ts` Files API 区段，在 `precheck` 路由之后加：

```ts
  { method: 'GET', pattern: '/api/files/duplicates', middleware: [authMiddleware], handler: files.listDuplicates },
```

确认这条路由位于 `'/api/files/:id'` 之**前**——`createRouter` 按声明顺序匹配，字面段 `duplicates` 必须在 `:id` 通配之前。

- [ ] **Step 4：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 6：grep 验证路由顺序**

Run: `awk '/api\/files\/(duplicates|:id)/ {print NR": "$0}' src/index.ts`
Expected: `duplicates` 这一行的行号 < `'/api/files/:id'` 那一行的行号。

- [ ] **Step 7：提交**

```bash
git add src/api/files.ts src/index.ts
git commit -m "feat(api/files): 新增重复内容列表接口"
```

---

## Task 7：前端 `web/src/utils/hash.ts` 浏览器算 SHA-256

**Files:**
- Create: `web/src/utils/hash.ts`

**目标：** 浏览器端流式（按 chunk 读）算文件 SHA-256，带 progress 回调。

- [ ] **Step 1：创建文件**

新建 `web/src/utils/hash.ts`：

```ts
/**
 * 浏览器端计算 File 的 SHA-256，返回 64 位小写 hex 字符串。
 * 通过 file.stream() 分块读，避免一次性加载到内存（大文件友好）。
 * 受限于 SubtleCrypto 不支持流式 digest，仍需把所有 chunk 拼成单个 buffer。
 * 100MB 以内浏览器内存充裕，可接受。
 */
export async function computeFileSha256(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.(loaded, file.size);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }

  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

- [ ] **Step 2：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 3：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 4：提交**

```bash
git add web/src/utils/hash.ts
git commit -m "feat(web): 浏览器端 SHA-256 计算工具"
```

---

## Task 8：前端 API 层新增预检 + 重复列表

**Files:**
- Modify: `web/src/api/index.ts`（新增 `precheckFiles` / `listDuplicates`，改 `multipartCreate` 与 mpu-complete 调用支持 sha）

**目标：** 前端 API 层暴露后端新接口，并让上传相关函数能携带 `X-File-Sha256` header 与 mpu-complete 请求体的 `sha256` 字段。

- [ ] **Step 1：阅读现状**

读 `web/src/api/index.ts`，找到：
- `multipartCreate(headers, signal)` —— 已经接受任意 headers，调用方加 `X-File-Sha256` 即可，**无需改函数**。
- `multipartComplete(args)` —— 看是否接受 sha256 字段。

- [ ] **Step 2：扩展 `multipartComplete` 接受 sha256**

找到 `web/src/api/index.ts` 中的 `multipartComplete` 函数（约第 230-245 行），把它改为：

```ts
export async function multipartComplete(args: {
  uploadId: string;
  key: string;
  parts: UploadPart[];
  sha256?: string;
  signal?: AbortSignal;
}) {
  const res = await fetch('/api/files/upload?action=mpu-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: args.uploadId,
      key: args.key,
      parts: args.parts,
      ...(args.sha256 ? { sha256: args.sha256 } : {}),
    }),
    credentials: 'same-origin',
    signal: args.signal,
  });
  if (!res.ok) {
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      throw new DuplicateContentError(body);
    }
    throw new Error('Failed to complete multipart upload');
  }
}
```

- [ ] **Step 3：定义 `DuplicateContentError`**

在 `web/src/api/index.ts` 顶部（紧跟在 `import type` 之后）追加：

```ts
export class DuplicateContentError extends Error {
  existing?: { id: string; name: string; folder: string; size: number };
  constructor(body: { error?: string; existing?: DuplicateContentError['existing'] }) {
    super(body.error || 'Duplicate content');
    this.name = 'DuplicateContentError';
    this.existing = body.existing;
  }
}
```

- [ ] **Step 4：新增 `precheckFiles` 与 `listDuplicates`**

在 `web/src/api/index.ts` 的 Files 区段（紧跟在 `zipDownload` 之后）追加：

```ts
export interface PrecheckResult {
  sha256: string;
  exists: boolean;
  existing?: { id: string; name: string; folder: string; size: number };
}

export function precheckFiles(sha256s: string[]): Promise<{ results: PrecheckResult[] }> {
  return apiFetch<{ results: PrecheckResult[] }>('/api/files/precheck', {
    method: 'POST',
    body: { sha256s },
  });
}

export interface DuplicateGroup {
  sha256: string;
  files: FileMeta[];
}

export function listDuplicates(): Promise<{ groups: DuplicateGroup[] }> {
  return apiFetch<{ groups: DuplicateGroup[] }>('/api/files/duplicates');
}
```

- [ ] **Step 5：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

如果 `apiFetch` 的类型签名要求 body 参数类型匹配，参考已有 `deleteFiles`、`moveFiles` 的写法，确保 `body: { sha256s }` 通过类型检查。

- [ ] **Step 6：grep 验证**

Run: `grep -n "precheckFiles\|listDuplicates\|DuplicateContentError" web/src/api/index.ts`
Expected: 至少 5 行（class 定义 + 两个 function + 调用点）。

- [ ] **Step 7：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 8：提交**

```bash
git add web/src/api/index.ts
git commit -m "feat(web): 前端 API 层接入预检与重复列表"
```

---

## Task 9：UploadManager 接入 SHA-256 预检与上传 header

**Files:**
- Modify: `web/src/features/upload/uploadManager.ts`

**目标：** 选完文件后，先算 SHA-256、调预检、向用户汇总「M 个重复」、用户确认后只上传非重复的；上传时把 sha 传到 server。

- [ ] **Step 1：阅读现有 UploadManager**

读 `web/src/features/upload/uploadManager.ts:1-100` 和 `:480-560`，理解：
- `enqueue`/`add` 添加文件入口在哪
- `directUpload` 与 `multipartUpload` 在哪
- `UploadItem` 结构

- [ ] **Step 2：在 `UploadItem` 加 sha256 字段**

找到 `UploadItem` 接口定义（在文件顶部或相邻 types 文件），加一个可选字段：

```ts
interface UploadItem {
  // ... 原有字段
  sha256?: string;  // 浏览器端预先算的 SHA-256，缺失则不参与判重
}
```

- [ ] **Step 3：在文件入队前算 SHA + 预检**

找到 `enqueue` / `addFiles` / 类似的添加文件入口（搜 `items.push` 或 `this.items.push`），在文件入队**之前**插入预处理步骤。

具体改造方式取决于现有 enqueue 函数签名。下面给出**模板**实现，如果现有签名不同请按现状适配：

```ts
// 在 UploadManager class 中新增方法
private async preflightFiles(files: File[]): Promise<{ allowed: { file: File; sha256: string }[]; duplicates: Array<{ file: File; existing: PrecheckResult['existing'] }> }> {
  // 算 SHA
  const withSha: { file: File; sha256: string }[] = [];
  for (const f of files) {
    const sha256 = await computeFileSha256(f);
    withSha.push({ file: f, sha256 });
  }

  // 批量预检
  const { results } = await precheckFiles(withSha.map((x) => x.sha256));
  const byHash = new Map(results.map((r) => [r.sha256, r]));

  const allowed: typeof withSha = [];
  const duplicates: Array<{ file: File; existing: PrecheckResult['existing'] }> = [];
  for (const { file, sha256 } of withSha) {
    const r = byHash.get(sha256);
    if (r?.exists) {
      duplicates.push({ file, existing: r.existing });
    } else {
      allowed.push({ file, sha256 });
    }
  }
  return { allowed, duplicates };
}
```

import 区追加：
```ts
import { precheckFiles, type PrecheckResult, DuplicateContentError } from '~/api';
import { computeFileSha256 } from '~/utils/hash';
```

- [ ] **Step 4：改原 `enqueue` 入口接入预检**

找到现有 enqueue 签名（假设是 `enqueue(files: File[], folder?: string)` 或 `add(files, folder)`），把它改造为：

```ts
async enqueue(files: File[], folder = 'root'): Promise<{ skipped: typeof duplicates }> {
  // 显示"准备中"状态（你可以扩展 UploadItem.status 加一个 'preflighting' 值，或者用一个简单的 flag）
  const { allowed, duplicates } = await this.preflightFiles(files);

  for (const { file, sha256 } of allowed) {
    const item: UploadItem = {
      // ... 原有字段构造
      sha256,
    };
    this.items.push(item);
  }
  this.emit();
  this.kick();

  return { skipped: duplicates };
}
```

调用方（UI）拿到 `skipped` 就用现有 dialog/toast 机制告诉用户「M 个重复内容已跳过」。具体 UI 形态由 Task 10 处理，本任务只保证 API 返回了重复信息。

注意：上述 enqueue 的具体接口形态以**仓库现有**为准。如果现有是同步 `enqueue(files)`，把它改成 async 版本，并更新所有调用方。如果改造范围过大，**记录为 BLOCKED 汇报**——不要硬改。

- [ ] **Step 5：directUpload 携带 SHA header**

把 `web/src/features/upload/uploadManager.ts:513-538` 的 `directUpload` 中 `xhr.setRequestHeader('Content-Type', ...)` 之后追加一行：

```ts
      if (item.sha256) {
        xhr.setRequestHeader('X-File-Sha256', item.sha256);
      }
```

并在 `xhr.onload` 中处理 409：

```ts
      xhr.onload = () => {
        if (xhr.status === 409) {
          // 服务端兜底命中重复（理论上预检已拦下，这里是竞态防护）
          let existing;
          try { existing = JSON.parse(xhr.responseText)?.existing; } catch { /* ignore */ }
          reject(new DuplicateContentError({ error: 'Duplicate content', existing }));
        } else if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(xhr.responseText || 'Upload failed'));
        }
      };
```

- [ ] **Step 6：multipartCreate 携带 SHA header**

修改 `multipartUpload` 中调 `multipartCreate` 的位置（约第 543-550 行），把 headers 对象中追加 sha256：

```ts
      const created = await multipartCreate(
        {
          'X-File-Name': encodeURIComponent(file.name),
          'X-Folder': encodeURIComponent(item.folder || 'root'),
          'Content-Type': file.type || 'application/octet-stream',
          ...(item.sha256 ? { 'X-File-Sha256': item.sha256 } : {}),
        },
        state.abort?.signal,
      );
```

如果 `multipartCreate` 抛 `DuplicateContentError`（见 Task 8 的扩展），向上传播——multipartUpload 函数的外层 catch 已经把所有 throw 转 `item.error`，能正确显示"重复"错误信息。

- [ ] **Step 7：multipartComplete 传 sha256**

找到 `multipartComplete` 调用点（同文件，搜 `multipartComplete(`），改成：

```ts
    await multipartComplete({
      uploadId: state.uploadId!,
      key: state.key!,
      parts: state.completedParts,
      sha256: item.sha256,
      signal: state.abort?.signal,
    });
```

- [ ] **Step 8：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 9：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 10：grep 验证**

Run: `grep -n "X-File-Sha256\|computeFileSha256\|precheckFiles\|sha256" web/src/features/upload/uploadManager.ts`
Expected: 至少 6 行命中。

- [ ] **Step 11：提交**

```bash
git add web/src/features/upload/uploadManager.ts
git commit -m "feat(web): 上传前 SHA-256 预检 + header 携带"
```

---

## Task 10：上传 UI 提示「M 个重复内容已跳过」

**Files:**
- Modify: 调用 `uploadManager.enqueue` 的组件（搜 `enqueue(` 在 web/src 下的调用点确定）

**目标：** 用户拖拽 / 选择文件后，等 enqueue 返回 skipped 列表，弹 toast 或对话框告知。

- [ ] **Step 1：定位调用点**

Run: `grep -rn "enqueue(" web/src/`
找到 1-3 处调用点（文件选择按钮 / 拖拽 handler）。

- [ ] **Step 2：处理 skipped 返回**

把每处调用从：
```ts
this.uploadManager.enqueue(files, folder);
```
改为：
```ts
const { skipped } = await this.uploadManager.enqueue(files, folder);
if (skipped.length > 0) {
  this.notifySkippedDuplicates(skipped);
}
```

`notifySkippedDuplicates` 实现：用现有项目的 toast 机制，**或**一个简单的对话框。如果项目已有 `useToast()` 之类 hook：

```ts
private notifySkippedDuplicates(skipped: Array<{ file: File; existing: { name: string; folder: string } }>) {
  const lines = skipped.map((s) => `${s.file.name} → 已存在于 ${s.existing.folder}/${s.existing.name}`);
  // 使用项目现有 toast / alert API；下面是占位伪代码：
  alert(`${skipped.length} 个文件因内容重复未上传：\n${lines.join('\n')}`);
}
```

如果项目没有现成的 toast 系统，**先用 `alert` 兜底**——后续可在专门的 UI Task 中替换为更优雅的对话框，但本任务先保证功能可用。

- [ ] **Step 3：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 4：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 5：手工浏览器验证（如 dev 环境可用）**

参考 CLAUDE.md：UI 改动应当在浏览器里走一遍 golden path。如果你能跑 `npm run dev` + 浏览器：
- 选两个相同内容的文件 → 第二个应被跳过 + alert 显示
- 选一个新文件 + 一个已存在内容的文件 → 新文件正常上传，重复的被跳过

如果不能在浏览器里跑（agentic 环境），**直接说明无法手动验证**——typecheck + build 通过即可，不要伪装"已测试"。

- [ ] **Step 6：提交**

```bash
git add web/src/
git commit -m "feat(web): 上传跳过重复内容提示"
```

---

## Task 11：清理重复 UI 入口

**Files:**
- Create: `web/src/features/duplicates/DuplicatesDialog.tsx`
- Modify: `web/src/apps/dashboard.tsx`（加按钮触发）

**目标：** 在 dashboard 工具栏加「清理重复」按钮，点击拉 `/api/files/duplicates`，展示分组列表，让用户勾选要删除的副本，调 `/api/files/delete` 删除。

- [ ] **Step 1：阅读 dashboard 工具栏现状**

读 `web/src/apps/dashboard.tsx` 中工具栏区域（搜 `toolbar`、`bulkActions`、批量操作栏相关），定位合适的按钮放置位置。

- [ ] **Step 2：创建 DuplicatesDialog 组件**

新建 `web/src/features/duplicates/DuplicatesDialog.tsx`：

```tsx
import { createSignal, createResource, For, Show } from 'solid-js';
import { listDuplicates, deleteFiles, type DuplicateGroup } from '~/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}

export function DuplicatesDialog(props: Props) {
  const [data, { refetch }] = createResource(
    () => props.open,
    async (open) => (open ? (await listDuplicates()).groups : []),
  );
  const [selected, setSelected] = createSignal(new Set<string>());
  const [busy, setBusy] = createSignal(false);

  const initSelection = (groups: DuplicateGroup[]) => {
    const s = new Set<string>();
    for (const g of groups) {
      // 默认勾选除最早一条外的所有副本（保留最早）
      for (let i = 1; i < g.files.length; i++) {
        s.add(g.files[i]!.id);
      }
    }
    setSelected(s);
  };

  const toggle = (id: string) => {
    const s = new Set(selected());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };

  const handleDelete = async () => {
    const ids = Array.from(selected());
    if (ids.length === 0) return;
    if (!confirm(`确定删除 ${ids.length} 个重复副本？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await deleteFiles(ids);
      props.onDeleted?.();
      await refetch();
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div class="bg-bg-surface rounded-md max-w-3xl w-full max-h-[80vh] overflow-auto p-4">
          <div class="flex justify-between mb-3">
            <h2 class="text-lg font-semibold">清理重复内容</h2>
            <button onClick={props.onClose} class="text-fg-muted">✕</button>
          </div>

          <Show when={data.loading}><div>加载中…</div></Show>
          <Show when={data() && data()!.length === 0}><div class="text-fg-muted">仓库无重复内容。</div></Show>
          <Show when={data() && data()!.length > 0}>
            {(_) => {
              if (selected().size === 0 && data()!.length > 0) initSelection(data()!);
              return null;
            }}
            <div class="space-y-3">
              <For each={data()!}>{(group) => (
                <div class="border border-line rounded p-2">
                  <div class="text-xs text-fg-muted mb-1">SHA-256: {group.sha256.slice(0, 16)}…（{group.files.length} 个副本）</div>
                  <For each={group.files}>{(f, i) => (
                    <label class="flex items-center gap-2 py-1">
                      <input
                        type="checkbox"
                        checked={selected().has(f.id)}
                        onChange={() => toggle(f.id)}
                      />
                      <span class={i() === 0 ? 'text-fg-muted' : ''}>
                        {f.folder}/{f.name}
                        <Show when={i() === 0}>（最早，建议保留）</Show>
                      </span>
                    </label>
                  )}</For>
                </div>
              )}</For>
            </div>
            <div class="flex justify-end gap-2 mt-4">
              <button class="px-3 py-1.5 rounded border border-line" onClick={props.onClose}>取消</button>
              <button
                class="px-3 py-1.5 rounded bg-brand text-fg-onAccent disabled:opacity-50"
                disabled={busy() || selected().size === 0}
                onClick={handleDelete}
              >
                删除选中（{selected().size}）
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
```

注意：上述 className 与样式系统假设与现有 dashboard 一致（`bg-bg-surface`、`border-line`、`bg-brand`、`text-fg-onAccent` 等 tokens 已在仓库 tokens.css 中定义——参考上一轮 spec/plan）。如果实际 token 名不同，按现有同类组件（如批量操作栏）调整。

- [ ] **Step 3：在 dashboard 工具栏加按钮**

在 `web/src/apps/dashboard.tsx` 的工具栏 / 设置入口附近加：

```tsx
import { DuplicatesDialog } from '~/features/duplicates/DuplicatesDialog';

// 在组件 setup 中
const [showDup, setShowDup] = createSignal(false);

// 在 JSX 工具栏区
<button onClick={() => setShowDup(true)}>清理重复</button>

<DuplicatesDialog
  open={showDup()}
  onClose={() => setShowDup(false)}
  onDeleted={() => { /* 刷新文件列表，按现有 dashboard 模式调用 */ }}
/>
```

具体放在什么菜单 / 按钮组里、用什么图标、`onDeleted` 怎么刷新——按 dashboard.tsx 的现有约定来。如果 dashboard 很复杂，**找到一个合适的位置**（例如设置抽屉、用户菜单、批量操作下拉），不要重构现有结构。

- [ ] **Step 4：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 6：grep 验证**

Run: `grep -rn "DuplicatesDialog" web/src/`
Expected: 至少 2 行（component 文件 + dashboard import）。

- [ ] **Step 7：手工浏览器验证（如可用）**

- 仓库里有几个重复内容时，点「清理重复」应弹 dialog
- 默认勾选「非最早」副本
- 取消勾选 / 重新勾选可工作
- 点删除 → 对应文件从 R2 / D1 删除，dashboard 文件列表刷新

如果无法浏览器验证，typecheck + build 通过即可。

- [ ] **Step 8：提交**

```bash
git add web/src/features/duplicates/ web/src/apps/dashboard.tsx
git commit -m "feat(web): 清理重复内容 UI"
```

---

## Task 12：整仓 sanity check + 重建前端构建产物

**Files:**
- Modify（自动）: `public/assets/`（vite 输出）

- [ ] **Step 1：完整 typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 2：完整 build**

Run: `npm run build`
Expected: vite + wrangler dry-run 都成功。

- [ ] **Step 3：检查 public/assets/ 变更**

Run: `git status`

如果 `public/assets/` 有未跟踪 / 已修改文件：

```bash
git add public/assets/
git commit -m "chore(build): 重建前端构建产物"
```

如果无变化（vite hash 与现状一致）：跳过。

- [ ] **Step 4：检视提交序列**

Run: `git log --oneline -15`
Expected：从最新到最旧应当出现（顺序是 commit 时间倒序，与 Task 编号倒序对应）：

```
chore(build): 重建前端构建产物（如有）
feat(web): 清理重复内容 UI                           # Task 11
feat(web): 上传跳过重复内容提示                      # Task 10
feat(web): 上传前 SHA-256 预检 + header 携带          # Task 9
feat(web): 前端 API 层接入预检与重复列表              # Task 8
feat(web): 浏览器端 SHA-256 计算工具                  # Task 7
feat(api/files): 新增重复内容列表接口                 # Task 6
feat(api/files): 上传入口 SHA-256 重复检查            # Task 5
feat(api/files): 新增 SHA-256 批量预检接口            # Task 4
feat(db): 新增 sha256 查重与重复列表查询              # Task 3
feat(db): 新增 sha256 索引 migration                  # Task 2
perf(api/media): CRC32 改 slicing-by-8 提速 5-8 倍    # Task 1
docs(specs): 大文件 zip 修复 + SHA-256 内容唯一性设计 # 729cf6f（已存在）
```

如果顺序不一致或缺失，**不**要 rebase 自动修复，先汇报。

- [ ] **Step 5：提醒用户应用 D1 migration**

提醒（人类用户操作，不在 plan 自动执行范围）：

```bash
# 本地 / 测试环境
npx wrangler d1 execute cloudvault --local --file=src/db/migrations/003_add_sha256_index.sql

# 生产环境（Cloudflare）
npx wrangler d1 execute cloudvault --remote --file=src/db/migrations/003_add_sha256_index.sql
```

migration 是非破坏的（仅加索引），但仍属生产 DB 改动，需用户审批。

---

## Self-Review

**1. Spec coverage：**

| Spec 节 | 对应 Task |
|---|---|
| §4.1 CRC32 slicing-by-8 | Task 1 |
| §4.2.1 D1 查询函数 | Task 3 |
| §4.2.2 批量预检接口 | Task 4 |
| §4.2.3 上传入口 SHA header | Task 5 |
| §4.2.4 客户端 SHA + UX | Task 7 + Task 9 + Task 10 |
| §4.2.5 重复内容上传 header | Task 5（服务端）+ Task 9（客户端 directUpload + multipartCreate） |
| §4.3.1 后端列表接口 | Task 6 |
| §4.3.2 前端入口 | Task 11 |
| §4.4 D1 索引 migration | Task 2 |
| §6 测试与验证（typecheck + build） | 每个 Task 步骤 |
| §7 提交计划 | Task 1-12 提交 |
| §5 非范围（不加 UNIQUE / 不自动删 / 不回填）| 隐式遵守——本 plan 无任何 schema UNIQUE 约束、无 migration 自动 DELETE、无 sha256 回填脚本 |

无遗漏。

**2. Placeholder 扫描：**

- "TBD" / "TODO" / "类似 Task N" / "适当的错误处理" —— 都没有出现。
- 每一处代码改动都给出完整可粘贴片段。
- Task 9（UploadManager）的 enqueue 改造对仓库现状有依赖，明确写了"如果改造范围过大，BLOCKED 汇报"的退出条件——不是占位。
- Task 10 的 `notifySkippedDuplicates` 写了"先用 alert 兜底"的明确退路——不是占位。
- Task 11 的工具栏按钮位置写了"按 dashboard.tsx 现有约定"——这是合理委派，不是占位。

**3. Type 一致性：**

- `findFileBySha256(env, sha256): Promise<FileMeta | null>` —— Task 3 定义，Task 5（×3 处）调用，签名一致。
- `listDuplicatesBySha256(env): Promise<{sha256, files}[]>` —— Task 3 定义，Task 6 调用，签名一致。
- `precheck(request, env): Promise<Response>` —— Task 4 定义，Task 4 在 index.ts 注册，名称一致。
- `listDuplicates(request, env): Promise<Response>` —— Task 6 定义，Task 6 注册，名称一致。
- `computeFileSha256(file, onProgress?): Promise<string>` —— Task 7 定义，Task 9 调用（无 onProgress 参数也兼容，因为 onProgress 是可选）。
- `precheckFiles(sha256s): Promise<{results: PrecheckResult[]}>` —— Task 8 定义，Task 9 调用，签名一致。
- `listDuplicates()` —— Task 8 定义，Task 11 调用，签名一致（前端 API 函数和后端 handler 同名是有意——`api.listDuplicates()` 调 `GET /api/files/duplicates`，与服务端 `files.listDuplicates` handler 对应）。
- `DuplicateContentError` —— Task 8 定义，Task 8（multipartComplete）+ Task 9（directUpload xhr.onload）抛出，类型一致。
- `UploadItem.sha256?: string` —— Task 9 Step 2 加，Task 9 Step 5/6/7 读取，类型一致。
- `SHA256_RE = /^[0-9a-f]{64}$/` —— Task 4 定义、Task 5 引用（Task 5 Step 2 明确处理了把它从 precheck 旁移到顶部）。

无类型不一致。

**4. 路由顺序检查：**

`'/api/files/precheck'` 与 `'/api/files/duplicates'` 都是字面段，必须**先**于通配 `'/api/files/:id'`。Task 4 Step 4 与 Task 6 Step 3 都明确说明插入位置在 `/api/files/zip` 之后、`/api/files/:id/thumbnail` 之前——对照现有 index.ts，这一段都是字面段，安全。Task 6 Step 6 还有 `awk` 验证脚本兜底。

---

## 总结

本计划包含 12 个 Task，按依赖顺序：

1. **Task 1**：CRC32 slicing-by-8（解决大文件 zip 损坏的根因）
2. **Task 2**：D1 sha256 索引（让后续查询不慢）
3. **Task 3**：D1 查询函数（Task 4-6 的依赖）
4. **Task 4-6**：服务端预检 / 上传入口判重 / 重复列表
5. **Task 7-8**：前端工具函数 + API 层
6. **Task 9-10**：上传链路接入预检 + UX
7. **Task 11**：清理重复 UI
8. **Task 12**：整仓 sanity check

执行原则：
- 每个 Task 内步骤都给完整可粘贴代码片段；
- 每个 Task 末尾都有 typecheck + build 验证 + 原子 commit；
- 失败时 BLOCKED 汇报而非自行扩大改动；
- 不动 D1 schema（不加 UNIQUE 约束）、不自动删旧数据、不回填旧 sha256——这些都是 §5 非范围。

