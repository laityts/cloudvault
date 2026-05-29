# 大文件 zip 修复 + 内容唯一性 设计

**日期**：2026-05-29
**作者**：协同设计（用户 × 助手）
**状态**：草案（待用户审阅）
**关联**：本设计是上一份 spec `2026-05-29-bulk-ops-and-checkbox-fixes-design.md` 的迭代。上一份解决的是中等规模批量打包的 OOM/connection limit；本份解决"100MB 级文件多个一起打包 → zip 损坏"和"防止内容重复上传"两个新发现的问题。

## 1. 背景与问题

### 1.1 大文件 zip 损坏

上一轮已把 zip 改为 `TransformStream` 流式 + GP flag bit 3 + Data Descriptor，规避了 OOM 和 R2 connection limit。但用户报告：**多个 100MB 量级文件一起打包时，下载下来的 zip 解压后文件大小不一致（症状 B）且文件少了（症状 D）**。

根因：当前 CRC32 实现是 byte-wise LSB-first，每字节 8 次内层循环，实测 V8 上约 30-50 MB/s/CPU。100MB × 几个文件 ≈ 几百 MB 总数据，CRC 计算耗 10-20s+ CPU；与 R2 IO 串联后逼近或突破 Cloudflare Workers 的 30s CPU 时间限制（Paid plan）。运行时 kill Worker 时，`TransformStream` 的 writable 端被异常关闭，readable 端发给客户端的 zip body **截断**：

- 截断点之前的文件可能完整、之后的文件丢失（症状 D）
- 截断点正在传的那一个文件会少字节（症状 B）
- central directory（最后才写）丢失或不完整 → 部分解压器仍能"宽松解析"前面的 local headers，但 size 字段被 data descriptor 覆盖时位置不对、解出的字节数与原文件不符（症状 B）

### 1.2 缺少内容唯一性约束

当前上传链路允许同一份内容（甚至同一文件名）被多次上传：每次 PUT 都会 `crypto.randomUUID()` 一个新 id、`buildR2Key` 一个新 key、`putFile` 写一条新 D1 记录。**重复内容会重复占用 R2 存储和 D1 行**，且后续找回某份文件时容易混淆——用户已明确希望"整个仓库任意位置不允许内容重复"，以 SHA-256 作为内容唯一性的判定标准（不以文件名）。

文件名可重复——这是用户最终的明确决策（见会话记录）。

## 2. 根因分析

### 2.1 CRC32 性能

LSB-first byte-wise 算法每字节 8 次 `>>>` + `^` + 条件分支，分支预测在 V8 上约 30-50 MB/s。常见加速方案：

- **slicing-by-1（256 项查表）**：每字节 1 次表查询 + 1 次 XOR。约 5-8 倍提升，达 200-300 MB/s。
- **slicing-by-8（8 张 256 项查表）**：每 8 字节 8 次查表 + 8 次 XOR + 8 次右移。约 20-30 倍提升，达 600-900 MB/s。
- **WASM SIMD CRC32**：极致性能但引入 WASM 依赖。

我们选 **slicing-by-8**：30s CPU 内可处理 18-27 GB 数据，远超用户当前 100MB × N 场景；纯 TypeScript 无依赖；表预计算约 9 KB，启动时一次性算出。

### 2.2 当前上传链路的判重缺口

- `direct-upload`（`src/api/files.ts:29-58`）：直接 `env.VAULT_BUCKET.put(key, request.body)` 写 R2，再 `putFile` 写 D1。**全程无 SHA 介入**——SHA 是后续 `/info` 端点按需流式补算的。
- `mpu-create`（同文件 60-74 行）：服务端创建 multipart upload，返回 uploadId。同样无 SHA 介入。
- 客户端：浏览器**目前不算 SHA**，纯粹 PUT 文件流。

要做 SHA 判重，需要：
1. **客户端在浏览器算 SHA-256**（`crypto.subtle.digest`，硬件加速，100MB 约 1-3 秒）
2. **预检接口** `POST /api/files/precheck { sha256 }` —— 命中返回 409 + `existingPath`，未命中返回 200。
3. **上传入口接受 `X-File-Sha256` header**：`direct-upload` 和 `mpu-create` 都先用这个 header 查 D1，命中 409 拒绝；未命中再继续。
4. **服务端写 D1 之前再查一次**（保护并发竞态：两个客户端同时预检通过、同时上传）。

服务端流式补算 SHA 的现有 `/info` 端点（`src/api/files.ts:281+` 的 `meta.sha1 && meta.sha256` 分支）保留——它仍然有用，针对那些**没有**走新预检上传路径的旧数据。

## 3. 改动范围

| 改动点 | 文件 | 性质 |
|---|---|---|
| CRC32 改 slicing-by-8 表查 | `src/api/media.ts` | 替换 `crc32Update`（保持函数签名） |
| 新增预检接口 | `src/api/files.ts` + `src/index.ts` 路由表 | 新增 `precheckUpload` handler + 路由 `POST /api/files/precheck` |
| 上传入口接受 `X-File-Sha256` | `src/api/files.ts` 的 `handleDirectUpload` 和 `handleMultipartCreate` | 入口先查 D1，命中 409 |
| 服务端写 D1 前再查 | `src/api/files.ts` 的 `handleDirectUpload`（multipart 在 complete 阶段补） | 应用层兜底竞态 |
| 新增"清理重复"接口 | `src/api/files.ts` + `src/index.ts` 路由表 | `GET /api/files/duplicates` 列出按 SHA-256 分组的重复文件；`POST /api/files/duplicates/delete` 接收用户选定的 ids 删除 |
| 客户端预检 + UX | `web/src/api/index.ts` + 上传相关页面 | 选完文件先算 SHA + 调预检 + 弹"M 个重复，是否继续"对话框 |
| 新增"清理重复"前端入口 | dashboard 某处加按钮 + 列表页面 / 弹窗 | 调 duplicates 接口、展示分组、用户选删 |

**不**改 D1 schema、**不**加 `UNIQUE(sha256)` 约束（旧数据可能有重复，约束会让 migration 失败）。schema 约束作为后续阶段单独 spec。

## 4. 详细设计

### 4.1 CRC32 slicing-by-8

#### 4.1.1 算法

slicing-by-8 把 byte-wise 循环展开为每 8 字节一个 round：

```
crc ^= read32_le(data + i)         # 吃前 4 字节
slice = read32_le(data + i + 4)    # 后 4 字节备用

next = T7[crc & 0xff]
     ^ T6[(crc >>> 8) & 0xff]
     ^ T5[(crc >>> 16) & 0xff]
     ^ T4[(crc >>> 24) & 0xff]
     ^ T3[slice & 0xff]
     ^ T2[(slice >>> 8) & 0xff]
     ^ T1[(slice >>> 16) & 0xff]
     ^ T0[(slice >>> 24) & 0xff]

crc = next  # 推进 8 字节
```

剩余 < 8 字节的尾巴用原 byte-wise 算法补齐。

#### 4.1.2 表预计算

启动时算一次，模块顶层常量：

```ts
const CRC32_TABLES = (() => {
  const t = Array.from({ length: 8 }, () => new Uint32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[0]![n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[0]![n]!;
    for (let k = 1; k < 8; k++) {
      c = t[0]![c & 0xff]! ^ (c >>> 8);
      t[k]![n] = c;
    }
  }
  return t;
})();
```

8 张表 × 256 项 × 4 字节 = 8 KB，加常量元数据约 9 KB。Worker 启动一次性算。

#### 4.1.3 函数签名兼容

保持 `crc32Update(crc: number, data: Uint8Array): number` 与 `crc32Final(crc: number): number` 的对外签名不变——`zipDownload` 调用方零改动。

#### 4.1.4 chunk 边界

R2 reader.read() 返回的 chunk 大小不固定。`crc32Update` 内部按 8 字节对齐处理 chunk 主体，余下尾巴（< 8 字节）用 byte-wise 补齐。**跨 chunk 的 8 字节对齐**通过函数内部累计——但更简单的做法是不跨 chunk 累计：每个 chunk 各自走 slicing-by-8 主体 + byte-wise 尾巴，因为 CRC32 是 LSB-first 累加，**chunk 边界不影响最终结果**（每个 chunk 末尾的 byte-wise 尾巴和下一个 chunk 起始的 slicing-by-8 主体可以无缝衔接）。

### 4.2 SHA-256 内容唯一性

#### 4.2.1 D1 查询接口

新增 `src/db/files.ts` 中的辅助：

```ts
export async function findFileBySha256(env: Env, sha256: string): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE sha256 = ? LIMIT 1')
    .bind(sha256)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

export async function listDuplicatesBySha256(env: Env): Promise<Array<{ sha256: string; files: FileMeta[] }>> {
  const rows = await env.VAULT_DB
    .prepare(`SELECT * FROM files
              WHERE sha256 IS NOT NULL
                AND sha256 IN (SELECT sha256 FROM files WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*) > 1)
              ORDER BY sha256, created_at`)
    .all<FileRow>();
  // 按 sha256 分组
  const groups = new Map<string, FileMeta[]>();
  for (const row of rows.results ?? []) {
    const meta = rowToMeta(row);
    if (!meta.sha256) continue;
    if (!groups.has(meta.sha256)) groups.set(meta.sha256, []);
    groups.get(meta.sha256)!.push(meta);
  }
  return Array.from(groups, ([sha256, files]) => ({ sha256, files }));
}
```

`sha256` 字段当前**未加索引**——上线前需要看下 D1 表的索引情况，按需在 migration `003_add_sha256_index.sql` 中加 `CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256)`。索引 migration 不破坏现有数据，安全。

#### 4.2.2 预检接口（批量）

`POST /api/files/precheck`：

请求：
```json
{ "sha256s": ["abc...64hex", "def...64hex", ...] }
```

响应：`200 OK`
```json
{
  "results": [
    { "sha256": "abc...", "exists": false },
    { "sha256": "def...", "exists": true, "existing": { "id": "...", "name": "report.pdf", "folder": "docs", "size": 1234567 } }
  ]
}
```

要点：
- 选批量而非单文件——节省 N 次 round-trip。
- 用 200 而非 409，因为预检本身**不是**冲突动作——只是查询。冲突响应（409）保留给"已经发起 PUT 但服务端再检拒绝"的场景。
- 服务端实现：单条 SQL `SELECT id, name, folder, size, sha256 FROM files WHERE sha256 IN (?, ?, ...)`，再按 sha256 拼回结果。
- 限制单次请求 sha256s 长度上限（如 200），避免 D1 查询参数列表爆。
- `sha256s` 中的项要做 `^[0-9a-f]{64}$` 校验，非法的直接 400。

#### 4.2.3 上传入口的 `X-File-Sha256` header

`handleDirectUpload`：

```ts
async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const clientSha256 = request.headers.get('X-File-Sha256')?.toLowerCase() || null;

  // 入口检查（早退）
  if (clientSha256) {
    if (!/^[0-9a-f]{64}$/.test(clientSha256)) return error('Invalid X-File-Sha256', 400);
    const existing = await findFileBySha256(env, clientSha256);
    if (existing) return json({ error: 'Duplicate content', existing }, 409);
  }

  // ... 原有 R2 PUT + D1 写入逻辑

  // 写 D1 之前再查一次（竞态兜底）
  if (clientSha256) {
    const existing = await findFileBySha256(env, clientSha256);
    if (existing) {
      await env.VAULT_BUCKET.delete(key); // 回滚 R2
      return json({ error: 'Duplicate content', existing }, 409);
    }
  }

  // ... putFile
}
```

`handleMultipartCreate`：

```ts
const clientSha256 = request.headers.get('X-File-Sha256')?.toLowerCase() || null;
if (clientSha256) {
  if (!/^[0-9a-f]{64}$/.test(clientSha256)) return error('Invalid X-File-Sha256', 400);
  const existing = await findFileBySha256(env, clientSha256);
  if (existing) return json({ error: 'Duplicate content', existing }, 409);
}
// 继续原有 createMultipartUpload 流程
```

multipart 的二次检查放在 `handleMultipartComplete`（用户上传完所有 part、客户端调 complete 时）：服务端在写 D1 之前再 `findFileBySha256` 一次，命中就 R2 abort 并 409。

#### 4.2.4 客户端 SHA 计算 + 预检 UX

新增 `web/src/utils/hash.ts`：

```ts
export async function computeFileSha256(file: File, onProgress?: (loaded: number, total: number) => void): Promise<string> {
  const stream = file.stream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, file.size);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

100MB 文件浏览器算 SHA 大约 1-3 秒。整个文件读到内存——浏览器内存远比 Worker 宽裕，可接受。

UX 流程（`web/src/apps/dashboard.tsx` 上传按钮）：

1. 用户选 N 个文件
2. 进度面板显示「准备中：1/N」、并行（或顺序）算每个文件的 SHA-256
3. 全部算完后，POST `/api/files/precheck` 批量请求（一个文件一次请求或合并成 `{ sha256s: [...] }`——见下）
4. 收到结果，把 N 个文件分成"可上传"和"重复"两组
5. 弹对话框：「N 个文件中 M 个内容已存在（点击查看）；剩余 N-M 个继续上传？」
6. 用户点「继续」就只对非重复文件发起 PUT/MPU；点「取消」就清空选择

预检接口请求 / 响应格式见 4.2.2（批量）。

#### 4.2.5 重复内容上传 header

PUT `/api/files/upload` 时携带：

```
X-File-Sha256: <64 hex>
```

如果客户端没算 SHA 或 header 缺失，服务端**仍然接受**——保持向后兼容（旧客户端、curl 上传等场景）。这种情况下走原流程：上传 → 写 D1（无 SHA）→ 后续 `/info` 端点按需补算 SHA。这种"漏网之鱼"在用户选预检 UX 走完整路径时不会出现；只在绕过前端的场景出现，影响小。

### 4.3 清理重复工具

#### 4.3.1 后端接口

`GET /api/files/duplicates`：

响应：
```json
{
  "groups": [
    {
      "sha256": "abc...",
      "files": [
        { "id": "...", "name": "report.pdf", "folder": "docs", "size": 12345, "createdAt": "..." },
        { "id": "...", "name": "report-final.pdf", "folder": "archive", "size": 12345, "createdAt": "..." }
      ]
    },
    ...
  ]
}
```

按 SHA-256 分组、组内按 createdAt 升序（最早的在最前）。

`POST /api/files/duplicates/delete`：

请求：
```json
{ "ids": ["id1", "id2", ...] }
```

复用现有 `deleteFiles` 逻辑（已有 R2 + D1 的删除路径）。**注意**：这与已有的 `POST /api/files/delete` 是同一个语义。其实可以**直接复用** `/api/files/delete`，前端在 UI 上展示重复分组、收集用户勾选的 ids、调现有 delete 接口。这样不用新增第二个 delete 接口。

**确定方案**：只新增 `GET /api/files/duplicates`（列表），删除走现有 `POST /api/files/delete`。

#### 4.3.2 前端入口

dashboard 页面顶部菜单或设置页面新增「清理重复」按钮——点击后：

1. GET `/api/files/duplicates`
2. 展示分组列表：每组用 SHA 折叠成"N 个重复"，展开看每个文件的 name/folder/size/createdAt
3. 默认勾选每组除最早一条外的所有副本（"保留最早，删除其余"启发式）
4. 用户可手动调整勾选
5. 点「删除选中」→ POST `/api/files/delete { ids }` → 刷新列表

具体 UI 形态（弹窗 vs 路由页面）由实施时根据现有 dashboard 设计决定。**spec 不约束**这一层的实现细节。

### 4.4 D1 索引 migration

新建 `src/db/migrations/003_add_sha256_index.sql`：

```sql
CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
```

非破坏性，对既存数据零影响。`findFileBySha256` 与 `listDuplicatesBySha256` 都依赖此索引才能在大表上保持快速。

## 5. 非范围

- 不加 `UNIQUE(sha256)` schema 约束（留给后续阶段）。
- 不自动删除已存在的重复（只提供工具，由用户主动操作）。
- 不回填旧数据的 `sha256` 字段（旧数据 sha256 为 null 时不参与判重；用户可主动调用现有 `/info` 端点触发流式补算）。
- 不支持 zip64（单文件 < 4GB、总 zip < 4GB 仍是硬限制；本次只解决 CPU 性能瓶颈）。
- 不引入 WASM SIMD CRC32（slicing-by-8 已足够）。
- 不改既有的 SHA-1 字段或 `computeHashes` 工具（保留向下兼容）。
- 不改 multipart upload 的分片结构（仍 mpu-create / mpu-upload / mpu-complete 三阶段；只在 create + complete 阶段加 SHA 检查）。
- 不强制要求客户端必须发 `X-File-Sha256`——缺失时退回原行为（保持兼容）。

## 6. 测试与验证

无单元测试框架（CLAUDE.md §13 也禁止真机），依赖：

- **类型检查**：`npm run typecheck`
- **构建**：`npm run build`
- **CRC32 正确性自验**：在 `crc32Update` 改完后，写一个临时脚本（验证后删除）算几个已知字符串的 CRC，对照标准值（如 `"123456789"` 的 CRC32 应为 `0xCBF43926`）。临时脚本本身不留在仓库。
- **逻辑推理**：
  - slicing-by-8 表预计算与 byte-wise 算法在数学上等价（参考 Intel slicing-by-8 论文 / zlib `crc32.c`）。
  - 跨 chunk 的 CRC 累计正确性：每个 chunk 内部走 slicing-by-8 + byte-wise 尾巴；chunk 边界处 `crc` 状态变量持续累加，与一次性算等价。
  - 预检接口在未命中时不影响上传链路（只增加一次 D1 查询）。
  - 上传入口的二次检查在 D1 已写入的情况下能正确回滚 R2。

## 7. 提交计划

按 CLAUDE.md §12 原子提交，拆为：

1. `perf(api/media): CRC32 改 slicing-by-8 提速 5-8 倍` —— `media.ts`
2. `feat(db): 新增 sha256 索引 migration` —— `migrations/003_add_sha256_index.sql`
3. `feat(api/files): 新增 SHA-256 预检接口` —— `files.ts`、`db/files.ts`、`index.ts`
4. `feat(api/files): direct/multipart upload 加 SHA-256 重复检查` —— `files.ts`
5. `feat(api/files): 新增重复内容列表接口` —— `files.ts`、`db/files.ts`、`index.ts`
6. `feat(web): 上传前 SHA-256 预检 + 重复提示` —— `web/src/utils/hash.ts`、上传相关组件
7. `feat(web): 清理重复 UI` —— dashboard 入口 + 列表组件
8. `chore(build): 重建前端构建产物`（如必要）

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| slicing-by-8 表预计算 bug 导致 CRC 不对，所有 zip 都损坏 | 提交前用临时脚本对照标准值验证；保留旧 byte-wise 实现到提交体一周后再清理 |
| `/api/files/precheck` 增加上传链路一次 D1 查询，整体延迟 | D1 单次 PK / 索引查询 < 10ms，相对客户端算 SHA 的 1-3s 微不足道 |
| 客户端算 SHA 阻塞 UI | 用 `crypto.subtle.digest`（非阻塞，硬件加速）+ progress 回调；100MB 在 1-3s |
| 旧客户端不发 `X-File-Sha256` 绕过判重 | 保留服务端 `/info` 端点的流式补算路径；后续阶段加 schema UNIQUE 约束彻底兜底 |
| D1 大表上 `WHERE sha256 = ?` 慢 | 配套 003 migration 加 `idx_files_sha256` 索引 |
| `computeFileSha256` 把整个文件读到内存，浏览器 OOM | 100MB 在浏览器内存远内（移动端最低也 1GB+），可接受；如需更大文件后续可改用 SubtleCrypto 的增量 API（`crypto.subtle.digest` 不支持，但可用 `js-sha256` 库的 streaming 模式） |
| 用户在「清理重复」工具里误删 | 默认只勾选"非最早"副本，最早一条不勾；用户主动调整勾选；前端弹二次确认 |

## 9. 决策依据回顾

- 选 slicing-by-8 而非 slicing-by-1：30s CPU 内能处理几十 GB，给未来留余量。
- 选客户端算 SHA 而非"上传完再判重":前者能在用户开始 PUT 之前就拒绝、节省带宽和 R2 写。
- 不加 UNIQUE(sha256)：旧数据可能有重复，约束 migration 会失败。等用户用清理工具清完后单独做 schema migration。
- 提供清理工具但不自动清：删除是破坏性操作，必须用户明确确认。
- 文件名可重复但内容不可重复：用户最终决策（见会话）。简化语义：判重只依赖 SHA-256，文件名是展示属性。
